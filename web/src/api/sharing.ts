import { apiFetch } from './client';

// Types miroirs de server/src/modules/sharing/share-links.service.ts.
/** `auto` : verdict proposé automatiquement, recalculé à chaque affichage de la page publique (modèle et phrase). */
export type VerdictAuto = 'global' | 'quality' | 'cost';
export type ShareVerdict = { label: string; modelId: string | null; text: string; auto?: VerdictAuto };

export type ShareLink = {
  id: string;
  runId: string;
  runName: string;
  title: string;
  intro: string | null;
  verdicts: ShareVerdict[];
  showCosts: boolean;
  showResponses: boolean;
  active: boolean;
  viewCount: number;
  /** Le lien peut être recopié ; faux pour un lien créé avant cette possibilité (le régénérer une fois). */
  tokenAvailable: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Champs modifiables d'un lien (corps de création sans la série, corps du PATCH sans `active`). */
export type ShareLinkFields = {
  title: string;
  intro: string | null;
  verdicts: ShareVerdict[];
  showCosts: boolean;
  showResponses: boolean;
};

/** Le jeton en clair n'est renvoyé qu'à la création et à la régénération. */
export type IssuedShareLink = { link: ShareLink; token: string };

export const SHARE_LINKS_KEY = ['admin', 'share-links'] as const;
export const SHARING_SETTINGS_KEY = ['admin', 'settings', 'sharing'] as const;

const enc = encodeURIComponent;

export async function listShareLinks(runId?: string): Promise<ShareLink[]> {
  const query = runId ? `?runId=${enc(runId)}` : '';
  return (await apiFetch<{ links: ShareLink[] }>(`/api/share-links${query}`)).links;
}

export function createShareLink(body: ShareLinkFields & { runId: string }): Promise<IssuedShareLink> {
  return apiFetch('/api/share-links', { method: 'POST', body });
}

/** Le serveur attend le corps complet, `active` compris. */
export async function updateShareLink(id: string, patch: ShareLinkFields & { active: boolean }): Promise<ShareLink> {
  return (await apiFetch<{ link: ShareLink }>(`/api/share-links/${enc(id)}`, { method: 'PATCH', body: patch })).link;
}

export function regenerateShareLink(id: string): Promise<IssuedShareLink> {
  return apiFetch(`/api/share-links/${enc(id)}/regenerate`, { method: 'POST' });
}

/** Jeton en clair d'un lien existant, pour recopier le lien sans le régénérer. */
export async function getShareLinkToken(id: string): Promise<string> {
  return (await apiFetch<{ token: string }>(`/api/share-links/${enc(id)}/token`)).token;
}

export function deleteShareLink(id: string): Promise<void> {
  return apiFetch(`/api/share-links/${enc(id)}`, { method: 'DELETE' });
}

export async function getSharingSettings(): Promise<{ auditUrl: string }> {
  return apiFetch('/api/settings/sharing');
}

export function saveSharingSettings(auditUrl: string): Promise<{ auditUrl: string }> {
  return apiFetch('/api/settings/sharing', { method: 'PUT', body: { auditUrl } });
}

/** Adresse publique d'un lien : page sans session ni menu. */
export const shareUrl = (token: string): string => `${location.origin}/p/${token}`;
