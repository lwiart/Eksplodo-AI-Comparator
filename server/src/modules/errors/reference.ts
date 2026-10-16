import { createHash, randomInt } from 'node:crypto';

/** Sans 0, O, 1, I, L : une référence se lit et se dicte sans ambiguïté. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Référence courte d'un événement : `E-` suivi de 5 caractères (par exemple `E-7K2QX`). */
export function newReference(): string {
  let out = 'E-';
  for (let i = 0; i < 5; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const LONG_HEX = /\b[0-9a-f]{8,}\b/g;
const NUMBERS = /\d+/g;

/** Message sans ce qui varie d'une occurrence à l'autre : minuscules, UUID, longs nombres hexadécimaux et chiffres -> `#`. */
export function normalizeMessage(message: string): string {
  return message.toLowerCase().replace(UUID, '#').replace(LONG_HEX, '#').replace(NUMBERS, '#');
}

/** Empreinte de regroupement (SHA-256 hexadécimal) : source, origine, code, statut HTTP et message normalisé. */
export function fingerprintOf(e: {
  source: string;
  origin: string;
  code: string;
  httpStatus?: number | null;
  message: string;
}): string {
  const parts = [e.source, e.origin, e.code, e.httpStatus == null ? '' : String(e.httpStatus), normalizeMessage(e.message)];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}
