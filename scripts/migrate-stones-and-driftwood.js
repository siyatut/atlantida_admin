#!/usr/bin/env node

'use strict';

// Deletes outdated products from «Камни и коряги» and creates new ones
// with updated titles, prices and descriptions.
//
// Usage:
//   node --env-file=.env scripts/migrate-stones-and-driftwood.js [--dry-run]

const SUBCATEGORY_ID = 40; // Камни и коряги
const MAIN_CATEGORY_ID = 1; // Рыбки

const TITLES_TO_DELETE = [
  'Вулканическая лава',
  'Песчаник',
  'Камень дракона',
  'Коряга мопани',
];

const NEW_PRODUCTS = [
  // --- Коряги ---
  {
    title: 'Мангровая коряга',
    slug: 'mangrove-koryaga',
    price: 2800,
    description: '<p>Мангровая коряга из мангровых пород дерева для оформления аквариума. Создаёт укрытия и природный вид подводного ландшафта. Цена — 2800 ₽ за 1 кг.</p>',
  },
  {
    title: 'Коряга мопани',
    slug: 'koryaga-mopani',
    price: 200,
    description: '<p>Коряга мопани из африканского дерева — плотная и долговечная. Тонет без предварительного вымачивания быстрее большинства коряг. Создаёт укрытия и украшает аквариум. Цена — от 200 ₽ за штуку.</p>',
  },
  {
    title: 'Коряга Сакура',
    slug: 'koryaga-sakura',
    price: 3000,
    description: '<p>Ветвистая декоративная коряга с тонкой фактурой веток. Создаёт изящный природный вид, подходит для нано-аквариумов и крупных композиций. Цена — 3000 ₽ за 1 кг.</p>',
  },
  // --- Камни ---
  {
    title: 'Камень Зебра',
    slug: 'kamen-zebra',
    price: 550,
    description: '<p>Природный камень с характерным полосатым рисунком светлых и тёмных оттенков. Подходит для оформления в стиле природного биотопа. Цена — 550 ₽ за 1 кг.</p>',
  },
  {
    title: 'Окаменелое дерево',
    slug: 'okamenelee-derevo',
    price: 550,
    description: '<p>Природный камень, образовавшийся в результате минерализации древесины. Сохраняет структуру дерева, создаёт эффектный природный декор. Химически нейтрален. Цена — 550 ₽ за 1 кг.</p>',
  },
  {
    title: 'Камень Тантазия светло-серый',
    slug: 'kamen-tantaziya-svetlo-seryj',
    price: 550,
    description: '<p>Декоративный природный камень мягких серых оттенков. Хорошо сочетается с тёмным грунтом и зелёными растениями. Цена — 550 ₽ за 1 кг.</p>',
  },
  {
    title: 'Песчаник Песчаная буря',
    slug: 'peshchanik-peschanaya-burya',
    price: 550,
    description: '<p>Природный пористый камень тёплых песчаных оттенков. Создаёт атмосферу пустынного биотопа в аквариуме. Цена — 550 ₽ за 1 кг.</p>',
  },
  {
    title: 'Камень дракона 20–30 см',
    slug: 'kamen-drakona-20-30-sm',
    price: 550,
    description: '<p>Природный камень с угловатой формой и рельефной поверхностью. Фракция 20–30 см подходит для создания объёмных скальных композиций. Цена — 550 ₽ за 1 кг.</p>',
  },
  {
    title: 'Вулканическая лава',
    slug: 'vulkanicheskaya-lava',
    price: 550,
    description: '<p>Пористый камень вулканического происхождения. Пористая структура служит субстратом для полезных бактерий, работая одновременно как украшение и элемент биофильтрации. Цена — 550 ₽ за 1 кг.</p>',
  },
  {
    title: 'Песчаник пещеристый',
    slug: 'peshchanik-peshcheristyj',
    price: 180,
    description: '<p>Природный камень с пористой ноздреватой структурой. Создаёт натуральный вид скал и пещер в аквариуме. Цена — 180 ₽ за 1 кг.</p>',
  },
];

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
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${getApiToken()}` };
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try { return await fetch(url, options); } catch (err) {
      lastError = err;
      if (attempt < RETRY_ATTEMPTS) { await sleep(RETRY_DELAY_MS); }
    }
  }
  throw lastError;
}

async function fetchProductsToDelete() {
  const results = [];
  for (const title of TITLES_TO_DELETE) {
    const url = new URL(`${getStrapiBaseUrl()}/api/products`);
    url.searchParams.set('filters[title][$eq]', title);
    url.searchParams.set('filters[subcategories][id][$eq]', String(SUBCATEGORY_ID));
    url.searchParams.set('fields[0]', 'title');
    url.searchParams.set('pagination[pageSize]', String(PAGE_SIZE));
    const res = await fetchWithRetry(url.toString(), { headers: apiHeaders() });
    const json = await res.json();
    for (const p of json.data ?? []) results.push(p);
  }
  return results;
}

async function deleteProduct(documentId) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/products/${documentId}`, {
    method: 'DELETE', headers: apiHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DELETE failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

async function createProduct(product) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/products`, {
    method: 'POST', headers: apiHeaders(),
    body: JSON.stringify({ data: {
      title: product.title, slug: product.slug, price: product.price,
      description: product.description, inStock: true, isActive: true,
      mainCategory: MAIN_CATEGORY_ID, subcategories: [SUBCATEGORY_ID],
    }}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  return (await res.json()).data;
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Strapi:  ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:    DRY RUN — no changes will be made');
  console.log('');

  console.log('Finding products to delete...');
  const toDelete = await fetchProductsToDelete();
  toDelete.forEach((p) => console.log(`  [found] id=${p.id} "${p.title}"`));
  console.log('');

  if (dryRun) {
    console.log(`[dry-run] Would delete ${toDelete.length} product(s)`);
    console.log(`[dry-run] Would create ${NEW_PRODUCTS.length} new product(s):`);
    NEW_PRODUCTS.forEach((p) => console.log(`  "${p.title}" — ${p.price}₽`));
    console.log('\nDry run complete. Run without --dry-run to apply.');
    return;
  }

  // Delete old products
  console.log('Deleting old products...');
  let deleted = 0, deleteFailed = 0;
  for (const p of toDelete) {
    try {
      await deleteProduct(p.documentId);
      console.log(`  [ok]   deleted "${p.title}"`);
      deleted++;
    } catch (err) {
      console.error(`  [fail] "${p.title}": ${err.message}`);
      deleteFailed++;
    }
  }
  console.log(`Deleted: ${deleted}  Failed: ${deleteFailed}\n`);

  // Create new products
  console.log('Creating new products...');
  let created = 0, createFailed = 0;
  for (const product of NEW_PRODUCTS) {
    try {
      const result = await createProduct(product);
      console.log(`  [ok]   id=${result.id} "${product.title}"`);
      created++;
    } catch (err) {
      console.error(`  [fail] "${product.title}": ${err.message}`);
      createFailed++;
    }
  }

  console.log(`\nDone.  Deleted: ${deleted}  Created: ${created}  Failed: ${createFailed}`);
}

run().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
