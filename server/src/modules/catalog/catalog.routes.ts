import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogService } from './catalog.service.js';

const idParams = z.object({ id: z.string().uuid() });

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
const baseUrl = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname));
      } catch {
        return false;
      }
    },
    { message: 'URL https: attendue (http: seulement vers localhost ou 127.0.0.1)' },
  );

// La validité de la clé (caractères, longueur) est contrôlée par `sealApiKey`, dont le message ne reprend jamais la valeur.
const providerType = z.enum(['openai_compatible', 'anthropic', 'google']);
const name = z.string().trim().min(1).max(100);
const maxConcurrency = z.number().int().min(1).max(10);

const createProviderBody = z
  .object({ name, type: providerType, baseUrl, maxConcurrency: maxConcurrency.optional(), apiKey: z.string().optional() })
  .strict();
const patchProviderBody = z
  .object({
    name: name.optional(),
    type: providerType.optional(),
    baseUrl: baseUrl.optional(),
    maxConcurrency: maxConcurrency.optional(),
    enabled: z.boolean().optional(),
    apiKey: z.string().nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'aucune modification fournie' });

const price = z
  .number()
  .min(0)
  .max(100_000)
  .refine((v) => Math.abs(v * 10_000 - Math.round(v * 10_000)) < 1e-6, { message: '4 décimales au plus' });
const displayName = z.string().trim().min(1).max(200);
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'couleur #RRGGBB attendue');
const contextWindow = z.number().int().positive().nullable();

const createModelBody = z
  .object({
    providerId: z.string().uuid(),
    apiModelId: z.string().trim().min(1).max(200),
    displayName,
    color: color.optional(),
    inputPricePerM: price.optional(),
    outputPricePerM: price.optional(),
    priceSource: z.enum(['manual', 'openrouter']).optional(),
    supportsVision: z.boolean().optional(),
    supportsPdf: z.boolean().optional(),
    contextWindow: contextWindow.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const patchModelBody = z
  .object({
    displayName: displayName.optional(),
    color: color.optional(),
    inputPricePerM: price.optional(),
    outputPricePerM: price.optional(),
    priceSource: z.enum(['manual', 'openrouter']).optional(),
    supportsVision: z.boolean().optional(),
    supportsPdf: z.boolean().optional(),
    contextWindow: contextWindow.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'aucune modification fournie' });

export function registerCatalogRoutes(app: FastifyInstance, service: CatalogService): void {
  const connected = { preHandler: app.requireActor };
  const admin = { preHandler: app.requireAdmin };

  app.get('/api/providers', connected, async (req) => ({ providers: await service.listProviders(req.actor!) }));

  app.post('/api/providers', admin, async (req, reply) => {
    const body = createProviderBody.parse(req.body);
    return reply.status(201).send({ provider: await service.createProvider(req.actor!, body) });
  });

  app.patch('/api/providers/:id', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    const patch = patchProviderBody.parse(req.body);
    return { provider: await service.updateProvider(req.actor!, id, patch) };
  });

  app.post('/api/providers/:id/test', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return service.testConnection(id);
  });

  app.get('/api/providers/:id/remote-models', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    return { models: await service.remoteModels(id) };
  });

  app.get('/api/models', connected, async (req) => ({ models: await service.listModels(req.actor!) }));

  app.get('/api/models/:id', connected, async (req) => {
    const { id } = idParams.parse(req.params);
    return { model: await service.getModel(req.actor!, id) };
  });

  app.post('/api/models', admin, async (req, reply) => {
    const body = createModelBody.parse(req.body);
    return reply.status(201).send({ model: await service.createModel(req.actor!, body) });
  });

  app.patch('/api/models/:id', admin, async (req) => {
    const { id } = idParams.parse(req.params);
    const patch = patchModelBody.parse(req.body);
    return { model: await service.updateModel(req.actor!, id, patch) };
  });
}
