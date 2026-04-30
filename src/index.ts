import type { Core } from '@strapi/strapi';
import fs from 'node:fs/promises';
import path from 'node:path';

const PUBLIC_READ_ACTIONS = [
  'api::category.category.find',
  'api::category.category.findOne',
  'api::product.product.find',
  'api::product.product.findOne',
  'plugin::upload.content-api.find',
  'plugin::upload.content-api.findOne',
] as const;

type ProductSeed = {
  name: string;
  slug: string;
  description: string;
  shortDescription: string;
  price: number;
  wooId: number;
  isActive: boolean;
  categoryNames: string[];
  imageFileName: string;
};

const categorySeeds = [
  {
    name: 'Dogs',
    slug: 'dogs',
    description:
      'Everyday essentials for dogs: food, treats, toys, leashes, and grooming basics.',
    wooId: 101,
  },
  {
    name: 'Cats',
    slug: 'cats',
    description:
      'Popular cat catalog items including litter accessories, wet food, and play products.',
    wooId: 102,
  },
] as const;

const productSeeds: ProductSeed[] = [
  {
    name: 'Atlantic Salmon Dog Bites',
    slug: 'atlantic-salmon-dog-bites',
    description:
      'Soft salmon training treats for small and medium dogs. Great for rewards during short daily sessions.',
    shortDescription: 'Soft salmon bites for training and everyday rewards.',
    price: 12.9,
    wooId: 5001,
    isActive: true,
    categoryNames: ['Dogs'],
    imageFileName: 'atlantic-salmon-dog-bites.svg',
  },
  {
    name: 'Feather Chase Cat Wand',
    slug: 'feather-chase-cat-wand',
    description:
      'A lightweight teaser wand with feather tassels to keep indoor cats active and engaged.',
    shortDescription: 'Interactive feather wand for daily play.',
    price: 8.5,
    wooId: 5002,
    isActive: true,
    categoryNames: ['Cats'],
    imageFileName: 'feather-chase-cat-wand.svg',
  },
  {
    name: 'Comfort Step Pet Bowl Set',
    slug: 'comfort-step-pet-bowl-set',
    description:
      'A raised feeding stand with two bowls that works well for both cats and small dogs.',
    shortDescription: 'Raised double-bowl set for calm daily feeding.',
    price: 24.0,
    wooId: 5003,
    isActive: true,
    categoryNames: ['Dogs', 'Cats'],
    imageFileName: 'comfort-step-pet-bowl-set.svg',
  },
];

const enablePermission = (
  permissions: Record<string, { controllers?: Record<string, Record<string, { enabled: boolean; policy: string }>> }>,
  actionId: string
) => {
  const [scope, controller, action] = actionId.split('.');
  const controllerPermissions = permissions[scope]?.controllers?.[controller];

  if (controllerPermissions?.[action]) {
    controllerPermissions[action] = { enabled: true, policy: '' };
  }
};

const ensurePublicReadPermissions = async (strapi: Core.Strapi) => {
  const publicRole = await strapi.db.query('plugin::users-permissions.role').findOne({
    where: { type: 'public' },
  });

  if (!publicRole) {
    return;
  }

  const roleService = strapi.plugin('users-permissions').service('role');
  const currentRole = await roleService.findOne(publicRole.id);
  const permissions = currentRole.permissions;

  for (const actionId of PUBLIC_READ_ACTIONS) {
    enablePermission(permissions, actionId);
  }

  await roleService.updateRole(publicRole.id, {
    name: currentRole.name,
    description: currentRole.description,
    permissions,
  });
};

const uploadProductImage = async (
  strapi: Core.Strapi,
  productId: number,
  imageFileName: string,
  productName: string
) => {
  const productWithImage = await strapi.db.query('api::product.product').findOne({
    where: { id: productId },
    populate: { image: true },
  });

  if (productWithImage?.image) {
    return;
  }

  const filePath = path.join(strapi.dirs.app.root, 'public', 'seed-assets', imageFileName);
  const stats = await fs.stat(filePath);

  await strapi.plugin('upload').service('upload').upload({
    data: {
      refId: productId,
      ref: 'api::product.product',
      field: 'image',
      fileInfo: {
        name: productName,
        alternativeText: `${productName} sample image`,
        caption: `${productName} sample image`,
      },
    },
    files: [
      {
        filepath: filePath,
        originalFilename: imageFileName,
        mimetype: 'image/svg+xml',
        size: stats.size,
      },
    ],
  });
};

const seedCatalogData = async (strapi: Core.Strapi) => {
  const createdCategories = new Map<string, { id: number }>();

  for (const category of categorySeeds) {
    const existingCategory = await strapi.db.query('api::category.category').findOne({
      where: { wooId: category.wooId },
    });

    const createdCategory = existingCategory
      ? await strapi.db.query('api::category.category').update({
          where: { id: existingCategory.id },
          data: category,
        })
      : await strapi.db.query('api::category.category').create({
          data: category,
        });

    createdCategories.set(category.name, { id: createdCategory.id });
  }

  for (const product of productSeeds) {
    const categoryIds = product.categoryNames
      .map((categoryName) => createdCategories.get(categoryName)?.id)
      .filter((categoryId): categoryId is number => Boolean(categoryId));

    const existingProduct = await strapi.db.query('api::product.product').findOne({
      where: { wooId: product.wooId },
    });

    const createdProduct = existingProduct
      ? await strapi.db.query('api::product.product').update({
          where: { id: existingProduct.id },
          data: {
            name: product.name,
            slug: product.slug,
            description: product.description,
            shortDescription: product.shortDescription,
            price: product.price,
            wooId: product.wooId,
            isActive: product.isActive,
            categories: categoryIds,
          },
        })
      : await strapi.db.query('api::product.product').create({
          data: {
            name: product.name,
            slug: product.slug,
            description: product.description,
            shortDescription: product.shortDescription,
            price: product.price,
            wooId: product.wooId,
            isActive: product.isActive,
            categories: categoryIds,
          },
        });

    await uploadProductImage(strapi, createdProduct.id, product.imageFileName, product.name);
  }
};

export default {
  register() {},

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await ensurePublicReadPermissions(strapi);
    await seedCatalogData(strapi);
  },
};
