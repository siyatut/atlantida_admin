#!/usr/bin/env node

'use strict';

// Bulk product import from a plain-text file.
//
// File format (UTF-8):
//   Line 1: main category title         (e.g. "Рыбки")
//   Line 2: parent subcategory title    (e.g. "Корма для рыбок")
//   Line 3: target subcategory title    (e.g. "Сухие корма")
//   Lines 4+: one product per line in format "Title — Price"
//
// Usage:
//   STRAPI_API_TOKEN=<token> node scripts/import-products.js products.txt
//
// Optional env:
//   STRAPI_BASE_URL  (default: http://localhost:1337)
//
// The API token must have write access to the Product content-type.

const fs = require('fs/promises');

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

async function findMainCategoryDocumentId(title) {
  const url = new URL(`${getStrapiBaseUrl()}/api/main-categories`);
  url.searchParams.set('filters[title][$eqi]', title);
  url.searchParams.set('fields[0]', 'title');
  url.searchParams.set('pagination[limit]', '1');

  const res = await fetch(url.toString(), { headers: getHeaders() });
  if (!res.ok) throw new Error(`GET /api/main-categories failed: HTTP ${res.status}`);

  const json = await res.json();
  const record = json.data?.[0];
  if (!record) throw new Error(`Main category not found: "${title}"`);
  return record.documentId;
}

async function findSubcategoryDocumentId(title, parentTitle) {
  const url = new URL(`${getStrapiBaseUrl()}/api/subcategories`);
  url.searchParams.set('filters[title][$eqi]', title);
  url.searchParams.set('filters[parent][title][$eqi]', parentTitle);
  url.searchParams.set('fields[0]', 'title');
  url.searchParams.set('pagination[limit]', '1');

  const res = await fetch(url.toString(), { headers: getHeaders() });
  if (!res.ok) throw new Error(`GET /api/subcategories failed: HTTP ${res.status}`);

  const json = await res.json();
  const record = json.data?.[0];
  if (!record) throw new Error(`Subcategory "${title}" with parent "${parentTitle}" not found`);
  return record.documentId;
}

async function createProduct({ title, price, mainCategoryDocumentId, subcategoryDocumentId }) {
  const res = await fetch(`${getStrapiBaseUrl()}/api/products`, {
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

  const summary = { created: 0, failed: 0, skipped: 0 };

  for (const line of productLines) {
    const parsed = parseProductLine(line);
    if (!parsed) {
      console.warn(`[skipped]  Could not parse: "${line}"`);
      summary.skipped++;
      continue;
    }

    try {
      await createProduct({ ...parsed, mainCategoryDocumentId, subcategoryDocumentId });
      console.log(`[created]  ${parsed.title} — ${parsed.price} ₽`);
      summary.created++;
    } catch (err) {
      console.error(`[failed]   ${parsed.title}: ${err.message}`);
      summary.failed++;
    }
  }

  console.log('');
  console.log(`Done.  Created: ${summary.created}  Failed: ${summary.failed}  Skipped: ${summary.skipped}`);
}

run().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
