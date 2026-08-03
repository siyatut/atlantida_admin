#!/usr/bin/env node

'use strict';

// Moves all products whose title contains "улитк" (case-insensitive) into the
// "Улитки" subcategory under the "Рыбки" main category, creating the subcategory
// if it doesn't exist. Replaces any existing subcategories on matched products.
// Also moves all their images into a "Рыбки/Улитки" folder in the media library.
//
// Usage:
//   node --env-file=.env scripts/migrate-snails-subcategory.js [--dry-run]

const SNAIL_KEYWORD = 'Улитка';
const SNAIL_SUBCATEGORY_TITLE = 'Улитки';
const FISH_MAIN_CATEGORY_TITLE = 'Рыбки';

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

function apiHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getApiToken()}`,
  };
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

// --- Content API ---

async function findMainCategory(title) {
  const url = new URL(`${getStrapiBaseUrl()}/api/main-categories`);
  url.searchParams.set('filters[title][$eq]', title);
  url.searchParams.set('fields[0]', 'title');
  const res = await fetchWithRetry(url.toString(), { headers: apiHeaders() });
  if (!res.ok) throw new Error(`GET /api/main-categories failed: HTTP ${res.status}`);
  const json = await res.json();
  return json.data?.[0] ?? null;
}

async function findSubcategory(title, mainCategoryTitle) {
  const url = new URL(`${getStrapiBaseUrl()}/api/subcategories`);
  url.searchParams.set('filters[title][$eq]', title);
  url.searchParams.set('filters[mainCategory][title][$eq]', mainCategoryTitle);
  url.searchParams.set('fields[0]', 'title');
  const res = await fetchWithRetry(url.toString(), { headers: apiHeaders() });
  if (!res.ok) throw new Error(`GET /api/subcategories failed: HTTP ${res.status}`);
  const json = await res.json();
  return json.data?.[0] ?? null;
}

async function createSubcategory(title, slug, mainCategoryId) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/subcategories`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ data: { title, slug, mainCategory: mainCategoryId } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/subcategories failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.data;
}

async function fetchSnailProducts() {
  const products = [];
  let page = 1;
  while (true) {
    const url = new URL(`${getStrapiBaseUrl()}/api/products`);
    url.searchParams.set('filters[title][$contains]', SNAIL_KEYWORD);
    url.searchParams.set('fields[0]', 'title');
    url.searchParams.set('populate[images][fields][0]', 'id');
    url.searchParams.set('populate[subcategories][fields][0]', 'title');
    url.searchParams.set('pagination[page]', String(page));
    url.searchParams.set('pagination[pageSize]', String(PAGE_SIZE));
    const res = await fetchWithRetry(url.toString(), { headers: apiHeaders() });
    if (!res.ok) throw new Error(`GET /api/products failed: HTTP ${res.status}`);
    const json = await res.json();
    products.push(...(json.data ?? []));
    const { pageCount } = json.meta?.pagination ?? {};
    if (page >= (pageCount ?? 1)) break;
    page++;
  }
  return products;
}

