#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const WOO_PRODUCTS_PATH = '/wp-json/wc/store/v1/products';

const TOP_LEVEL_WOO_CATEGORY_MAP = {
  30: 'rybki',
  58: 'gryzuny',
  64: 'reptilii',
  69: 'koshki',
  77: 'sobaki',
  84: 'pticzy',
};

const MAIN_CATEGORY_UID = 'api::main-category.main-category';
const PRODUCT_UID = 'api::product.product';
const SUBCATEGORY_UID = 'api::subcategory.subcategory';
const UPLOAD_FILE_UID = 'plugin::upload.file';

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '');
}

function getStrapiBaseUrl() {
  return normalizeBaseUrl(process.env.STRAPI_BASE_URL?.trim() || 'http://localhost:1337');
}

function getStrapiApiToken() {
  return process.env.STRAPI_API_TOKEN?.trim() || null;
}

function buildStrapiRequestHeaders() {
  const token = getStrapiApiToken();
  return token
    ? {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      }
    : {
        Accept: 'application/json',
      };
}

function getWooProductsUrl() {
  const explicitUrl = process.env.WOO_PRODUCTS_URL?.trim();

  if (explicitUrl) {
    return explicitUrl;
  }

  const wooBaseUrl = process.env.WOO_BASE_URL?.trim();

  if (!wooBaseUrl) {
    throw new Error(
      'Missing WOO_BASE_URL. Example: WOO_BASE_URL=https://your-woo-store.example npm run migrate:woo:products'
    );
  }

  return `${normalizeBaseUrl(wooBaseUrl)}${WOO_PRODUCTS_PATH}`;
}

