#!/usr/bin/env node

'use strict';

// Bulk product import from a plain-text file.
//
// File format (UTF-8):
//   Line 1: main category title         (e.g. "Рыбки")
//   Line 2: parent subcategory title    (e.g. "Корм для рыбок")
//   Line 3: target subcategory title    (e.g. "Сухие корма на развес")
//   Lines 4+: one product per line in format "Title — Price"
//
// Usage:
//   node --env-file=.env scripts/import-products.js products.txt
//
// Optional env:
//   STRAPI_BASE_URL  (default: http://localhost:1337)
//
// The API token must have write access to the Product content-type.
// Run "npm run list:categories" to see exact category names.

const fs = require('fs/promises');

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function getStrapiBaseUrl() {
  const url = process.env.STRAPI_BASE_URL?.trim() || 'http://localhost:1337';
  return url.replace(/\/+$/, '');
}

function getHeaders() {
  const token = process.env.STRAPI_API_TOKEN?.trim();
  if (!token) {
    throw new Error('STRAPI_API_TOKEN is required. Set it in your .env or pass it inline.');
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_ATTEMPTS) {
        console.warn(`  [retry ${attempt}/${RETRY_ATTEMPTS - 1}] Connection error, retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

async function findMainCategoryDocumentId(title) {
  const url = new URL(`${getStrapiBaseUrl()}/api/main-categories`);
  url.searchParams.set('fields[0]', 'title');
  url.searchParams.set('pagination[limit]', '100');

  const res = await fetchWithRetry(url.toString(), { headers: getHeaders() });
  if (!res.ok) throw new Error(`GET /api/main-categories failed: HTTP ${res.status}`);

  const json = await res.json();
  const all = json.data ?? [];
  const match = all.find((r) => r.title.toLowerCase() === title.toLowerCase());

  if (!match) {
    const names = all.map((r) => `  • ${r.title}`).join('\n');
    throw new Error(`Main category not found: "${title}"\nAvailable:\n${names}`);
  }

  return match.documentId;
}

async function findSubcategoryDocumentId(title, parentTitle) {
  // When parent === title the subcategory has no children — look it up directly.
  if (title.toLowerCase() === parentTitle.toLowerCase()) {
    const url = new URL(`${getStrapiBaseUrl()}/api/subcategories`);
    url.searchParams.set('filters[title][$eqi]', title);
    url.searchParams.set('fields[0]', 'title');
    url.searchParams.set('pagination[limit]', '2');
    const res = await fetchWithRetry(url.toString(), { headers: getHeaders() });
    if (!res.ok) throw new Error(`GET /api/subcategories failed: HTTP ${res.status}`);
    const json = await res.json();
    const match = json.data?.[0];
    if (!match) throw new Error(`Subcategory not found: "${title}". Run "npm run list:categories" to check names.`);
    return match.documentId;
  }

  const url = new URL(`${getStrapiBaseUrl()}/api/subcategories`);
  url.searchParams.set('filters[parent][title][$eqi]', parentTitle);
  url.searchParams.set('fields[0]', 'title');
  url.searchParams.set('pagination[limit]', '100');

  const res = await fetchWithRetry(url.toString(), { headers: getHeaders() });
  if (!res.ok) throw new Error(`GET /api/subcategories failed: HTTP ${res.status}`);

  const json = await res.json();
  const siblings = json.data ?? [];
  const match = siblings.find((r) => r.title.toLowerCase() === title.toLowerCase());

  if (!match) {
    if (siblings.length === 0) {
      throw new Error(`Parent subcategory not found: "${parentTitle}". Run "npm run list:categories" to check names.`);
    }
    const names = siblings.map((r) => `  • ${r.title}`).join('\n');
    throw new Error(`Subcategory not found: "${title}"\nSubcategories under "${parentTitle}":\n${names}`);
  }

  return match.documentId;
}

async function productExists(title, subcategoryDocumentId) {
  const url = new URL(`${getStrapiBaseUrl()}/api/products`);
  url.searchParams.set('filters[title][$eqi]', title);
  url.searchParams.set('filters[subcategories][documentId][$eq]', subcategoryDocumentId);
  url.searchParams.set('fields[0]', 'title');
  url.searchParams.set('pagination[limit]', '1');

  const res = await fetchWithRetry(url.toString(), { headers: getHeaders() });
  if (!res.ok) return false;
  const json = await res.json();
  return (json.data?.length ?? 0) > 0;
}

async function createProduct({ title, price, mainCategoryDocumentId, subcategoryDocumentId }) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/products`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      data: {
        title,
        slug: generateSlug(title),
        price,
        description: '',
        inStock: true,
        isActive: true,
        mainCategory: mainCategoryDocumentId,
        subcategories: [subcategoryDocumentId],
      },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const message = err?.error?.message || `HTTP ${res.status}`;
    throw new Error(message);
  }

  return res.json();
}

const TRANSLIT_MAP = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',
  к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',
  х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
};