async function updateProduct(documentId, subcategoryId, mainCategoryId) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/products/${documentId}`, {
    method: 'PUT',
    headers: apiHeaders(),
    body: JSON.stringify({
      data: {
        subcategories: [subcategoryId],
        mainCategory: mainCategoryId,
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT /api/products/${documentId} failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

// --- Media library ---

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

// --- Main ---

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Strapi:  ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:    DRY RUN — no changes will be made');
  console.log('');

  // 1. Find "Рыбки" main category
  process.stdout.write(`Finding main category "${FISH_MAIN_CATEGORY_TITLE}"... `);
  const fishCategory = await findMainCategory(FISH_MAIN_CATEGORY_TITLE);
  if (!fishCategory) throw new Error(`Main category "${FISH_MAIN_CATEGORY_TITLE}" not found.`);
  console.log(`id=${fishCategory.id}`);

  // 2. Find or create "Улитки" subcategory under "Рыбки"
  process.stdout.write(`Finding subcategory "${SNAIL_SUBCATEGORY_TITLE}" under "${FISH_MAIN_CATEGORY_TITLE}"... `);
  let snailSubcategory = await findSubcategory(SNAIL_SUBCATEGORY_TITLE, FISH_MAIN_CATEGORY_TITLE);
  if (snailSubcategory) {
    console.log(`id=${snailSubcategory.id} (exists)`);
  } else if (dryRun) {
    console.log(`not found — [dry-run] would create it`);
  } else {
    console.log('not found — creating...');
    snailSubcategory = await createSubcategory(SNAIL_SUBCATEGORY_TITLE, 'ulitki', fishCategory.id);
    console.log(`Created "${SNAIL_SUBCATEGORY_TITLE}" id=${snailSubcategory.id}`);
  }
  console.log('');

  // 3. Find snail products
  console.log(`Searching for products with title containing "${SNAIL_KEYWORD}"...`);
  const products = await fetchSnailProducts();
  console.log(`Found ${products.length} product(s):\n`);
  for (const p of products) {
    const currentSubs = (p.subcategories ?? []).map((s) => s.title).join(', ') || '(none)';
    const imageCount = (p.images ?? []).length;
    console.log(`  [${imageCount} img] ${p.title}  (subcategories: ${currentSubs})`);
  }
  console.log('');

  if (products.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const imageIds = [];
  for (const p of products) {
    for (const img of p.images ?? []) imageIds.push(img.id);
  }
  console.log(`Total images to move: ${imageIds.length}`);
  console.log('');

  if (dryRun) {
    console.log(`[dry-run] Would set subcategories → ["${SNAIL_SUBCATEGORY_TITLE}"] on ${products.length} products`);
    console.log(`[dry-run] Would move ${imageIds.length} image(s) → folder "${FISH_MAIN_CATEGORY_TITLE}/${SNAIL_SUBCATEGORY_TITLE}"`);
    console.log('\nDry run complete. Run without --dry-run to apply.');
    return;
  }

  // 4. Update products
  console.log('Updating products...');
  let updated = 0;
  let failed = 0;
  for (const product of products) {
    try {
      await updateProduct(product.documentId, snailSubcategory.id, fishCategory.id);
      console.log(`  [ok]   ${product.title}`);
      updated++;
    } catch (err) {
      console.error(`  [fail] ${product.title}: ${err.message}`);
      failed++;
    }
  }
  console.log(`\nProducts — updated: ${updated}  failed: ${failed}\n`);

  // 5. Move images
  if (imageIds.length === 0) {
    console.log('No images to move. Done.');
    return;
  }

  console.log('Authenticating as admin for media library...');
  const adminJwt = await getAdminJwt();
  console.log('OK\n');

  console.log('Fetching media folders...');
  const allFolders = await fetchAllFolders(adminJwt);
  console.log(`Found ${allFolders.length} folder(s)\n`);

  let fishFolder = allFolders.find((f) => f.depth === 1 && f.name === FISH_MAIN_CATEGORY_TITLE);
  if (!fishFolder) {
    process.stdout.write(`Creating root folder "${FISH_MAIN_CATEGORY_TITLE}"... `);
    const created = await createFolder(adminJwt, FISH_MAIN_CATEGORY_TITLE, null);
    fishFolder = { ...created, name: FISH_MAIN_CATEGORY_TITLE, depth: 1 };
    console.log(`id=${fishFolder.id}`);
  } else {
    console.log(`Folder "${FISH_MAIN_CATEGORY_TITLE}" exists (id=${fishFolder.id})`);
  }

  const snailFolderExisting = allFolders.find((f) => {
    if (f.depth !== 2) return false;
    const parentPathId = Number(f.path.split('/').filter(Boolean)[0]);
    return parentPathId === fishFolder.pathId && f.name === SNAIL_SUBCATEGORY_TITLE;
  });

  let snailFolder;
  if (!snailFolderExisting) {
    process.stdout.write(`Creating folder "${FISH_MAIN_CATEGORY_TITLE}/${SNAIL_SUBCATEGORY_TITLE}"... `);
    const created = await createFolder(adminJwt, SNAIL_SUBCATEGORY_TITLE, fishFolder.id);
    snailFolder = created;
    console.log(`id=${snailFolder.id}`);
  } else {
    snailFolder = snailFolderExisting;
    console.log(`Folder "${FISH_MAIN_CATEGORY_TITLE}/${SNAIL_SUBCATEGORY_TITLE}" exists (id=${snailFolder.id})`);
  }

  process.stdout.write(`\nMoving ${imageIds.length} image(s) to "${FISH_MAIN_CATEGORY_TITLE}/${SNAIL_SUBCATEGORY_TITLE}"... `);
  await moveFiles(adminJwt, imageIds, snailFolder.id);
  console.log('done\n');

  console.log(`Done.  Products updated: ${updated}  failed: ${failed}  Images moved: ${imageIds.length}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
