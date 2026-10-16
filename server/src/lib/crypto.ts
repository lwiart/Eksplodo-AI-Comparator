import { createHash, randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

// Algorithm.Argon2id (valeur 2) : l'enum @node-rs/argon2 est `const enum`, on utilise la valeur numérique.
const ARGON2ID = 2;

export function hashPassword(password: string): Promise<string> {
  return argonHash(password, { algorithm: ARGON2ID });
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argonVerify(hash, password);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Jeton aléatoire de 32 octets (base64url, 43 caractères) ; `hash` est son SHA-256 hexadécimal. */
export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256Hex(token) };
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}
