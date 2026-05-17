#!/usr/bin/env node

'use strict';

// Downloads all images from a specific Strapi media library folder to a local directory.
//
// Usage:
//   node --env-file=.env scripts/download-folder-images.js "Аквариумные рыбки"
//   node --env-file=.env scripts/download-folder-images.js "Аквариумные рыбки" --out ./downloads
//   node --env-file=.env scripts/download-folder-images.js "Аквариумные рыбки" --rename
//
// --rename: name each file after the product title instead of the original filename.

const fs = require('fs');
const path = require('path');

const FOLDER_NAME = process.argv[2];
if (!FOLDER_NAME) {
  console.error('Usage: node scripts/download-folder-images.js <folder-name> [--out <dir>] [--rename]');
  process.exit(1);
}

const outArgIdx = process.argv.indexOf('--out');
const OUT_DIR = outArgIdx !== -1 ? process.argv[outArgIdx + 1] : `./${FOLDER_NAME}`;
const RENAME = process.argv.includes('--rename');

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

// Strips characters not allowed in filenames (macOS/Windows safe).
function sanitizeFilename(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim();
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

async function findFolder(adminJwt, name) {
  const res = await fetchWithRetry(
    `${getStrapiBaseUrl()}/upload/folders?pagination[pageSize]=200`,
    { headers: { Authorization: `Bearer ${adminJwt}` } },
  );
  const json = await res.json();
  return (json.data ?? []).find((f) => f.name === name) ?? null;
}

async function fetchFilesInFolder(adminJwt, folderId) {
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
    files.push(
      ...items
        .filter((f) => f.folder?.id === folderId)
        .map((f) => ({ id: f.id, name: f.name ?? String(f.id), ext: f.ext ?? '', url: f.url })),
    );
    const total = json.pagination?.total ?? 0;
    if (items.length < PAGE_SIZE || page * PAGE_SIZE >= total) break;
    page++;
  }
  return files;
}

// Returns Map: imageId → product title
async function fetchImageToTitleMap() {
  const map = new Map();
  let page = 1;
  while (true) {
    const url = new URL(`${getStrapiBaseUrl()}/api/products`);
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
      for (const image of product.images ?? []) {
        if (!map.has(image.id)) map.set(image.id, product.title);
      }
    }

    const { pageCount } = json.meta?.pagination ?? {};
    if (page >= (pageCount ?? 1)) break;
    page++;
  }
  return map;
}

async function downloadFile(url, destPath) {
  const fullUrl = url.startsWith('http') ? url : `${getStrapiBaseUrl()}${url}`;
  const res = await fetchWithRetry(fullUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

async function run() {
  console.log(`Strapi:   ${getStrapiBaseUrl()}`);
  console.log(`Folder:   ${FOLDER_NAME}`);
  console.log(`Save to:  ${path.resolve(OUT_DIR)}`);
  console.log(`Rename:   ${RENAME ? 'by product title' : 'original filename'}\n`);

  console.log('Authenticating...');
  const adminJwt = await getAdminJwt();
  console.log('OK\n');

  console.log(`Looking for folder "${FOLDER_NAME}"...`);
  const folder = await findFolder(adminJwt, FOLDER_NAME);
  if (!folder) throw new Error(`Folder "${FOLDER_NAME}" not found in media library.`);
  console.log(`Found (id=${folder.id}, files=${folder.files?.count ?? '?'})\n`);

  console.log('Fetching file list...');
  const files = await fetchFilesInFolder(adminJwt, folder.id);
  console.log(`Found ${files.length} file(s)\n`);

  if (files.length === 0) {
    console.log('Nothing to download.');
    return;
  }

  let imageToTitle = new Map();
  if (RENAME) {
    console.log('Fetching product titles...');
    imageToTitle = await fetchImageToTitleMap();
    console.log(`Matched ${files.filter((f) => imageToTitle.has(f.id)).length}/${files.length} files to products\n`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Track used filenames to avoid collisions when multiple products share an image.
  const usedNames = new Map();

  let downloaded = 0;
  let failed = 0;

  for (const file of files) {
    let filename;
    if (RENAME) {
      const title = imageToTitle.get(file.id);
      const base = sanitizeFilename(title ?? file.name);
      const ext = file.ext || path.extname(file.name);
      const count = usedNames.get(base) ?? 0;
      usedNames.set(base, count + 1);
      filename = count === 0 ? `${base}${ext}` : `${base} (${count})${ext}`;
    } else {
      filename = file.name;
    }

    const destPath = path.join(OUT_DIR, filename);
    process.stdout.write(`  ${filename}... `);
    try {
      await downloadFile(file.url, destPath);
      downloaded++;
      console.log('done');
    } catch (err) {
      failed++;
      console.error(`FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone.  Downloaded: ${downloaded}  Failed: ${failed}`);
  console.log(`Saved to: ${path.resolve(OUT_DIR)}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
