import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UsersService } from './users.service.js';

const roleEnum = z.enum(['admin', 'user']);
const idParams = z.object({ id: z.string().uuid() });
const inviteBody = z.object({
  email: z.string().trim().min(3).max(320).email(),
  name: z.string().trim().min(1).max(200),
  role: roleEnum,
});
const patchBody = z
  .object({ role: roleEnum, status: z.enum(['active', 'disabled']) })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'aucune modification fournie' });

export function registerUserRoutes(app: FastifyInstance, service: UsersService): void {
  const guard = { preHandler: app.requireAdmin };

  app.get('/api/users', guard, async () => ({ users: await service.listUsers() }));

  app.post('/api/users', guard, async (req, reply) => {
    const body = inviteBody.parse(req.body);
    return reply.status(201).send(await service.inviteUser(req.actor!, body, req.log));
  });

  app.post('/api/users/:id/invite-link', guard, async (req) => {
    const { id } = idParams.parse(req.params);
    return service.regenerateInvite(req.actor!, id, req.log);
  });

  app.post('/api/users/:id/reset-link', guard, async (req) => {
    const { id } = idParams.parse(req.params);
    return service.issueReset(req.actor!, id, req.log);
  });

  app.patch('/api/users/:id', guard, async (req) => {
    const { id } = idParams.parse(req.params);
    const patch = patchBody.parse(req.body);
    return { user: await service.updateUser(req.actor!, id, patch) };
  });
}
