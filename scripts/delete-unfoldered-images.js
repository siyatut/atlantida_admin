#!/usr/bin/env node

'use strict';

// Deletes all images from Strapi media library that are not in any folder.
// These are typically orphaned files not linked to any product.
//
// Usage:
//   node --env-file=.env scripts/delete-unfoldered-images.js [--dry-run]

const PAGE_SIZE = 100;
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

async function fetchUnfolderedFiles(adminJwt) {
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
    files.push(...items.filter((f) => f.folder === null).map((f) => ({ id: f.id, name: f.name, ext: f.ext ?? '' })));
    const total = json.pagination?.total ?? 0;
    if (items.length < PAGE_SIZE || page * PAGE_SIZE >= total) break;
    page++;
  }
  return files;
}

async function bulkDelete(adminJwt, fileIds) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/upload/actions/bulk-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt}` },
    body: JSON.stringify({ fileIds }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`bulk-delete failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Strapi:  ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:    DRY RUN — nothing will be deleted');
  console.log('');

  console.log('Authenticating as admin...');
  const adminJwt = await getAdminJwt();
  console.log('OK\n');

  console.log('Fetching unfoldered files...');
  const files = await fetchUnfolderedFiles(adminJwt);
  console.log(`Found: ${files.length} file(s)\n`);

  if (files.length === 0) {
    console.log('Nothing to delete.');
    return;
  }

  files.forEach((f) => console.log(`  ${f.id}  ${f.name}${f.ext}`));
  console.log('');

  if (dryRun) {
    console.log(`Dry run complete. Would delete ${files.length} file(s).`);
    return;
  }

  // Delete in batches of 100.
  const ids = files.map((f) => f.id);
  for (let i = 0; i < ids.length; i += PAGE_SIZE) {
    const batch = ids.slice(i, i + PAGE_SIZE);
    process.stdout.write(`Deleting ${batch.length} file(s)... `);
    await bulkDelete(adminJwt, batch);
    console.log('done');
  }

  console.log(`\nDone. Deleted: ${ids.length}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
