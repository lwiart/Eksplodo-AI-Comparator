import { readSse } from '../../lib/sse.js';
import { httpError, ProviderError, thrownError } from './errors.js';
import { acceptsTemperature, isTemperatureRejection, rememberNoTemperature } from './temperature.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter, ProviderConfig, RemoteModel } from './types.js';

type FinishReason = Extract<GenerateEvent, { type: 'finish' }>['reason'];
type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function mapFinish(raw: string): FinishReason {
  if (raw === 'STOP') return 'stop';
  if (raw === 'MAX_TOKENS') return 'length';
  if (raw === 'SAFETY' || raw === 'RECITATION' || raw === 'PROHIBITED_CONTENT') return 'content_filter';
  return 'other';
}

/** Parties du message utilisateur : pièces jointes (images, puis autres fichiers) en `inline_data`, puis le texte. */
function userParts(req: GenerateRequest): Json[] {
  const inline = (a: GenerateRequest['attachments'][number]) => ({ inline_data: { mime_type: a.mime, data: a.base64 } });
  const images = req.attachments.filter((a) => a.mime.startsWith('image/')).map(inline);
  const files = req.attachments.filter((a) => !a.mime.startsWith('image/')).map(inline);
  return [...images, ...files, { text: req.prompt }];
}

export function createGoogleAdapter(cfg: ProviderConfig): ProviderAdapter {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const doFetch = cfg.fetch ?? globalThis.fetch;
  const secrets = [cfg.apiKey];

  // La clé ne passe que par cet en-tête, jamais par l'URL.
  function headers(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (withBody) h['content-type'] = 'application/json';
    if (cfg.apiKey) h['x-goog-api-key'] = cfg.apiKey;
    return h;
  }

  function requestBody(req: GenerateRequest): Json {
    const generationConfig: Json = { maxOutputTokens: req.maxTokens };
    if (req.temperature !== undefined && acceptsTemperature(cfg.id, req.model)) generationConfig.temperature = req.temperature;
    const body: Json = { contents: [{ role: 'user', parts: userParts(req) }], generationConfig };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    return body;
  }

  const post = (model: string, body: Json, signal: AbortSignal) =>
    doFetch(`${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(body),
      signal,
    });

  async function* generate(req: GenerateRequest, signal: AbortSignal): AsyncGenerator<GenerateEvent> {
    try {
      const body = requestBody(req);
      let res = await post(req.model, body, signal);
      if (!res.ok) {
        const err = httpError(res.status, await res.text(), res.headers, secrets);
        const config = body.generationConfig as Json;
        if (!(isTemperatureRejection(err) && config.temperature !== undefined)) throw err;
        // Le modèle refuse `temperature` : on le mémorise et on renvoie une seule fois sans.
        rememberNoTemperature(cfg.id, req.model);
        delete config.temperature;
        res = await post(req.model, body, signal);
        if (!res.ok) throw httpError(res.status, await res.text(), res.headers, secrets);
      }
      if (!res.body) throw new ProviderError('invalid_response', { detail: 'Réponse sans corps' });

      let finish: FinishReason | null = null;
      let usage: Extract<GenerateEvent, { type: 'usage' }> | null = null;

      for await (const ev of readSse(res.body, signal)) {
        let packet: unknown;
        try {
          packet = JSON.parse(ev.data);
        } catch {
          throw new ProviderError('invalid_response', { detail: 'Paquet de flux non JSON' });
        }
        if (!isRecord(packet)) throw new ProviderError('invalid_response', { detail: 'Paquet de flux inattendu' });

        if (packet.error != null) {
          const e = isRecord(packet.error) ? packet.error : {};
          const code = typeof e.code === 'number' ? e.code : 502;
          throw httpError(code, JSON.stringify(packet), {}, secrets);
        }

        if (isRecord(packet.usageMetadata)) {
          usage = {
            type: 'usage',
            inputTokens: num(packet.usageMetadata.promptTokenCount),
            // `candidatesTokenCount` exclut déjà les pensées (`thoughtsTokenCount`).
            outputTokens: num(packet.usageMetadata.candidatesTokenCount),
            reasoningTokens: num(packet.usageMetadata.thoughtsTokenCount),
            costUsd: undefined,
          };
        }

        const candidate = Array.isArray(packet.candidates) && isRecord(packet.candidates[0]) ? packet.candidates[0] : null;
        if (candidate) {
          const parts = isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
          for (const part of parts) {
            if (!isRecord(part) || typeof part.text !== 'string' || part.text === '') continue;
            yield { type: part.thought === true ? 'reasoning' : 'text', delta: part.text };
          }
          if (finish === null && typeof candidate.finishReason === 'string') finish = mapFinish(candidate.finishReason);
        } else if (finish === null && isRecord(packet.promptFeedback) && typeof packet.promptFeedback.blockReason === 'string') {
          // Requête bloquée avant toute génération : aucun candidat.
          finish = 'content_filter';
        }
      }

      if (usage) yield usage;
      if (finish !== null) yield { type: 'finish', reason: finish };
    } catch (err) {
      throw thrownError(err, signal, secrets);
    }
  }

  async function listModels(signal: AbortSignal): Promise<RemoteModel[]> {
    try {
      const models: RemoteModel[] = [];
      let pageToken: string | undefined;
      do {
        const query = `pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
        const res = await doFetch(`${base}/models?${query}`, { method: 'GET', headers: headers(false), signal });
        if (!res.ok) throw httpError(res.status, await res.text(), res.headers, secrets);
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          throw new ProviderError('invalid_response', { detail: 'Liste de modèles non JSON' });
        }
        const page = isRecord(json) && Array.isArray(json.models) ? json.models : null;
        if (!page) throw new ProviderError('invalid_response', { detail: 'Liste de modèles inattendue' });
        for (const m of page) {
          if (!isRecord(m) || typeof m.name !== 'string') continue;
          const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
          if (!methods.includes('generateContent')) continue;
          const id = m.name.replace(/^models\//, '');
          if (id === '') continue;
          models.push({
            id,
            name: typeof m.displayName === 'string' && m.displayName !== '' ? m.displayName : id,
            contextWindow: num(m.inputTokenLimit) ?? null,
            inputPricePerM: null,
            outputPricePerM: null,
            supportsVision: null,
            supportsPdf: null,
          });
        }
        pageToken = isRecord(json) && typeof json.nextPageToken === 'string' && json.nextPageToken !== '' ? json.nextPageToken : undefined;
      } while (pageToken);
      return models;
    } catch (err) {
      throw thrownError(err, signal, secrets);
    }
  }

  return { generate, listModels };
}
