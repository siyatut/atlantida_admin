#!/usr/bin/env node

'use strict';

// Reorganises media library into a two-level hierarchy:
//   Root → Main Category folder → Subcategory folder
//
// Expects folders to be in "Main — Sub" format (created by rename-folders-by-category.js).
// Creates a root-level folder for each main category, then moves each subcategory
// folder into it and strips the "Main — " prefix from its name.
//
// Usage:
//   node --env-file=.env scripts/nest-folders-by-category.js [--dry-run]

const SEPARATOR = ' — ';
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function getStrapiBaseUrl() {
  return (process.env.STRAPI_BASE_URL?.trim() || 'http://localhost:1337').replace(/\/+$/, '');
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

async function fetchFolders(adminJwt) {
  const res = await fetchWithRetry(
    `${getStrapiBaseUrl()}/upload/folders?pagination[pageSize]=200`,
    { headers: { Authorization: `Bearer ${adminJwt}` } },
  );
  const json = await res.json();
  return (json.data ?? []).map((f) => ({ id: f.id, name: f.name, parent: f.parent ?? null }));
}

async function createFolder(adminJwt, name) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/upload/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({ name, parent: null }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /upload/folders failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data?.id;
}

async function moveAndRenameFolder(adminJwt, folderId, newName, parentId) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/upload/folders/${folderId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({ name: newName, parent: parentId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT /upload/folders/${folderId} failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Strapi:  ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:    DRY RUN — no changes will be made');
  console.log('');

  console.log('Authenticating...');
  const adminJwt = await getAdminJwt();
  console.log('OK\n');

  console.log('Fetching folders...');
  const folders = await fetchFolders(adminJwt);
  console.log(`Found ${folders.length} folder(s)\n`);

  // Split folders into two groups: "Main — Sub" (to be nested) and others (skip).
  const toNest = [];
  const skipped = [];

  for (const folder of folders) {
    const idx = folder.name.indexOf(SEPARATOR);
    if (idx === -1) {
      skipped.push(folder);
      continue;
    }
    const mainCategory = folder.name.slice(0, idx);
    const subcategoryName = folder.name.slice(idx + SEPARATOR.length);
    toNest.push({ folder, mainCategory, subcategoryName });
  }

  if (skipped.length > 0) {
    console.log('Skipped (no separator — not in "Main — Sub" format):');
    skipped.forEach(({ name }) => console.log(`  "${name}"`));
    console.log('');
  }

  if (toNest.length === 0) {
    console.log('Nothing to nest.');
    return;
  }

  // Collect unique main categories.
  const mainCategories = [...new Set(toNest.map((x) => x.mainCategory))].sort();
  console.log(`Main categories: ${mainCategories.join(', ')}\n`);

  console.log('Plan:');
  for (const { folder, mainCategory, subcategoryName } of toNest) {
    console.log(`  "${folder.name}"  →  ${mainCategory}/"${subcategoryName}"`);
  }
  console.log('');

  if (dryRun) {
    console.log(`Dry run complete. Would create ${mainCategories.length} parent folder(s) and nest ${toNest.length} subfolder(s).`);
    return;
  }

  // Create or reuse parent folders.
  const parentIds = new Map(); // mainCategory → folderId

  // First, check if any main category folders already exist.
  for (const folder of folders) {
    if (mainCategories.includes(folder.name)) {
      parentIds.set(folder.name, folder.id);
      console.log(`Parent "${folder.name}" already exists (id=${folder.id})`);
    }
  }

  for (const mainCategory of mainCategories) {
    if (parentIds.has(mainCategory)) continue;
    process.stdout.write(`Creating parent folder "${mainCategory}"... `);
    const id = await createFolder(adminJwt, mainCategory);
    parentIds.set(mainCategory, id);
    console.log(`id=${id}`);
  }
  console.log('');

  // Move and rename subcategory folders.
  let moved = 0;
  let failed = 0;

  for (const { folder, mainCategory, subcategoryName } of toNest) {
    const parentId = parentIds.get(mainCategory);
    process.stdout.write(`"${folder.name}"  →  ${mainCategory}/"${subcategoryName}"... `);
    try {
      await moveAndRenameFolder(adminJwt, folder.id, subcategoryName, parentId);
      moved++;
      console.log('done');
    } catch (err) {
      failed++;
      console.error(`FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone.  Moved: ${moved}  Failed: ${failed}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
