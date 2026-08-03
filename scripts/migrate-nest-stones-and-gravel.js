#!/usr/bin/env node

'use strict';

// Sets "Камни и коряги" and "Грунт" as child subcategories of "Декорации"
// by updating their parent field. Then redistributes the 12 products currently
// in "Декорации" back into the appropriate child subcategory based on title.
// Also creates "Рыбки/Декорации/Камни и коряги" and "Рыбки/Декорации/Грунт"
// folders in the media library and moves images there.
//
// Usage:
//   node --env-file=.env scripts/migrate-nest-stones-and-gravel.js [--dry-run]

const FISH_MAIN_CATEGORY_TITLE = 'Рыбки';
const DECORATIONS_TITLE = 'Декорации';

const CHILDREN = [
  { title: 'Камни и коряги' },
  { title: 'Грунт' },
];

// Products whose title starts with one of these prefixes belong to "Грунт".
// Everything else in "Декорации" goes to "Камни и коряги".
const GRAVEL_PREFIXES = ['Грунт', 'ЭКОгрунт', 'ПРО ПЛАНТ'];

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

async function updateSubcategoryParent(documentId, parentId) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/subcategories/${documentId}`, {
    method: 'PUT',
    headers: apiHeaders(),
    body: JSON.stringify({ data: { parent: parentId } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT /api/subcategories/${documentId} failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

async function fetchProductsInSubcategory(subcategoryTitle) {
  const products = [];
  let page = 1;
  while (true) {
    const url = new URL(`${getStrapiBaseUrl()}/api/products`);
    url.searchParams.set('filters[subcategories][title][$eq]', subcategoryTitle);
    url.searchParams.set('fields[0]', 'title');
    url.searchParams.set('populate[images][fields][0]', 'id');
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

function classifyProduct(title) {
  if (GRAVEL_PREFIXES.some((prefix) => title.startsWith(prefix))) return 'Грунт';
  return 'Камни и коряги';
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
    throw new Error(`POST /upload/folders "${name}" failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
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

function findChildFolder(allFolders, parentPathId, name) {
  return allFolders.find((f) => {
    const parts = f.path.split('/').filter(Boolean);
    return Number(parts[parts.length - 2]) === parentPathId && f.name === name;
  }) ?? null;
}

