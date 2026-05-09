export default {
  routes: [
    {
      method: 'POST',
      path: '/contact',
      handler: 'contact.send',
      config: {
        auth: false,
        policies: [],
        middlewares: [],
      },
    },
  ],
};
