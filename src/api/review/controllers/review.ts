import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::review.review', ({ strapi }) => ({
  async create(ctx) {
    await this.validateQuery(ctx);
    const sanitizedInput = await this.sanitizeInput(ctx.request.body?.data ?? {}, ctx);

    const document = await strapi.documents('api::review.review').create({
      data: sanitizedInput as { name: string; rating: number; message: string },
      status: 'draft',
    });

    const sanitizedOutput = await this.sanitizeOutput(document, ctx);
    return this.transformResponse(sanitizedOutput);
  },
}));
