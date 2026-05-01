import type { Core } from '@strapi/strapi';

const PUBLIC_READ_ACTIONS = [
  'api::main-category.main-category.find',
  'api::main-category.main-category.findOne',
  'api::subcategory.subcategory.find',
  'api::subcategory.subcategory.findOne',
  'api::product.product.find',
  'api::product.product.findOne',
  'plugin::upload.content-api.find',
  'plugin::upload.content-api.findOne',
] as const;

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

export default {
  register() {},

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await ensurePublicReadPermissions(strapi);
  },
};
