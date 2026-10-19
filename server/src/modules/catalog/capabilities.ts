// Vérification des capacités d'un modèle (images, PDF) par de tout petits appels réels au fournisseur.
import { deflateSync } from 'node:zlib';
import { ProviderError, readableDetail, thrownError, type ProviderErrorCode } from '../providers/errors.js';
import type { GenerateRequest, ProviderAdapter } from '../providers/types.js';

/** `supported` : `true` accepté, `false` refusé par le fournisseur, `null` inconnu (clé, délai, indisponibilité…). */
export type CapabilityResult = { supported: boolean | null; message: string };
/** `contextWindow` : fenêtre de contexte lue dans la liste des modèles du fournisseur (gratuite), `null` si absente. */
export type CapabilityCheck = { vision: CapabilityResult; pdf: CapabilityResult; contextWindow: number | null };

/** Délai de chaque appel : les trois partent ensemble, la réponse HTTP reste loin de la coupure de 60 s de l'hébergeur. */
export const PROBE_TIMEOUT_MS = 20_000;
/** Sortie minimale : seule compte l'acceptation de la pièce jointe, l'appel s'arrête au premier signe de réponse. */
const PROBE_MAX_TOKENS = 16;

/** Codes qui veulent dire « ce modèle ne prend pas cette pièce jointe » quand l'appel texte seul passe. */
const REFUSAL_CODES: ReadonlySet<ProviderErrorCode> = new Set(['bad_request', 'model_not_found', 'invalid_response', 'context_too_long']);

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG 32 × 32 uni (orange Eksplodo) : assez grand pour les fournisseurs qui refusent les images minuscules. */
function samplePng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const size = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8 bits par canal
  header[9] = 2; // RVB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [0xf0, 0x63, 0x1f]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** PDF d'une page portant le mot « Bonjour ». */
function samplePdf(): Buffer {
  const text = 'BT /F1 24 Tf 72 720 Td (Bonjour) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const SAMPLE_PNG = samplePng();
export const SAMPLE_PDF = samplePdf();

type Probe = { ok: true } | { ok: false; error: ProviderError };

/** Un appel : accepté dès le premier événement du flux (texte, réflexion, usage ou fin), sinon l'erreur du fournisseur. */
async function probe(adapter: ProviderAdapter, req: GenerateRequest, timeoutMs: number): Promise<Probe> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('Délai dépassé', 'TimeoutError')), timeoutMs);
  try {
    for await (const _event of adapter.generate(req, ctrl.signal)) break; // la sortie de boucle ferme le flux
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ProviderError ? err : thrownError(err, ctrl.signal, []) };
  } finally {
    clearTimeout(timer);
  }
}

const describe = (e: ProviderError) => {
  const detail = readableDetail(e.detail);
  return detail ? `${e.message} : ${detail}` : e.message;
};

/** Libellés accordés : « Image acceptée », « PDF accepté ». */
const LABELS = {
  vision: { accepted: 'Image acceptée par le modèle.', refused: 'Image refusée' },
  pdf: { accepted: 'PDF accepté par le modèle.', refused: 'PDF refusé' },
} as const;

function verdict(result: Probe, kind: keyof typeof LABELS): CapabilityResult {
  if (result.ok) return { supported: true, message: LABELS[kind].accepted };
  if (REFUSAL_CODES.has(result.error.code)) return { supported: false, message: `${LABELS[kind].refused} : ${describe(result.error)}` };
  return { supported: null, message: `Indéterminé : ${describe(result.error)}` };
}

/**
 * Fenêtre de contexte du modèle d'après la liste des modèles du fournisseur (aucun token consommé). Liste illisible,
 * modèle absent ou taille non publiée : `null`, la vérification des capacités n'en dépend pas.
 */
export async function findContextWindow(adapter: ProviderAdapter, apiModelId: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<number | null> {
  try {
    const list = await adapter.listModels(AbortSignal.timeout(timeoutMs));
    const id = apiModelId.replace(/^models\//, '');
    return list.find((m) => m.id === id || m.id === apiModelId)?.contextWindow ?? null;
  } catch {
    return null;
  }
}

/**
 * Trois appels en parallèle : texte seul (contrôle), petite image, PDF d'une page ; en même temps, la fenêtre de contexte
 * est lue dans la liste des modèles. Si le texte seul échoue (clé, modèle
 * inconnu, fournisseur indisponible), rien ne peut être conclu : les deux capacités restent inconnues.
 */
export async function checkCapabilities(adapter: ProviderAdapter, apiModelId: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<CapabilityCheck> {
  const request = (attachments: GenerateRequest['attachments']): GenerateRequest => ({
    model: apiModelId,
    prompt: attachments.length === 0 ? 'Réponds simplement « OK ».' : 'Que contient la pièce jointe ? Réponds en un mot.',
    attachments,
    maxTokens: PROBE_MAX_TOKENS,
  });
  const [contextWindow, text, image, pdf] = await Promise.all([
    findContextWindow(adapter, apiModelId, timeoutMs),
    probe(adapter, request([]), timeoutMs),
    probe(adapter, request([{ mime: 'image/png', base64: SAMPLE_PNG.toString('base64'), filename: 'verification.png' }]), timeoutMs),
    probe(adapter, request([{ mime: 'application/pdf', base64: SAMPLE_PDF.toString('base64'), filename: 'verification.pdf' }]), timeoutMs),
  ]);
  if (!text.ok) {
    const message = `Indéterminé : l'appel sans pièce jointe a lui aussi échoué (${describe(text.error)}).`;
    return { vision: { supported: null, message }, pdf: { supported: null, message }, contextWindow };
  }
  return { vision: verdict(image, 'vision'), pdf: verdict(pdf, 'pdf'), contextWindow };
}
