#!/usr/bin/env node

'use strict';

// Creates the "Декорации" subcategory under "Рыбки" and three child subcategories
// inside it ("Декор керамический", "Декор пластиковый", "Искусственные растения").
// Moves all products from "Камни и коряги" and "Грунт" into "Декорации".
// In the media library, creates a "Рыбки/Декорации" folder with three sub-folders
// for the child subcategories, then moves product images into "Рыбки/Декорации".
//
// Usage:
//   node --env-file=.env scripts/migrate-decorations-subcategory.js [--dry-run]

const FISH_MAIN_CATEGORY_TITLE = 'Рыбки';

const DECORATIONS = {
  title: 'Декорации',
  slug: 'dekoracii',
};

const CHILD_SUBCATEGORIES = [
  { title: 'Декор керамический', slug: 'dekor-keramicheskij' },
  { title: 'Декор пластиковый',  slug: 'dekor-plastikovyj'  },
  { title: 'Искусственные растения', slug: 'iskusstvennye-rasteniya' },
];

const SOURCE_SUBCATEGORIES = ['Камни и коряги', 'Грунт'];

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

async function createSubcategory(title, slug, mainCategoryId, parentId = null) {
  const data = { title, slug, mainCategory: mainCategoryId };
  if (parentId !== null) data.parent = parentId;
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/subcategories`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({ data }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/subcategories failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  return (await res.json()).data;
}

async function fetchProductsBySubcategory(subcategoryTitle) {
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
    const directParentPathId = Number(parts[parts.length - 2]);
    return directParentPathId === parentPathId && f.name === name;
  }) ?? null;
}

// --- Main ---

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Strapi:  ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:    DRY RUN — no changes will be made');
  console.log('');

  // 1. Find "Рыбки"
  process.stdout.write(`Finding main category "${FISH_MAIN_CATEGORY_TITLE}"... `);
  const fishCategory = await findMainCategory(FISH_MAIN_CATEGORY_TITLE);
  if (!fishCategory) throw new Error(`Main category "${FISH_MAIN_CATEGORY_TITLE}" not found.`);
  console.log(`id=${fishCategory.id}`);

  // 2. Find or create "Декорации"
  process.stdout.write(`Finding subcategory "${DECORATIONS.title}"... `);
  let decorationsSubcat = await findSubcategory(DECORATIONS.title, FISH_MAIN_CATEGORY_TITLE);
  if (decorationsSubcat) {
    console.log(`id=${decorationsSubcat.id} (exists)`);
  } else if (dryRun) {
    console.log(`not found — [dry-run] would create it`);
  } else {
    console.log('not found — creating...');
    decorationsSubcat = await createSubcategory(DECORATIONS.title, DECORATIONS.slug, fishCategory.id, null);
    console.log(`Created "${DECORATIONS.title}" id=${decorationsSubcat.id}`);
  }

  // 3. Find or create child subcategories
  const childSubcats = [];
  for (const child of CHILD_SUBCATEGORIES) {
    process.stdout.write(`Finding subcategory "${child.title}"... `);
    let found = await findSubcategory(child.title, FISH_MAIN_CATEGORY_TITLE);
    if (found) {
      console.log(`id=${found.id} (exists)`);
      childSubcats.push(found);
    } else if (dryRun) {
      console.log(`not found — [dry-run] would create inside "${DECORATIONS.title}"`);
    } else {
      console.log(`not found — creating inside "${DECORATIONS.title}"...`);
      const created = await createSubcategory(child.title, child.slug, fishCategory.id, decorationsSubcat.id);
      console.log(`Created "${child.title}" id=${created.id}`);
      childSubcats.push(created);
    }
  }
  console.log('');

  // 4. Collect products from source subcategories
  console.log('Collecting products from source subcategories...');
  const allProducts = [];
  for (const sourceName of SOURCE_SUBCATEGORIES) {
    const products = await fetchProductsBySubcategory(sourceName);
    console.log(`  "${sourceName}": ${products.length} product(s)`);
    for (const p of products) {
      console.log(`    [${(p.images ?? []).length} img] ${p.title}`);
      allProducts.push(p);
    }
  }
  console.log(`\nTotal: ${allProducts.length} products\n`);

  if (allProducts.length === 0) {
    console.log('No products to move. Will still create folders.');
  }

  const imageIds = allProducts.flatMap((p) => (p.images ?? []).map((img) => img.id));
  console.log(`Total images to move: ${imageIds.length}\n`);

  if (dryRun) {
    console.log(`[dry-run] Would move ${allProducts.length} products → subcategory "${DECORATIONS.title}"`);
    console.log(`[dry-run] Would create media folders: Рыбки/Декорации + 3 child folders`);
    console.log(`[dry-run] Would move ${imageIds.length} image(s) → "Рыбки/Декорации"`);
    console.log('\nDry run complete. Run without --dry-run to apply.');
    return;
  }

  // 5. Update products
  if (allProducts.length > 0) {
    console.log('Updating products...');
    let updated = 0;
    let failed = 0;
    for (const product of allProducts) {
      try {
        await updateProduct(product.documentId, decorationsSubcat.id, fishCategory.id);
        console.log(`  [ok]   ${product.title}`);
        updated++;
      } catch (err) {
        console.error(`  [fail] ${product.title}: ${err.message}`);
        failed++;
      }
    }
    console.log(`\nProducts — updated: ${updated}  failed: ${failed}\n`);
  }

  // 6. Media library
  console.log('Authenticating as admin for media library...');
  const adminJwt = await getAdminJwt();
  console.log('OK\n');

  console.log('Fetching media folders...');
  let allFolders = await fetchAllFolders(adminJwt);
  console.log(`Found ${allFolders.length} folder(s)\n`);

  // Find or create "Рыбки" root folder
  let fishFolder = allFolders.find((f) => f.depth === 1 && f.name === FISH_MAIN_CATEGORY_TITLE);
  if (!fishFolder) {
    process.stdout.write(`Creating root folder "${FISH_MAIN_CATEGORY_TITLE}"... `);
    const created = await createFolder(adminJwt, FISH_MAIN_CATEGORY_TITLE, null);
    fishFolder = { ...created, name: FISH_MAIN_CATEGORY_TITLE, depth: 1 };
    console.log(`id=${fishFolder.id}`);
  } else {
    console.log(`Folder "${FISH_MAIN_CATEGORY_TITLE}" exists (id=${fishFolder.id}, pathId=${fishFolder.pathId})`);
  }

  // Find or create "Декорации" inside "Рыбки"
  let decorationsFolder = findChildFolder(allFolders, fishFolder.pathId, DECORATIONS.title);
  if (!decorationsFolder) {
    process.stdout.write(`Creating folder "Рыбки/${DECORATIONS.title}"... `);
    const created = await createFolder(adminJwt, DECORATIONS.title, fishFolder.id);
    decorationsFolder = { ...created, name: DECORATIONS.title };
    console.log(`id=${decorationsFolder.id}`);
    // Re-fetch folders so child lookups work with updated pathIds
    allFolders = await fetchAllFolders(adminJwt);
    decorationsFolder = allFolders.find((f) => f.id === decorationsFolder.id);
  } else {
    console.log(`Folder "Рыбки/${DECORATIONS.title}" exists (id=${decorationsFolder.id}, pathId=${decorationsFolder.pathId})`);
  }

  // Find or create child folders inside "Декорации"
  for (const child of CHILD_SUBCATEGORIES) {
    const existing = findChildFolder(allFolders, decorationsFolder.pathId, child.title);
    if (!existing) {
      process.stdout.write(`Creating folder "Рыбки/${DECORATIONS.title}/${child.title}"... `);
      const created = await createFolder(adminJwt, child.title, decorationsFolder.id);
      console.log(`id=${created.id}`);
    } else {
      console.log(`Folder "Рыбки/${DECORATIONS.title}/${child.title}" exists (id=${existing.id})`);
    }
  }

  // Move images to "Рыбки/Декорации"
  if (imageIds.length > 0) {
    process.stdout.write(`\nMoving ${imageIds.length} image(s) to "Рыбки/${DECORATIONS.title}"... `);
    await moveFiles(adminJwt, imageIds, decorationsFolder.id);
    console.log('done');
  }

  console.log(`\nDone.  Products updated: ${allProducts.length}  Images moved: ${imageIds.length}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
