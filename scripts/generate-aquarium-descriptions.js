#!/usr/bin/env node

'use strict';

// Generates and updates aquarium product descriptions in Strapi.
//
// Usage:
//   node --env-file=.env ./scripts/generate-aquarium-descriptions.js <input-file> [--dry-run]
//
// Input file: one product per line, 6 fields separated by " | "
//   Название товара | ДxШxВ | толщина_стекла | толщина_дна | крышка | доп_вариант
//
// крышка:      1E14 | 2E14 | без
// доп_вариант: белая:ЦЕНА | LED:ЦЕНА | 2LED60:ЦЕНА | 2LED:ЦЕНА | -
//
// Example:
//   Аквариум куб 10 литров | 220x220x220 | 4 | - | 1E14 | белая:2200

const fs = require('fs');

const DRY_RUN = process.argv.includes('--dry-run');
const INPUT_FILE = process.argv.slice(2).find((a) => !a.startsWith('-'));

function getStrapiBaseUrl() {
  return (process.env.STRAPI_BASE_URL?.trim() || 'http://localhost:1337').replace(/\/+$/, '');
}

function getHeaders() {
  const token = process.env.STRAPI_API_TOKEN?.trim();
  if (!token) throw new Error('STRAPI_API_TOKEN is required.');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function fetchWithRetry(url, options = {}, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt < maxRetries) {
        process.stdout.write(`  [retry ${attempt + 1}/${maxRetries}] Connection error, retrying in 1.5s...\n`);
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        throw err;
      }
    }
  }
}

function detectType(title) {
  const t = title.toLowerCase();
  if (t.includes('куб')) return 'куб';
  if (t.includes('телевизор')) return 'телевизор';
  if (t.includes('прямоугольный')) return 'прямоугольный';
  if (t.includes('колонна')) return 'колонна';
  if (t.includes('трапеция')) return 'трапеция';
  return null;
}

function extractVolume(title) {
  const match = title.match(/(\d+)\s*литр/i);
  return match ? parseInt(match[1], 10) : null;
}

function parseDimensions(dimStr) {
  const parts = dimStr.trim().split(/[x*×]/i).map((s) => s.trim());
  if (parts.length !== 3) throw new Error(`Invalid dimensions: "${dimStr}"`);
  return { d: parts[0], sh: parts[1], v: parts[2] };
}

function formatDims(dims, type) {
  const sep = type === 'куб' || type === 'колонна' || type === 'трапеция' ? '×' : '*';
  return `${dims.d}${sep}${dims.sh}${sep}${dims.v}`;
}

function generateLidText(lidType) {
  const map = {
    '1E14': 'крышка с патроном Е14',
    '2E14': 'крышка с патронами Е14',
    'без': 'крышка без освещения',
  };
  if (!map[lidType]) throw new Error(`Unknown lid type: "${lidType}". Valid: 1E14, 2E14, без`);
  return map[lidType];
}

