import { ForbiddenError } from '../../errors.js';

export type Role = 'admin' | 'user';

export type Actor = { userId: string; role: Role; email: string; name: string };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) throw new ForbiddenError();
}
