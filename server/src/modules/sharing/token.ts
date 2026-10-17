import { createHash, randomBytes } from 'node:crypto';

/** Empreinte SHA-256 (hex, 64 caractères) d'un jeton de partage : seule elle est stockée en base. */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Jeton aléatoire de 24 octets en base64url (32 caractères) et son empreinte. */
export function newShareToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: hashShareToken(token) };
}