function buildPaginatedUrl(baseUrl, page, perPage) {
  const url = new URL(baseUrl);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  return url.toString();
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function trimDecimalZeros(value) {
  if (!value.includes('.')) {
    return value;
  }

  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

function pickCurrentPriceSource(product) {
  if (product?.prices && product.prices.price != null) {
    return {
      raw: product.prices.price,
      minorUnit: parsePositiveInteger(product.prices.currency_minor_unit) ?? 0,
      isMinorUnit: true,
    };
  }

  return {
    raw: product?.price ?? null,
    minorUnit: 0,
    isMinorUnit: false,
  };
}

function pickRegularPriceSource(product) {
  if (product?.prices && product.prices.regular_price != null) {
    return {
      raw: product.prices.regular_price,
      minorUnit: parsePositiveInteger(product.prices.currency_minor_unit) ?? 0,
      isMinorUnit: true,
    };
  }

  return {
    raw: product?.regular_price ?? product?.regularPrice ?? null,
    minorUnit: 0,
    isMinorUnit: false,
  };
}

function formatMinorUnitAmount(rawValue, minorUnit) {
  if (rawValue == null || rawValue === '') {
    return null;
  }

  const rawString = String(rawValue).trim();

  if (!/^-?\d+$/.test(rawString)) {
    return null;
  }

  const isNegative = rawString.startsWith('-');
  const digits = isNegative ? rawString.slice(1) : rawString;
  const normalizedDigits = digits.replace(/^0+(?=\d)/, '') || '0';

  if (minorUnit <= 0) {
    return isNegative ? `-${normalizedDigits}` : normalizedDigits;
  }

  const padded = normalizedDigits.padStart(minorUnit + 1, '0');
  const integerPart = padded.slice(0, -minorUnit) || '0';
  const fractionalPart = padded.slice(-minorUnit);
  const decimal = trimDecimalZeros(`${integerPart}.${fractionalPart}`);

  return isNegative ? `-${decimal}` : decimal;
}

function formatDecimalAmount(rawValue) {
  if (rawValue == null || rawValue === '') {
    return null;
  }

  const normalized = String(rawValue).trim().replace(',', '.');

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  return trimDecimalZeros(normalized);
}

function parseWooAmount(source) {
  if (!source || source.raw == null || source.raw === '') {
    return null;
  }

  return source.isMinorUnit
    ? formatMinorUnitAmount(source.raw, source.minorUnit)
    : formatDecimalAmount(source.raw);
}

function toComparableNumber(value) {
  if (value == null) {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function pickOldPrice(currentPrice, regularPrice) {
  const currentNumber = toComparableNumber(currentPrice);
  const regularNumber = toComparableNumber(regularPrice);

  if (currentNumber == null || regularNumber == null) {
    return null;
  }

  return regularNumber > currentNumber ? regularPrice : null;
}

function pickShortDescription(product) {
  return (
    product?.short_description ??
    product?.shortDescription ??
    product?.summary ??
    null
  );
}

function isProductInStock(product) {
  if (typeof product?.is_in_stock === 'boolean') {
    return product.is_in_stock;
  }

  if (typeof product?.isInStock === 'boolean') {
    return product.isInStock;
  }

  if (typeof product?.stock_status === 'string') {
    return product.stock_status.toLowerCase() === 'instock';
  }

  if (typeof product?.stockStatus === 'string') {
    return product.stockStatus.toLowerCase() === 'instock';
  }

  return false;
}

function normalizeWooProduct(rawProduct) {
  const currentPrice = parseWooAmount(pickCurrentPriceSource(rawProduct));
  const regularPrice = parseWooAmount(pickRegularPriceSource(rawProduct));

  return {
    id: rawProduct?.id,
    title: rawProduct?.name?.trim() || '',
    slug: rawProduct?.slug?.trim() || '',
    price: currentPrice,
    oldPrice: pickOldPrice(currentPrice, regularPrice),
    description: rawProduct?.description ?? '',
    shortDescription: pickShortDescription(rawProduct),
    wooPermalink: rawProduct?.permalink ?? '',
    inStock: isProductInStock(rawProduct),
    categories: Array.isArray(rawProduct?.categories) ? rawProduct.categories : [],
    images: Array.isArray(rawProduct?.images) ? rawProduct.images : [],
  };
}

async function fetchWooProducts() {
  const baseUrl = getWooProductsUrl();
  const perPage = 100;
  const products = [];

  console.log('Fetching WooCommerce products...');
  console.log(`[source] ${baseUrl}`);

  let page = 1;
  let totalPages = null;

  while (true) {
    const paginatedUrl = buildPaginatedUrl(baseUrl, page, perPage);
    const response = await fetch(paginatedUrl, {
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
      throw new Error(`WooCommerce products response for page ${page} is not an array.`);
    }

    const reportedTotalPages = parsePositiveInteger(response.headers.get('x-wp-totalpages'));

    if (reportedTotalPages) {
      totalPages = reportedTotalPages;
    }

    console.log(`[page ${page}] fetched ${payload.length} products`);
    products.push(...payload.map(normalizeWooProduct));

    if (payload.length === 0) {
      break;
    }

    if (totalPages !== null) {
      if (page >= totalPages) {
        break;
      }
    } else if (payload.length < perPage) {
      break;
    }

    page += 1;
  }

  console.log(`Fetched ${products.length} products total`);

  return products;
}

async function logStrapiApiCheck() {
  const url = new URL('/api/products', `${getStrapiBaseUrl()}/`);
  url.searchParams.set('pagination[pageSize]', '1');

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: buildStrapiRequestHeaders(),
    });

    if (response.ok) {
      console.log(`[strapi-api] reachable at ${url.toString()}`);
      return;
    }

    console.warn(
      `[strapi-api:warn] ${response.status} ${response.statusText} at ${url.toString()}`
    );
  } catch (error) {
    console.warn(`[strapi-api:warn] Could not reach ${url.toString()}: ${error.message}`);
  }
}

async function loadSubcategories(strapi) {
  const subcategoryRepo = strapi.documents(SUBCATEGORY_UID);
  const subcategories = await subcategoryRepo.findMany({
    populate: ['mainCategory'],
    sort: ['title:asc'],
  });

  console.log(`Loaded ${subcategories.length} Subcategory`);

  return new Map(
    subcategories
      .filter((subcategory) => typeof subcategory.wooCategoryId === 'number')
      .map((subcategory) => [subcategory.wooCategoryId, subcategory])
  );
}

async function loadMainCategories(strapi) {
  const mainCategoryRepo = strapi.documents(MAIN_CATEGORY_UID);
  const mainCategories = await mainCategoryRepo.findMany({
    sort: ['title:asc'],
  });

  console.log(`Loaded ${mainCategories.length} MainCategory`);

  return new Map(
    mainCategories
      .filter((mainCategory) => mainCategory.externalKey)
      .map((mainCategory) => [mainCategory.externalKey, mainCategory])
  );
}

function getRelationDocumentId(relation) {
  if (!relation) {
    return null;
  }

  if (typeof relation === 'object') {
    return relation.documentId ?? null;
  }

  return relation;
}

function getMediaId(file) {
  if (!file) {
    return null;
  }

  if (typeof file === 'object') {
    return file.id ?? null;
  }

  return file;
}

function areOrderedArraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

function areUnorderedArraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }

  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function resolveProductRelations({
  product,
  subcategoriesByWooCategoryId,
  mainCategoriesByExternalKey,
}) {
  if (product.categories.length === 0) {
    return {
      error: 'Woo product has no categories.',
    };
  }

  const missingCategoryIds = [];
  const matchedSubcategories = [];
  let resolvedMainCategoryDocumentId = null;

  for (const category of product.categories) {
    const categoryId = category?.id;

    if (typeof categoryId !== 'number') {
      missingCategoryIds.push(String(categoryId));
      continue;
    }

    const subcategory = subcategoriesByWooCategoryId.get(categoryId);

    if (subcategory) {
      matchedSubcategories.push(subcategory);

      const subcategoryMainCategoryDocumentId = getRelationDocumentId(subcategory.mainCategory);

      if (!subcategoryMainCategoryDocumentId) {
        return {
          error: `Subcategory ${subcategory.title ?? 'unknown'} has no mainCategory relation.`,
        };
      }

      if (
        resolvedMainCategoryDocumentId !== null &&
        resolvedMainCategoryDocumentId !== subcategoryMainCategoryDocumentId
      ) {
        return {
          error: 'Matched categories resolve to different MainCategory records.',
        };
      }

      resolvedMainCategoryDocumentId = subcategoryMainCategoryDocumentId;
      continue;
    }

    const mainCategoryExternalKey = TOP_LEVEL_WOO_CATEGORY_MAP[categoryId];

    if (!mainCategoryExternalKey) {
      missingCategoryIds.push(String(categoryId));
      continue;
    }

    const mainCategory = mainCategoriesByExternalKey.get(mainCategoryExternalKey);

    if (!mainCategory?.documentId) {
      return {
        error: `MainCategory with externalKey "${mainCategoryExternalKey}" does not exist in Strapi.`,
      };
    }

    if (
      resolvedMainCategoryDocumentId !== null &&
      resolvedMainCategoryDocumentId !== mainCategory.documentId
    ) {
      return {
        error: 'Matched categories resolve to different MainCategory records.',
      };
    }

    resolvedMainCategoryDocumentId = mainCategory.documentId;
  }

  if (missingCategoryIds.length > 0) {
    return {
      error: `Missing Subcategory matches for Woo category IDs: ${missingCategoryIds.join(', ')}`,
    };
  }

  if (!resolvedMainCategoryDocumentId) {
    return {
      error: 'Could not resolve MainCategory from Woo categories.',
    };
  }

  const uniqueSubcategoryDocumentIds = [...new Set(
    matchedSubcategories.map((subcategory) => subcategory.documentId).filter(Boolean)
  )];

  return {
    mainCategoryDocumentId: resolvedMainCategoryDocumentId,
    subcategoryDocumentIds: uniqueSubcategoryDocumentIds,
  };
}

async function findExistingProduct(productRepo, wooProductId) {
  const existingProducts = await productRepo.findMany({
    filters: {
      wooProductId: {
        $eq: wooProductId,
      },
    },
    populate: ['mainCategory', 'subcategories', 'images'],
  });

  return existingProducts[0] ?? null;
}

function sanitizeFilenamePart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image';
}

