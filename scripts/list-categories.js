#!/usr/bin/env node

'use strict';

// Prints the full category tree: main categories → subcategories → sub-subcategories.
//
// Usage:
//   node --env-file=.env scripts/list-categories.js
//
// Optional env:
//   STRAPI_BASE_URL  (default: http://localhost:1337)

function getStrapiBaseUrl() {
  const url = process.env.STRAPI_BASE_URL?.trim() || 'http://localhost:1337';
  return url.replace(/\/+$/, '');
}

function getHeaders() {
  const token = process.env.STRAPI_API_TOKEN?.trim();
  if (!token) {
    throw new Error('STRAPI_API_TOKEN is required.');
  }
  return { Authorization: `Bearer ${token}` };
}

async function fetchAll(endpoint, params = {}) {
  const url = new URL(`${getStrapiBaseUrl()}/api/${endpoint}`);
  url.searchParams.set('pagination[limit]', '200');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString(), { headers: getHeaders() });
  if (!res.ok) throw new Error(`GET /api/${endpoint} failed: HTTP ${res.status}`);
  const json = await res.json();
  return json.data ?? [];
}

async function run() {
  const [mainCategories, subcategories] = await Promise.all([
    fetchAll('main-categories', { 'fields[0]': 'title', 'sort': 'sortOrder:asc' }),
    fetchAll('subcategories', {
      'fields[0]': 'title',
      'populate[parent][fields][0]': 'title',
      'sort': 'sortOrder:asc',
    }),
  ]);

  // Group subcategories by parent documentId (null = top-level under main category)
  const byParentId = new Map();
  for (const sub of subcategories) {
    const parentId = sub.parent?.documentId ?? null;
    if (!byParentId.has(parentId)) byParentId.set(parentId, []);
    byParentId.get(parentId).push(sub);
  }

  function printChildren(parentDocumentId, indent) {
    const children = byParentId.get(parentDocumentId) ?? [];
    for (const child of children) {
      console.log(`${indent}${child.title}`);
      printChildren(child.documentId, indent + '    ');
    }
  }

  // Top-level subcategories (no parent) are not tied to a main category in the schema,
  // so we print main categories first, then their subcategories by matching title context.
  // Since the schema has mainCategory on Product (not on Subcategory), we just print
  // the full subcategory tree grouped by parent.

  console.log('Main categories:');
  for (const mc of mainCategories) {
    console.log(`  ${mc.title}`);
  }

  console.log('');
  console.log('Subcategory tree:');

  // Print roots (no parent)
  const roots = byParentId.get(null) ?? [];
  for (const root of roots) {
    console.log(`  ${root.title}`);
    printChildren(root.documentId, '      ');
  }
}

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
