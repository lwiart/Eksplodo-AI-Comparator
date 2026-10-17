import { readSse } from '../../lib/sse.js';
import { httpError, ProviderError, thrownError } from './errors.js';
import { isOpenRouter, parseOpenRouterModels } from './openrouter.js';
import { acceptsTemperature, isTemperatureRejection, rememberNoTemperature } from './temperature.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter, ProviderConfig, RemoteModel } from './types.js';

type FinishReason = Extract<GenerateEvent, { type: 'finish' }>['reason'];
type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function mapFinish(raw: string): FinishReason {
  if (raw === 'stop') return 'stop';
  if (raw === 'length') return 'length';
  if (raw === 'content_filter') return 'content_filter';
  return 'other';
}

function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return null;
  }
}

/** Contenu du message utilisateur : chaîne simple, ou parties (images, PDF, puis texte) s'il y a des pièces jointes. */
function userContent(req: GenerateRequest): string | Json[] {
  if (req.attachments.length === 0) return req.prompt;
  const images = req.attachments
    .filter((a) => a.mime.startsWith('image/'))
    .map((a) => ({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.base64}` } }));
  const files = req.attachments
    .filter((a) => !a.mime.startsWith('image/'))
    .map((a) => ({ type: 'file', file: { filename: a.filename, file_data: `data:${a.mime};base64,${a.base64}` } }));
  return [...images, ...files, { type: 'text', text: req.prompt }];
}

export function createOpenAiCompatibleAdapter(cfg: ProviderConfig): ProviderAdapter {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const doFetch = cfg.fetch ?? globalThis.fetch;
  const secrets = [cfg.apiKey];
  const openRouter = isOpenRouter(base);
  const officialOpenAi = hostOf(base) === 'api.openai.com';

  function headers(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (withBody) h['content-type'] = 'application/json';
    if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
    if (openRouter) {
      h['HTTP-Referer'] = cfg.appBaseUrl;
      h['X-Title'] = 'Eksplodo Comparateur IA';
    }
    return h;
  }

  function requestBody(req: GenerateRequest): Json {
    const messages: Json[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: userContent(req) });
    const body: Json = {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      [officialOpenAi ? 'max_completion_tokens' : 'max_tokens']: req.maxTokens,
    };
    if (req.temperature !== undefined && acceptsTemperature(cfg.id, req.model)) body.temperature = req.temperature;
    if (openRouter) body.usage = { include: true };
    return body;
  }

  const post = (body: Json, signal: AbortSignal) =>
    doFetch(`${base}/chat/completions`, { method: 'POST', headers: headers(true), body: JSON.stringify(body), signal });

  async function* generate(req: GenerateRequest, signal: AbortSignal): AsyncGenerator<GenerateEvent> {
    try {
      const body = requestBody(req);
      let res = await post(body, signal);
      if (!res.ok) {
        const err = httpError(res.status, await res.text(), res.headers, secrets);
        if (!(isTemperatureRejection(err) && body.temperature !== undefined)) throw err;
        // Le modèle refuse `temperature` : on le mémorise et on renvoie une seule fois sans.
        rememberNoTemperature(cfg.id, req.model);
        delete body.temperature;
        res = await post(body, signal);
        if (!res.ok) throw httpError(res.status, await res.text(), res.headers, secrets);
      }
      if (!res.body) throw new ProviderError('invalid_response', { detail: 'Réponse sans corps' });

      let finish: FinishReason | null = null;
      let refused = false;
      let usage: Extract<GenerateEvent, { type: 'usage' }> | null = null;

      for await (const ev of readSse(res.body, signal)) {
        if (ev.data.trim() === '[DONE]') break;
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

        if (isRecord(packet.usage)) {
          const details = isRecord(packet.usage.completion_tokens_details) ? packet.usage.completion_tokens_details : {};
          usage = {
            type: 'usage',
            inputTokens: num(packet.usage.prompt_tokens),
            outputTokens: num(packet.usage.completion_tokens),
            reasoningTokens: num(details.reasoning_tokens),
            costUsd: num(packet.usage.cost),
          };
        }

        const choice = Array.isArray(packet.choices) && isRecord(packet.choices[0]) ? packet.choices[0] : null;
        if (!choice) continue;
        const delta = isRecord(choice.delta) ? choice.delta : {};
        const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : delta.reasoning;
        if (typeof reasoning === 'string' && reasoning !== '') yield { type: 'reasoning', delta: reasoning };
        if (typeof delta.content === 'string' && delta.content !== '') yield { type: 'text', delta: delta.content };
        if (typeof delta.refusal === 'string' && delta.refusal !== '') {
          refused = true;
          yield { type: 'text', delta: delta.refusal };
        }
        if (typeof choice.finish_reason === 'string') finish = mapFinish(choice.finish_reason);
      }

      if (usage) yield usage;
      if (finish !== null) yield { type: 'finish', reason: refused ? 'refusal' : finish };
    } catch (err) {
      throw thrownError(err, signal, secrets);
    }
  }

  async function listModels(signal: AbortSignal): Promise<RemoteModel[]> {
    try {
      const res = await doFetch(`${base}/models`, { method: 'GET', headers: headers(false), signal });
      if (!res.ok) throw httpError(res.status, await res.text(), res.headers, secrets);
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new ProviderError('invalid_response', { detail: 'Liste de modèles non JSON' });
      }
      const data = isRecord(json) && Array.isArray(json.data) ? json.data : null;
      if (!data) throw new ProviderError('invalid_response', { detail: 'Liste de modèles inattendue' });
      if (openRouter) return parseOpenRouterModels(json);
      return data
        .flatMap((m) => (isRecord(m) && typeof m.id === 'string' && m.id !== '' ? [m.id] : []))
        .sort()
        .map((id) => ({
          id,
          name: id,
          contextWindow: null,
          inputPricePerM: null,
          outputPricePerM: null,
          supportsVision: null,
          supportsPdf: null,
        }));
    } catch (err) {
      throw thrownError(err, signal, secrets);
    }
  }

  return { generate, listModels };
}
