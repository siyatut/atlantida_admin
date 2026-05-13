#!/usr/bin/env node

'use strict';

// Removes the leading "Аквариум " word from all matching product titles in Strapi.
//
// Usage:
//   node --env-file=.env scripts/rename-aquarium-products.js [--dry-run]

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const PAGE_SIZE = 100;
const PREFIX = 'аквариум ';

function getStrapiBaseUrl() {
  return (process.env.STRAPI_BASE_URL?.trim() || 'http://localhost:1337').replace(/\/+$/, '');
}

function getHeaders() {
  const token = process.env.STRAPI_API_TOKEN?.trim();
  if (!token) throw new Error('STRAPI_API_TOKEN is required.');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
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
        console.warn(`  [retry ${attempt}] retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

function stripPrefix(title) {
  if (!title.toLowerCase().startsWith(PREFIX)) return null;
  const rest = title.slice(PREFIX.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

async function fetchAllProducts() {
  const products = [];
  let page = 1;
  while (true) {
    const url = new URL(`${getStrapiBaseUrl()}/api/products`);
    url.searchParams.set('filters[title][$startsWith]', 'Аквариум ');
    url.searchParams.set('fields[0]', 'title');
    url.searchParams.set('pagination[page]', String(page));
    url.searchParams.set('pagination[pageSize]', String(PAGE_SIZE));

    const res = await fetchWithRetry(url.toString(), { headers: getHeaders() });
    if (!res.ok) throw new Error(`GET /api/products failed: HTTP ${res.status}`);
    const json = await res.json();
    products.push(...(json.data ?? []));
    const { pageCount } = json.meta?.pagination ?? {};
    if (page >= (pageCount ?? 1)) break;
    page++;
  }
  return products;
}

async function renameProduct(documentId, newTitle) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/products/${documentId}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ data: { title: newTitle } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Strapi:  ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:    DRY RUN — Strapi not changed');
  console.log('');

  console.log('Fetching products starting with "Аквариум "...');
  const products = await fetchAllProducts();
  console.log(`Found:   ${products.length} product(s)`);
  console.log('');

  const toRename = products
    .map((p) => ({ documentId: p.documentId, oldTitle: p.title, newTitle: stripPrefix(p.title) }))
    .filter((p) => p.newTitle !== null);

  if (toRename.length === 0) {
    console.log('Nothing to rename.');
    return;
  }

  for (const item of toRename) {
    console.log(`  "${item.oldTitle}"`);
    console.log(`  → "${item.newTitle}"`);
    console.log('');
  }

  if (dryRun) {
    console.log(`Dry run complete. Would rename ${toRename.length} product(s).`);
    return;
  }

  let renamed = 0, failed = 0;
  for (const item of toRename) {
    try {
      await renameProduct(item.documentId, item.newTitle);
      console.log(`[renamed]  ${item.newTitle}`);
      renamed++;
    } catch (err) {
      console.error(`[failed]   ${item.oldTitle}: ${err.message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`Done.  Renamed: ${renamed}  Failed: ${failed}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
