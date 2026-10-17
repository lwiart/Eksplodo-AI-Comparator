// Faux fournisseur hors ligne : tests, développement et démonstrations (AIC_FAKE_LLM=1).
// Déterministe pour (graine, modèle, prompt) ; la seule source d'aléa est un PRNG amorcé par un hachage.
import { httpError } from './errors.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter, RemoteModel } from './types.js';

type Profile = { firstTokenMs: number; tokensPerSecond: number; errorRate: number };

const PROFILES: Record<string, Profile> = {
  'fake-rapide': { firstTokenMs: 300, tokensPerSecond: 120, errorRate: 0 },
  'fake-equilibre': { firstTokenMs: 800, tokensPerSecond: 60, errorRate: 0 },
  'fake-lent': { firstTokenMs: 2000, tokensPerSecond: 25, errorRate: 0 },
  'fake-instable': { firstTokenMs: 600, tokensPerSecond: 50, errorRate: 0.25 },
  'fake-vision': { firstTokenMs: 500, tokensPerSecond: 80, errorRate: 0 },
};

/** Appels déjà reçus par (modèle, prompt) : une nouvelle tentative sur `fake-instable` tire un autre sort. Niveau module, car le registre crée un adaptateur par appel. */
const callCounters = new Map<string, number>();

/** Remet les compteurs d'appels à zéro (tests). */
export function resetFakeCallCounters(): void {
  callCounters.clear();
}

function fakeModel(id: string, name: string, inputPricePerM: number, outputPricePerM: number, vision = false): RemoteModel {
  return {
    id,
    name,
    contextWindow: 128_000,
    inputPricePerM,
    outputPricePerM,
    supportsVision: vision,
    supportsPdf: vision,
  };
}

export const FAKE_MODELS: RemoteModel[] = [
  fakeModel('fake-rapide', 'Faux rapide', 0.5, 1.5),
  fakeModel('fake-equilibre', 'Faux équilibré', 2, 8),
  fakeModel('fake-lent', 'Faux lent', 0.2, 0.6),
  fakeModel('fake-instable', 'Faux instable', 1, 3),
  fakeModel('fake-vision', 'Faux vision', 3, 12, true),
];

const CHARS_PER_TOKEN = 4;
const TOKENS_PER_IMAGE = 1500;
const TOKENS_PER_PDF = 800;
const CHUNK_TOKENS = 4;
const JITTER = 0.2;

const WORDS = [
  'le', 'la', 'un', 'une', 'et', 'de', 'des', 'pour', 'dans', 'avec', 'plus', 'très', 'cette', 'notre',
  'modèle', 'réponse', 'analyse', 'texte', 'exemple', 'résultat', 'question', 'contexte', 'idée', 'point',
  'clair', 'simple', 'utile', 'rapide', 'précis', 'complet', 'montre', 'permet', 'explique', 'résume',
  'ainsi', 'donc', 'enfin', 'souvent', 'parfois', 'toujours', 'ensemble', 'chaque', 'autre', 'même',
];

/** Hachage FNV-1a 32 bits. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Attente annulable par le signal (rejette avec sa raison). */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sentence(rng: () => number, minChars: number): string {
  let out = '';
  while (out.length < minChars) {
    const words = 5 + Math.floor(rng() * 6);
    const parts: string[] = [];
    for (let i = 0; i < words; i++) parts.push(WORDS[Math.floor(rng() * WORDS.length)]!);
    const s = parts.join(' ');
    out += `${s.charAt(0).toUpperCase()}${s.slice(1)}. `;
  }
  return out.trimEnd();
}

function inputTokens(req: GenerateRequest): number {
  const chars = (req.system?.length ?? 0) + req.prompt.length;
  let tokens = Math.ceil(chars / CHARS_PER_TOKEN);
  for (const a of req.attachments) tokens += a.mime === 'application/pdf' ? TOKENS_PER_PDF : TOKENS_PER_IMAGE;
  return tokens;
}

