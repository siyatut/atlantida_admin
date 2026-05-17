#!/usr/bin/env node

'use strict';

// Uploads images from a local directory to a Strapi media library folder,
// then assigns each image to the matching product by filename (without extension).
//
// Usage:
//   node --env-file=.env scripts/upload-and-assign-images.js <local-dir> "<strapi-folder-name>" [--only "File1.jpg,File2.png"] [--dry-run]
//
// --only: comma-separated list of filenames to process (skips all others)
//
// Example:
//   node --env-file=.env scripts/upload-and-assign-images.js ./images/"Аквариумные рыбки" "Аквариумные рыбки"
//   node --env-file=.env scripts/upload-and-assign-images.js ./images/"Аквариумные рыбки" "Аквариумные рыбки" --only "Телескоп ситцевый.jpg,Телескоп чёрный.jpg"

const fs = require('fs');
const path = require('path');

const LOCAL_DIR = process.argv[2];
const FOLDER_NAME = process.argv[3];

if (!LOCAL_DIR || !FOLDER_NAME) {
  console.error('Usage: node scripts/upload-and-assign-images.js <local-dir> "<strapi-folder-name>" [--only "file1,file2"] [--dry-run]');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');
const onlyArgIdx = process.argv.indexOf('--only');
const ONLY_FILES = onlyArgIdx !== -1
  ? new Set(process.argv[onlyArgIdx + 1].split(',').map((f) => f.trim().normalize('NFC')))
  : null;
const PAGE_SIZE = 100;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

const SUPPORTED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

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

async function findTargetFolder(adminJwt, name) {
  const res = await fetchWithRetry(
    `${getStrapiBaseUrl()}/upload/folders?pagination[pageSize]=200`,
    { headers: { Authorization: `Bearer ${adminJwt}` } },
  );
  const json = await res.json();
  const folders = json.data ?? [];

  // Build pathId → name for parent lookup
  const nameByPathId = new Map(folders.map((f) => [f.pathId, f.name]));

  // Prefer a depth-2 folder (nested) named `name`; fall back to any match
  const depth2 = folders.find((f) => {
    const parts = f.path.split('/').filter(Boolean);
    return f.name === name && parts.length === 2;
  });
  if (depth2) return depth2;
  return folders.find((f) => f.name === name) ?? null;
}

const normalize = (s) => s.normalize('NFC').trim().toLowerCase();

// Returns Map: productTitle (normalized) → { documentId, hasImage }
async function fetchProductMap() {
  const map = new Map();
  let page = 1;
  while (true) {
    const url = new URL(`${getStrapiBaseUrl()}/api/products`);
    url.searchParams.set('fields[0]', 'title');
    url.searchParams.set('populate[images][fields][0]', 'id');
    url.searchParams.set('pagination[page]', String(page));
    url.searchParams.set('pagination[pageSize]', String(PAGE_SIZE));

    const res = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Bearer ${getApiToken()}` },
    });
    if (!res.ok) throw new Error(`GET /api/products failed: HTTP ${res.status}`);
    const json = await res.json();

    for (const p of json.data ?? []) {
      map.set(normalize(p.title), {
        documentId: p.documentId,
        title: p.title,
        hasImage: (p.images?.length ?? 0) > 0,
      });
    }

    const { pageCount } = json.meta?.pagination ?? {};
    if (page >= (pageCount ?? 1)) break;
    page++;
  }
  return map;
}

async function uploadFile(fileBuffer, filename, mimeType) {
  const formData = new FormData();
  formData.append('files', new Blob([fileBuffer], { type: mimeType }), filename);

  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiToken()}` },
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const uploaded = Array.isArray(json) ? json[0] : json;
  return uploaded?.id ?? null;
}

async function moveFilesToFolder(adminJwt, fileIds, destinationFolderId) {
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

async function assignImageToProduct(documentId, imageId) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/products/${documentId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiToken()}`,
    },
    body: JSON.stringify({ data: { images: [imageId] } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT /api/products/${documentId} failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

async function run() {
  console.log(`Strapi:     ${getStrapiBaseUrl()}`);
  console.log(`Local dir:  ${path.resolve(LOCAL_DIR)}`);
  console.log(`Folder:     ${FOLDER_NAME}`);
  if (DRY_RUN) console.log('Mode:       DRY RUN — no changes will be made');
  console.log('');

  // Read local image files
  const allFiles = fs.readdirSync(LOCAL_DIR);
  const imageFiles = allFiles
    .filter((f) => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
    .filter((f) => !ONLY_FILES || ONLY_FILES.has(f.normalize('NFC')))
    .map((f) => ({
      filename: f,
      title: path.basename(f, path.extname(f)),
      ext: path.extname(f).toLowerCase(),
      fullPath: path.join(LOCAL_DIR, f),
    }));

  console.log(`Found ${imageFiles.length} image(s) in local directory\n`);

  if (imageFiles.length === 0) {
    console.log('Nothing to upload.');
    return;
  }

  console.log('Authenticating...');
  const adminJwt = await getAdminJwt();
  console.log('OK\n');

  console.log(`Looking for Strapi folder "${FOLDER_NAME}"...`);
  const folder = await findTargetFolder(adminJwt, FOLDER_NAME);
  if (!folder) throw new Error(`Folder "${FOLDER_NAME}" not found in media library.`);
  console.log(`Found (id=${folder.id})\n`);

  console.log('Fetching products...');
  const productMap = await fetchProductMap();
  console.log(`Found ${productMap.size} product(s)\n`);

  // Match files to products
  const matched = [];
  const noMatch = [];

  for (const file of imageFiles) {
    const product = productMap.get(normalize(file.title));
    if (product) {
      matched.push({ file, product });
    } else {
      noMatch.push(file);
    }
  }

  console.log(`Matched:    ${matched.length} file(s)`);
  console.log(`No match:   ${noMatch.length} file(s)`);
  if (noMatch.length > 0) {
    noMatch.forEach(({ filename }) => console.log(`  — "${filename}"`));
  }
  console.log('');

  if (matched.length === 0) {
    console.log('Nothing to upload.');
    return;
  }

  console.log('Plan:');
  for (const { file, product } of matched) {
    const tag = product.hasImage ? '[replace]' : '[new]    ';
    console.log(`  ${tag}  "${file.filename}"  →  ${product.title}`);
  }
  console.log('');

  if (DRY_RUN) {
    console.log('Dry run complete. Run without --dry-run to apply.');
    return;
  }

  let uploaded = 0;
  let assigned = 0;
  let failed = 0;
  const uploadedIds = [];

  for (const { file, product } of matched) {
    process.stdout.write(`Uploading "${file.filename}"... `);
    let imageId;
    try {
      const buffer = fs.readFileSync(file.fullPath);
      const mimeType = MIME_TYPES[file.ext] ?? 'application/octet-stream';
      imageId = await uploadFile(buffer, file.filename, mimeType);
      uploadedIds.push(imageId);
      uploaded++;
      console.log(`done (id=${imageId})`);
    } catch (err) {
      failed++;
      console.error(`FAILED: ${err.message}`);
      continue;
    }

    process.stdout.write(`  Assigning to "${product.title}"... `);
    try {
      await assignImageToProduct(product.documentId, imageId);
      assigned++;
      console.log('done');
    } catch (err) {
      failed++;
      console.error(`FAILED: ${err.message}`);
    }
  }

  // Move all uploaded files to the target folder in one request.
  if (uploadedIds.length > 0) {
    process.stdout.write(`\nMoving ${uploadedIds.length} file(s) to "${FOLDER_NAME}"... `);
    try {
      await moveFilesToFolder(adminJwt, uploadedIds, folder.id);
      console.log('done');
    } catch (err) {
      console.error(`FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone.  Uploaded: ${uploaded}  Assigned: ${assigned}  Failed: ${failed}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
