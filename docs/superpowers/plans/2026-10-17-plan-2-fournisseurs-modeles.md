# Plan 2 – Fournisseurs et modèles : plan de réalisation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un catalogue opérationnel : trois adaptateurs de fournisseurs (compatible OpenAI, Anthropic, Google) et un faux fournisseur derrière une interface commune, un registre qui lit les clés dans `process.env` au moment de l'appel, les tables `providers` / `models` / `openrouter_catalog`, l'assistant d'ajout `/models`, l'import des prix et capacités OpenRouter, la détection quotidienne des nouveautés, la fiche modèle et la présence des clés dans `/health`.

**Architecture:** Le module `server/src/modules/providers/` ne connaît ni la base ni HTTP entrant : il transforme une `GenerateRequest` en flux de `GenerateEvent` et lève des `ProviderError` normalisées. Le module `server/src/modules/catalog/` gère les tables, l'API et la tâche `catalog_refresh` ; il obtient un adaptateur par le registre. Aucun appel de génération n'est fait dans une requête HTTP (le moteur et l'essai rapide arrivent au plan 3 et passent par la file) ; seule la liste `/models` est interrogée en direct, bornée à 15 s.

**Tech Stack:** celle du plan 1, plus `@anthropic-ai/sdk` (^0.135). `fetch` natif de Node 24 et lecteur SSE maison pour les API compatibles OpenAI et Gemini.

**Spec:** `docs/superpowers/specs/2026-10-16-comparateur-ia-design.md` (§5.2, §6, §9.2 pour les nouveautés, §9.3, §10 « Catalogue », §12.1, §12.3, §13, §15 ligne 2, §16 lignes 3 à 5). Plan précédent : `docs/superpowers/plans/2026-10-16-plan-1-fondations.md` (conventions et Global Constraints, toujours valables).

## Global Constraints

- Toutes les Global Constraints du plan 1 restent en vigueur (Node 24, TypeScript strict ESM, aucun `await` de premier niveau, format d'erreur `{ error: { code, message, reference? } }` en français, UUID `CHAR(36)`, dates `DATETIME(3)`, CSRF, thème « Nuit », skill `frontend-design` pour toute tâche d'interface, jamais `hosting_nodejs_replace-environment-variables`).
- Base de test : MariaDB 11.8 sur `127.0.0.1:3307` (`root` / `test`). Docker Desktop est indisponible sur le poste : si le port ne répond pas, lancer `"C:\Users\laure\OneDrive\Bureau\Claude directory\Code-appels offre\mariadb-11.8\bin\mariadbd.exe" --defaults-file="C:/Users/laure/AppData/Local/aic-mariadb/data/my.ini"` en tâche de fond.
- **Clés API** : lues dans `process.env[provider.apiKeyEnv]` **au moment de l'appel**, jamais copiées en base, jamais renvoyées par l'API, jamais journalisées, jamais placées dans une URL (Google : en-tête `x-goog-api-key`, pas de paramètre `key=`). Une valeur vide ou faite d'espaces vaut « clé manquante ».
- Types de fournisseur : `openai_compatible` | `anthropic` | `google`. Le faux fournisseur n'est pas un type : quand `AIC_FAKE_LLM=1` hors production, le registre le substitue à tous les adaptateurs et considère toutes les clés présentes.
- Fournisseurs préconfigurés à la première installation : OpenAI (`openai_compatible`, `https://api.openai.com/v1`, `OPENAI_API_KEY`), Anthropic (`anthropic`, `https://api.anthropic.com`, `ANTHROPIC_API_KEY`), Google (`google`, `https://generativelanguage.googleapis.com/v1beta`, `GOOGLE_API_KEY`), Mistral (`openai_compatible`, `https://api.mistral.ai/v1`, `MISTRAL_API_KEY`), DeepSeek (`openai_compatible`, `https://api.deepseek.com/v1`, `DEEPSEEK_API_KEY`), OpenRouter (`openai_compatible`, `https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`) ; `max_concurrency` 2, `enabled` vrai.
- Prix connus préremplis par l'assistant (en $ par million de tokens, entrée / sortie, vérifiés le 2026-10-17) : `claude-opus-5-5` 4 / 20, `claude-sonnet-5-5` 2 / 10, `claude-haiku-5-5` 0,10 / 0,50.
- Prix stockés en `DECIMAL(10,4)` ($ par million), exposés en nombres par l'API. Conversion OpenRouter : prix par token × 1 000 000, arrondi à 4 décimales ; prix négatif, absent ou non numérique → `null` (jamais « gratuit » par erreur).
- Codes `ProviderError` : `auth_invalid`, `model_not_found`, `rate_limited`, `provider_unavailable`, `timeout`, `context_too_long`, `bad_request`, `invalid_response`. Nouvelle tentative possible pour `rate_limited`, `provider_unavailable`, `timeout` seulement.
- Délais : interrogation `/models` 15 s (dans une requête HTTP, sous les 60 s du proxy Hostinger) ; téléchargement du catalogue OpenRouter 30 s ; les appels de génération reçoivent un `AbortSignal` (le délai de 120 s est posé par l'appelant, au plan 3).
- Les adaptateurs ne font **aucune** nouvelle tentative réseau eux-mêmes (le SDK Anthropic est créé avec `maxRetries: 0`) : les tentatives appartiennent au moteur du plan 3. Seule exception : le renvoi sans `temperature` (Task 5).
- `catalog_refresh` : tous les jours à `06:00` (Europe/Paris), source `https://openrouter.ai/api/v1/models`, publique, sans clé. Nouveautés = vues depuis moins de **30 jours**, hors première synchronisation, non écartées, absentes du catalogue local.
- Nouvelles variables d'environnement : `AIC_FAKE_LLM` (`1` pour activer, ignorée en production avec un avertissement) et les clés des fournisseurs. Aucune n'est obligatoire.
- Les tests automatiques n'appellent jamais un fournisseur réel ni `openrouter.ai` : `fetch` est injecté et les flux viennent de `server/test/fixtures/`.

## Review Focus

1. **Clé qui fuit par un message d'erreur** : un fournisseur (ou un proxy) renvoie un corps d'erreur qui recopie la clé ou l'en-tête `x-api-key` ; la clé n'apparaît ni dans la réponse de l'API, ni dans `error_events`, ni dans les journaux. → tests en Task 1 et Task 3.
2. **Variable de clé détournée** : l'Admin nomme `DB_PASSWORD`, `CRON_SECRET`, `DATABASE_URL` ou `SMTP_PASS` comme variable de clé d'un fournisseur ; c'est refusé, sinon le secret partirait en en-tête `Authorization` vers l'URL du fournisseur. → tests en Task 9.
3. **Flux découpé n'importe où** : un caractère UTF-8 coupé entre deux paquets, une ligne coupée, des fins de ligne `\r\n`, des commentaires `: OPENROUTER PROCESSING`, une ligne `data:` qui n'est pas du JSON ; le texte reconstitué est exact et le JSON invalide donne `invalid_response`, jamais un plantage. → tests en Task 2 et Task 4.
4. **Catalogue OpenRouter partiel ou indisponible** : prix `"-1"` ou absents, modèle sans `architecture`, réponse 5xx ou délai dépassé ; aucun modèle n'apparaît « gratuit » à tort, et un échec de la première synchronisation ne la marque pas comme faite (la suivante reste silencieuse). → tests en Task 10.
5. **Modèle qui refuse `temperature`** (Claude 5.x, modèles de raisonnement OpenAI) : 400 du fournisseur mentionnant `temperature` ; l'adaptateur renvoie la requête une fois sans ce paramètre et s'en souvient pour ce modèle. → tests en Task 4 et Task 5.

---

## Structure des fichiers (plan 2)

```
server/
  src/
    lib/sse.ts                               # lecteur SSE générique
    db/schema/catalog.ts                     # providers, models, openrouter_catalog
    modules/providers/
      types.ts                               # ProviderAdapter, GenerateRequest, GenerateEvent, RemoteModel, ProviderConfig
      errors.ts                              # ProviderError, normalisation HTTP / réseau / délai, masquage par valeur
      temperature.ts                         # mémoire « ce modèle refuse temperature »
      openrouter.ts                          # isOpenRouter, parseOpenRouterModels
      openai-compatible.ts  anthropic.ts  google.ts  fake.ts
      registry.ts                            # adaptateur + état de la clé, lus à l'appel
    modules/catalog/
      seed.ts                                # fournisseurs préconfigurés (première installation)
      known-prices.ts
      providers.repo.ts  models.repo.ts  catalog.service.ts  catalog.routes.ts
      openrouter-sync.ts                     # refreshOpenRouterCatalog + gestionnaire catalog_refresh
  drizzle/0001_*.sql
  test/fixtures/
    openai/  anthropic/  google/  openrouter/   # flux SSE (.sse) et réponses /models (.json)
web/src/
  api/catalog.ts
  pages/admin/ProvidersPage.tsx  components/catalog/RemoteModelsDialog.tsx  components/catalog/ModelForm.tsx
  pages/ModelsPage.tsx  pages/ModelPage.tsx  components/catalog/NewModelsCard.tsx
```

---

### Task 1: Masquage des secrets aux formes des fournisseurs (point différé du plan 1)

**Files:**
- Modify : `server/src/modules/errors/report.ts` (`redact`)
- Test : `server/test/errors-report.test.ts`

**Interfaces:**
- Produces : `redact(text: string): string` étendu (même signature), réutilisé par `providers/errors.ts` (Task 4).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test.each([
  ['x-api-key: sk-ant-api03-AbCdEf123456', 'sk-ant-api03-AbCdEf123456'],
  ['X-Api-Key=abcdefghij0123456789', 'abcdefghij0123456789'],
  ['x-goog-api-key: AQ.Ab8RN6Kz-very-secret', 'AQ.Ab8RN6Kz-very-secret'],
  ['{"api_key":"mistral-0123456789abcdef"}', 'mistral-0123456789abcdef'],
  ['{"apiKey": "ds-0123456789abcdef"}', 'ds-0123456789abcdef'],
  ["{'api-key': 'tok_0123456789abcdef'}", 'tok_0123456789abcdef'],
  ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
])('redact masque %s', (input, secret) => {
  const out = redact(input);
  expect(out).not.toContain(secret);
  expect(out).toContain('[clé masquée]');
});
test('redact garde le nom du champ et le reste du texte', () => {
  expect(redact('{"api_key":"abc123456789","model":"gpt-x"}')).toBe('{"api_key":"[clé masquée]","model":"gpt-x"}');
});
test('redact ne touche pas un texte sans secret', () => {
  expect(redact('Modèle claude-opus-5-5 introuvable (404)')).toBe('Modèle claude-opus-5-5 introuvable (404)');
});
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/errors-report.test.ts` — Expected: FAIL sur les nouveaux cas.

- [ ] **Step 3: Implémenter** — ajouter à `redact` : en-têtes `x-api-key`, `x-goog-api-key`, `api-key` et `authorization` (tout schéma, pas seulement `Bearer`) suivis de `:` ou `=` (insensible à la casse, valeur jusqu'au premier espace, guillemet, `,` ou `;`) ; clés JSON ou objet nommées `api_key`, `apiKey`, `api-key`, `x-api-key`, `secret`, `password`, `token` entre guillemets simples ou doubles : seule la valeur est remplacée. Mettre à jour le commentaire de la fonction.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server server/test/errors-report.test.ts server/test/errors-api.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "fix: masquage des clés aux formes des fournisseurs (x-api-key, champs JSON)"`

---

### Task 2: Lecteur SSE

**Files:**
- Create : `server/src/lib/sse.ts`
- Test : `server/test/sse.test.ts`

**Interfaces:**
- Produces : `type SseEvent = { event: string | null; data: string }` ; `readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent>` — un événement par bloc terminé par une ligne vide ; lignes `data:` multiples jointes par `\n` ; lignes de commentaire (`:`) et champs `id` / `retry` ignorés ; un espace unique après `:` retiré ; `\n`, `\r\n` et `\r` acceptés ; bloc final non terminé émis s'il contient des données ; arrêt (et `reader.cancel()`) si `signal` est annulé, en relançant `signal.reason`.

- [ ] **Step 1: Écrire les tests qui échouent** — fabriquer les flux avec `new ReadableStream({ start(c) { chunks.forEach(x => c.enqueue(enc.encode(x))); c.close(); } })`, des morceaux en octets quand il faut couper un caractère.

```ts
test('événements simples et nommés', async () => {
  expect(await collect('data: {"a":1}\n\nevent: message_start\ndata: {"b":2}\n\n'))
    .toEqual([{ event: null, data: '{"a":1}' }, { event: 'message_start', data: '{"b":2}' }]);
});
test('ligne coupée entre deux paquets', async () => { expect(await collect('da', 'ta: {"x"', ':1}\n', '\n')).toEqual([{ event: null, data: '{"x":1}' }]); });
test('caractère UTF-8 coupé entre deux paquets', async () => {
  const bytes = enc.encode('data: {"t":"é🚀"}\n\n');
  expect((await collectBytes(bytes.slice(0, 13), bytes.slice(13)))[0]!.data).toBe('{"t":"é🚀"}');
});
test('fins de ligne CRLF', async () => { expect(await collect('data: a\r\n\r\ndata: b\r\n\r\n')).toHaveLength(2); });
test('commentaires ignorés', async () => { expect(await collect(': OPENROUTER PROCESSING\n\ndata: x\n\n')).toEqual([{ event: null, data: 'x' }]); });
test('données sur plusieurs lignes', async () => { expect((await collect('data: a\ndata: b\n\n'))[0]!.data).toBe('a\nb'); });
test('dernier bloc sans ligne vide finale', async () => { expect(await collect('data: fin')).toEqual([{ event: null, data: 'fin' }]); });
test('annulation : lève la raison du signal', async () => { /* flux qui n'envoie rien ; ctrl.abort(new Error('stop')) */ await expect(p).rejects.toThrow('stop'); });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/sse.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter `readSse`** avec un `TextDecoder` en mode `stream: true` et un tampon de lignes.

- [ ] **Step 4: Vérifier le succès** — même commande — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: lecteur SSE"`

---

### Task 3: Types communs, erreurs normalisées et configuration du faux fournisseur

**Files:**
- Create : `server/src/modules/providers/types.ts`, `server/src/modules/providers/errors.ts`, `server/src/modules/providers/temperature.ts`
- Modify : `server/src/config/config.ts`, `server/test/helpers/test-app.ts` (`testConfig`), `.env.example`
- Test : `server/test/provider-errors.test.ts`, `server/test/config.test.ts`

**Interfaces:**
- Produces :
  - `GenerateRequest`, `GenerateEvent` : exactement ceux de la spec §6.1.
  - `interface ProviderAdapter { generate(req: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerateEvent>; listModels(signal: AbortSignal): Promise<RemoteModel[]> }` (le `signal` de `listModels` porte le délai de 15 s).
  - `type RemoteModel = { id: string; name: string; contextWindow: number | null; inputPricePerM: number | null; outputPricePerM: number | null; supportsVision: boolean | null; supportsPdf: boolean | null }` (`null` = inconnu, l'Admin complète).
  - `type ProviderConfig = { id: string; type: 'openai_compatible' | 'anthropic' | 'google'; baseUrl: string; apiKey: string | null; appBaseUrl: string; fetch?: typeof fetch }`.
  - `type ProviderErrorCode` (liste des Global Constraints) ; `class ProviderError extends Error { code; retryable: boolean; status: number | null; retryAfterMs: number | null; detail: string }` (`detail` = message brut du fournisseur, masqué et tronqué à 500 caractères ; `message` = phrase française de `providerErrorMessage(code)`).
  - `providerErrorMessage(code): string` : `auth_invalid` « Clé invalide ou sans droit sur ce modèle », `model_not_found` « Modèle introuvable chez le fournisseur », `rate_limited` « Limite de débit atteinte chez le fournisseur », `provider_unavailable` « Fournisseur indisponible », `timeout` « Délai dépassé », `context_too_long` « Contexte trop long pour ce modèle », `bad_request` « Requête refusée par le fournisseur », `invalid_response` « Réponse du fournisseur illisible ».
  - `httpError(status: number, body: string, headers: Headers | Record<string, string>, secrets: (string | null)[]): ProviderError` ; `thrownError(err: unknown, signal: AbortSignal, secrets: (string | null)[]): ProviderError` (renvoie `err` tel quel si c'est déjà une `ProviderError`) ; `maskSecrets(text: string, secrets: (string | null)[]): string` = `redact` puis remplacement de chaque valeur exacte de `secrets` longue d'au moins 8 caractères.
  - `temperature.ts` : `acceptsTemperature(providerId: string, model: string): boolean`, `rememberNoTemperature(providerId: string, model: string): void`, `isTemperatureRejection(err: ProviderError): boolean` (statut 400 et `/temperature/i` dans `detail`), `resetTemperatureMemory(): void` (tests). Mémoire du processus, non persistée.
  - `AppConfig` étendu : `fakeLlm: boolean` (`AIC_FAKE_LLM === '1'` et `nodeEnv !== 'production'`) et `fakeLlmIgnored: boolean` (`AIC_FAKE_LLM === '1'` en production) ; `configWarnings(config: Pick<AppConfig, 'nodeEnv' | 'appBaseUrl' | 'fakeLlmIgnored'>)` ajoute « AIC_FAKE_LLM est ignorée en production » quand `fakeLlmIgnored` est vrai. `testConfig()` renvoie `fakeLlm: false, fakeLlmIgnored: false`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// server/test/provider-errors.test.ts
test.each([
  [401, '', 'auth_invalid', false], [403, '', 'auth_invalid', false], [404, '', 'model_not_found', false],
  [429, '', 'rate_limited', true], [500, '', 'provider_unavailable', true], [503, '', 'provider_unavailable', true],
  [529, '', 'provider_unavailable', true], [413, '', 'context_too_long', false],
  [400, '{"error":{"code":"context_length_exceeded"}}', 'context_too_long', false],
  [400, 'prompt is too long: 250000 tokens > 200000 maximum', 'context_too_long', false],
  [400, '{"error":{"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}', 'auth_invalid', false],
  [400, '{"error":{"message":"unsupported value: temperature"}}', 'bad_request', false],
])('HTTP %i → %s', (status, body, code, retryable) => {
  const e = httpError(status, body, {}, []);
  expect(e.code).toBe(code); expect(e.retryable).toBe(retryable); expect(e.status).toBe(status);
});
test('Retry-After en secondes et en date HTTP', () => {
  expect(httpError(429, '', { 'retry-after': '7' }, []).retryAfterMs).toBe(7000);
  expect(httpError(429, '', { 'retry-after': new Date(Date.now() + 5000).toUTCString() }, []).retryAfterMs).toBeGreaterThan(3000);
});
test('la clé recopiée par le fournisseur est masquée', () => {
  const key = 'zz-secret-0123456789';
  const e = httpError(401, `{"error":"bad key ${key}","headers":{"x-api-key":"${key}"}}`, {}, [key]);
  expect(e.detail).not.toContain(key); expect(e.message).toBe('Clé invalide ou sans droit sur ce modèle');
});
test('délai : signal annulé par AbortSignal.timeout → timeout, réessayable', async () => {
  const signal = AbortSignal.timeout(1); await sleep(5);
  expect(thrownError(new DOMException('aborted', 'AbortError'), signal, []).code).toBe('timeout');
});
test('coupure réseau (TypeError fetch failed) → provider_unavailable', () => {
  expect(thrownError(new TypeError('fetch failed'), new AbortController().signal, []).code).toBe('provider_unavailable');
});
test('ProviderError déjà normalisée renvoyée telle quelle', () => { const e = httpError(404, '', {}, []); expect(thrownError(e, sig, [])).toBe(e); });
test('mémoire temperature', () => {
  expect(acceptsTemperature('p1', 'm')).toBe(true); rememberNoTemperature('p1', 'm');
  expect(acceptsTemperature('p1', 'm')).toBe(false); expect(acceptsTemperature('p2', 'm')).toBe(true);
});
// server/test/config.test.ts (ajouts)
test('AIC_FAKE_LLM=1 active le faux fournisseur hors production', () => { expect(loadConfig({ ...base, AIC_FAKE_LLM: '1' }).fakeLlm).toBe(true); });
test('AIC_FAKE_LLM ignorée en production, avec avertissement', () => {
  const c = loadConfig({ ...base, NODE_ENV: 'production', AIC_FAKE_LLM: '1' });
  expect(c.fakeLlm).toBe(false); expect(configWarnings(c).join()).toMatch(/AIC_FAKE_LLM/);
});
```

Un `thrownError` sur un signal annulé par l'appelant (raison autre que `TimeoutError`) relance la raison d'origine : une annulation n'est pas une erreur du fournisseur.

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/provider-errors.test.ts server/test/config.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** les trois fichiers et la configuration. Détection de `context_too_long` sur 400 : `context_length_exceeded`, `maximum context length`, `prompt is too long`, `too many tokens`, `exceeds the context window`, `input token count` (insensible à la casse). `auth_invalid` sur 400 : `API_KEY_INVALID` ou `API key not valid`. Tout autre 4xx → `bad_request`. `.env.example` : `AIC_FAKE_LLM=1` commenté « développement sans clé ni dépense » et les six variables de clé vides.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: interface des fournisseurs, erreurs normalisées et option AIC_FAKE_LLM"`

---

### Task 4: Adaptateur compatible OpenAI et lecture du catalogue OpenRouter

**Files:**
- Create : `server/src/modules/providers/openai-compatible.ts`, `server/src/modules/providers/openrouter.ts`
- Create (fixtures, écrites d'après la documentation publique des fournisseurs) : `server/test/fixtures/openai/{text,reasoning-deepseek,refusal,length,error-midstream,cut,bad-json}.sse`, `server/test/fixtures/openrouter/{stream-with-cost.sse,models.json}`, `server/test/fixtures/openai/models.json`
- Create : `server/test/helpers/fake-fetch.ts`
- Test : `server/test/openai-compatible.test.ts`, `server/test/openrouter-parse.test.ts`

**Interfaces:**
- Consumes : `readSse` (Task 2), types, `httpError`, `thrownError`, `maskSecrets`, `temperature.ts` (Task 3).
- Produces :
  - `createOpenAiCompatibleAdapter(cfg: ProviderConfig): ProviderAdapter`
  - `isOpenRouter(baseUrl: string): boolean` (hôte `openrouter.ai`) ; `parseOpenRouterModels(json: unknown): RemoteModel[]` (prix par token × 1 000 000 arrondis à 4 décimales, `null` si négatif, absent ou non numérique ; `supportsVision` = `input_modalities` contient `image` ; `supportsPdf` = contient `file` ; `contextWindow` = `context_length` ; entrées sans `id` texte ignorées)
  - `fakeFetch(routes: Record<string, (req: Request) => Response | Promise<Response>>): typeof fetch & { calls: Request[] }` et `sseResponse(fixtureName: string, init?: { status?: number; chunkSize?: number }): Response` (découpe la fixture en paquets de `chunkSize` octets, 7 par défaut, pour éprouver le lecteur)

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test('texte, usage puis finish : événements dans l’ordre', async () => {
  const events = await run(adapter, req, 'openai/text.sse');
  expect(textOf(events)).toBe('Bonjour le monde');
  expect(events.at(-2)).toEqual({ type: 'usage', inputTokens: 12, outputTokens: 4, reasoningTokens: undefined, costUsd: undefined });
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
});
test('corps de la requête', async () => {
  const body = await lastBody(fetchMock);
  expect(body).toMatchObject({ model: 'gpt-x', stream: true, stream_options: { include_usage: true }, temperature: 0.2 });
  expect(body.messages[0]).toEqual({ role: 'system', content: 'Sois bref' });
  expect(fetchMock.calls[0]!.headers.get('authorization')).toBe('Bearer test-key-0123456789');
});
test('api.openai.com : max_completion_tokens ; autres hôtes : max_tokens', async () => { /* deux adaptateurs */ });
test('image en image_url data:, PDF en partie file', async () => {
  expect(userParts).toEqual(expect.arrayContaining([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } },
    { type: 'file', file: { filename: 'doc.pdf', file_data: 'data:application/pdf;base64,JVBER' } },
    { type: 'text', text: 'Décris' },
  ]));
});
test('raisonnement DeepSeek (reasoning_content) → événements reasoning', async () => { expect(kinds(events)).toContain('reasoning'); });
test('OpenRouter : usage.include demandé, coût réel lu dans usage.cost', async () => {
  expect(body.usage).toEqual({ include: true }); expect(usageOf(events).costUsd).toBeCloseTo(0.000123, 9);
  expect(fetchMock.calls[0]!.headers.get('x-title')).toBe('Eksplodo Comparateur IA');
});
test('refus OpenAI (delta.refusal) → texte conservé, finish refusal', async () => { expect(events.at(-1)).toEqual({ type: 'finish', reason: 'refusal' }); });
test('finish_reason length et content_filter', async () => { /* … */ });
test('erreur au milieu du flux ({"error":…}) → ProviderError après le texte déjà émis', async () => {
  await expect(run(adapter, req, 'openai/error-midstream.sse')).rejects.toMatchObject({ code: 'provider_unavailable' });
});
test('flux coupé sans [DONE] ni finish_reason : se termine sans événement finish', async () => { expect(kinds(events)).not.toContain('finish'); });
test('ligne data non JSON → invalid_response', async () => { await expect(run(adapter, req, 'openai/bad-json.sse')).rejects.toMatchObject({ code: 'invalid_response' }); });
test('HTTP 401 → auth_invalid, sans la clé dans le détail', async () => { /* … */ });
test('400 mentionnant temperature : renvoi unique sans temperature, puis mémorisé', async () => {
  // première réponse 400 {"error":{"message":"Unsupported parameter: 'temperature'"}}, seconde OK
  expect(fetchMock.calls).toHaveLength(2); expect((await bodyOf(fetchMock.calls[1]!)).temperature).toBeUndefined();
  await run(adapter, req, 'openai/text.sse'); expect((await bodyOf(fetchMock.calls[2]!)).temperature).toBeUndefined();
});
test('listModels : GET {base}/models, identifiants triés', async () => { expect(models.map((m) => m.id)).toEqual(['gpt-a', 'gpt-b']); });
test('listModels sur OpenRouter : prix et capacités renseignés', async () => {
  expect(models.find((m) => m.id === 'anthropic/claude-sonnet-5.5')).toMatchObject({ inputPricePerM: 2, outputPricePerM: 10, supportsVision: true, supportsPdf: true });
});
// server/test/openrouter-parse.test.ts
test('prix "-1", absents ou non numériques → null', () => { /* openrouter/auto, entrée sans pricing */ });
test('0.000003 par token → 3 $ par million (pas 2.9999…)', () => { expect(m.inputPricePerM).toBe(3); });
test('entrée sans architecture : capacités null', () => { expect(m.supportsVision).toBeNull(); });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/openai-compatible.test.ts server/test/openrouter-parse.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter**
  - `generate` : `POST {baseUrl}/chat/completions` (barre oblique finale de `baseUrl` retirée), `fetch` de `cfg.fetch ?? globalThis.fetch`, en-têtes `content-type`, `authorization: Bearer <clé>` si `apiKey` non nul ; OpenRouter ajoute `HTTP-Referer: <appBaseUrl>` et `X-Title: Eksplodo Comparateur IA` (ASCII obligatoire dans un en-tête) et `usage: { include: true }`. Contenu utilisateur : chaîne simple s'il n'y a pas de pièce jointe, sinon parties (images, PDF, puis texte). `temperature` omise si `acceptsTemperature` est faux.
  - Lecture : `[DONE]` termine ; `choices[0].delta.content` → `text` ; `delta.reasoning_content` ou `delta.reasoning` → `reasoning` ; `delta.refusal` → `text` et fin `refusal` ; `finish_reason` : `stop` → `stop`, `length` → `length`, `content_filter` → `content_filter`, autre valeur non nulle → `other` ; `usage` (souvent dans un paquet sans `choices`) : `prompt_tokens`, `completion_tokens`, `completion_tokens_details.reasoning_tokens`, `cost`. L'événement `usage` est émis une fois, à la fin, avant `finish` ; `finish` n'est émis que si un `finish_reason` a été reçu. Paquet `{ error }` → `httpError(error.code numérique ou 502, JSON du paquet, {}, [clé])`.
  - Erreur HTTP : `httpError(res.status, await res.text(), res.headers, [clé])` ; si `isTemperatureRejection` et `temperature` envoyée : `rememberNoTemperature`, puis un seul renvoi. Toute exception de `fetch` ou de lecture passe par `thrownError`.
  - `listModels` : `GET {baseUrl}/models` avec la même authentification ; OpenRouter → `parseOpenRouterModels` ; sinon `data[].id` (nom = id, reste `null`), tri par id.

- [ ] **Step 4: Vérifier le succès** — même commande, puis `npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: adaptateur compatible OpenAI et lecture du catalogue OpenRouter"`

---

### Task 5: Adaptateur Anthropic (SDK officiel)

**Files:**
- Create : `server/src/modules/providers/anthropic.ts`
- Create (fixtures) : `server/test/fixtures/anthropic/{text,thinking,refusal,max-tokens,error-midstream}.sse`, `server/test/fixtures/anthropic/models.json`
- Create : `server/src/modules/catalog/known-prices.ts`
- Modify : `package.json` (`@anthropic-ai/sdk` ^0.135)
- Test : `server/test/anthropic-adapter.test.ts`

**Interfaces:**
- Consumes : types, erreurs, `temperature.ts` (Task 3), `fakeFetch`, `sseResponse` (Task 4).
- Produces : `createAnthropicAdapter(cfg: ProviderConfig): ProviderAdapter`.

- [ ] **Step 1: Écrire les tests qui échouent** — le client du SDK reçoit `fetch: cfg.fetch` ; les fixtures reproduisent les événements `message_start`, `content_block_start`, `content_block_delta` (`text_delta`, `thinking_delta`), `content_block_stop`, `message_delta`, `message_stop`, `ping`, `error`.

```ts
test('texte et usage (entrée de message_start, sortie de message_delta)', async () => {
  expect(textOf(events)).toBe('Bonjour'); expect(usageOf(events)).toMatchObject({ inputTokens: 25, outputTokens: 9 });
  expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
});
test('requête : en-tête x-api-key, max_tokens, système, image et document en base64 avant le texte', async () => {
  expect(call.headers.get('x-api-key')).toBe('test-key-0123456789');
  expect(body.messages[0].content).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } },
    { type: 'text', text: 'Décris' },
  ]);
  expect(body.system).toBe('Sois bref'); expect(body.max_tokens).toBe(1000);
});
test('thinking_delta → reasoning ; le texte vide de raisonnement n’émet rien', async () => { /* … */ });
test.each([['end_turn', 'stop'], ['stop_sequence', 'stop'], ['max_tokens', 'length'], ['refusal', 'refusal'], ['pause_turn', 'other']])('stop_reason %s → %s', async () => { /* … */ });
test('événement error en cours de flux (overloaded_error) → provider_unavailable', async () => { /* … */ });
test('HTTP 401 / 404 / 429 avec retry-after → codes normalisés, aucune nouvelle tentative du SDK', async () => {
  expect(fetchMock.calls).toHaveLength(1); expect(err).toMatchObject({ code: 'rate_limited', retryAfterMs: 3000 });
});
test('400 « temperature … not supported » : renvoi sans temperature, mémorisé', async () => { /* comme Task 4 */ });
test('listModels : display_name, max_input_tokens et image_input', async () => {
  expect(models[0]).toMatchObject({ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, supportsVision: true, supportsPdf: true });
});
test('listModels préremplit les prix connus', async () => { expect(models[0]).toMatchObject({ inputPricePerM: 4, outputPricePerM: 20 }); });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npm install @anthropic-ai/sdk@^0.135 && npx vitest run --project server server/test/anthropic-adapter.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — client `new Anthropic({ apiKey, baseURL: cfg.baseUrl, maxRetries: 0, fetch: cfg.fetch })`, créé à chaque appel (la clé est relue à chaque appel par le registre). `client.messages.stream({ model, max_tokens, system?, temperature?, messages }, { signal })`, parcours des événements bruts (`for await (const event of stream)`), sans paramètre `thinking` (les modèles récents raisonnent par défaut). Erreurs : `Anthropic.APIError` avec statut → `httpError(status, JSON.stringify(err.error ?? err.message), err.headers, [clé])` ; événement `error` dans le flux → `httpError` avec le statut correspondant au type (`overloaded_error` 529, `rate_limit_error` 429, `api_error` 500, sinon 400) ; le reste → `thrownError`. `listModels` : itération de `client.models.list()` ; `supportsVision` et `supportsPdf` = `capabilities.image_input.supported` ; prix depuis `KNOWN_PRICES` de `server/src/modules/catalog/known-prices.ts` (créé ici : `KNOWN_PRICES: Record<string, { input: number; output: number }>` avec les trois modèles des Global Constraints).

- [ ] **Step 4: Vérifier le succès** — même commande, puis `npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: adaptateur Anthropic (SDK officiel)"`

---

### Task 6: Adaptateur Google Gemini

**Files:**
- Create : `server/src/modules/providers/google.ts`
- Create (fixtures) : `server/test/fixtures/google/{text,thoughts,safety,max-tokens,prompt-blocked}.sse`, `server/test/fixtures/google/models-page1.json`, `models-page2.json`
- Test : `server/test/google-adapter.test.ts`

**Interfaces:**
- Consumes : `readSse`, types, erreurs, `temperature.ts`, `fakeFetch`, `sseResponse`.
- Produces : `createGoogleAdapter(cfg: ProviderConfig): ProviderAdapter`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test('URL et en-tête : la clé n’est jamais dans l’URL', async () => {
  expect(call.url).toBe('https://g.test/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
  expect(call.url).not.toMatch(/key=/); expect(call.headers.get('x-goog-api-key')).toBe('test-key-0123456789');
});
test('corps : systemInstruction, inline_data, generationConfig', async () => {
  expect(body).toMatchObject({
    systemInstruction: { parts: [{ text: 'Sois bref' }] },
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/png', data: 'iVBOR' } }, { text: 'Décris' }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1000 },
  });
});
test('parties thought:true → reasoning, usage final avec thoughtsTokenCount', async () => {
  expect(usageOf(events)).toEqual({ type: 'usage', inputTokens: 10, outputTokens: 20, reasoningTokens: 35, costUsd: undefined });
});
test.each([['STOP', 'stop'], ['MAX_TOKENS', 'length'], ['SAFETY', 'content_filter'], ['RECITATION', 'content_filter'], ['PROHIBITED_CONTENT', 'content_filter'], ['MALFORMED_FUNCTION_CALL', 'other']])('finishReason %s → %s', async () => { /* … */ });
test('promptFeedback.blockReason sans candidat → finish content_filter', async () => { /* … */ });
test('400 API_KEY_INVALID → auth_invalid', async () => { /* … */ });
test('listModels : préfixe models/ retiré, pagination suivie, seuls les modèles generateContent', async () => {
  expect(models.map((m) => m.id)).toEqual(['gemini-a', 'gemini-b']); expect(models[0]!.contextWindow).toBe(1_048_576);
});
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/google-adapter.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — `POST {baseUrl}/models/{encodeURIComponent(model)}:streamGenerateContent?alt=sse` ; usage = dernier `usageMetadata` reçu (`promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`), émis à la fin ; `finish` émis au premier `finishReason` reçu, après l'usage. `listModels` : `GET {baseUrl}/models?pageSize=1000[&pageToken=…]` tant que `nextPageToken` est présent, filtre `supportedGenerationMethods` contenant `generateContent`, `name` sans `models/`, `displayName`, `inputTokenLimit` ; capacités et prix `null`. Renvoi sans `temperature` comme Task 4.

- [ ] **Step 4: Vérifier le succès** — même commande, puis `npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: adaptateur Google Gemini"`

---

### Task 7: Faux fournisseur et registre

**Files:**
- Create : `server/src/modules/providers/fake.ts`, `server/src/modules/providers/registry.ts`
- Test : `server/test/fake-provider.test.ts`, `server/test/registry.test.ts`

**Interfaces:**
- Consumes : tous les adaptateurs (Tasks 4 à 6), `ProviderError`.
- Produces :
  - `FAKE_MODELS: RemoteModel[]` — `fake-rapide` (premier token 300 ms, 120 tokens/s, 0,50 $ / 1,50 $), `fake-equilibre` (800 ms, 60 tokens/s, 2 $ / 8 $), `fake-lent` (2 000 ms, 25 tokens/s, 0,20 $ / 0,60 $), `fake-instable` (600 ms, 50 tokens/s, 1 $ / 3 $, 25 % d'erreurs 429 ou 500), `fake-vision` (500 ms, 80 tokens/s, 3 $ / 12 $, image et PDF). Seul `fake-vision` déclare `supportsVision` et `supportsPdf` vrais ; les autres faux.
  - `createFakeAdapter(opts?: { sleep?: (ms: number, signal: AbortSignal) => Promise<void>; seed?: number }): ProviderAdapter` — déterministe pour (graine, modèle, prompt) ; jitter de ±20 % sur la latence et le débit ; texte français déterministe, borné à `maxTokens` (≈ 4 caractères par token) ; usage simulé (entrée = caractères du système et du prompt ÷ 4, plus 1 500 par image et 800 par PDF ; sortie = tokens générés) ; `costUsd` absent. Directives dans le prompt, prioritaires sur le hasard : `[[fake:429]]`, `[[fake:500]]` (lèvent la `ProviderError` correspondante avant tout texte), `[[fake:timeout]]` (n'émet rien jusqu'à l'annulation du signal), `[[fake:refusal]]`, `[[fake:length]]`, `[[fake:cut]]` (texte puis fin du flux sans `usage` ni `finish`), `[[fake:reasoning]]` (événements `reasoning` avant le texte). Modèle inconnu → `model_not_found`.
  - `type KeyStatus = { apiKeyEnv: string | null; keyRequired: boolean; keyPresent: boolean; fake: boolean }`
  - `type ProviderLike = { id: string; type: 'openai_compatible' | 'anthropic' | 'google'; baseUrl: string; apiKeyEnv: string | null }` (une ligne de la table `providers` de la Task 8 la satisfait)
  - `createProviderRegistry(deps: { env?: NodeJS.ProcessEnv; fakeLlm: boolean; appBaseUrl: string; fetch?: typeof fetch; fakeSleep?: (ms: number, signal: AbortSignal) => Promise<void> })` → `{ keyStatus(p: Pick<ProviderLike, 'apiKeyEnv'>): KeyStatus; adapterFor(p: ProviderLike): ProviderAdapter }` ; `env` vaut `process.env` par défaut et est lu à chaque appel ; `adapterFor` lève `KeyMissingError` (`AppError` code `key_missing`, statut 409, message « Clé manquante : renseignez la variable <NOM> dans hPanel puis appliquez les modifications ») si la clé est requise et absente ; en mode faux, renvoie le faux adaptateur pour tout fournisseur.
  - `type Registry = ReturnType<typeof createProviderRegistry>`

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// server/test/fake-provider.test.ts (sleep injecté qui enregistre les durées sans attendre)
test('même graine, même prompt → mêmes événements', async () => { expect(await run(a1)).toEqual(await run(a2)); });
test('latence avant le premier texte proche du profil', async () => { expect(sleeps[0]).toBeGreaterThanOrEqual(240); expect(sleeps[0]).toBeLessThanOrEqual(360); });
test('texte borné à maxTokens, finish length si coupé', async () => { /* maxTokens 5 */ });
test.each([['[[fake:429]]', 'rate_limited'], ['[[fake:500]]', 'provider_unavailable']])('%s → %s', async (d, code) => {
  await expect(run(adapter, { ...req, prompt: `x ${d}` })).rejects.toMatchObject({ code });
});
test('[[fake:timeout]] attend l’annulation', async () => { /* AbortSignal.timeout(20) → rejet */ });
test('[[fake:cut]] : ni usage ni finish', async () => { /* … */ });
test('listModels renvoie FAKE_MODELS', async () => { expect((await adapter.listModels(sig)).map((m) => m.id)).toContain('fake-vision'); });
// server/test/registry.test.ts
test('clé présente, absente, faite d’espaces', () => {
  const r = createProviderRegistry({ env: { A_API_KEY: 'k-0123456789', B_API_KEY: '   ' }, fakeLlm: false, appBaseUrl: 'http://x' });
  expect(r.keyStatus({ apiKeyEnv: 'A_API_KEY' }).keyPresent).toBe(true);
  expect(r.keyStatus({ apiKeyEnv: 'B_API_KEY' }).keyPresent).toBe(false);
  expect(r.keyStatus({ apiKeyEnv: 'C_API_KEY' }).keyPresent).toBe(false);
  expect(r.keyStatus({ apiKeyEnv: null })).toMatchObject({ keyRequired: false, keyPresent: true });
});
test('clé lue à l’appel : ajoutée après la création du registre, elle est prise en compte', () => { env.A_API_KEY = 'k-…'; expect(r.keyStatus(p).keyPresent).toBe(true); });
test('clé absente → key_missing (409)', () => { expect(() => r.adapterFor(row)).toThrow(expect.objectContaining({ code: 'key_missing', status: 409 })); });
test('type → adaptateur : openai_compatible, anthropic, google', async () => { /* vérifier par l’URL appelée via fetch injecté */ });
test('mode faux : clés présentes, faux adaptateur pour tout fournisseur', async () => {
  expect(rf.keyStatus({ apiKeyEnv: 'ABSENTE_API_KEY' })).toMatchObject({ keyPresent: true, fake: true });
  expect((await rf.adapterFor(row).listModels(sig))[0]!.id).toMatch(/^fake-/);
});
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/fake-provider.test.ts server/test/registry.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — PRNG `mulberry32` amorcé par un hachage FNV-1a de `seed|model|prompt` ; `sleep` par défaut = `setTimeout` annulable par le signal. Le registre construit `ProviderConfig` à chaque `adapterFor` avec la clé `trim()`ée.

- [ ] **Step 4: Vérifier le succès** — même commande, puis `npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: faux fournisseur et registre des clés"`

---

### Task 8: Schéma du catalogue, migration et fournisseurs préconfigurés

**Files:**
- Create : `server/src/db/schema/catalog.ts`, `server/drizzle/0001_*.sql` (généré), `server/src/modules/catalog/seed.ts`
- Modify : `drizzle.config.ts`, `server/src/startup.ts` (`prepareDatabase` appelle `seedProviders` sous le verrou, après les migrations)
- Test : `server/test/catalog-schema.test.ts`

**Interfaces:**
- Produces :
  - `providers` : `id`, `name` (varchar 100, unique), `type` (enum `openai_compatible` | `anthropic` | `google`), `baseUrl` (varchar 500), `apiKeyEnv` (varchar 64, nullable), `maxConcurrency` (int, défaut 2), `enabled` (bool, défaut vrai), `createdAt`, `updatedAt`.
  - `models` : `id`, `providerId` (FK `providers.id`, `ON DELETE RESTRICT`), `apiModelId` (varchar 200), `displayName` (varchar 200), `color` (char 7), `inputPricePerM` et `outputPricePerM` (`DECIMAL(10,4)` non nuls, défaut 0), `priceSource` (enum `manual` | `openrouter`, défaut `manual`), `supportsVision`, `supportsPdf` (bool, défaut faux), `contextWindow` (int, nullable), `enabled` (bool, défaut vrai), `createdAt`, `updatedAt` ; unique (`providerId`, `apiModelId`).
  - `openrouterCatalog` (`openrouter_catalog`) : `id`, `openrouterId` (varchar 200, unique), `name` (varchar 300), `inputPricePerM`, `outputPricePerM` (`DECIMAL(10,4)`, nullables), `inputModalities` (JSON, tableau de chaînes), `contextWindow` (int, nullable), `initialSync` (bool : ajoutée par la première synchronisation, jamais présentée comme nouveauté), `firstSeenAt`, `lastSeenAt`, `dismissedAt` (nullable) ; index sur `firstSeenAt`.
  - Colonnes décimales lues et écrites en `number` (`decimal(..., { mode: 'number' })` de Drizzle).
  - `PRESET_PROVIDERS` (les six des Global Constraints) ; `seedProviders(db: Db, now: Date): Promise<'seeded' | 'skipped'>` — insère les fournisseurs préconfigurés une seule fois dans la vie de la base (réglage `catalog.seeded_at` dans `settings`), sans écraser un fournisseur de même nom.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test('migration : tables providers, models, openrouter_catalog', async () => { /* SELECT sur chacune */ });
test('premier démarrage : six fournisseurs préconfigurés, une seule fois', async () => {
  expect(await seedProviders(db, now)).toBe('seeded'); expect(await count(providers)).toBe(6);
  await db.delete(providers).where(eq(providers.name, 'DeepSeek'));
  expect(await seedProviders(db, now)).toBe('skipped'); expect(await count(providers)).toBe(5);
});
test('deux démarrages simultanés → six fournisseurs, pas douze', async () => {
  await Promise.all([prepareDatabase(deps), prepareDatabase(deps)]); expect(await count(providers)).toBe(6);
});
test('un modèle est unique par fournisseur ; prix lus en nombres', async () => {
  // insertion de { inputPricePerM: 0.1, outputPricePerM: 0.5 } → relu { inputPricePerM: 0.1, outputPricePerM: 0.5 } ; doublon → Duplicate
});
test('aucune colonne ne peut contenir une clé : pas de colonne api_key ni secret', async () => {
  const [rows] = await poolOf(db).query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME REGEXP 'api_key$|secret'");
  expect(rows).toEqual([]); // api_key_env ne correspond pas au motif
});
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/catalog-schema.test.ts` — Expected: FAIL.

- [ ] **Step 3: Écrire le schéma et générer la migration** — ajouter `./server/src/db/schema/catalog.ts` à `drizzle.config.ts`. Run: `npx drizzle-kit generate` — Expected: un seul nouveau fichier `server/drizzle/0001_*.sql`, sans modification des tables du plan 1.

- [ ] **Step 4: Implémenter `seedProviders` et le brancher** dans `prepareDatabase`.

- [ ] **Step 5: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: tables du catalogue, migration et fournisseurs préconfigurés"`

---

### Task 9: API des fournisseurs et des modèles, assistant `/models`, `/health`

**Files:**
- Create : `server/src/modules/catalog/providers.repo.ts`, `models.repo.ts`, `catalog.service.ts`, `catalog.routes.ts`
- Modify : `server/src/app.ts` (`AppDeps.registry`, enregistrement des routes, `/health`), `server/src/index.ts`, `server/test/helpers/test-app.ts` (`buildTestApp({ env?, fakeLlm?, fetch? })` avec `env` vide par défaut, jamais `process.env` ; `seedProvider(db, overrides)`, `seedModel(db, overrides)`)
- Test : `server/test/catalog-api.test.ts`, `server/test/health.test.ts`

**Interfaces:**
- Consumes : `Registry`, `KeyStatus`, `ProviderError` (Task 7, Task 3), tables (Task 8), `KNOWN_PRICES` (Task 5), `audit` et `app.requireAdmin` (plan 1).
- Produces :
  - `AppDeps` étendu : `registry: Registry`.
  - `type PublicProvider = { id; name; type; baseUrl; apiKeyEnv: string | null; maxConcurrency; enabled; keyRequired: boolean; keyPresent: boolean; fake: boolean; modelCount: number }`
  - `type PublicModel = { id; providerId; providerName; providerType; apiModelId; displayName; color; inputPricePerM: number; outputPricePerM: number; priceSource; supportsVision; supportsPdf; contextWindow: number | null; enabled; keyPresent: boolean; available: boolean; createdAt: string }` (`available` = modèle et fournisseur actifs et clé présente : seul critère de sélection pour le plan 3).
  - `type RemoteModelView = RemoteModel & { alreadyAdded: boolean }`
  - `createCatalogService(deps: { db; registry; clock })` → `listProviders()`, `createProvider(actor, input)`, `updateProvider(actor, id, patch)`, `remoteModels(id): Promise<RemoteModelView[]>`, `listModels(actor)`, `getModel(id): Promise<PublicModel & { provider: PublicProvider }>`, `createModel(actor, input)`, `updateModel(actor, id, patch)`, `keyPresence(): Promise<{ name: string; keyPresent: boolean }[]>`
  - Routes : `GET /api/providers` (connecté) ; **A** `POST /api/providers`, `PATCH /api/providers/:id`, `GET /api/providers/:id/remote-models` ; `GET /api/models` (connecté ; un Utilisateur ne voit que les modèles `enabled`) ; `GET /api/models/:id` (connecté ; 404 pour un Utilisateur si désactivé) ; **A** `POST /api/models`, `PATCH /api/models/:id`.
  - Validation Zod : fournisseur `name` 1 à 100 ; `baseUrl` URL `https:`, ou `http:` seulement vers `localhost` / `127.0.0.1` (Ollama) ; `apiKeyEnv` `null` ou `^[A-Z][A-Z0-9_]{0,55}_API_KEY$` et hors liste interdite (`DATABASE_URL`, `DB_PASSWORD`, `CRON_SECRET`, `SMTP_PASS`, `BOOTSTRAP_ADMIN_PASSWORD`, tout nom commençant par `DB_` ou `SMTP_`) ; `maxConcurrency` 1 à 10. Modèle : `apiModelId` 1 à 200, `displayName` 1 à 200, `color` `^#[0-9A-Fa-f]{6}$` (défaut : couleur de la palette choisie par hachage de `apiModelId`), prix 0 à 100 000 avec 4 décimales au plus, `contextWindow` entier positif ou `null`.
  - Codes d'erreur : `provider_name_taken` (409), `model_exists` (409), `key_missing` (409), `provider_error` (502, champ supplémentaire `providerCode`, message = celui de la `ProviderError`).
  - `/health` : `{ status, db, worker, providers: { name: string; keyPresent: boolean }[] }` (fournisseurs actifs, triés par nom, booléens seulement).
  - Audit : `provider_created`, `provider_updated`, `model_created`, `model_updated`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test('GET /api/providers : état des clés, jamais leur valeur', async () => {
  // buildTestApp({ env: { OPENAI_API_KEY: 'sk-test-0123456789abcdef' } }) puis seedProviders
  const res = await get('/api/providers', userSession);
  expect(res.json().providers.find((p) => p.name === 'OpenAI')).toMatchObject({ apiKeyEnv: 'OPENAI_API_KEY', keyPresent: true });
  expect(res.json().providers.find((p) => p.name === 'Mistral').keyPresent).toBe(false);
  expect(res.body).not.toContain('sk-test-0123456789abcdef');
});
test.each(['DB_PASSWORD', 'CRON_SECRET', 'DATABASE_URL', 'SMTP_PASS', 'BOOTSTRAP_ADMIN_PASSWORD', 'DB_API_KEY', 'mistral_api_key', 'MISTRAL'])('apiKeyEnv %s refusé', async (name) => {
  expect((await post('/api/providers', { name: 'X', type: 'openai_compatible', baseUrl: 'https://x.test/v1', apiKeyEnv: name }, admin)).json().error.code).toBe('validation');
});
test('baseUrl http:// refusée sauf localhost', async () => { /* http://evil.test → 400 ; http://localhost:11434/v1 → 201 */ });
test('remote-models : liste du fournisseur, modèles déjà ajoutés marqués', async () => {
  // fetch injecté : GET https://api.mistral.ai/v1/models → fixture ; un modèle déjà en base
  expect(res.json().models).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'mistral-large', alreadyAdded: true })]));
});
test('remote-models sans clé → 409 key_missing', async () => { /* … */ });
test('remote-models : 401 du fournisseur → 502 provider_error / auth_invalid, sans la clé', async () => {
  expect(res.statusCode).toBe(502); expect(res.json().error).toMatchObject({ code: 'provider_error', providerCode: 'auth_invalid' });
  expect(res.body).not.toContain(key);
});
test('remote-models : fournisseur muet → réponse en moins de 16 s, code timeout', async () => { /* fetch qui ne répond jamais ; horloge réelle, vi.useFakeTimers interdit ici */ }, 20_000);
test('créer un modèle, doublon → 409 model_exists', async () => { /* … */ });
test('prix : 4 décimales au plus, négatif refusé', async () => { /* 0.12345 → validation ; -1 → validation */ });
test('available : faux si clé absente, fournisseur ou modèle désactivé', async () => { /* … */ });
test('Utilisateur : 403 sur POST/PATCH providers et models et remote-models ; modèles désactivés invisibles', async () => { /* … */ });
test('chaque modification est auditée', async () => { /* … */ });
// server/test/health.test.ts (remplace le test d’égalité existant)
test('GET /health : présence des clés par fournisseur actif', async () => {
  expect(res.json()).toEqual({ status: 'ok', db: 'ok', worker: 'stopped', providers: expect.arrayContaining([{ name: 'OpenAI', keyPresent: true }, { name: 'Mistral', keyPresent: false }]) });
  expect(res.body).not.toContain('sk-test');
});
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/catalog-api.test.ts server/test/health.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — `remoteModels` appelle `registry.adapterFor(p).listModels(AbortSignal.timeout(15_000))`, convertit une `ProviderError` en `AppError('provider_error', 502, message, { providerCode })`, complète les prix par `KNOWN_PRICES` quand ils sont `null`, trie par id. `index.ts` : `createProviderRegistry({ fakeLlm: config.fakeLlm, appBaseUrl: config.appBaseUrl })` (avec `process.env`). En mode faux, un journal d'information au démarrage : « Faux fournisseur actif (AIC_FAKE_LLM=1) : aucun appel réel ».

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: API des fournisseurs et des modèles, assistant /models et clés dans /health"`

---

### Task 10: Synchronisation du catalogue OpenRouter et nouveautés

**Files:**
- Create : `server/src/modules/catalog/openrouter-sync.ts`
- Modify : `server/src/modules/jobs/handlers.ts` (`catalog_refresh`), `server/src/modules/jobs/schedules.ts` (`catalog-refresh` à `06:00`), `server/src/modules/catalog/catalog.service.ts`, `catalog.routes.ts`, `server/test/helpers/test-app.ts`
- Create (fixtures) : `server/test/fixtures/openrouter/models-day2.json`
- Test : `server/test/openrouter-sync.test.ts`, `server/test/scheduler.test.ts` (ajout)

**Interfaces:**
- Consumes : `parseOpenRouterModels`, `isOpenRouter` (Task 4), tables (Task 8), service et routes (Task 9), `JobHandler` (plan 1).
- Produces :
  - `OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'`
  - `refreshOpenRouterCatalog(deps: { db: Db; fetch?: typeof fetch; now: Date; signal?: AbortSignal }): Promise<{ added: number; updated: number; initial: boolean; localPricesUpdated: number }>` — délai de 30 s ; réponse non 2xx ou JSON illisible → lève une erreur (la file réessaie) sans rien écrire ; première synchronisation (table vide) → toutes les lignes `initialSync = true` ; ensuite les inconnues sont ajoutées `initialSync = false`, `firstSeenAt = now` ; les connues voient `name`, prix, modalités, `contextWindow` et `lastSeenAt` mis à jour ; les modèles locaux des fournisseurs OpenRouter (`isOpenRouter(baseUrl)`) dont `priceSource = 'openrouter'` reçoivent les nouveaux prix non nuls.
  - `createCatalogRefreshHandler(deps: { fetch?: typeof fetch }): JobHandler`
  - `JobHandlersDeps` étendu : `fetch?: typeof fetch`.
  - Service : `newModels(): Promise<NewModel[]>`, `dismissNew(actor, id): Promise<void>` avec `type NewModel = { id; openrouterId; name; inputPricePerM: number | null; outputPricePerM: number | null; supportsVision: boolean; supportsPdf: boolean; contextWindow: number | null; firstSeenAt: string }`.
  - Routes **A** : `GET /api/catalog/new` → `{ models: NewModel[]; openRouterProviderId: string | null }` (premier fournisseur OpenRouter actif, pour le bouton « Ajouter ») ; `POST /api/catalog/:id/dismiss` (204, audit `catalog_dismissed`).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test('première synchronisation silencieuse', async () => {
  const r = await refreshOpenRouterCatalog({ db, fetch: serve('openrouter/models.json'), now: day1 });
  expect(r).toMatchObject({ initial: true }); expect(await svc.newModels()).toEqual([]);
});
test('le lendemain, seuls les modèles apparus sont des nouveautés', async () => {
  await refresh(day1, 'openrouter/models.json'); await refresh(day2, 'openrouter/models-day2.json');
  expect((await svc.newModels()).map((m) => m.openrouterId)).toEqual(['newlab/model-x']);
});
test('nouveauté de plus de 30 jours, écartée, ou déjà dans le catalogue local : absente', async () => { /* … */ });
test('échec de la première synchronisation (500) : rien écrit, la suivante reste silencieuse', async () => {
  await expect(refresh(day1, status500)).rejects.toThrow(); expect(await count(openrouterCatalog)).toBe(0);
  expect((await refresh(day2, 'openrouter/models.json')).initial).toBe(true);
});
test('prix "-1" stocké null, jamais 0', async () => { expect(row('openrouter/auto').inputPricePerM).toBeNull(); });
test('prix du catalogue local mis à jour pour priceSource openrouter seulement', async () => { /* manuel inchangé */ });
test('API : 403 pour un Utilisateur ; dismiss retire la nouveauté et audite', async () => { /* … */ });
test('la tâche catalog_refresh est planifiée à 06:00 heure de Paris', async () => {
  // scheduleDueJobs(db, appSchedules(), new Date('2026-03-10T05:01:00Z')) → une tâche catalog_refresh
});
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/openrouter-sync.test.ts server/test/scheduler.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — écritures dans une transaction ; « absent du catalogue local » = aucun `models.apiModelId` égal à `openrouterId` chez un fournisseur dont `isOpenRouter(baseUrl)`. `index.ts` passe `fetch` par défaut (global).

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: synchronisation quotidienne du catalogue OpenRouter et nouveautés"`

---

### Task 11: Interface Admin des fournisseurs et assistant d'ajout

Utiliser le skill **`frontend-design`** (cartes, tableaux, pastilles et boutons de `maquettes/resultats-nuit.html` ; logos des fournisseurs de `web/src/three/providers.ts` quand le nom correspond).

**Files:**
- Create : `web/src/api/catalog.ts`, `web/src/pages/admin/ProvidersPage.tsx`, `web/src/components/catalog/RemoteModelsDialog.tsx`, `web/src/components/catalog/ModelForm.tsx`
- Modify : `web/src/app/routes.tsx` (`/admin/fournisseurs`), `web/src/app/AppShell.tsx` (ADMIN : « Fournisseurs »), `web/src/api/messages.ts` (`key_missing`, `provider_error`, `provider_name_taken`, `model_exists`)
- Test : `web/src/pages/admin/ProvidersPage.test.tsx`, `web/src/components/catalog/RemoteModelsDialog.test.tsx`

**Interfaces:**
- Consumes : routes de la Task 9 et types `PublicProvider`, `PublicModel`, `RemoteModelView`.
- Produces (`web/src/api/catalog.ts`) : types miroirs ; `listProviders()`, `createProvider(body)`, `updateProvider(id, patch)`, `listRemoteModels(id)`, `listModels()`, `getModel(id)`, `createModel(body)`, `updateModel(id, patch)`, `listNewModels()`, `dismissNewModel(id)` ; clés TanStack `PROVIDERS_KEY`, `MODELS_KEY`, `NEW_MODELS_KEY`.
- Produces (composants) : `<RemoteModelsDialog providerId open onOpenChange initialSearch? />` — liste filtrable (recherche texte), cases à cocher, pour chaque modèle coché un formulaire `ModelForm` compact (nom affiché, couleur, prix entrée/sortie, vision, PDF, contexte), modèles déjà ajoutés grisés « déjà ajouté » ; « Ajouter N modèles » crée les modèles un par un et affiche les échecs ligne par ligne. `<ModelForm value onChange />` réutilisé par la fiche (Task 12).

- [ ] **Step 1: Écrire les tests qui échouent**

```tsx
test('pastilles « Clé présente » / « Clé manquante » avec le nom de la variable', async () => {
  expect(await screen.findByText('OPENAI_API_KEY')).toBeInTheDocument();
  expect(screen.getAllByText('Clé manquante').length).toBeGreaterThan(0);
});
test('mode faux : pastille « Faux fournisseur »', async () => { /* … */ });
test('clé manquante : bouton « Interroger /models » désactivé, consigne hPanel affichée', async () => { /* … */ });
test('assistant : filtre, prix OpenRouter préremplis, modèle déjà ajouté grisé', async () => {
  await user.type(screen.getByRole('searchbox'), 'sonnet');
  expect(screen.getByDisplayValue('2')).toBeInTheDocument(); expect(screen.getByText('déjà ajouté')).toBeInTheDocument();
});
test('assistant : « Ajouter 2 modèles » envoie deux POST et signale l’échec du second', async () => { /* 201 puis 409 model_exists */ });
test('erreur provider_error affichée avec le message du fournisseur', async () => { expect(await screen.findByRole('alert')).toHaveTextContent(/Clé invalide/); });
test('formulaire fournisseur : variable de clé invalide refusée avant envoi', async () => { /* « DB_PASSWORD » → message « doit se terminer par _API_KEY » */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project web web/src/pages/admin/ProvidersPage.test.tsx web/src/components/catalog` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — `ProvidersPage` : une carte par fournisseur (logo, nom, type, URL, variable de clé en Noto Sans Mono, pastille d'état, nombre de modèles, concurrence, interrupteur actif), boutons « Interroger /models » et « Modifier » ; bouton « Ajouter un fournisseur » (fenêtre : nom, type, URL, variable, concurrence). Encadré d'aide : « Les clés se saisissent dans hPanel → Variables d'environnement, puis “Appliquer les modifications”. Elles ne sont jamais enregistrées par l'application. »

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project web && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: écran des fournisseurs et assistant d'ajout de modèles"`

---

### Task 12: Liste des modèles, fiche modèle et nouveautés du tableau de bord

Utiliser le skill **`frontend-design`** (onglet « Fiche modèle » de `maquettes/ecrans-nuit.html`, « Tableau de bord » pour la carte des nouveautés).

**Files:**
- Create : `web/src/pages/ModelsPage.tsx`, `web/src/pages/ModelPage.tsx`, `web/src/components/catalog/NewModelsCard.tsx`
- Modify : `web/src/app/routes.tsx` (`/modeles`, `/modeles/:id`), `web/src/app/AppShell.tsx` (EXPLORER : « Modèles »), `web/src/pages/DashboardPage.tsx`
- Test : `web/src/pages/ModelsPage.test.tsx`, `web/src/pages/ModelPage.test.tsx`, `web/src/components/catalog/NewModelsCard.test.tsx`

**Interfaces:**
- Consumes : `web/src/api/catalog.ts`, `<RemoteModelsDialog />`, `<ModelForm />` (Task 11).
- Produces : pages et carte ; aucune nouvelle API.

- [ ] **Step 1: Écrire les tests qui échouent**

```tsx
// ModelsPage
test('tableau : modèle (pastille de couleur), fournisseur, prix $/M, vision, PDF, contexte, disponibilité', async () => { /* … */ });
test('filtres : fournisseur, « disponibles seulement »', async () => { /* … */ });
test('Admin : bouton « Ajouter des modèles » ; Utilisateur : absent', async () => { /* … */ });
// ModelPage
test('fiche : fournisseur, identifiant API, prix, capacités, variable de clé sans valeur', async () => {
  expect(screen.getByText('claude-opus-5-5')).toBeInTheDocument(); expect(screen.getByText('ANTHROPIC_API_KEY')).toBeInTheDocument();
});
test('sections de mesures vides : « Aucune série pour l’instant »', async () => { /* qualité, vitesse, radar, historique : plan 4 */ });
test('Admin : modifier prix, couleur et activation ; Utilisateur : lecture seule', async () => { /* … */ });
// NewModelsCard
test('Admin : nouveautés avec date, prix et capacités ; « Ignorer » retire la ligne', async () => { /* … */ });
test('« Ajouter » ouvre l’assistant sur le fournisseur OpenRouter, filtré sur le modèle', async () => { /* initialSearch = openrouterId */ });
test('sans fournisseur OpenRouter actif : « Ajouter » désactivé avec explication', async () => { /* … */ });
test('Utilisateur : carte absente du tableau de bord (aucun appel à /api/catalog/new)', async () => { /* … */ });
test('aucune nouveauté : « Rien de nouveau sur OpenRouter ces 30 derniers jours »', async () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project web web/src/pages/ModelsPage.test.tsx web/src/pages/ModelPage.test.tsx web/src/components/catalog/NewModelsCard.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — fiche selon la maquette : en-tête (pastille de couleur, nom, fournisseur, identifiant API en mono), cartes « Prix » (entrée / sortie en $ par million, source « OpenRouter » ou « saisi »), « Capacités » (vision, PDF, contexte), « Clé » (nom de la variable et pastille d'état), puis les emplacements « Chiffres clés », « Radar par catégorie » et « Historique des séries » à l'état vide. Le tableau de bord garde l'en-tête « Bonjour {name} » et ajoute `NewModelsCard` pour l'Admin.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project web && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: liste et fiche des modèles, nouveautés OpenRouter sur le tableau de bord"`

---

### Task 13: Documentation, vérification complète et parcours dans le navigateur

**Files:**
- Modify : `docs/deploiement.md` (section « Ajouter une clé API » : liste des fournisseurs préconfigurés, vérification sur l'écran Fournisseurs et dans `/health`, `AIC_FAKE_LLM` jamais en production), `README.md` (développement avec `AIC_FAKE_LLM=1`), `docs/superpowers/specs/2026-10-16-comparateur-ia-design.md` (§16 lignes 3 et 5 : fixtures construites d'après la documentation des fournisseurs ; vérification sur appel réel au premier essai rapide du plan 3, les clés n'existant que sur Hostinger ; §6.3 : prix Anthropic vérifiés le 2026-10-17)

- [ ] **Step 1: Mettre à jour la documentation** comme indiqué ci-dessus.

- [ ] **Step 2: Vérification complète** — Run: `npx vitest run && npm run typecheck && npm run build` — Expected: PASS ; `server/test/entry.test.ts` passe (aucun `await` de premier niveau, le SDK Anthropic compris).

- [ ] **Step 3: Parcours dans le navigateur** — `.env` local avec `AIC_FAKE_LLM=1` ; `preview_start` sur `comparateur-api` et `comparateur-web`. Vérifier : écran Fournisseurs (six fournisseurs, pastilles « Faux fournisseur »), assistant sur Mistral (liste `fake-*`, ajout de deux modèles), liste des modèles, fiche d'un modèle (modification du prix), `/health` (présence des clés), compte Utilisateur (pas d'entrée Fournisseurs, fiche en lecture seule). Puis sans `AIC_FAKE_LLM` : pastilles « Clé manquante » et bouton « Interroger /models » désactivé. Capture d'écran de la fiche modèle.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs: fournisseurs, clés et faux fournisseur"`
