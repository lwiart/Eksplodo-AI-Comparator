import Anthropic from '@anthropic-ai/sdk';
import { KNOWN_PRICES } from '../catalog/known-prices.js';
import { httpError, ProviderError, thrownError } from './errors.js';
import { acceptsTemperature, isTemperatureRejection, rememberNoTemperature } from './temperature.js';
import type { GenerateEvent, GenerateRequest, ProviderAdapter, ProviderConfig, RemoteModel } from './types.js';

type FinishReason = Extract<GenerateEvent, { type: 'finish' }>['reason'];

function mapStop(raw: string): FinishReason {
  if (raw === 'end_turn' || raw === 'stop_sequence') return 'stop';
  if (raw === 'max_tokens') return 'length';
  if (raw === 'refusal') return 'refusal';
  return 'other';
}

/** Statut HTTP équivalent à un type d'erreur de flux Anthropic. */
function statusOfStreamError(type: unknown): number {
  if (type === 'overloaded_error') return 529;
  if (type === 'rate_limit_error') return 429;
  if (type === 'api_error') return 500;
  return 400;
}

/** Pièces jointes (images, PDF) puis texte, comme dans la spec §6.1. */
function userContent(req: GenerateRequest): Anthropic.MessageParam['content'] {
  if (req.attachments.length === 0) return req.prompt;
  const blocks: Anthropic.ContentBlockParam[] = req.attachments.map((a) =>
    a.mime.startsWith('image/')
      ? { type: 'image', source: { type: 'base64', media_type: a.mime as Anthropic.Base64ImageSource['media_type'], data: a.base64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.base64 } },
  );
  return [...blocks, { type: 'text', text: req.prompt }];
}

export function createAnthropicAdapter(cfg: ProviderConfig): ProviderAdapter {
  const secrets = [cfg.apiKey];

  // Client recréé à chaque appel : la clé est relue à chaque appel par le registre. Aucune nouvelle tentative du SDK.
  const client = () =>
    new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl.replace(/\/+$/, ''), maxRetries: 0, fetch: cfg.fetch });

  /** Normalise une erreur du SDK ; les autres exceptions passent par `thrownError`. */
  function normalize(err: unknown, signal: AbortSignal): ProviderError {
    if (
      err instanceof Anthropic.APIError &&
      !(err instanceof Anthropic.APIConnectionError) &&
      !(err instanceof Anthropic.APIUserAbortError)
    ) {
      const body = JSON.stringify(err.error ?? err.message);
      if (typeof err.status === 'number') return httpError(err.status, body, err.headers ?? {}, secrets);
      // Erreur survenue en cours de flux : seul le type de l'erreur indique la gravité.
      const inner = (err.error as { error?: { type?: unknown } } | undefined)?.error;
      return httpError(statusOfStreamError(inner?.type), body, {}, secrets);
    }
    return thrownError(err, signal, secrets);
  }

  async function* generate(req: GenerateRequest, signal: AbortSignal): AsyncGenerator<GenerateEvent> {
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: req.maxTokens,
      messages: [{ role: 'user', content: userContent(req) }],
      stream: true,
    };
    if (req.system) params.system = req.system;
    if (req.temperature !== undefined && acceptsTemperature(cfg.id, req.model)) params.temperature = req.temperature;

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let finish: FinishReason | null = null;

    // Une première tentative, puis (seulement si le modèle refuse `temperature`) une seconde sans.
    for (let attempt = 0; ; attempt++) {
      try {
        const stream = client().messages.stream(params, { signal });
        for await (const event of stream) {
          if (event.type === 'message_start') {
            inputTokens = event.message.usage.input_tokens;
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta' && event.delta.text !== '') {
              yield { type: 'text', delta: event.delta.text };
            } else if (event.delta.type === 'thinking_delta' && event.delta.thinking !== '') {
              yield { type: 'reasoning', delta: event.delta.thinking };
            }
          } else if (event.type === 'message_delta') {
            if (event.delta.stop_reason) finish = mapStop(event.delta.stop_reason);
            outputTokens = event.usage.output_tokens;
          }
        }
        break;
      } catch (err) {
        const normalized = normalize(err, signal);
        if (attempt === 0 && params.temperature !== undefined && isTemperatureRejection(normalized)) {
          rememberNoTemperature(cfg.id, req.model);
          delete params.temperature;
          continue;
        }
        throw normalized;
      }
    }

    // `output_tokens` inclut la réflexion (thinking) sans la détailler : pas de `reasoningTokens`, la sortie la contient.
    if (inputTokens !== undefined || outputTokens !== undefined) yield { type: 'usage', inputTokens, outputTokens };
    if (finish !== null) yield { type: 'finish', reason: finish };
  }

  async function listModels(signal: AbortSignal): Promise<RemoteModel[]> {
    try {
      const models: RemoteModel[] = [];
      for await (const m of client().models.list({}, { signal })) {
        const vision = m.capabilities?.image_input?.supported;
        const price = KNOWN_PRICES[m.id];
        models.push({
          id: m.id,
          name: m.display_name || m.id,
          contextWindow: m.max_input_tokens ?? null,
          inputPricePerM: price?.input ?? null,
          outputPricePerM: price?.output ?? null,
          supportsVision: vision ?? null,
          supportsPdf: vision ?? null,
        });
      }
      return models;
    } catch (err) {
      throw normalize(err, signal);
    }
  }

  return { generate, listModels };
}
