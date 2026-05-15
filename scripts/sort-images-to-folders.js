#!/usr/bin/env node

'use strict';

// Sorts unfoldered images in Strapi media library into subcategory folders.
// For each image assigned to a product, finds the product's subcategory,
// creates a folder for it if needed, and moves the image there.
//
// Usage:
//   node --env-file=.env scripts/sort-images-to-folders.js [--dry-run]

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const PAGE_SIZE = 100;

function getStrapiBaseUrl() {
  return (process.env.STRAPI_BASE_URL?.trim() || 'http://localhost:1337').replace(/\/+$/, '');
}

function getApiToken() {
  const token = process.env.STRAPI_API_TOKEN?.trim();
  if (!token) throw new Error('STRAPI_API_TOKEN is required.');
  return token;
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

async function getAdminJwt() {
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD?.trim();
  if (!email || !password) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required.');

  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await res.json();
  const token = json.data?.token;
  if (!token) throw new Error(`Admin login failed: ${JSON.stringify(json).slice(0, 200)}`);
  return token;
}

// Fetch all products with their subcategory titles and image ids.
async function fetchProductImageMap() {
  const imageToSubcategory = new Map(); // imageId → subcategoryTitle
  let page = 1;

  while (true) {
    const url = new URL(`${getStrapiBaseUrl()}/api/products`);
    url.searchParams.set('populate[subcategories][fields][0]', 'title');
    url.searchParams.set('populate[images][fields][0]', 'id');
    url.searchParams.set('fields[0]', 'title');
    url.searchParams.set('pagination[page]', String(page));
    url.searchParams.set('pagination[pageSize]', String(PAGE_SIZE));

    const res = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${getApiToken()}` },
    });
    if (!res.ok) throw new Error(`GET /api/products failed: HTTP ${res.status}`);
    const json = await res.json();

    for (const product of json.data ?? []) {
      const subcategory = product.subcategories?.[0]?.title ?? null;
      if (!subcategory) continue;
      for (const image of product.images ?? []) {
        if (!imageToSubcategory.has(image.id)) {
          imageToSubcategory.set(image.id, subcategory);
        }
      }
    }

    const { pageCount } = json.meta?.pagination ?? {};
    if (page >= (pageCount ?? 1)) break;
    page++;
  }

  return imageToSubcategory;
}

// Fetch all unfoldered files (folder === null).
async function fetchUnfolderedFiles(adminJwt) {
  const files = [];
  let page = 1;

  while (true) {
    // Admin upload API uses plain `page` / `pageSize` params (not pagination[]).
    const url = `${getStrapiBaseUrl()}/upload/files?page=${page}&pageSize=${PAGE_SIZE}`;
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${adminJwt}` },
    });
    if (!res.ok) throw new Error(`GET /upload/files failed: HTTP ${res.status}`);
    const json = await res.json();

    const items = Array.isArray(json) ? json : (json.results ?? json.data ?? []);
    // Filter in memory: unfoldered files have folder === null.
    files.push(
      ...items
        .filter((f) => f.folder === null)
        .map((f) => ({ id: f.id, name: f.name, ext: f.ext ?? '' })),
    );

    const total = json.pagination?.total ?? 0;
    if (items.length < PAGE_SIZE || page * PAGE_SIZE >= total) break;
    page++;
  }

  return files;
}

// Fetch existing folders, return Map: name → id.
async function fetchFolders(adminJwt) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/upload/folders?pagination[pageSize]=100`, {
    headers: { Authorization: `Bearer ${adminJwt}` },
  });
  const json = await res.json();
  const map = new Map();
  for (const folder of json.data ?? []) {
    map.set(folder.name, folder.id);
  }
  return map;
}

// Create a folder, return its id.
async function createFolder(adminJwt, name) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/upload/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({ name, parent: null }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create folder "${name}": HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data?.id;
}

// Move files to a folder.
async function moveFiles(adminJwt, fileIds, destinationFolderId) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/upload/actions/bulk-move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({ fileIds, destinationFolderId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`bulk-move failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Strapi:  ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:    DRY RUN — no changes will be made');
  console.log('');

  console.log('Authenticating as admin...');
  const adminJwt = await getAdminJwt();
  console.log('OK\n');

  console.log('Building image → subcategory map from products...');
  const imageToSubcategory = await fetchProductImageMap();
  console.log(`Found ${imageToSubcategory.size} image(s) linked to products\n`);

  console.log('Fetching unfoldered files...');
  const unfolderedFiles = await fetchUnfolderedFiles(adminJwt);
  console.log(`Found ${unfolderedFiles.length} unfoldered file(s)\n`);

  // Match unfoldered files to subcategories.
  const subcategoryToFileIds = new Map(); // subcategoryTitle → fileId[]
  const unmatched = [];

  for (const file of unfolderedFiles) {
    const subcategory = imageToSubcategory.get(file.id);
    if (!subcategory) {
      unmatched.push(file);
      continue;
    }
    if (!subcategoryToFileIds.has(subcategory)) subcategoryToFileIds.set(subcategory, []);
    subcategoryToFileIds.get(subcategory).push(file.id);
  }

  if (subcategoryToFileIds.size === 0) {
    console.log('Nothing to move — no unfoldered files matched to a subcategory.');
    if (unmatched.length > 0) {
      console.log(`\n${unmatched.length} file(s) not linked to any product (skipped):`);
      unmatched.forEach((f) => console.log(`  ${f.id}  ${f.name}${f.ext}`));
    }
    return;
  }

  // Preview plan.
  console.log('Plan:');
  for (const [subcategory, fileIds] of subcategoryToFileIds) {
    console.log(`  [${subcategory}]  ${fileIds.length} file(s)`);
  }
  if (unmatched.length > 0) {
    console.log(`  (skipped — not linked to any product: ${unmatched.length} file(s))`);
  }
  console.log('');

  if (dryRun) {
    console.log('Dry run complete. Run without --dry-run to apply.');
    return;
  }

  // Get/create folders and move files.
  const folders = await fetchFolders(adminJwt);
  let totalMoved = 0;
  let totalFailed = 0;

  for (const [subcategory, fileIds] of subcategoryToFileIds) {
    let folderId = folders.get(subcategory);

    if (!folderId) {
      process.stdout.write(`Creating folder "${subcategory}"... `);
      try {
        folderId = await createFolder(adminJwt, subcategory);
        folders.set(subcategory, folderId);
        console.log(`id=${folderId}`);
      } catch (err) {
        console.error(`FAILED: ${err.message}`);
        totalFailed += fileIds.length;
        continue;
      }
    } else {
      console.log(`Folder "${subcategory}" already exists (id=${folderId})`);
    }

    process.stdout.write(`Moving ${fileIds.length} file(s) → "${subcategory}"... `);
    try {
      await moveFiles(adminJwt, fileIds, folderId);
      totalMoved += fileIds.length;
      console.log('done');
    } catch (err) {
      totalFailed += fileIds.length;
      console.error(`FAILED: ${err.message}`);
    }
  }

  console.log('');
  console.log(`Done.  Moved: ${totalMoved}  Failed: ${totalFailed}`);
  if (unmatched.length > 0) {
    console.log(`Skipped (not linked to any product): ${unmatched.length} file(s)`);
  }
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
