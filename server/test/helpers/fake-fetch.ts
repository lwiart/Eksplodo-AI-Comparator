import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Handler = (req: Request) => Response | Promise<Response>;
/** Une route : un gestionnaire, ou une liste de gestionnaires utilisés tour à tour (le dernier se répète). */
type Route = Handler | Handler[];

export type FakeFetch = typeof fetch & { calls: Request[] };

/**
 * `fetch` factice : construit une `Request` à partir de `(input, init)`, l'enregistre dans `calls`
 * et répond selon la clé `'MÉTHODE url'` (par exemple `'POST https://x.test/v1/chat/completions'`).
 */
export function fakeFetch(routes: Record<string, Route>): FakeFetch {
  const counters = new Map<string, number>();
  const calls: Request[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input instanceof URL ? input.href : input, init);
    calls.push(req.clone());
    const key = `${req.method} ${req.url}`;
    const route = routes[key];
    if (!route) throw new Error(`Aucune route factice pour ${key}`);
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    const handler = Array.isArray(route) ? route[Math.min(n, route.length - 1)]! : route;
    return handler(req);
  };
  return Object.assign(fn, { calls }) as FakeFetch;
}

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

export function fixtureText(name: string): string {
  return readFileSync(FIXTURES + name, 'utf8');
}

/** Réponse SSE tirée d'une fixture, découpée en paquets de `chunkSize` octets (7 par défaut). */
export function sseResponse(fixtureName: string, init: { status?: number; chunkSize?: number } = {}): Response {
  const bytes = new Uint8Array(readFileSync(FIXTURES + fixtureName));
  const size = init.chunkSize ?? 7;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
  return new Response(body, { status: init.status ?? 200, headers: { 'content-type': 'text/event-stream' } });
}
