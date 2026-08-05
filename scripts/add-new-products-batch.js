#!/usr/bin/env node

'use strict';

// Deletes existing products in «Герметики» and creates a batch of new products
// across «Кормушки», «Отсадники», and «Герметики» subcategories.
//
// Usage:
//   node --env-file=.env scripts/add-new-products-batch.js [--dry-run]

const FISH_MAIN_CATEGORY_ID = 1;

const SUBCATEGORY_IDS = {
  'Кормушки':  33,
  'Отсадники': 42,
  'Герметики': 17,
};

const ГЕРМЕТИКИ_TO_DELETE = [
  'qp93mdwk7e8bvq56w6kor4j2',
  'ns3a1sh27elxi67ydry25cq8',
  'qfasj3c6c2z58pluj1nr09yu',
  'fduqhlg7ug6kicsbc0k9l8tj',
  'spcq5jvhmcabr503v0x437qd',
];

const NEW_PRODUCTS = [
  // --- Кормушки ---
  {
    title: 'Naribo кормушка круглая',
    slug: 'naribo-kormushka-kruglaya',
    price: 200,
    subcategory: 'Кормушки',
    description: '<p>Кормушка круглой формы для аквариума удерживает корм на поверхности воды, предотвращая его рассеивание. Выполнена из лёгкого пластика и держится на воде за счёт собственной плавучести. Подходит для всех видов сухого корма: хлопьев, гранул, таблеток.</p>',
  },
  {
    title: 'Naribo кормушка прямоугольная',
    slug: 'naribo-kormushka-pryamougolnaya',
    price: 200,
    subcategory: 'Кормушки',
    description: '<p>Кормушка прямоугольной формы для аквариума удерживает корм на поверхности воды в одном месте. Выполнена из лёгкого пластика с открытым верхом для удобного добавления корма. Подходит для хлопьев, гранул и крупного корма, удобна для аквариумов с покровным стеклом.</p>',
  },
  // --- Отсадники ---
  {
    title: 'Naribo отсадник сетчатый MBL-01',
    slug: 'naribo-otsadnik-mbl-01',
    price: 542,
    subcategory: 'Отсадники',
    description: '<p>Сетчатый отсадник для безопасного содержания мальков, больных или агрессивных рыб в отдельной секции внутри аквариума. Мелкоячеистая сетка обеспечивает постоянную циркуляцию воды, сохраняя привычные параметры среды. Крепится к стенке аквариума на присосках, не требует отдельной помпы или обогревателя. Поставляется без внутреннего разделителя.</p>',
  },
  // --- Герметики ---
  {
    title: 'Zhongtian 9800 прозрачный 300 мл',
    slug: 'zhongtian-9800-prozrachnyj-300-ml',
    price: 495,
    subcategory: 'Герметики',
    description: '<p>Профессиональный силиконовый герметик для сборки и ремонта стеклянных аквариумов. Прозрачный состав не искажает вид швов, содержит добавки против плесени и грибка. Безопасен для рыб и растений после полного отверждения (24–48 часов). Объём 300 мл рассчитан на аквариумы среднего и большого размера.</p>',
  },
  {
    title: 'Silikon aquarium прозрачный 8 мл',
    slug: 'silikon-aquarium-prozrachnyj-8-ml',
    price: 290,
    subcategory: 'Герметики',
    description: '<p>Тюбик прозрачного аквариумного силиконового герметика для локального ремонта и точечной герметизации швов. Образует эластичный водостойкий шов, безопасен для обитателей аквариума после высыхания. Удобен для небольших аквариумов и труднодоступных мест. Время отверждения — 24 часа.</p>',
  },
  {
    title: 'Silikon aquarium чёрный 8 мл',
    slug: 'silikon-aquarium-chornyj-8-ml',
    price: 290,
    subcategory: 'Герметики',
    description: '<p>Тюбик чёрного аквариумного силиконового герметика для точечной герметизации и ремонта швов. Чёрный цвет позволяет замаскировать швы в аквариумах с тёмным фоном или оборудованием. Образует прочный эластичный шов, безопасен для обитателей аквариума после полного отверждения (24 часа).</p>',
  },
  {
    title: 'Marlin aquariam 5 гр',
    slug: 'marlin-aquariam-5-gr',
    price: 230,
    subcategory: 'Герметики',
    description: '<p>Герметик-клей для фиксации декораций в аквариуме: камней, коряг, пластиковых и керамических украшений. Небольшой объём 5 г рассчитан на точечную работу при создании аквадизайна. После отверждения полностью безопасен для рыб и растений, не разрушается в воде.</p>',
  },
  {
    title: 'Barbus аква гель супер фиксатор аквариумного фона 26 мл',
    slug: 'barbus-akva-gel-26-ml',
    price: 200,
    subcategory: 'Герметики',
    description: '<p>Гель для крепления плёночного фона к внешней стенке аквариума. Обеспечивает равномерное прилегание без пузырей и складок, после высыхания не оставляет разводов. Объём 26 мл достаточен для аквариумов до 200 литров. Наносится только снаружи — не контактирует с водой и обитателями.</p>',
  },
];

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

async function deleteProduct(documentId) {
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/products/${documentId}`, {
    method: 'DELETE',
    headers: apiHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DELETE /api/products/${documentId} failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

async function createProduct(product) {
  const subcategoryId = SUBCATEGORY_IDS[product.subcategory];
  const res = await fetchWithRetry(`${getStrapiBaseUrl()}/api/products`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      data: {
        title: product.title,
        slug: product.slug,
        price: product.price,
        description: product.description,
        inStock: true,
        isActive: true,
        mainCategory: FISH_MAIN_CATEGORY_ID,
        subcategories: [subcategoryId],
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /api/products failed: HTTP ${res.status} — ${text.slice(0, 300)}`);
  }
  return (await res.json()).data;
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`Strapi:  ${getStrapiBaseUrl()}`);
  if (dryRun) console.log('Mode:    DRY RUN — no changes will be made');
  console.log('');

  console.log(`Deleting ${ГЕРМЕТИКИ_TO_DELETE.length} existing products from «Герметики»...`);
  if (dryRun) {
    ГЕРМЕТИКИ_TO_DELETE.forEach((id) => console.log(`  [dry-run] Would delete ${id}`));
  } else {
    let deleted = 0;
    let failed = 0;
    for (const documentId of ГЕРМЕТИКИ_TO_DELETE) {
      try {
        await deleteProduct(documentId);
        console.log(`  [ok]   deleted ${documentId}`);
        deleted++;
      } catch (err) {
        console.error(`  [fail] ${documentId}: ${err.message}`);
        failed++;
      }
    }
    console.log(`Deleted: ${deleted}  Failed: ${failed}`);
  }

  console.log('');
  console.log(`Creating ${NEW_PRODUCTS.length} new products...`);

  if (dryRun) {
    NEW_PRODUCTS.forEach((p) => console.log(`  [dry-run] Would create «${p.title}» → ${p.subcategory} ${p.price}₽`));
    console.log('\nDry run complete. Run without --dry-run to apply.');
    return;
  }

  let created = 0;
  let failed = 0;
  for (const product of NEW_PRODUCTS) {
    try {
      const result = await createProduct(product);
      console.log(`  [ok]   «${product.title}» → ${product.subcategory} (id=${result.id})`);
      created++;
    } catch (err) {
      console.error(`  [fail] «${product.title}»: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone.  Created: ${created}  Failed: ${failed}`);
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
