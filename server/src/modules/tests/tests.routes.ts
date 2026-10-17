import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { AppError } from '../../errors.js';
import { addAttachment, findAttachment, removeAttachment, resolveAttachmentPath, type AttachmentsDeps } from './attachments.js';
import type { TestsService } from './tests.service.js';

const idParams = z.object({ id: z.string().uuid() });
const attachmentParams = z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() });

/** `Content-Disposition` en pièce jointe : repli ASCII + `filename*` (RFC 5987) pour le nom d'origine. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const listQuery = z
  .object({
    archived: z.enum(['true', 'false']).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    tag: z.string().trim().min(1).max(50).optional(),
    q: z.string().trim().max(200).optional(),
  })
  .strict();

// La configuration de notation est validée par `parseScoringConfig` selon la méthode (dans le service).
const testBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    category: z.string().trim().min(1).max(100),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
    systemPrompt: z.string().max(50_000).nullable().default(null),
    userPrompt: z.string().min(1).max(100_000),
    temperature: z.number().min(0).max(2).default(0.2),
    maxTokens: z.number().int().min(1).max(16_000).default(1000),
    scoringMethod: z.enum(['judge', 'expected', 'manual']),
    scoringConfig: z.unknown(),
  })
  .strict();

export function registerTestsRoutes(app: FastifyInstance, service: TestsService, attachments: AttachmentsDeps): void {
  const admin = { preHandler: app.requireAdmin };

  app.get('/api/tests', admin, async (req) => {
    const q = listQuery.parse(req.query);
    return {
      tests: await service.list({ archived: q.archived === 'true', category: q.category, tag: q.tag, q: q.q }),
    };
  });

  app.get('/api/tests/meta', admin, async () => {
    const [categories, tags] = await Promise.all([service.categories(), service.tags()]);
    return { categories, tags };
  });

  app.get('/api/tests/:id', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { test: await service.get(id) };
  });

  app.post('/api/tests', admin, async (req, reply) => {
    const body = testBody.parse(req.body);
    return reply.status(201).send({ test: await service.create(req.actor!, body) });
  });

  app.put('/api/tests/:id', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = testBody.parse(req.body);
    return { test: await service.update(req.actor!, id, body) };
  });

  app.delete('/api/tests/:id', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { outcome: await service.remove(req.actor!, id) };
  });

  app.post('/api/tests/:id/restore', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { test: await service.restore(req.actor!, id) };
  });

  app.post('/api/tests/:id/attachments', admin, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const part = await req.file();
    if (!part) throw new AppError('validation', 400, 'Fichier manquant (champ « file »)');
    try {
      if (part.fieldname !== 'file') throw new AppError('validation', 400, 'Fichier manquant (champ « file »)');
      const attachment = await addAttachment(attachments, req.actor!, id, { filename: part.filename, stream: part.file });
      return reply.status(201).send({ attachment });
    } catch (err) {
      part.file.resume(); // le reste du corps est lu et jeté pour que la réponse arrive sur une connexion intacte
      throw err;
    }
  });

  app.delete('/api/tests/:id/attachments/:attachmentId', admin, async (req) => {
    const { id, attachmentId } = attachmentParams.parse(req.params);
    return { outcome: await removeAttachment(attachments, req.actor!, id, attachmentId) };
  });

  app.get('/api/tests/:id/attachments/:attachmentId/download', admin, async (req, reply) => {
    const { id, attachmentId } = attachmentParams.parse(req.params);
    const row = await findAttachment(attachments, id, attachmentId);
    return reply
      .header('content-type', row.mime)
      .header('content-length', row.size)
      .header('content-disposition', contentDisposition(row.originalName))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(createReadStream(resolveAttachmentPath(attachments.config.dataDir, row.storagePath)));
  });
}