// --- Main ---

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Strapi:  ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:    DRY RUN — no changes will be made');
  console.log('');

  // Find "Декорации"
  process.stdout.write(`Finding subcategory "${DECORATIONS_TITLE}"... `);
  const decorationsSubcat = await findSubcategory(DECORATIONS_TITLE, FISH_MAIN_CATEGORY_TITLE);
  if (!decorationsSubcat) throw new Error(`Subcategory "${DECORATIONS_TITLE}" not found.`);
  console.log(`id=${decorationsSubcat.id}`);

  // Find "Камни и коряги" and "Грунт", update their parent to Декорации
  const childSubcats = {};
  for (const child of CHILDREN) {
    process.stdout.write(`Finding subcategory "${child.title}"... `);
    const found = await findSubcategory(child.title, FISH_MAIN_CATEGORY_TITLE);
    if (!found) throw new Error(`Subcategory "${child.title}" not found.`);
    console.log(`id=${found.id}`);
    childSubcats[child.title] = found;

    if (dryRun) {
      console.log(`  [dry-run] Would set parent → "${DECORATIONS_TITLE}" (id=${decorationsSubcat.id})`);
    } else {
      process.stdout.write(`  Setting parent → "${DECORATIONS_TITLE}"... `);
      await updateSubcategoryParent(found.documentId, decorationsSubcat.id);
      console.log('done');
    }
  }
  console.log('');

  // Fetch products currently in "Декорации", classify them
  console.log(`Fetching products in "${DECORATIONS_TITLE}"...`);
  const decorationsProducts = await fetchProductsInSubcategory(DECORATIONS_TITLE);
  console.log(`Found ${decorationsProducts.length} product(s)\n`);

  const grouped = { 'Камни и коряги': [], 'Грунт': [] };
  for (const p of decorationsProducts) {
    const target = classifyProduct(p.title);
    grouped[target].push(p);
  }

  for (const [subcat, products] of Object.entries(grouped)) {
    console.log(`  → "${subcat}" (${products.length}):`);
    products.forEach((p) => console.log(`    [${(p.images ?? []).length} img] ${p.title}`));
  }
  console.log('');

  if (dryRun) {
    const totalImages = decorationsProducts.reduce((n, p) => n + (p.images ?? []).length, 0);
    console.log(`[dry-run] Would reassign ${decorationsProducts.length} products to their child subcategories`);
    console.log(`[dry-run] Would create folders: Рыбки/Декорації/Камни и коряги, Рыбки/Декорации/Грунт`);
    console.log(`[dry-run] Would move ${totalImages} image(s) to respective folders`);
    console.log('\nDry run complete. Run without --dry-run to apply.');
    return;
  }

  // Reassign products to child subcategories
  console.log('Reassigning products...');
  let updated = 0;
  let failed = 0;

  for (const mainCategoryId of [decorationsSubcat.mainCategory?.id]) {
    // fetch mainCategory id via decorationsSubcat — it may not be populated; look it up separately
  }

  // Get mainCategory id from one of the child subcats (already fetched, use its mainCategory)
  // Actually we need to fetch it — let's get it from the subcategory populate
  const mainCatRes = await fetchWithRetry(
    `${getStrapiBaseUrl()}/api/main-categories?filters[title][$eq]=${encodeURIComponent(FISH_MAIN_CATEGORY_TITLE)}&fields[0]=title`,
    { headers: apiHeaders() },
  );
  const mainCatJson = await mainCatRes.json();
  const fishMainCategoryId = mainCatJson.data?.[0]?.id;
  if (!fishMainCategoryId) throw new Error(`Main category "${FISH_MAIN_CATEGORY_TITLE}" not found.`);

  for (const [subcatTitle, products] of Object.entries(grouped)) {
    const subcat = childSubcats[subcatTitle];
    for (const product of products) {
      try {
        await updateProduct(product.documentId, subcat.id, fishMainCategoryId);
        console.log(`  [ok]   ${product.title}  → ${subcatTitle}`);
        updated++;
      } catch (err) {
        console.error(`  [fail] ${product.title}: ${err.message}`);
        failed++;
      }
    }
  }
  console.log(`\nProducts — updated: ${updated}  failed: ${failed}\n`);

  // Media library
  console.log('Authenticating as admin for media library...');
  const adminJwt = await getAdminJwt();
  console.log('OK\n');

  console.log('Fetching media folders...');
  let allFolders = await fetchAllFolders(adminJwt);

  const fishFolder = allFolders.find((f) => f.depth === 1 && f.name === FISH_MAIN_CATEGORY_TITLE);
  if (!fishFolder) throw new Error(`Media folder "${FISH_MAIN_CATEGORY_TITLE}" not found.`);
  console.log(`Folder "${FISH_MAIN_CATEGORY_TITLE}" (id=${fishFolder.id}, pathId=${fishFolder.pathId})`);

  let decorationsFolder = findChildFolder(allFolders, fishFolder.pathId, DECORATIONS_TITLE);
  if (!decorationsFolder) throw new Error(`Media folder "${FISH_MAIN_CATEGORY_TITLE}/${DECORATIONS_TITLE}" not found.`);
  console.log(`Folder "${FISH_MAIN_CATEGORY_TITLE}/${DECORATIONS_TITLE}" (id=${decorationsFolder.id}, pathId=${decorationsFolder.pathId})`);

  // Create child folders and move images
  for (const child of CHILDREN) {
    let folder = findChildFolder(allFolders, decorationsFolder.pathId, child.title);
    if (!folder) {
      process.stdout.write(`Creating folder "${DECORATIONS_TITLE}/${child.title}"... `);
      const created = await createFolder(adminJwt, child.title, decorationsFolder.id);
      folder = created;
      // refresh folder list to get pathId
      allFolders = await fetchAllFolders(adminJwt);
      folder = allFolders.find((f) => f.id === created.id);
      console.log(`id=${folder.id}`);
    } else {
      console.log(`Folder "${DECORATIONS_TITLE}/${child.title}" exists (id=${folder.id})`);
    }

    const products = grouped[child.title] ?? [];
    const imageIds = products.flatMap((p) => (p.images ?? []).map((img) => img.id));
    if (imageIds.length > 0) {
      process.stdout.write(`  Moving ${imageIds.length} image(s) → "${DECORATIONS_TITLE}/${child.title}"... `);
      await moveFiles(adminJwt, imageIds, folder.id);
      console.log('done');
    }
  }

  console.log(`\nDone.  Products updated: ${updated}  failed: ${failed}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
