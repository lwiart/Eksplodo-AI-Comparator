import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';
import { runTests, runs } from '../src/db/schema/runs.js';
import { testAttachments } from '../src/db/schema/tests.js';
import { MAX_ATTACHMENT_BYTES, readAttachment } from '../src/modules/tests/attachments.js';
import { buildTestApp, loginAs, seedUser, type TestApp } from './helpers/test-app.js';

const PW = 'motdepasse-solide';
const created: TestApp[] = [];
const dirs: string[] = [];

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'aic-att-'));
  dirs.push(dataDir);
  const t = await buildTestApp({ dataDir });
  created.push(t);
  const adminRow = await seedUser(t.db, { email: 'admin@acme.fr', role: 'admin' });
  await seedUser(t.db, { email: 'user@acme.fr', role: 'user' });
  const admin = await loginAs(t.app, 'admin@acme.fr', PW);
  const user = await loginAs(t.app, 'user@acme.fr', PW);
  const hdr = (s: typeof admin) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf });
  const testRes = await t.app.inject({
    method: 'POST',
    url: '/api/tests',
    headers: hdr(admin),
    payload: { name: 'T', category: 'C', userPrompt: 'p', scoringMethod: 'manual', scoringConfig: {} },
  });
  const testId: string = testRes.json().test.id;
  const upload = (content: Buffer, filename: string, s = admin, id = testId) => {
    const boundary = '----aic' + randomUUID();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return t.app.inject({
      method: 'POST',
      url: `/api/tests/${id}/attachments`,
      headers: { ...hdr(s), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
  };
  return {
    ...t,
    dataDir,
    adminRow,
    admin,
    user,
    testId,
    upload,
    get: (url: string, s = admin) => t.app.inject({ method: 'GET', url, headers: hdr(s) }),
    del: (url: string, s = admin) => t.app.inject({ method: 'DELETE', url, headers: hdr(s) }),
  };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((t) => t.destroy()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}, 60_000);

test('dépôt d’un PNG : 201, fichier sous DATA_DIR/attachments/<testId>/, empreinte SHA-256', async () => {
  const t = await setup();
  const res = await t.upload(PNG, 'photo.png');
  expect(res.statusCode).toBe(201);
  const att = res.json().attachment;
  expect(att).toMatchObject({ originalName: 'photo.png', mime: 'image/png', size: PNG.length, pages: null });
  expect(att.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));
  const [row] = await t.db.select().from(testAttachments).where(eq(testAttachments.id, att.id));
  expect(row!.storagePath).toBe(`attachments/${t.testId}/${att.id}`);
  expect(await readFile(path.join(t.dataDir, row!.storagePath))).toEqual(PNG);
  expect(await readdir(path.join(t.dataDir, 'attachments', t.testId))).toEqual([att.id]);
  const test_ = await t.get(`/api/tests/${t.testId}`);
  expect(test_.json().test.attachments).toHaveLength(1);
});

test('HTML renommé en .png → 415, aucun fichier laissé', async () => {
  const t = await setup();
  const res = await t.upload(Buffer.from('<html><script>alert(1)</script></html>'), 'x.png');
  expect(res.statusCode).toBe(415);
  expect(res.json().error).toEqual({
    code: 'unsupported_file_type',
    message: 'Type de fichier non pris en charge : PNG, JPEG, WebP ou PDF',
  });
  const dir = path.join(t.dataDir, 'attachments', t.testId);
  expect(existsSync(dir) ? await readdir(dir) : []).toEqual([]);
});

test('PDF de 11 Mo → 413, aucun fichier laissé', async () => {
  const t = await setup();
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024 * 1024)]);
  const res = await t.upload(big, 'gros.pdf');
  expect(res.statusCode).toBe(413);
  expect(res.json().error).toEqual({ code: 'file_too_large', message: 'Fichier trop volumineux (10 Mo au plus)' });
  const dir = path.join(t.dataDir, 'attachments', t.testId);
  expect(existsSync(dir) ? await readdir(dir) : []).toEqual([]);
});

test('PDF : nombre de pages calculé', async () => {
  const t = await setup();
  const pdf = Buffer.from('%PDF-1.4\n<< /Type /Pages /Count 2 >>\n<< /Type /Page >>\n<< /Type /Page >>\n');
  const res = await t.upload(pdf, 'doc.pdf');
  expect(res.statusCode).toBe(201);
  expect(res.json().attachment).toMatchObject({ mime: 'application/pdf', pages: 2 });
});

