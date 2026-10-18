import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

// Algorithm.Argon2id (valeur 2) : l'enum @node-rs/argon2 est `const enum`, on utilise la valeur numérique.
const ARGON2ID = 2;
/** v2 : chiffré lié à un contexte (données associées GCM). v1 : ancien format sans contexte, lu seulement pour conversion. */
const SECRET_VERSION = 'v2';
const LEGACY_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

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

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error('Clé de chiffrement invalide : 32 octets attendus');
  }
}

/**
 * Chiffre `plain` en AES-256-GCM, lié à `context` (données associées) : le chiffré ne se déchiffre qu'avec ce même
 * contexte, si bien qu'un chiffré recopié ailleurs ou un contexte modifié en base le rend illisible.
 * Format `v2.<iv>.<tag>.<chiffré>` (base64url).
 */
export function encryptSecret(plain: string, key: Buffer, context: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SECRET_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function open(payload: string, key: Buffer, version: string, context: string | null): string {
  assertKey(key);
  const [found, ivB64 = '', tagB64 = '', dataB64 = ''] = payload.split('.');
  if (payload.split('.').length !== 4 || found !== version) {
    throw new Error('Secret chiffré malformé');
  }
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const ciphertext = Buffer.from(dataB64, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Secret chiffré malformé');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (context !== null) decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Déchiffre un secret produit par `encryptSecret` avec le même `context`. Lève une erreur sinon (clé, contexte ou contenu). */
export function decryptSecret(payload: string, key: Buffer, context: string): string {
  return open(payload, key, SECRET_VERSION, context);
}

/** Ancien format v1 (sans contexte) : `decryptSecret` le refuse. */
export function isLegacySecret(payload: string): boolean {
  return payload.startsWith(`${LEGACY_VERSION}.`);
}

/** Déchiffre un secret v1 : réservé à sa conversion en v2 au démarrage. */
export function decryptLegacySecret(payload: string, key: Buffer): string {
  return open(payload, key, LEGACY_VERSION, null);
}
