interface ContactContext {
  request: { body: unknown };
  body: unknown;
  badRequest(message: string): void;
  internalServerError(message: string): void;
}

const FIELD_LIMITS = { name: 100, phone: 30, email: 254, message: 5000 };

function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default {
  async send(ctx: ContactContext) {
    const body = ctx.request.body as Record<string, unknown>;
    const name = getString(body.name).slice(0, FIELD_LIMITS.name);
    const phone = getString(body.phone).slice(0, FIELD_LIMITS.phone);
    const email = getString(body.email).slice(0, FIELD_LIMITS.email);
    const message = getString(body.message).slice(0, FIELD_LIMITS.message);

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
        <p><strong>Имя:</strong> ${escapeHtml(name)}</p>
        <p><strong>Телефон:</strong> ${escapeHtml(phone)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Сообщение:</strong></p>
        <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
      `,
    });

    ctx.body = { ok: true };
  },
};
