import { inflateSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { SAMPLE_PDF, SAMPLE_PNG, checkCapabilities } from '../src/modules/catalog/capabilities.js';
import { httpError } from '../src/modules/providers/errors.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter } from '../src/modules/providers/types.js';

type Behaviour = 'ok' | 'never' | Error;

/** Adaptateur factice : comportement choisi selon la pièce jointe (aucune, image, PDF). */
function adapter(behaviour: { text: Behaviour; image: Behaviour; pdf: Behaviour }): ProviderAdapter & { seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  return {
    seen,
    async *generate(req: GenerateRequest, signal: AbortSignal): AsyncGenerator<GenerateEvent> {
      seen.push(req);
      const kind = req.attachments.length === 0 ? 'text' : req.attachments[0]!.mime === 'application/pdf' ? 'pdf' : 'image';
      const b = behaviour[kind];
      if (b instanceof Error) throw b;
      if (b === 'never') {
        await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      yield { type: 'text', delta: 'OK' };
      yield { type: 'finish', reason: 'stop' };
    },
    async listModels() {
      return [];
    },
  };
}

const deepseekPdfError = httpError(400, '{"error":{"message":"messages[0]: file must have a file_id or file_data"}}', {}, []);

test('image acceptée, PDF refusé : le message du fournisseur explique le refus', async () => {
  const a = adapter({ text: 'ok', image: 'ok', pdf: deepseekPdfError });
  const result = await checkCapabilities(a, 'deepseek-flash');
  expect(result.vision).toEqual({ supported: true, message: 'Image acceptée par le modèle.' });
  expect(result.pdf.supported).toBe(false);
  expect(result.pdf.message).toBe('PDF refusé : Requête refusée par le fournisseur : messages[0]: file must have a file_id or file_data');
  // Trois appels minuscules : contrôle sans pièce jointe, image, PDF ; toujours le même modèle.
  expect(a.seen.map((r) => r.attachments.map((x) => x.mime))).toEqual(expect.arrayContaining([[], ['image/png'], ['application/pdf']]));
  expect(a.seen.every((r) => r.model === 'deepseek-flash' && r.maxTokens === 16)).toBe(true);
});

test('« modèle introuvable » sur la pièce jointe (aucun point d’accès qui lit les images) : refusé', async () => {
  const result = await checkCapabilities(adapter({ text: 'ok', image: httpError(404, '{"error":{"message":"No endpoints found that support image input"}}', {}, []), pdf: 'ok' }), 'm');
  expect(result.vision.supported).toBe(false);
  expect(result.pdf.supported).toBe(true);
});

test('appel de contrôle en échec (clé refusée) : rien ne peut être conclu, les deux capacités restent inconnues', async () => {
  const auth = httpError(401, '{"error":"invalid key"}', {}, []);
  const result = await checkCapabilities(adapter({ text: auth, image: auth, pdf: auth }), 'm');
  expect(result.vision.supported).toBeNull();
  expect(result.pdf.supported).toBeNull();
  expect(result.vision.message).toMatch(/^Indéterminé : l'appel sans pièce jointe a lui aussi échoué/);
});

test('pas de réponse dans le délai, ou fournisseur indisponible : inconnu, pas refusé', async () => {
  const result = await checkCapabilities(adapter({ text: 'ok', image: 'never', pdf: httpError(503, 'surcharge', {}, []) }), 'm', 50);
  expect(result.vision).toEqual({ supported: null, message: 'Indéterminé : Délai dépassé' });
  expect(result.pdf.supported).toBeNull();
});

test('échantillons valides : PNG 32 × 32 orange et PDF d’une page', () => {
  expect([...SAMPLE_PNG.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(SAMPLE_PNG.readUInt32BE(16)).toBe(32);
  expect(SAMPLE_PNG.readUInt32BE(20)).toBe(32);
  const idat = SAMPLE_PNG.indexOf('IDAT');
  const raw = inflateSync(SAMPLE_PNG.subarray(idat + 4, idat + 4 + SAMPLE_PNG.readUInt32BE(idat - 4)));
  expect([...raw.subarray(1, 4)]).toEqual([0xf0, 0x63, 0x1f]);
  const pdf = SAMPLE_PDF.toString('latin1');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf).toContain('/Count 1');
  expect(pdf).toContain('(Bonjour) Tj');
  expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
});
