import { expect, test } from 'vitest';
import { configWarnings, loadConfig } from '../src/config/config.js';

const base = {
  NODE_ENV: 'test',
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'mysql://u:p@127.0.0.1:3307/x',
  DATA_DIR: '/tmp/aic',
  CRON_SECRET: 'x'.repeat(32),
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

test('valeurs par défaut', () => {
  const c = loadConfig(base);
  expect(c.port).toBe(3000);
  expect(c.smtp).toBeNull();
  expect(c.bootstrapAdmin).toBeNull();
});
test('variable vide = absente', () => {
  expect(loadConfig({ ...base, SMTP_HOST: '' }).smtp).toBeNull();
});
test('SMTP partiel refusé', () => {
  expect(() => loadConfig({ ...base, SMTP_HOST: 'smtp.hostinger.com' })).toThrow(/SMTP/);
});
test('CRON_SECRET trop court refusé', () => {
  expect(() => loadConfig({ ...base, CRON_SECRET: 'court' })).toThrow(/CRON_SECRET/);
});
test('amorçage : e-mail sans mot de passe refusé', () => {
  expect(() => loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAIL: 'a@b.fr' })).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/);
});
test('amorçage : mot de passe sans e-mail refusé', () => {
  expect(() => loadConfig({ ...base, BOOTSTRAP_ADMIN_PASSWORD: 'p'.repeat(12) })).toThrow(/BOOTSTRAP_ADMIN_EMAIL/);
});
test('amorçage : mot de passe de moins de 12 caractères refusé', () => {
  expect(() => loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAIL: 'a@b.fr', BOOTSTRAP_ADMIN_PASSWORD: 'court' })).toThrow(/12/);
});
test('amorçage : e-mail normalisé', () => {
  const c = loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAIL: ' Laurent@Eksplodo.FR ', BOOTSTRAP_ADMIN_PASSWORD: 'p'.repeat(12) });
  expect(c.bootstrapAdmin).toEqual({ email: 'laurent@eksplodo.fr', password: 'p'.repeat(12) });
});
test('APP_ENCRYPTION_KEY obligatoire', () => { const { APP_ENCRYPTION_KEY: _, ...env } = base; expect(() => loadConfig(env)).toThrow(/APP_ENCRYPTION_KEY/); });
test('APP_ENCRYPTION_KEY de mauvaise longueur refusée', () => {
  expect(() => loadConfig({ ...base, APP_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 octets/);
});
test('APP_ENCRYPTION_KEY décodée en 32 octets', () => { expect(loadConfig(base).encryptionKey).toHaveLength(32); });
test('AIC_FAKE_LLM=1 active le faux fournisseur hors production', () => { expect(loadConfig({ ...base, AIC_FAKE_LLM: '1' }).fakeLlm).toBe(true); });
test('AIC_FAKE_LLM absente : faux fournisseur inactif', () => {
  const c = loadConfig(base);
  expect(c.fakeLlm).toBe(false); expect(c.fakeLlmIgnored).toBe(false);
});
test('AIC_FAKE_LLM ignorée en production, avec avertissement', () => {
  const c = loadConfig({ ...base, NODE_ENV: 'production', AIC_FAKE_LLM: '1' });
  expect(c.fakeLlm).toBe(false); expect(c.fakeLlmIgnored).toBe(true);
  expect(configWarnings(c).join()).toMatch(/AIC_FAKE_LLM est ignorée en production/);
});