function buildStableImageName(product, image, index) {
  const sourceUrl = String(image?.src ?? '').trim();
  const sourceHash = crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0, 12);
  const parsedUrl = new URL(sourceUrl);
  const sourceFilename = path.basename(parsedUrl.pathname) || `image-${index + 1}`;
  const safeFilename = sanitizeFilenamePart(sourceFilename);

  return `woo-product-${product.id}-${image?.id ?? index + 1}-${sourceHash}-${safeFilename}`;
}

async function findExistingUploadFile(strapi, name) {
  return strapi.db.query(UPLOAD_FILE_UID).findOne({
    where: { name },
  });
}

async function uploadProductImage({ strapi, product, image, index }) {
  const sourceUrl = String(image?.src ?? '').trim();

  if (!sourceUrl) {
    throw new Error('Woo image is missing src.');
  }

  const uploadService = strapi.plugin('upload').service('upload');
  const uploadFileService = strapi.plugin('upload').service('file');
  const sizeLimit = strapi.config.get('plugin::upload.sizeLimit');
  const tmpDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'woo-product-image-'));

  try {
    const { file } = await uploadFileService.fetchUrlToInputFile(sourceUrl, tmpDirectory, sizeLimit);
    const stableName = buildStableImageName(product, image, index);
    const uploadedFiles = await uploadService.upload({
      data: {
        fileInfo: {
          name: stableName,
          alternativeText: image?.alt || product.title || null,
        },
      },
      files: file,
    });

    return uploadedFiles[0] ?? null;
  } finally {
    await fs.rm(tmpDirectory, { recursive: true, force: true });
  }
}