function generateSlug(title) {
  return title
    .toLowerCase()
    .split('')
    .map((ch) => TRANSLIT_MAP[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Accepts em-dash (—), en-dash (–), and plain hyphen surrounded by spaces.
function parseProductLine(line) {
  const separatorMatch = line.match(/^(.+?)\s*(?:—|–|\s-\s)\s*(\d+(?:[.,]\d+)?)\s*$/u);
  if (!separatorMatch) return null;

  const title = separatorMatch[1].trim();
  const price = parseFloat(separatorMatch[2].replace(',', '.'));
  if (!title || !Number.isFinite(price) || price <= 0) return null;

  return { title, price };
}

async function run() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/import-products.js <file>');
    process.exit(1);
  }

  const content = await fs.readFile(filePath, 'utf8');
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 4) {
    console.error('File must contain at least 4 lines: main category, parent subcategory, target subcategory, and one product.');
    process.exit(1);
  }

  const [mainCategoryName, parentSubcategoryName, subcategoryName, ...productLines] = lines;

  console.log(`Strapi:             ${getStrapiBaseUrl()}`);
  console.log(`Main category:      ${mainCategoryName}`);
  console.log(`Parent subcategory: ${parentSubcategoryName}`);
  console.log(`Subcategory:        ${subcategoryName}`);
  console.log(`Products:           ${productLines.length}`);
  console.log('');

  const mainCategoryDocumentId = await findMainCategoryDocumentId(mainCategoryName);
  const subcategoryDocumentId = await findSubcategoryDocumentId(subcategoryName, parentSubcategoryName);
  console.log(`main-category documentId: ${mainCategoryDocumentId}`);
  console.log(`subcategory   documentId: ${subcategoryDocumentId}`);
  console.log('');

  const summary = { created: 0, exists: 0, failed: 0, skipped: 0 };

  for (const line of productLines) {
    const parsed = parseProductLine(line);
    if (!parsed) {
      console.warn(`[skipped]  Could not parse: "${line}"`);
      summary.skipped++;
      continue;
    }

    try {
      const alreadyExists = await productExists(parsed.title, subcategoryDocumentId);
      if (alreadyExists) {
        console.log(`[exists]   ${parsed.title}`);
        summary.exists++;
        continue;
      }

      await createProduct({ ...parsed, mainCategoryDocumentId, subcategoryDocumentId });
      console.log(`[created]  ${parsed.title} — ${parsed.price} ₽`);
      summary.created++;
    } catch (err) {
      console.error(`[failed]   ${parsed.title}: ${err.message}`);
      summary.failed++;
    }
  }

  console.log('');
  console.log(`Done.  Created: ${summary.created}  Exists: ${summary.exists}  Failed: ${summary.failed}  Skipped: ${summary.skipped}`);
}

run().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
