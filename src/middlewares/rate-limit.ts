import { RateLimit } from 'koa2-ratelimit';

const PROTECTED_ROUTES = new Set(['/api/contact', '/api/reviews']);

export default (config: unknown, { strapi }: { strapi: unknown }) => {
  const limiter = RateLimit.middleware({
    interval: { min: 1 },
    max: 10,
    prefixKey: 'rl',
  });

  return async (ctx: { path: string; [key: string]: unknown }, next: () => Promise<unknown>) => {
    if (PROTECTED_ROUTES.has(ctx.path)) {
      await limiter(ctx, next);
    } else {
      await next();
    }
  };
};
