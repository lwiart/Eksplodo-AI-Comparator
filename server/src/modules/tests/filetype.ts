export type AttachmentMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

/** Type d'une pièce jointe d'après sa signature (jamais l'extension ni le type annoncé) ; `null` si non pris en charge. */
export function detectFileType(head: Buffer): AttachmentMime | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG)) return 'image/png';
  if (head.length >= 3 && head.subarray(0, 3).equals(JPEG)) return 'image/jpeg';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 5 && head.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** Nombre de pages d'un PDF : objets `/Type /Page` (hors nœuds `/Pages`) ; 1 au minimum si rien n'est repérable. */
export function countPdfPages(buf: Buffer): number {
  const matches = buf.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g);
  return Math.max(1, matches?.length ?? 0);
}
