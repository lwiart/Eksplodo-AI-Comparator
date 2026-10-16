import { apiFetch } from './client';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'invited' | 'active' | 'disabled';
export type MailStatus = 'sent' | 'failed' | 'not_configured';

export type ManagedUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
};

/** Lien à usage unique renvoyé par le serveur (affiché une seule fois) et état de l'envoi par e-mail. */
export type IssuedLink = { link: string; expiresAt: string; mail: MailStatus };

export const USERS_KEY = ['admin', 'users'] as const;

export async function listUsers(): Promise<ManagedUser[]> {
  return (await apiFetch<{ users: ManagedUser[] }>('/api/users')).users;
}

export function inviteUser(body: { email: string; name: string; role: UserRole }): Promise<IssuedLink & { user: ManagedUser }> {
  return apiFetch('/api/users', { method: 'POST', body });
}

export function regenerateInvite(id: string): Promise<IssuedLink> {
  return apiFetch(`/api/users/${encodeURIComponent(id)}/invite-link`, { method: 'POST' });
}

export function issueReset(id: string): Promise<IssuedLink> {
  return apiFetch(`/api/users/${encodeURIComponent(id)}/reset-link`, { method: 'POST' });
}

export async function updateUser(
  id: string,
  patch: { role?: UserRole; status?: 'active' | 'disabled' },
): Promise<ManagedUser> {
  return (await apiFetch<{ user: ManagedUser }>(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })).user;
}