test('onzième pièce jointe → 409', async () => {
  const t = await setup();
  for (let i = 0; i < 10; i += 1) expect((await t.upload(PNG, `a${i}.png`)).statusCode).toBe(201);
  const res = await t.upload(PNG, 'a10.png');
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('too_many_attachments');
  expect(await readdir(path.join(t.dataDir, 'attachments', t.testId))).toHaveLength(10);
});

test('test inconnu → 404', async () => {
  const t = await setup();
  expect((await t.upload(PNG, 'a.png', t.admin, randomUUID())).statusCode).toBe(404);
});

test('téléchargement : en-têtes attachment et nosniff', async () => {
  const t = await setup();
  const att = (await t.upload(PNG, 'Café été.png')).json().attachment;
  const res = await t.get(`/api/tests/${t.testId}/attachments/${att.id}/download`);
  expect(res.statusCode).toBe(200);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['content-type']).toBe('image/png');
  expect(res.headers['content-disposition']).toBe(
    `attachment; filename="Caf_ _t_.png"; filename*=UTF-8''Caf%C3%A9%20%C3%A9t%C3%A9.png`,
  );
  expect(res.rawPayload).toEqual(PNG);
});

test('retrait sans instantané : ligne et fichier supprimés', async () => {
  const t = await setup();
  const att = (await t.upload(PNG, 'a.png')).json().attachment;
  const res = await t.del(`/api/tests/${t.testId}/attachments/${att.id}`);
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ outcome: 'deleted' });
  expect(await t.db.select().from(testAttachments).where(eq(testAttachments.id, att.id))).toHaveLength(0);
  expect(existsSync(path.join(t.dataDir, 'attachments', t.testId, att.id))).toBe(false);
  expect((await t.get(`/api/tests/${t.testId}/attachments/${att.id}/download`)).statusCode).toBe(404);
});

test('pièce jointe d’un instantané : retirée du test, fichier conservé', async () => {
  const t = await setup();
  const att = (await t.upload(PNG, 'a.png')).json().attachment;
  const runId = randomUUID();
  await t.db.insert(runs).values({
    id: runId,
    name: 'Série',
    repetitions: 1,
    concurrency: 4,
    status: 'completed',
    weights: { quality: 50, speed: 20, cost: 20, reliability: 10 },
    createdBy: t.adminRow.id,
  });
  await t.db
    .insert(runTests)
    .values({ id: randomUUID(), runId, testId: t.testId, position: 0, snapshot: { attachments: [{ id: att.id, originalName: 'a.png' }] } });
  const res = await t.del(`/api/tests/${t.testId}/attachments/${att.id}`);
  expect(res.json()).toEqual({ outcome: 'detached' });
  const [row] = await t.db.select().from(testAttachments).where(eq(testAttachments.id, att.id));
  expect(row!.deletedAt).not.toBeNull();
  expect(existsSync(path.join(t.dataDir, row!.storagePath))).toBe(true);
  expect((await t.get(`/api/tests/${t.testId}`)).json().test.attachments).toEqual([]);
  expect((await t.get(`/api/tests/${t.testId}/attachments/${att.id}/download`)).statusCode).toBe(404);
});

test('nom d’origine malveillant (../../x) sans effet sur le chemin', async () => {
  const t = await setup();
  const res = await t.upload(PNG, '../../x.png');
  expect(res.statusCode).toBe(201);
  const att = res.json().attachment;
  expect(att.originalName).not.toContain('/');
  expect(await readdir(path.join(t.dataDir, 'attachments', t.testId))).toEqual([att.id]);
  expect(existsSync(path.join(t.dataDir, '..', 'x.png'))).toBe(false);
});

test('readAttachment refuse un chemin qui sort de DATA_DIR', async () => {
  const t = await setup();
  const att = (await t.upload(PNG, 'a.png')).json().attachment;
  expect(await readAttachment({ dataDir: t.dataDir }, { storagePath: `attachments/${t.testId}/${att.id}` })).toEqual(PNG);
  await expect(readAttachment({ dataDir: t.dataDir }, { storagePath: '../../etc/passwd' })).rejects.toThrow();
  await expect(readAttachment({ dataDir: t.dataDir }, { storagePath: path.resolve('/etc/passwd') })).rejects.toThrow();
});

test('Utilisateur : 403 sur dépôt, retrait et téléchargement', async () => {
  const t = await setup();
  const att = (await t.upload(PNG, 'a.png')).json().attachment;
  expect((await t.upload(PNG, 'b.png', t.user)).statusCode).toBe(403);
  expect((await t.del(`/api/tests/${t.testId}/attachments/${att.id}`, t.user)).statusCode).toBe(403);
  expect((await t.get(`/api/tests/${t.testId}/attachments/${att.id}/download`, t.user)).statusCode).toBe(403);
});
