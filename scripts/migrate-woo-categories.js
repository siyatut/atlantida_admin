#!/usr/bin/env node

'use strict';

const { compileStrapi, createStrapi } = require('@strapi/strapi');

const WOO_CATEGORIES_PATH = '/wp-json/wc/store/v1/products/categories';

const MAIN_CATEGORY_MAP = {
  rybki: 'rybki',
  gryzuny: 'gryzuny',
  koshki: 'koshki',
  sobaki: 'sobaki',
  pticzy: 'pticzy',
  reptilii: 'reptilii',
  // TODO: Adjust the Woo top-level slug keys here if the source store uses different slugs.
};

const MAIN_CATEGORY_UID = 'api::main-category.main-category';
const SUBCATEGORY_UID = 'api::subcategory.subcategory';

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '');
}

function getWooCategoriesUrl() {
  const explicitUrl = process.env.WOO_CATEGORIES_URL?.trim();

  if (explicitUrl) {
    return explicitUrl;
  }

  const wooBaseUrl = process.env.WOO_BASE_URL?.trim();

  if (!wooBaseUrl) {
    throw new Error(
      'Missing WOO_BASE_URL. Example: WOO_BASE_URL=https://your-woo-store.example npm run migrate:woo:categories'
    );
  }

  return `${normalizeBaseUrl(wooBaseUrl)}${WOO_CATEGORIES_PATH}`;
}

function buildWooCategoryMap(categories) {
  return new Map(categories.map((category) => [category.id, category]));
}

function isWooTopLevelCategory(category) {
  return category.parent === 0;
}

function getTopLevelCategory(category, categoriesById) {
  let current = category;
  const visited = new Set();

  while (current.parent && current.parent !== 0) {
    if (visited.has(current.id)) {
      throw new Error(`Detected a category parent cycle at Woo category ${current.id}.`);
    }

    visited.add(current.id);

    const parent = categoriesById.get(current.parent);

    if (!parent) {
      throw new Error(
        `Woo category ${current.id} references missing parent ${current.parent}.`
      );
    }

    current = parent;
  }

  return current;
}

function pickSortableValue(category) {
  if (typeof category.menu_order === 'number') {
    return category.menu_order;
  }

  return null;
}

function isSameRelation(currentRelation, nextDocumentId) {
  const currentDocumentId =
    currentRelation && typeof currentRelation === 'object'
      ? currentRelation.documentId ?? null
      : currentRelation ?? null;

  return currentDocumentId === nextDocumentId;
}

function normalizeWooCategory(rawCategory) {
  return {
    id: rawCategory.id,
    name: rawCategory.name,
    slug: rawCategory.slug,
    parent: rawCategory.parent ?? 0,
    sortOrder: pickSortableValue(rawCategory),
  };
}

function getDesiredParentWooCategoryId(category, categoriesById) {
  if (!category.parent || category.parent === 0) {
    return null;
  }

  const parentCategory = categoriesById.get(category.parent);

  if (!parentCategory) {
    throw new Error(
      `Woo category ${category.id} references missing parent ${category.parent}.`
    );
  }

  if (isWooTopLevelCategory(parentCategory)) {
    return null;
  }

  return parentCategory.id;
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

  const categories = payload.map(normalizeWooCategory);

  console.log(`Fetched ${categories.length} categories`);

  return categories;
}

async function loadMainCategories(strapi) {
  const mainCategoryRepo = strapi.documents(MAIN_CATEGORY_UID);
  const mainCategories = await mainCategoryRepo.findMany({
    sort: ['title:asc'],
  });

  console.log(`Loaded ${mainCategories.length} MainCategory`);

  return new Map(
    mainCategories.map((mainCategory) => [mainCategory.externalKey, mainCategory])
  );
}

async function loadExistingSubcategories(strapi) {
  const subcategoryRepo = strapi.documents(SUBCATEGORY_UID);
  const subcategories = await subcategoryRepo.findMany({
    populate: ['mainCategory', 'parent'],
    sort: ['title:asc'],
  });

  return new Map(
    subcategories
      .filter((subcategory) => typeof subcategory.wooCategoryId === 'number')
      .map((subcategory) => [subcategory.wooCategoryId, subcategory])
  );
}

async function deleteTopLevelDuplicateSubcategories({
  strapi,
  topLevelCategories,
  existingByWooCategoryId,
}) {
  const subcategoryRepo = strapi.documents(SUBCATEGORY_UID);
  let deleted = 0;

  for (const category of topLevelCategories) {
    const existing = existingByWooCategoryId.get(category.id);

    if (!existing) {
      continue;
    }

    await subcategoryRepo.delete({ documentId: existing.documentId });
    existingByWooCategoryId.delete(category.id);
    deleted += 1;
    console.log(`[deleted-top-level-subcategory] #${category.id} ${category.slug}`);
  }

  return deleted;
}

