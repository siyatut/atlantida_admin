#!/usr/bin/env node

'use strict';

const WOO_CATEGORIES_PATH = '/wp-json/wc/store/v1/products/categories';
const TARGET_CATEGORY_IDS = [30, 58, 64, 69, 84, 77];

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '');
}

function getWooCategoriesUrl() {
  const wooBaseUrl = process.env.WOO_BASE_URL?.trim();

  if (!wooBaseUrl) {
    throw new Error(
      'Missing WOO_BASE_URL. Example: WOO_BASE_URL=https://your-woo-store.example npm run debug:woo:categories'
    );
  }

  return `${normalizeBaseUrl(wooBaseUrl)}${WOO_CATEGORIES_PATH}`;
}

async function fetchWooCategories() {
  const url = getWooCategoriesUrl();

  console.log('Fetching WooCommerce categories...');
  console.log(`[source] ${url}`);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`WooCommerce request failed with ${response.status} ${response.statusText}.`);
  }

  const payload = await response.json();

  if (!Array.isArray(payload)) {
    throw new Error('WooCommerce categories response is not an array.');
  }

  return payload;
}

function printCategory(categoryId, category) {
  console.log(`Category ${categoryId}`);

  if (!category) {
    console.log('id: not found');
    console.log('');
    return;
  }

  console.log(`id: ${category.id}`);
  console.log(`name: ${category.name}`);
  console.log(`slug: ${category.slug}`);
  console.log(`parent: ${category.parent ?? 0}`);
  console.log(`count: ${category.count ?? 0}`);
  console.log('');
}

async function run() {
  const categories = await fetchWooCategories();
  const categoriesById = new Map(categories.map((category) => [category.id, category]));

  console.log(`Fetched ${categories.length} categories total`);
  console.log('');

  for (const categoryId of TARGET_CATEGORY_IDS) {
    printCategory(categoryId, categoriesById.get(categoryId));
  }
}

run().catch((error) => {
  console.error('WooCommerce category debug failed.');
  console.error(error);
  process.exitCode = 1;
});
