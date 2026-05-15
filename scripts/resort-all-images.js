#!/usr/bin/env node

'use strict';

// Checks every file in the Strapi media library and moves it to the correct
// subcategory folder based on the product it is linked to.
// Covers files that are unfoldered, in the wrong folder, or in a
// catch-all folder like "Оборудование для аквариума".
//
// Usage:
//   node --env-file=.env scripts/resort-all-images.js [--dry-run]

const PAGE_SIZE = 100;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

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

// Returns Map: subcategoryTitle → mainCategoryTitle
async function fetchSubcatToMainMap() {
  const map = new Map();
  let page = 1;
  while (true) {
    const url = `${getStrapiBaseUrl()}/api/subcategories?populate[mainCategory][fields][0]=title&fields[0]=title&pagination[page]=${page}&pagination[pageSize]=100`;
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${getApiToken()}` },
    });
    const json = await res.json();
    for (const s of json.data ?? []) {
      if (s.title && s.mainCategory?.title) map.set(s.title, s.mainCategory.title);
    }
    const { pageCount } = json.meta?.pagination ?? {};
    if (page >= (pageCount ?? 1)) break;
    page++;
  }
  return map;
}

// Returns Map: subcategoryTitle → productCount
async function fetchSubcatProductCounts() {
  const counts = new Map();
  let page = 1;
  while (true) {
    const url = new URL(`${getStrapiBaseUrl()}/api/products`);
    url.searchParams.set('populate[subcategories][fields][0]', 'title');
    url.searchParams.set('fields[0]', 'id');
    url.searchParams.set('pagination[page]', String(page));
    url.searchParams.set('pagination[pageSize]', String(PAGE_SIZE));

    const res = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${getApiToken()}` },
    });
    if (!res.ok) throw new Error(`GET /api/products failed: HTTP ${res.status}`);
    const json = await res.json();

    for (const product of json.data ?? []) {
      for (const s of product.subcategories ?? []) {
        counts.set(s.title, (counts.get(s.title) ?? 0) + 1);
      }
    }

    const { pageCount } = json.meta?.pagination ?? {};
    if (page >= (pageCount ?? 1)) break;
    page++;
  }
  return counts;
}

// Returns Map: imageId → subcategoryTitle
// When a product has multiple subcategories, picks the most specific one
// (the subcategory with the fewest products — broad catch-all categories have more).
async function fetchImageToSubcatMap(subcatCounts) {
  const map = new Map();
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
      const subs = product.subcategories ?? [];
      if (!subs.length) continue;
      // Most specific = fewest products in that subcategory.
      const subcategory = subs.reduce((best, s) => {
        const count = subcatCounts.get(s.title) ?? Infinity;
        return count < (subcatCounts.get(best.title) ?? Infinity) ? s : best;
      }).title;
      for (const image of product.images ?? []) {
        if (!map.has(image.id)) map.set(image.id, subcategory);
      }
    }

    const { pageCount } = json.meta?.pagination ?? {};
    if (page >= (pageCount ?? 1)) break;
    page++;
  }
  return map;
}

// Returns all folders, plus lookup maps.
async function fetchFolderMaps(adminJwt) {
  const res = await fetchWithRetry(
    `${getStrapiBaseUrl()}/upload/folders?pagination[pageSize]=200`,
    { headers: { Authorization: `Bearer ${adminJwt}` } },
  );
  const json = await res.json();
  const folders = json.data ?? [];

  // pathId → name (for all folders)
  const nameByPathId = new Map();
  for (const f of folders) nameByPathId.set(f.pathId, f.name);

  // (mainName, subName) → folderId  (for depth-2 folders)
  const targetIdByKey = new Map();
  // folderId → folderName (for reporting current location)
  const nameById = new Map();
  for (const f of folders) {
    nameById.set(f.id, f.name);
    const parts = f.path.split('/').filter(Boolean);
    if (parts.length === 2) {
      const parentPathId = Number(parts[0]);
      const parentName = nameByPathId.get(parentPathId) ?? '';
      targetIdByKey.set(`${parentName}|${f.name}`, f.id);
    }
  }

  return { targetIdByKey, nameById };
}