export function createFakeAdapter(
  opts: { sleep?: (ms: number, signal: AbortSignal) => Promise<void>; seed?: number } = {},
): ProviderAdapter {
  const sleep = opts.sleep ?? defaultSleep;
  const seed = opts.seed ?? 0;

  async function* generate(req: GenerateRequest, signal: AbortSignal): AsyncGenerator<GenerateEvent> {
    const profile = PROFILES[req.model] ?? PROFILES['fake-equilibre']!;

    const key = `${req.model}|${req.prompt}`;
    const callIndex = callCounters.get(key) ?? 0;
    callCounters.set(key, callIndex + 1);

    const rng = mulberry32(fnv1a(`${seed}|${key}`));
    // Seul le tirage d'échec dépend du compteur : le texte reste reproductible d'un appel à l'autre.
    const failRng = mulberry32(fnv1a(`${seed}|${key}|${callIndex}`));
    // Tirages dans un ordre fixe, quelles que soient les directives, pour garder le flux reproductible.
    const latencyFactor = 1 - JITTER + 2 * JITTER * rng();
    const rateFactor = 1 - JITTER + 2 * JITTER * rng();
    const failRoll = failRng();
    const failKind = failRng();
    const naturalTokens = 60 + Math.floor(rng() * 60);
    const has = (d: string) => req.prompt.includes(`[[fake:${d}]]`);

    if (has('429')) throw httpError(429, 'Limite de débit factice', {}, []);
    if (has('500')) throw httpError(500, 'Erreur serveur factice', {}, []);
    if (has('timeout')) {
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw signal.reason;
    }
    if (profile.errorRate > 0 && failRoll < profile.errorRate) {
      throw failKind < 0.5 ? httpError(429, 'Limite de débit factice', {}, []) : httpError(500, 'Erreur serveur factice', {}, []);
    }

    await sleep(Math.round(profile.firstTokenMs * latencyFactor), signal);

    const refusal = has('refusal');
    const forcedLength = has('length');
    const wanted = refusal ? 12 : forcedLength ? Math.max(naturalTokens, req.maxTokens + 1) : naturalTokens;
    const outputTokens = Math.min(wanted, req.maxTokens);
    const cappedByLength = !refusal && (forcedLength || wanted > req.maxTokens);

    let reasoningTokens = 0;
    if (has('reasoning')) {
      reasoningTokens = Math.min(24, req.maxTokens);
      yield { type: 'reasoning', delta: sentence(rng, reasoningTokens * CHARS_PER_TOKEN).slice(0, reasoningTokens * CHARS_PER_TOKEN) };
    }

    const text = refusal
      ? 'Je ne peux pas répondre à cette demande.'.slice(0, outputTokens * CHARS_PER_TOKEN)
      : sentence(rng, outputTokens * CHARS_PER_TOKEN).slice(0, outputTokens * CHARS_PER_TOKEN);
    const chunkChars = CHUNK_TOKENS * CHARS_PER_TOKEN;
    const msPerChunk = Math.round((CHUNK_TOKENS / profile.tokensPerSecond) * 1000 * rateFactor);
    const cut = has('cut');
    const cutAfter = cut ? Math.max(chunkChars, Math.floor(text.length / 2)) : Infinity;

    for (let offset = 0; offset < text.length; offset += chunkChars) {
      if (signal.aborted) throw signal.reason;
      if (offset > 0) await sleep(msPerChunk, signal);
      if (offset >= cutAfter) return; // flux coupé : ni usage ni finish
      yield { type: 'text', delta: text.slice(offset, offset + chunkChars) };
    }
    if (cut) return;

    yield {
      type: 'usage',
      inputTokens: inputTokens(req),
      outputTokens, // hors raisonnement, compté à part
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    };
    yield { type: 'finish', reason: refusal ? 'refusal' : cappedByLength ? 'length' : 'stop' };
  }

  async function listModels(): Promise<RemoteModel[]> {
    return FAKE_MODELS.map((m) => ({ ...m }));
  }

  return { generate, listModels };
}
