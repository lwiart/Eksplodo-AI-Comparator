import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

// Algorithm.Argon2id (valeur 2) : l'enum @node-rs/argon2 est `const enum`, on utilise la valeur numérique.
const ARGON2ID = 2;
const SECRET_VERSION = 'v1';
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

/** Chiffre `plain` en AES-256-GCM ; format `v1.<iv>.<tag>.<chiffré>` (base64url). */
export function encryptSecret(plain: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SECRET_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

/** Déchiffre un secret produit par `encryptSecret`. Lève une erreur si la clé ou le contenu est invalide. */
export function decryptSecret(payload: string, key: Buffer): string {
  assertKey(key);
  const [version, ivB64 = '', tagB64 = '', dataB64 = ''] = payload.split('.');
  if (payload.split('.').length !== 4 || version !== SECRET_VERSION) {
    throw new Error('Secret chiffré malformé');
  }
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const ciphertext = Buffer.from(dataB64, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Secret chiffré malformé');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