async function resolveProductImageIds({ strapi, product, existingProduct }) {
  const existingImages = Array.isArray(existingProduct?.images) ? existingProduct.images : [];
  const existingImagesByName = new Map(
    existingImages.filter((image) => image?.name).map((image) => [image.name, image])
  );

  const resolvedImageIds = [];

  for (let index = 0; index < product.images.length; index += 1) {
    const image = product.images[index];
    const stableName = buildStableImageName(product, image, index);
    const attachedImage = existingImagesByName.get(stableName);

    if (attachedImage?.id) {
      resolvedImageIds.push(attachedImage.id);
      continue;
    }

    const existingUpload = await findExistingUploadFile(strapi, stableName);

    if (existingUpload?.id) {
      resolvedImageIds.push(existingUpload.id);
      continue;
    }

    try {
      const uploadedImage = await uploadProductImage({
        strapi,
        product,
        image,
        index,
      });

      if (!uploadedImage?.id) {
        throw new Error('Upload succeeded but no media id was returned.');
      }

      resolvedImageIds.push(uploadedImage.id);
    } catch (error) {
      console.error(
        `[image-error] Woo product #${product.id} image ${image?.src ?? 'unknown'}: ${error.message}`
      );
    }
  }

  return resolvedImageIds;
}

function buildProductPayload(product, relations, imageIds) {
  return {
    title: product.title,
    slug: product.slug,
    price: product.price,
    oldPrice: product.oldPrice,
    description: product.description,
    shortDescription: product.shortDescription,
    images: imageIds,
    mainCategory: relations.mainCategoryDocumentId,
    subcategories: relations.subcategoryDocumentIds,
    wooProductId: product.id,
    wooPermalink: product.wooPermalink,
    inStock: product.inStock,
    isActive: true,
    sortOrder: 0,
  };
}

function isProductPayloadUpToDate(existingProduct, payload) {
  const currentSubcategoryIds = Array.isArray(existingProduct?.subcategories)
    ? existingProduct.subcategories.map((subcategory) => subcategory.documentId).filter(Boolean)
    : [];
  const currentImageIds = Array.isArray(existingProduct?.images)
    ? existingProduct.images.map((image) => getMediaId(image)).filter(Boolean)
    : [];

  return (
    existingProduct.title === payload.title &&
    existingProduct.slug === payload.slug &&
    toComparableNumber(existingProduct.price) === toComparableNumber(payload.price) &&
    toComparableNumber(existingProduct.oldPrice) === toComparableNumber(payload.oldPrice) &&
    existingProduct.description === payload.description &&
    String(existingProduct.shortDescription ?? '') === String(payload.shortDescription ?? '') &&
    getRelationDocumentId(existingProduct.mainCategory) === payload.mainCategory &&
    String(existingProduct.wooPermalink ?? '') === String(payload.wooPermalink ?? '') &&
    Boolean(existingProduct.inStock) === payload.inStock &&
    Boolean(existingProduct.isActive) === payload.isActive &&
    Number(existingProduct.sortOrder ?? 0) === Number(payload.sortOrder ?? 0) &&
    areUnorderedArraysEqual(currentSubcategoryIds, payload.subcategories) &&
    areOrderedArraysEqual(currentImageIds, payload.images)
  );
}

