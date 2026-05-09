interface ContactContext {
  request: { body: unknown };
  body: unknown;
  badRequest(message: string): void;
  internalServerError(message: string): void;
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export default {
  async send(ctx: ContactContext) {
    const body = ctx.request.body as Record<string, unknown>;
    const name = getString(body.name);
    const phone = getString(body.phone);
    const email = getString(body.email);
    const message = getString(body.message);

    if (!name || !phone || !email || !message) {
      return ctx.badRequest('All fields are required');
    }

    const recipient = process.env.SMTP_USER;

    if (!recipient) {
      strapi.log.error('[Contact] SMTP_USER is not set');
      return ctx.internalServerError('Email service is not configured');
    }

    await strapi.plugins['email'].services.email.send({
      to: recipient,
      replyTo: email,
      subject: 'Новое сообщение с сайта Атлантида',
      text: `Имя: ${name}\nТелефон: ${phone}\nEmail: ${email}\n\nСообщение:\n${message}`,
      html: `
        <p><strong>Имя:</strong> ${name}</p>
        <p><strong>Телефон:</strong> ${phone}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Сообщение:</strong></p>
        <p>${message.replace(/\n/g, '<br>')}</p>
      `,
    });

    ctx.body = { ok: true };
  },
};
