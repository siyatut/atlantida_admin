#!/usr/bin/env node

'use strict';

// Assigns images from Strapi media library to food products
// in "Сухие корма в упаковке" and "Сухие корма на развес" subcategories.
//
// Matching rule: image filename (without extension) must match the START of a product title.
// Example: "Tetra ReptoMin Junior.jpg" → "Tetra ReptoMin Junior 100 мл", "250 мл", "500 мл"
// Example: "Tetra Chips Pro Algae.jpg" → "Tetra Chips Pro Algae 30 гр" only
//
// Usage:
//   node --env-file=.env scripts/assign-food-images.js [--dry-run]
//
// Always run with --dry-run first to verify matches before applying changes.

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const PAGE_SIZE = 100;

const TARGET_SUBCATEGORY_IDS = [
  's42ndebgm94aqeq1jfusnnc3', // Сухие корма в упаковке
  'bldac6pzbixx3tz979j42ygw', // Сухие корма на развес
];

function getStrapiBaseUrl() {
  return (process.env.STRAPI_BASE_URL?.trim() || 'http://localhost:1337').replace(/\/+$/, '');
}

function getToken() {
  const token = process.env.STRAPI_API_TOKEN?.trim();
  if (!token) throw new Error('STRAPI_API_TOKEN is required.');
  return token;
}

function getJsonHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` };
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
        console.warn(`  [retry ${attempt}] retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

async function fetchAllFoodProducts() {
  const products = [];
  for (const subcatId of TARGET_SUBCATEGORY_IDS) {
    let page = 1;
    while (true) {
      const url = new URL(`${getStrapiBaseUrl()}/api/products`);
      url.searchParams.set('filters[subcategories][documentId][$eq]', subcatId);
      url.searchParams.set('fields[0]', 'title');
      url.searchParams.set('populate[images][fields][0]', 'id');
      url.searchParams.set('pagination[page]', String(page));
      url.searchParams.set('pagination[pageSize]', String(PAGE_SIZE));

      const res = await fetchWithRetry(url.toString(), { headers: getAuthHeaders() });
      if (!res.ok) throw new Error(`GET /api/products failed: HTTP ${res.status}`);
      const json = await res.json();
      for (const p of json.data ?? []) {
        products.push({
          documentId: p.documentId,
          title: p.title,
          hasImage: (p.images?.length ?? 0) > 0,
        });
      }
      const { pageCount } = json.meta?.pagination ?? {};
      if (page >= (pageCount ?? 1)) break;
      page++;
    }
  }
  return products;
}

async function fetchAllImages() {
  const images = [];
  let page = 1;
  while (true) {
    const url = new URL(`${getStrapiBaseUrl()}/api/upload/files`);
    url.searchParams.set('pagination[page]', String(page));
    url.searchParams.set('pagination[pageSize]', String(PAGE_SIZE));
    url.searchParams.set('sort', 'createdAt:desc');

    const res = await fetchWithRetry(url.toString(), { headers: getAuthHeaders() });
    if (!res.ok) throw new Error(`GET /api/upload/files failed: HTTP ${res.status}`);
    const json = await res.json();

    const items = Array.isArray(json) ? json : (json.results ?? json.data ?? []);
    for (const f of items) {
      const ext = f.ext ?? '';
      const nameWithExt = f.name ?? '';
      const name = nameWithExt.endsWith(ext)
        ? nameWithExt.slice(0, -ext.length).trim()
        : nameWithExt.trim();
      images.push({ id: f.id, name, ext });
    }

    if (Array.isArray(json) || items.length < PAGE_SIZE) break;
    const total = json.pagination?.total ?? json.meta?.pagination?.total ?? 0;
    if (images.length >= total) break;
    page++;
  }
  return images;
}

async function updateProductImage(documentId, imageId) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/products/${documentId}`, {
    method: 'PUT',
    headers: getJsonHeaders(),
    body: JSON.stringify({ data: { images: [imageId] } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Strapi:  ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:    DRY RUN — no changes will be made');
  console.log('');

  console.log('Fetching food products from target subcategories...');
  const products = await fetchAllFoodProducts();
  console.log(`Found:   ${products.length} product(s)\n`);

  console.log('Fetching images from media library...');
  const images = await fetchAllImages();
  console.log(`Found:   ${images.length} image(s)\n`);

  // For each product, pick the image with the longest matching keyword (most specific wins).
  // Among images with equal keyword length, the first in the list wins (sorted by createdAt:desc → newest first).
  const productToImage = new Map();
  for (const product of products) {
    const titleLower = product.title.toLowerCase();
    let bestImage = null;
    let bestLen = 0;
    for (const image of images) {
      const kw = image.name.toLowerCase();
      if (titleLower.startsWith(kw) && kw.length > bestLen) {
        bestLen = kw.length;
        bestImage = image;
      }
    }
    if (bestImage) productToImage.set(product.documentId, bestImage);
  }

  // Group by image for output.
  const imageToProducts = new Map();
  for (const product of products) {
    const image = productToImage.get(product.documentId);
    if (!image) continue;
    if (!imageToProducts.has(image.id)) imageToProducts.set(image.id, { image, products: [] });
    imageToProducts.get(image.id).products.push(product);
  }

  if (imageToProducts.size === 0) {
    console.log('─'.repeat(50));
    console.log('No matches found.');
    console.log('Check that image filenames match the start of product titles.');
    console.log('Example: "Tetra ReptoMin Junior.jpg" → "Tetra ReptoMin Junior 100 мл"');
    return;
  }

  let updated = 0;
  let failed = 0;

  for (const { image, products: matching } of imageToProducts.values()) {
    console.log(`"${image.name}${image.ext}"  →  ${matching.length} product(s):`);
    for (const product of matching) {
      const tag = product.hasImage ? '[has image]' : '[no image] ';
      console.log(`  ${tag}  ${product.title}`);
    }

    if (!dryRun) {
      for (const product of matching) {
        try {
          await updateProductImage(product.documentId, image.id);
          updated++;
        } catch (err) {
          failed++;
          console.error(`  [failed]  ${product.title}: ${err.message}`);
        }
      }
    }
    console.log('');
  }

  console.log('─'.repeat(50));
  const totalMatched = [...imageToProducts.values()].reduce((s, { products: p }) => s + p.length, 0);
  if (dryRun) {
    console.log(`Dry run complete. ${imageToProducts.size} image(s) matched ${totalMatched} product(s).`);
  } else {
    console.log(`Done.  Updated: ${updated}  Failed: ${failed}`);
  }
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
