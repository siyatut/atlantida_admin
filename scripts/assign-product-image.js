#!/usr/bin/env node

'use strict';

// Uploads an image file and assigns it to all products whose title contains a keyword.
// Replaces existing images on matched products.
//
// Usage:
//   node --env-file=.env scripts/assign-product-image.js --file <path> --match <keyword> [--dry-run]
//
// Examples:
//   node --env-file=.env scripts/assign-product-image.js --file ./images/round.jpg --match "круглый"
//   node --env-file=.env scripts/assign-product-image.js --file ./images/vase.jpg --match "ваза" --dry-run

const fs = require('fs');
const path = require('path');

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const PAGE_SIZE = 100;

function getStrapiBaseUrl() {
  return (process.env.STRAPI_BASE_URL?.trim() || 'http://localhost:1337').replace(/\/+$/, '');
}

function getToken() {
  const token = process.env.STRAPI_API_TOKEN?.trim();
  if (!token) throw new Error('STRAPI_API_TOKEN is required.');
  return token;
}

function getJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
  };
}

function getAuthHeaders() {
  return { Authorization: `Bearer ${getToken()}` };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_ATTEMPTS) {
        console.warn(`  [retry ${attempt}/${RETRY_ATTEMPTS - 1}] retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let file = null;
  let match = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) { file = args[++i]; continue; }
    if (args[i] === '--match' && args[i + 1]) { match = args[++i]; continue; }
    if (args[i] === '--dry-run') { dryRun = true; continue; }
  }

  if (!file || !match) {
    console.error('Usage: node scripts/assign-product-image.js --file <path> --match <keyword> [--dry-run]');
    process.exit(1);
  }

  const resolvedFile = path.resolve(file);
  if (!fs.existsSync(resolvedFile)) {
    console.error(`File not found: ${resolvedFile}`);
    process.exit(1);
  }

  return { file: resolvedFile, match, dryRun };
}

async function uploadImage(filePath) {
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const mimeType = fileName.match(/\.png$/i) ? 'image/png'
    : fileName.match(/\.gif$/i) ? 'image/gif'
    : 'image/jpeg';

  const formData = new FormData();
  formData.append('files', new Blob([fileBuffer], { type: mimeType }), fileName);

  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/upload`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const uploaded = Array.isArray(json) ? json[0] : json;
  if (!uploaded?.id) throw new Error('Upload response missing file id');
  return uploaded;
}

async function findMatchingProducts(keyword) {
  const products = [];
  let page = 1;

  while (true) {
    const url = new URL(`${getStrapiBaseUrl()}/api/products`);
    url.searchParams.set('filters[title][$containsi]', keyword);
    url.searchParams.set('fields[0]', 'title');
    url.searchParams.set('populate[images][fields][0]', 'id');
    url.searchParams.set('pagination[page]', String(page));
    url.searchParams.set('pagination[pageSize]', String(PAGE_SIZE));

    const res = await fetchWithRetry(url.toString(), { headers: getJsonHeaders() });
    if (!res.ok) throw new Error(`GET /api/products failed: HTTP ${res.status}`);

    const json = await res.json();
    const items = json.data ?? [];
    products.push(...items);

    const { pageCount } = json.meta?.pagination ?? {};
    if (page >= (pageCount ?? 1)) break;
    page++;
  }

  return products;
}

async function assignImage(documentId, fileId) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/products/${documentId}`, {
    method: 'PUT',
    headers: getJsonHeaders(),
    body: JSON.stringify({ data: { images: [fileId] } }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

async function run() {
  const { file, match, dryRun } = parseArgs();

  console.log(`File:      ${file}`);
  console.log(`Match:     "${match}"`);
  console.log(`Strapi:    ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:      DRY RUN — Strapi not changed');
  console.log('');

  console.log('Searching for matching products...');
  const products = await findMatchingProducts(match);
  console.log(`Found:     ${products.length} product(s)`);
  console.log('');

  if (products.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  for (const p of products) {
    const hasImages = (p.images ?? []).length > 0;
    console.log(`  ${hasImages ? '[has image]' : '[no image] '} ${p.title}`);
  }
  console.log('');

  if (dryRun) {
    console.log('Dry run complete. No changes made.');
    return;
  }

  console.log('Uploading image...');
  const uploaded = await uploadImage(file);
  console.log(`Uploaded:  ${uploaded.name} (id: ${uploaded.id})`);
  console.log('');

  let updated = 0, failed = 0;

  for (const product of products) {
    try {
      await assignImage(product.documentId, uploaded.id);
      console.log(`[updated]  ${product.title}`);
      updated++;
    } catch (err) {
      console.error(`[failed]   ${product.title}: ${err.message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`Done.  Updated: ${updated}  Failed: ${failed}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
