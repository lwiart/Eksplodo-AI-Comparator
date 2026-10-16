import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { clientKeyOf, createRateLimitKeying } from '../src/plugins/rate-limit.js';
import { buildTestApp, type TestApp } from './helpers/test-app.js';

const created: TestApp[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
}, 60_000);

type Req = Parameters<typeof clientKeyOf>[0];
const req = (ip: string | undefined, headers: Record<string, string | string[]> = {}): Req => ({ ip, headers }) as Req;

describe('clé de limitation par IP', () => {
  test('req.ip prioritaire, normalisée', () => {
    expect(clientKeyOf(req('203.0.113.7', { 'x-forwarded-for': '1.1.1.1' }))).toBe('203.0.113.7');
    expect(clientKeyOf(req('::ffff:203.0.113.7'))).toBe('203.0.113.7');
  });

  test('sans req.ip : dernière valeur de x-real-ip, puis de x-forwarded-for', () => {
    expect(clientKeyOf(req(undefined, { 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }))).toBe('9.9.9.9');
    expect(clientKeyOf(req(undefined, { 'x-forwarded-for': '6.6.6.6, 203.0.113.9 ' }))).toBe('203.0.113.9');
    expect(clientKeyOf(req('', { 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] }))).toBe('2.2.2.2');
  });

  test('aucune IP : pas de clé', () => {
    expect(clientKeyOf(req(undefined))).toBeNull();
    expect(clientKeyOf(req('', { 'x-forwarded-for': ' , ' }))).toBeNull();
  });

  test('aucune IP : la requête échappe à la limite par IP, avertissement journalisé une seule fois', async () => {
    const warn = vi.fn();
    const keying = createRateLimitKeying({ warn });
    const anonymous = req(undefined);
    expect(() => keying.keyGenerator(anonymous)).not.toThrow();
    expect(keying.allowList(anonymous)).toBe(true);
    expect(keying.allowList(anonymous)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(keying.allowList(req('203.0.113.7'))).toBe(false);
    expect(keying.keyGenerator(req('203.0.113.7'))).toBe('203.0.113.7');
  });
});

function socketPath(): string {
  const id = `aic-test-${process.pid}-${randomBytes(4).toString('hex')}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

function call(
  path: string,
  opts: { method: string; url: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: path, path: opts.url, method: opts.method, headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, setCookie: res.headers['set-cookie'] ?? [] }));
    });
    r.on('error', reject);
    r.end(opts.body);
  });
}

describe('écoute sur socket local (LiteSpeed) sans X-Forwarded-For', () => {
  test('la connexion répond 401, pas 500', async () => {
    const t = await buildTestApp();
    created.push(t);
    const path = socketPath();
    await t.app.listen({ path });

    const init = await call(path, { method: 'GET', url: '/api/auth/me' });
    const csrf = /aic_csrf=([^;]+)/.exec(init.setCookie.join(';'))![1]!;
    const body = JSON.stringify({ email: 'inconnu@x.fr', password: 'faux-mot-de-passe' });
    const res = await call(path, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: `aic_csrf=${csrf}`, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('invalid_credentials');
  }, 30_000);
});
