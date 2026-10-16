import { describe, expect, test } from 'vitest';
import { createFakeMailer, createLogMailer, createSmtpMailer, smtpTransportOptions } from '../src/modules/mail/mailer.js';

const smtp = { host: 'smtp.hostinger.com', port: 587, user: 'u', pass: 'p', from: 'f@x.fr' };

describe('transport SMTP', () => {
  test('délais finis de connexion, d’accueil et de socket', () => {
    expect(smtpTransportOptions(smtp)).toMatchObject({ connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  });

  test('port 587 : STARTTLS exigé ; port 465 : TLS implicite', () => {
    expect(smtpTransportOptions(smtp)).toMatchObject({ secure: false, requireTLS: true });
    expect(smtpTransportOptions({ ...smtp, port: 465 })).toMatchObject({ secure: true, requireTLS: false });
  });
});

describe('mailer.delivers', () => {
  test('faux seulement pour le journal de production (aucun e-mail ne part)', () => {
    const logger = { info: () => {}, warn: () => {} };
    expect(createLogMailer(logger, true).delivers).toBe(false);
    expect(createLogMailer(logger, false).delivers).toBe(true);
    expect(createFakeMailer().delivers).toBe(true);
    expect(createSmtpMailer({ host: 'smtp.test', port: 587, user: 'u', pass: 'p', from: 'a@b.fr' }).delivers).toBe(true);
  });
});
