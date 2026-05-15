#!/usr/bin/env node

'use strict';

// Creates missing media library folders to match the full category tree in Strapi.
// Ensures every main category has a root-level folder and every subcategory
// has a nested folder inside its main category folder.
//
// Usage:
//   node --env-file=.env scripts/sync-category-folders.js [--dry-run]

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

// Returns Map: mainCategoryTitle → Set of subcategoryTitles
async function fetchCategoryTree() {
  const tree = new Map();
  let page = 1;
  while (true) {
    const url = `${getStrapiBaseUrl()}/api/subcategories?populate[mainCategory][fields][0]=title&fields[0]=title&pagination[page]=${page}&pagination[pageSize]=100`;
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${getApiToken()}` },
    });
    const json = await res.json();
    for (const s of json.data ?? []) {
      const main = s.mainCategory?.title;
      const sub = s.title;
      if (!main || !sub) continue;
      if (!tree.has(main)) tree.set(main, new Set());
      tree.get(main).add(sub);
    }
    const { pageCount } = json.meta?.pagination ?? {};
    if (page >= (pageCount ?? 1)) break;
    page++;
  }
  return tree;
}

// Returns all folders with their path info.
// root folders: path has one segment (e.g. '/41')
// nested folders: path has two segments (e.g. '/41/1')
async function fetchAllFolders(adminJwt) {
  const res = await fetchWithRetry(
    `${getStrapiBaseUrl()}/upload/folders?pagination[pageSize]=200`,
    { headers: { Authorization: `Bearer ${adminJwt}` } },
  );
  const json = await res.json();
  return (json.data ?? []).map((f) => ({
    id: f.id,
    pathId: f.pathId,
    name: f.name,
    path: f.path,
    depth: f.path.split('/').filter(Boolean).length,
  }));
}

async function createFolder(adminJwt, name, parentId) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/upload/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({ name, parent: parentId ?? null }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /upload/folders failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  return { id: json.data?.id, pathId: json.data?.pathId };
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Strapi:  ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:    DRY RUN — no changes will be made');
  console.log('');

  console.log('Fetching category tree...');
  const tree = await fetchCategoryTree();
  const totalSubs = [...tree.values()].reduce((s, v) => s + v.size, 0);
  console.log(`Found ${tree.size} main categories, ${totalSubs} subcategories\n`);

  console.log('Authenticating...');
  const adminJwt = await getAdminJwt();
  console.log('OK\n');

  console.log('Fetching existing folders...');
  const folders = await fetchAllFolders(adminJwt);
  console.log(`Found ${folders.length} folder(s)\n`);

  // Build lookup: name → folder (for root-level folders)
  const rootByName = new Map();
  for (const f of folders) {
    if (f.depth === 1) rootByName.set(f.name, f);
  }

  // Build lookup: parentPathId → (childName → folder)
  const childByParentAndName = new Map();
  for (const f of folders) {
    if (f.depth !== 2) continue;
    const parts = f.path.split('/').filter(Boolean);
    const parentPathId = Number(parts[0]);
    if (!childByParentAndName.has(parentPathId)) childByParentAndName.set(parentPathId, new Map());
    childByParentAndName.get(parentPathId).set(f.name, f);
  }

  // Determine what needs to be created.
  const missingRoots = [];
  const missingSubs = [];

  for (const [main, subs] of tree) {
    if (!rootByName.has(main)) missingRoots.push(main);
    for (const sub of subs) {
      const parent = rootByName.get(main);
      const alreadyExists = parent
        ? childByParentAndName.get(parent.pathId)?.has(sub)
        : false;
      if (!alreadyExists) missingSubs.push({ main, sub, parentExists: !!parent });
    }
  }

  if (missingRoots.length === 0 && missingSubs.length === 0) {
    console.log('All folders are in sync. Nothing to create.');
    return;
  }

  if (missingRoots.length > 0) {
    console.log(`Missing root folders (${missingRoots.length}):`);
    missingRoots.forEach((m) => console.log(`  ${m}/`));
    console.log('');
  }

  if (missingSubs.length > 0) {
    console.log(`Missing subcategory folders (${missingSubs.length}):`);
    for (const { main, sub } of missingSubs) console.log(`  ${main}/${sub}`);
    console.log('');
  }

  if (dryRun) {
    console.log(`Dry run complete. Would create ${missingRoots.length} root folder(s) and ${missingSubs.length} subfolder(s).`);
    return;
  }

  // Create missing root folders first, update lookup.
  for (const main of missingRoots) {
    process.stdout.write(`Creating root folder "${main}"... `);
    try {
      const { id, pathId } = await createFolder(adminJwt, main, null);
      rootByName.set(main, { id, pathId, name: main });
      console.log(`id=${id}`);
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
    }
  }

  // Create missing subcategory folders.
  let created = 0;
  let failed = 0;

  for (const { main, sub } of missingSubs) {
    const parent = rootByName.get(main);
    if (!parent) {
      console.error(`  Skipping "${main}/${sub}" — parent folder missing (creation failed earlier)`);
      failed++;
      continue;
    }
    process.stdout.write(`Creating "${main}/${sub}"... `);
    try {
      await createFolder(adminJwt, sub, parent.id);
      created++;
      console.log('done');
    } catch (err) {
      failed++;
      console.error(`FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone.  Created: ${missingRoots.length} root + ${created} subfolder(s)  Failed: ${failed}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