function formatPrice(raw) {
  return String(raw).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function generateExtraText(extra) {
  if (!extra || extra === '-') return '';
  const colonIdx = extra.indexOf(':');
  if (colonIdx === -1) throw new Error(`Extra variant must include price after colon: "${extra}"`);
  const kind = extra.slice(0, colonIdx).trim();
  const price = formatPrice(extra.slice(colonIdx + 1).trim());
  const map = {
    'белая': `Возможен вариант с белой крышкой — ${price} руб.`,
    'LED': `Также доступен вариант с крышкой и светодиодным светильником. Его стоимость — ${price} руб.`,
    '2LED60': `Также доступен вариант с крышкой с 2 светодиодными лампами по 60 см. Его стоимость — ${price} руб.`,
    '2LED': `Также доступен вариант с крышкой с 2 светодиодными лампами. Его стоимость — ${price} руб.`,
  };
  if (!map[kind]) throw new Error(`Unknown extra variant: "${kind}". Valid: белая, LED, 2LED60, 2LED`);
  return ' ' + map[kind];
}

function generateDescription({ title, dims, glassThickness, bottomThickness, lidType, extra }) {
  const type = detectType(title);
  if (!type) throw new Error(`Cannot detect aquarium type from: "${title}"`);

  const volume = extractVolume(title);
  if (!volume) throw new Error(`Cannot extract volume from: "${title}"`);

  const dimsStr = formatDims(dims, type);
  const lid = generateLidText(lidType);
  const extraText = generateExtraText(extra);
  const disclaimer =
    'Изображение носит ознакомительный характер. Внешний вид товара может отличаться. Уточните детали в магазине.';

  let p1, p2, p3;

  if (type === 'куб') {
    p1 =
      `Аквариум куб ${volume} л — компактная стеклянная модель классической формы, ` +
      `подходящая для содержания рыб, креветок и растений. Равные стороны создают ощущение глубины ` +
      `и делают аквариум удобным для акваскейпа, нано-композиций и декоративного оформления.`;
    p2 =
      `Габариты составляют ${dimsStr} мм, толщина стекла — ${glassThickness} мм, ` +
      `что обеспечивает надёжность конструкции. Высота указана без учёта крышки.`;
  } else if (type === 'телевизор') {
    p1 =
      `Аквариум телевизор ${volume} л — вместительная стеклянная модель с выпуклым фронтальным стеклом, ` +
      `подходящая для содержания различных видов рыб и растений. Изогнутая передняя стенка обеспечивает ` +
      `панорамный обзор и усиливает эффект глубины, делая оформление более выразительным.`;
    p2 =
      `Габариты (Д*Ш*В) составляют ${dimsStr} мм, толщина стекла — ${glassThickness} мм, ` +
      `что обеспечивает прочность и надёжность конструкции. Высота указана без учёта крышки.`;
  } else if (type === 'колонна') {
    p1 =
      `Аквариум колонна ${volume} л — стеклянная модель вытянутой формы, ` +
      `подходящая для содержания рыб, растений и нано-экосистем. Вертикальные пропорции создают ` +
      `эффектный силуэт и делают аквариум оригинальным декоративным элементом интерьера.`;
    p2 =
      `Габариты составляют ${dimsStr} мм, толщина стекла — ${glassThickness} мм, ` +
      `что обеспечивает надёжность конструкции. Высота указана без учёта крышки.`;
  } else if (type === 'трапеция') {
    p1 =
      `Аквариум трапеция ${volume} л — стеклянная модель с трапециевидным сечением, ` +
      `подходящая для содержания рыб, растений и нано-экосистем. Скошенная форма позволяет ` +
      `эффективно использовать угловое пространство и органично вписывается в интерьер.`;
    p2 =
      `Габариты составляют ${dimsStr} мм, толщина стекла — ${glassThickness} мм, ` +
      `что обеспечивает надёжность конструкции. Высота указана без учёта крышки.`;
  } else {
    p1 =
      `Аквариум прямоугольный ${volume} л — стеклянная модель классической формы, ` +
      `подходящая для содержания различных видов рыб и растений. Прямые линии обеспечивают ` +
      `удобство размещения оборудования и позволяют создавать разнообразные подводные композиции.`;
    const bottomNote =
      bottomThickness && bottomThickness !== '-'
        ? `, толщина дна — ${bottomThickness} мм`
        : '';
    p2 =
      `Габариты (Д*Ш*В) составляют ${dimsStr} мм. Толщина стекла — ${glassThickness} мм${bottomNote}, ` +
      `что обеспечивает повышенную прочность и устойчивость конструкции. Высота указана без учёта крышки.`;
  }

  p3 = `В комплект входит ${lid}.${extraText}`;

  return `<p>${p1}</p>\n<p>${p2}</p>\n<p>${p3}</p>\n<p>${disclaimer}</p>`;
}

function parseLine(line, lineNum) {
  const parts = line.split('|').map((s) => s.trim());
  if (parts.length < 6) {
    throw new Error(`Line ${lineNum}: expected 6 fields, got ${parts.length}`);
  }
  const [title, dimStr, glassThickness, bottomThickness, lidType, extra] = parts;
  return {
    title,
    dims: parseDimensions(dimStr),
    glassThickness,
    bottomThickness,
    lidType,
    extra,
  };
}

async function findProductByTitle(title) {
  const url = new URL(`${getStrapiBaseUrl()}/api/products`);
  url.searchParams.set('filters[title][$eqi]', title);
  url.searchParams.set('fields[0]', 'title');
  url.searchParams.set('pagination[limit]', '2');
  const res = await fetchWithRetry(url.toString(), { headers: getHeaders() });
  if (!res.ok) throw new Error(`GET /api/products failed: HTTP ${res.status}`);
  const json = await res.json();
  return json.data?.[0] ?? null;
}

async function updateDescription(documentId, description) {
  const url = `${getStrapiBaseUrl()}/api/products/${documentId}`;
  const res = await fetchWithRetry(url, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ data: { description } }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT failed: HTTP ${res.status} — ${text.slice(0, 200)}`);
  }
}

async function run() {
  if (!INPUT_FILE) {
    console.error(
      'Usage: node --env-file=.env ./scripts/generate-aquarium-descriptions.js <input-file> [--dry-run]',
    );
    process.exit(1);
  }
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`File not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const lines = fs
    .readFileSync(INPUT_FILE, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  console.log(`Products:  ${lines.length}${DRY_RUN ? '  (DRY RUN — Strapi not changed)' : ''}`);
  console.log('');

  let updated = 0, notFound = 0, failed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let parsed;
    try {
      parsed = parseLine(line, i + 1);
    } catch (err) {
      console.log(`[parse error]  ${line}`);
      console.log(`               ${err.message}`);
      failed++;
      continue;
    }

    let description;
    try {
      description = generateDescription(parsed);
    } catch (err) {
      console.log(`[gen error]    ${parsed.title}`);
      console.log(`               ${err.message}`);
      failed++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`[preview]  ${parsed.title}`);
      console.log('─'.repeat(72));
      console.log(description);
      console.log('─'.repeat(72));
      console.log('');
      continue;
    }

    const product = await findProductByTitle(parsed.title);
    if (!product) {
      console.log(`[not found]    ${parsed.title}`);
      notFound++;
      continue;
    }

    try {
      await updateDescription(product.documentId, description);
      console.log(`[updated]      ${parsed.title}`);
      updated++;
    } catch (err) {
      console.log(`[update error] ${parsed.title}`);
      console.log(`               ${err.message}`);
      failed++;
    }
  }

  if (!DRY_RUN) {
    console.log('');
    console.log(`Done.  Updated: ${updated}  Not found: ${notFound}  Failed: ${failed}`);
  }
}

run().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