function resolveMainCategoryForWooCategory({
  category,
  categoriesById,
  mainCategoriesByExternalKey,
}) {
  try {
    const topLevelCategory = getTopLevelCategory(category, categoriesById);
    const mainCategoryExternalKey = MAIN_CATEGORY_MAP[topLevelCategory.slug];

    console.log(
      `[map] Woo #${category.id} slug=${category.slug} parent=${category.parent} -> topLevel=${topLevelCategory.slug} -> mainCategory=${mainCategoryExternalKey ?? 'unmapped'}`
    );

    if (!mainCategoryExternalKey) {
      return {
        error: `No MainCategory mapping found for Woo top-level slug "${topLevelCategory.slug}".`,
      };
    }

    const mainCategory = mainCategoriesByExternalKey.get(mainCategoryExternalKey);

    if (!mainCategory) {
      return {
        error: `MainCategory with externalKey "${mainCategoryExternalKey}" does not exist in Strapi.`,
      };
    }

    return {
      mainCategory,
      mainCategoryExternalKey,
      topLevelSlug: topLevelCategory.slug,
    };
  } catch (error) {
    console.error(
      `[map:failed] Woo #${category.id} slug=${category.slug} parent=${category.parent}: ${error.message}`
    );

    return {
      error: error.message,
    };
  }
}

async function upsertSubcategories({
  strapi,
  categories,
  categoriesById,
  mainCategoriesByExternalKey,
  existingByWooCategoryId,
}) {
  const subcategoryRepo = strapi.documents(SUBCATEGORY_UID);
  const syncedByWooCategoryId = new Map(existingByWooCategoryId);
  const summary = {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const category of categories) {
    if (isWooTopLevelCategory(category)) {
      console.log(`[skip-top-level] Woo #${category.id} ${category.slug}`);
      continue;
    }

    try {
      const mapping = resolveMainCategoryForWooCategory({
        category,
        categoriesById,
        mainCategoriesByExternalKey,
      });

      if (mapping.error) {
        summary.failed += 1;
        console.error(`[failed] #${category.id} ${category.slug}: ${mapping.error}`);
        continue;
      }

      const existing = syncedByWooCategoryId.get(category.id);
      const desiredParentWooCategoryId = getDesiredParentWooCategoryId(category, categoriesById);
      const desiredParentDocumentId =
        desiredParentWooCategoryId !== null
          ? syncedByWooCategoryId.get(desiredParentWooCategoryId)?.documentId ?? null
          : null;
      const payload = {
        title: category.name,
        slug: category.slug,
        wooCategoryId: category.id,
        sortOrder: category.sortOrder,
        mainCategory: mapping.mainCategory.documentId,
        parent: desiredParentDocumentId,
      };

      if (!existing) {
        console.log('[creating]', payload);

        const created = await subcategoryRepo.create({
          data: payload,
          populate: ['mainCategory', 'parent'],
          status: 'published',
        });

        syncedByWooCategoryId.set(category.id, created);
        summary.created += 1;
        console.log(`[created] #${category.id} ${category.slug}`);
        continue;
      }

      const hasCoreChanges =
        existing.title !== payload.title ||
        existing.slug !== payload.slug ||
        existing.sortOrder !== payload.sortOrder ||
        !isSameRelation(existing.mainCategory, payload.mainCategory) ||
        !isSameRelation(existing.parent, payload.parent);

      if (!hasCoreChanges) {
        summary.skipped += 1;
        console.log(`[skipped] #${category.id} ${category.slug} (already up to date)`);
        continue;
      }

      const updated = await subcategoryRepo.update({
        documentId: existing.documentId,
        data: payload,
        populate: ['mainCategory', 'parent'],
        status: 'published',
      });

      syncedByWooCategoryId.set(category.id, updated);
      summary.updated += 1;
      console.log(`[updated] #${category.id} ${category.slug}`);
    } catch (error) {
      summary.failed += 1;
      console.error(`[failed] #${category.id} ${category.slug}: ${error.message}`);
    }
  }

  return summary;
}

async function logFinalSubcategoryCount(strapi) {
  const subcategoryRepo = strapi.documents(SUBCATEGORY_UID);
  const totalSubcategories = await subcategoryRepo.count();

  console.log(`Total Subcategories in Strapi: ${totalSubcategories}`);
}

async function run() {
  console.log('=== START WOO CATEGORY MIGRATION ===');

  const categories = await fetchWooCategories();
  const categoriesById = buildWooCategoryMap(categories);
  const topLevelCategories = categories.filter(isWooTopLevelCategory);

  console.log(`Detected ${topLevelCategories.length} Woo top-level categories`);

  const { distDir } = await compileStrapi();
  const strapi = createStrapi({ distDir });

  try {
    await strapi.load();

    const mainCategoriesByExternalKey = await loadMainCategories(strapi);
    const existingByWooCategoryId = await loadExistingSubcategories(strapi);

    console.log(
      `Loaded ${existingByWooCategoryId.size} existing Subcategory records with wooCategoryId`
    );

    const deletedTopLevel = await deleteTopLevelDuplicateSubcategories({
      strapi,
      topLevelCategories,
      existingByWooCategoryId,
    });

    const summary = await upsertSubcategories({
      strapi,
      categories,
      categoriesById,
      mainCategoriesByExternalKey,
      existingByWooCategoryId,
    });

    console.log(`Deleted top-level duplicate Subcategories: ${deletedTopLevel}`);
    console.log(`Created: ${summary.created}`);
    console.log(`Updated: ${summary.updated}`);
    console.log(`Skipped: ${summary.skipped}`);
    console.log(`Failed: ${summary.failed}`);

    await logFinalSubcategoryCount(strapi);

    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await strapi.destroy();
  }
}

run().catch((error) => {
  console.error('WooCommerce category migration failed.');
  console.error(error);
  process.exitCode = 1;
});
