import type { Core } from '@strapi/strapi';

const config: Core.Config.Middlewares = [
  'strapi::logger',
  'strapi::errors',
  'strapi::security',
  'strapi::cors',
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