function validateProduct(product) {
  if (typeof product.id !== 'number') {
    return 'Woo product id is missing or invalid.';
  }

  if (!product.title) {
    return 'Woo product name is missing.';
  }

  if (!product.slug) {
    return 'Woo product slug is missing.';
  }

  if (product.price == null) {
    return 'Woo product price is missing or invalid.';
  }

  return null;
}

async function upsertProducts({
  strapi,
  products,
  subcategoriesByWooCategoryId,
  mainCategoriesByExternalKey,
}) {
  const productRepo = strapi.documents(PRODUCT_UID);
  const summary = {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const product of products) {
    try {
      const validationError = validateProduct(product);

      if (validationError) {
        summary.skipped += 1;
        console.warn(`[skipped] #${product.id ?? 'unknown'} ${product.slug || '(no-slug)'}: ${validationError}`);
        continue;
      }

      const relations = resolveProductRelations({
        product,
        subcategoriesByWooCategoryId,
        mainCategoriesByExternalKey,
      });

      if (relations.error) {
        summary.skipped += 1;
        console.warn(`[skipped] #${product.id} ${product.slug}: ${relations.error}`);
        continue;
      }

      const existingProduct = await findExistingProduct(productRepo, product.id);
      const imageIds = await resolveProductImageIds({
        strapi,
        product,
        existingProduct,
      });
      const payload = buildProductPayload(product, relations, imageIds);

      if (!existingProduct) {
        await productRepo.create({
          data: payload,
          populate: ['mainCategory', 'subcategories', 'images'],
          status: 'published',
        });

        summary.created += 1;
        console.log(`[created] #${product.id} ${product.slug}`);
        continue;
      }

      if (isProductPayloadUpToDate(existingProduct, payload)) {
        summary.skipped += 1;
        console.log(`[skipped] #${product.id} ${product.slug} (already up to date)`);
        continue;
      }

      await productRepo.update({
        documentId: existingProduct.documentId,
        data: payload,
        populate: ['mainCategory', 'subcategories', 'images'],
        status: 'published',
      });

      summary.updated += 1;
      console.log(`[updated] #${product.id} ${product.slug}`);
    } catch (error) {
      summary.failed += 1;
      console.error(`[failed] #${product.id ?? 'unknown'} ${product.slug || '(no-slug)'}: ${error.message}`);
    }
  }

  return summary;
}

function buildVerifyProductsUrl() {
  const url = new URL('/api/products', `${getStrapiBaseUrl()}/`);
  url.searchParams.set('sort', 'title:asc');
  url.searchParams.set('pagination[pageSize]', '25');
  url.searchParams.set('populate[mainCategory][fields][0]', 'title');
  url.searchParams.set('populate[subcategories][fields][0]', 'title');
  url.searchParams.set('populate[images][fields][0]', 'url');
  return url.toString();
}

async function run() {
  console.log('=== START WOO PRODUCT MIGRATION ===');
  console.log(`[strapi] ${getStrapiBaseUrl()}`);

  if (getStrapiApiToken()) {
    console.log('[strapi-auth] STRAPI_API_TOKEN detected');
  }

  await logStrapiApiCheck();

  const products = await fetchWooProducts();
  const { distDir } = await compileStrapi();
  const strapi = createStrapi({ distDir });

  try {
    await strapi.load();

    const mainCategoriesByExternalKey = await loadMainCategories(strapi);
    const subcategoriesByWooCategoryId = await loadSubcategories(strapi);
    console.log(
      `Loaded ${mainCategoriesByExternalKey.size} MainCategory records with externalKey`
    );
    console.log(
      `Loaded ${subcategoriesByWooCategoryId.size} Subcategory records with wooCategoryId`
    );

    const summary = await upsertProducts({
      strapi,
      products,
      subcategoriesByWooCategoryId,
      mainCategoriesByExternalKey,
    });

    console.log(`Fetched: ${products.length}`);
    console.log(`Created: ${summary.created}`);
    console.log(`Updated: ${summary.updated}`);
    console.log(`Skipped: ${summary.skipped}`);
    console.log(`Failed: ${summary.failed}`);
    console.log(`[verify] ${buildVerifyProductsUrl()}`);

    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await strapi.destroy();
  }
}

run().catch((error) => {
  console.error('WooCommerce product migration failed.');
  console.error(error);
  process.exitCode = 1;
});