// Fetches all files from the admin API with their current folder id.
async function fetchAllFiles(adminJwt) {
  const files = [];
  let page = 1;
  while (true) {
    const res = await fetchWithRetry(
      `${getStrapiBaseUrl()}/upload/files?page=${page}&pageSize=${PAGE_SIZE}`,
      { headers: { Authorization: `Bearer ${adminJwt}` } },
    );
    if (!res.ok) throw new Error(`GET /upload/files failed: HTTP ${res.status}`);
    const json = await res.json();
    const items = Array.isArray(json) ? json : (json.results ?? json.data ?? []);
    for (const f of items) {
      files.push({
        id: f.id,
        name: f.name ?? '',
        currentFolderId: f.folder?.id ?? null,
        currentFolderName: f.folder?.name ?? null,
      });
    }
    const total = json.pagination?.total ?? 0;
    if (items.length < PAGE_SIZE || page * PAGE_SIZE >= total) break;
    page++;
  }
  return files;
}

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

  console.log('Fetching subcategory → main category map...');
  const subcatToMain = await fetchSubcatToMainMap();
  console.log(`Found ${subcatToMain.size} subcategories\n`);

  console.log('Counting products per subcategory...');
  const subcatCounts = await fetchSubcatProductCounts();

  console.log('Building image → subcategory map from products...');
  const imageToSubcat = await fetchImageToSubcatMap(subcatCounts);
  console.log(`Found ${imageToSubcat.size} image(s) linked to products\n`);

  console.log('Authenticating...');
  const adminJwt = await getAdminJwt();
  console.log('OK\n');

  console.log('Fetching folders...');
  const { targetIdByKey, nameById } = await fetchFolderMaps(adminJwt);
  console.log(`Loaded ${targetIdByKey.size} subcategory folder(s)\n`);

  console.log('Fetching all media files...');
  const files = await fetchAllFiles(adminJwt);
  console.log(`Found ${files.length} file(s)\n`);

  // Classify each file.
  const toMove = new Map(); // targetFolderId → { folderKey, fileIds[] }
  const noProduct = [];
  const noFolder = [];
  let alreadyCorrect = 0;

  for (const file of files) {
    const subcat = imageToSubcat.get(file.id);
    if (!subcat) {
      noProduct.push(file);
      continue;
    }

    const main = subcatToMain.get(subcat);
    if (!main) {
      noFolder.push({ file, reason: `unknown main category for "${subcat}"` });
      continue;
    }

    const key = `${main}|${subcat}`;
    const targetFolderId = targetIdByKey.get(key);
    if (!targetFolderId) {
      noFolder.push({ file, reason: `folder "${main}/${subcat}" not found` });
      continue;
    }

    if (file.currentFolderId === targetFolderId) {
      alreadyCorrect++;
      continue;
    }

    if (!toMove.has(targetFolderId)) {
      toMove.set(targetFolderId, { key, fileIds: [] });
    }
    toMove.get(targetFolderId).fileIds.push(file.id);
  }

  // Report.
  console.log(`Already in correct folder: ${alreadyCorrect}`);
  console.log(`To move:                   ${[...toMove.values()].reduce((s, v) => s + v.fileIds.length, 0)}`);
  console.log(`Not linked to a product:   ${noProduct.length} (skipped)`);
  if (noFolder.length > 0) {
    console.log(`No matching folder:        ${noFolder.length}`);
    noFolder.forEach(({ file, reason }) => console.log(`  "${file.name}" — ${reason}`));
  }
  console.log('');

  if (toMove.size === 0) {
    console.log('Nothing to move.');
    return;
  }

  console.log('Plan:');
  for (const [, { key, fileIds }] of toMove) {
    const [main, sub] = key.split('|');
    console.log(`  ${main}/${sub}  ←  ${fileIds.length} file(s)`);
  }
  console.log('');

  if (dryRun) {
    console.log('Dry run complete. Run without --dry-run to apply.');
    return;
  }

  let moved = 0;
  let failed = 0;

  for (const [targetFolderId, { key, fileIds }] of toMove) {
    const [main, sub] = key.split('|');
    process.stdout.write(`Moving ${fileIds.length} file(s) → ${main}/${sub}... `);
    try {
      await moveFiles(adminJwt, fileIds, targetFolderId);
      moved += fileIds.length;
      console.log('done');
    } catch (err) {
      failed += fileIds.length;
      console.error(`FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone.  Moved: ${moved}  Failed: ${failed}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
