import type { Core } from '@strapi/strapi';

const config: Core.Config.Middlewares = [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  {
    name: 'strapi::cors',
    config: {
      origin: (process.env.FRONTEND_URL ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
      headers: ['Content-Type', 'Authorization', 'Origin', 'Accept'],
      keepHeadersOnError: true,
    },
  },
  'strapi::poweredBy',
  'strapi::query',
  'strapi::body',
  'strapi::session',
  'strapi::favicon',
  'strapi::public',
  {
    name: 'strapi::rateLimit',
    config: {
      interval: 60000,
      max: 10,
      routes: [
        { method: 'POST', path: '/api/contact' },
        { method: 'POST', path: '/api/reviews' },
      ],
    },
  },
];

export default config;
