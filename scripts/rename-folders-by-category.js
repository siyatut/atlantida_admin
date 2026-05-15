#!/usr/bin/env node

'use strict';

// Renames media library folders by prefixing each subcategory folder
// with its main category name.
// Example: "Внутренние фильтры" → "Рыбки — Внутренние фильтры"
//
// Usage:
//   node --env-file=.env scripts/rename-folders-by-category.js [--dry-run]

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

// Returns Map: subcategoryTitle → Set of mainCategoryTitles
async function fetchSubcategoryMap() {
  const map = new Map();
  let page = 1;
  while (true) {
    const url = `${getStrapiBaseUrl()}/api/subcategories?populate[mainCategory][fields][0]=title&fields[0]=title&pagination[page]=${page}&pagination[pageSize]=100`;
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${getApiToken()}` },
    });
    const json = await res.json();
    for (const s of json.data ?? []) {
      const sub = s.title;
      const main = s.mainCategory?.title;
      if (!sub || !main) continue;
      if (!map.has(sub)) map.set(sub, new Set());
      map.get(sub).add(main);
    }
    const { pageCount } = json.meta?.pagination ?? {};
    if (page >= (pageCount ?? 1)) break;
    page++;
  }
  return map;
}

// Returns array of { id, name } for all folders.
async function fetchFolders(adminJwt) {
  const res = await fetchWithRetry(
    `${getStrapiBaseUrl()}/upload/folders?pagination[pageSize]=100`,
    { headers: { Authorization: `Bearer ${adminJwt}` } },
  );
  const json = await res.json();
  return (json.data ?? []).map((f) => ({ id: f.id, name: f.name }));
}

async function renameFolder(adminJwt, folderId, newName) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/upload/folders/${folderId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({ name: newName }),
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

  console.log('Fetching subcategory → main category mapping...');
  const subcategoryMap = await fetchSubcategoryMap();
  console.log(`Found ${subcategoryMap.size} subcategories\n`);

  console.log('Fetching folders...');
  const folders = await fetchFolders(adminJwt);
  console.log(`Found ${folders.length} folder(s)\n`);

  const toRename = [];
  const ambiguous = [];
  const noMatch = [];

  for (const folder of folders) {
    // Skip folders that are already prefixed (re-run safety).
    const alreadyPrefixed = [...subcategoryMap.values()].some((mains) =>
      [...mains].some((main) => folder.name.startsWith(main + ' — ')),
    );
    if (alreadyPrefixed) continue;

    const mainCategories = subcategoryMap.get(folder.name);
    if (!mainCategories) {
      noMatch.push(folder);
      continue;
    }

    if (mainCategories.size > 1) {
      ambiguous.push({ folder, mains: [...mainCategories] });
      continue;
    }

    const mainCategory = [...mainCategories][0];
    toRename.push({ folder, newName: `${mainCategory} — ${folder.name}` });
  }

  if (toRename.length > 0) {
    console.log('Will rename:');
    toRename.forEach(({ folder, newName }) =>
      console.log(`  "${folder.name}"  →  "${newName}"`),
    );
    console.log('');
  }

  if (ambiguous.length > 0) {
    console.log('⚠ Ambiguous (subcategory exists in multiple main categories — skipped):');
    ambiguous.forEach(({ folder, mains }) =>
      console.log(`  "${folder.name}" → found in: ${mains.join(', ')}`),
    );
    console.log('');
  }

  if (noMatch.length > 0) {
    console.log('— No matching subcategory (skipped):');
    noMatch.forEach(({ name }) => console.log(`  "${name}"`));
    console.log('');
  }

  if (toRename.length === 0) {
    console.log('Nothing to rename.');
    return;
  }

  if (dryRun) {
    console.log(`Dry run complete. Would rename ${toRename.length} folder(s).`);
    return;
  }

  let renamed = 0;
  let failed = 0;
  for (const { folder, newName } of toRename) {
    process.stdout.write(`Renaming "${folder.name}" → "${newName}"... `);
    try {
      await renameFolder(adminJwt, folder.id, newName);
      renamed++;
      console.log('done');
    } catch (err) {
      failed++;
      console.error(`FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone.  Renamed: ${renamed}  Failed: ${failed}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
