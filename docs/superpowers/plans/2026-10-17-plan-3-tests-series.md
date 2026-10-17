# Plan 3 – Tests et séries : plan de réalisation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Écrire des tests (prompts, pièces jointes, méthode de notation), les ranger en suites, les essayer sur un modèle (essai rapide), estimer puis lancer une série qui s'exécute seule dans la file de tâches (concurrence, mesures, coûts, nouvelles tentatives, découpage en tranches de 10 min, reprise après redémarrage, pause, plafond, ajout de modèle, relance des erreurs) et la suivre en direct.

**Architecture:** Trois modules serveur : `tests/` (tests, pièces jointes, suites, essai rapide), `runs/` (estimation, création, moteur `run_execute`, contrôle), `usage/` (table `ai_usage`). Le moteur appelle `registry.adapterFor(provider).generate(req, signal)` (plan 2) et mesure le flux. Une série n'a jamais plus d'une tâche `run_execute` active (`runs.active_job_id`). Les essais rapides passent par une **voie rapide** : un second worker qui ne prend que les tâches `quick_try`, pour ne pas attendre derrière une tranche de série. La notation (réponse attendue, juge, manuelle) arrive au plan 4 : le plan 3 pose `score_status` et un crochet `onResultFinished`.

**Tech Stack:** celle des plans 1 et 2, plus `@fastify/multipart` (^10.1).

**Spec:** `docs/superpowers/specs/2026-10-16-comparateur-ia-design.md` (§5.3, §5.4, §5.5 `ai_usage`, §7, §8.1, §8.2, §9.1 « vue en direct », §10 « Tests » et « Séries », §11.3, §12.2, §13, §16 lignes 2 et 4). Plans précédents : `docs/superpowers/plans/2026-10-16-plan-1-fondations.md`, `docs/superpowers/plans/2026-10-17-plan-2-fournisseurs-modeles.md`. Maquettes : `maquettes/ecrans-nuit.html`, écrans « Éditeur de test », « Lancer une série », « Suivi en direct » (scène de la ligne 353). Référence du dépôt de fichiers : `$AO/server/src/modules/documents/filetype.ts` et `documents.routes.ts` (`$AO` = `C:\Users\laure\OneDrive\Bureau\Claude directory\Code-appels offre`, lecture seule).

## Global Constraints

- Toutes les Global Constraints des plans 1 et 2 restent en vigueur (Node 24, TypeScript strict ESM, aucun `await` de premier niveau, format d'erreur unique en français, UUID `CHAR(36)`, `DATETIME(3)`, CSRF, thème « Nuit », skill `frontend-design` pour toute tâche d'interface, clés jamais renvoyées ni journalisées, base de test MariaDB sur `127.0.0.1:3307`).
- **Aucune requête HTTP au-delà de 60 s** (proxy Hostinger) : tout appel de modèle passe par la file ; l'interface interroge toutes les **2 s**.
- Test : nom 1 à 200, catégorie 1 à 100, tags (0 à 20, 1 à 50 caractères), prompt système facultatif (≤ 50 000), prompt utilisateur 1 à 100 000, température 0 à 2 (défaut **0,2**), max tokens 1 à **16 000** (défaut **1 000**), `scoring_method` `judge` | `expected` | `manual`, `scoring_config` validée par Zod : `expected` = `{ mode: 'exact', expected, ignoreCase (défaut true), ignoreAccents (défaut false) }` | `{ mode: 'contains', items (1 à 50), ignoreCase (défaut true) }` | `{ mode: 'regex', pattern, flags }` (regex compilée à l'enregistrement, drapeaux parmi `gimsuy`) ; `judge` = `{ criteria (1 à 5 000), reference? (≤ 50 000) }` ; `manual` = `{}`.
- Pièces jointes : types `image/png`, `image/jpeg`, `image/webp`, `application/pdf` **reconnus par signature** (jamais par l'extension ni le type annoncé), **10 Mo** maximum, au plus 10 par test ; stockées dans `DATA_DIR/attachments/<testId>/<uuid>` (nom généré), empreinte SHA-256, nombre de pages pour un PDF ; jamais servies directement : téléchargement Admin par l'API avec `Content-Disposition: attachment` et `X-Content-Type-Options: nosniff`.
- Un test utilisé par une série est **archivé** au lieu d'être supprimé ; une pièce jointe référencée par un instantané de série est **retirée du test** (`deleted_at`) sans effacer son fichier.
- Série : répétitions 1 à **5** (défaut 1), concurrence 1 à 8 (défaut **4**), plafond facultatif en $ (> 0), pondération par défaut qualité **50**, vitesse **20**, coût **20**, fiabilité **10** (entiers ≥ 0, somme 100).
- Estimation : tokens d'entrée = caractères (système + prompt) ÷ 4, arrondi au supérieur, + **1 500** par image + **800** par page de PDF ; coût maximal d'un appel = entrée × prix d'entrée + `max_tokens` × prix de sortie, ÷ 1 000 000 ; juge (tests `judge` seulement) : entrée = (caractères du prompt + critères + référence) ÷ 4 + `max_tokens` du test + 300, sortie **800** ; durée = Σ par modèle (médiane historique de `total_ms` des résultats `done` du modèle, **10 s** par défaut × appels du modèle) ÷ concurrence.
- Moteur : ordre des résultats en attente par répétition, puis position du test, puis **modèles en alternance** ; au plus `runs.concurrency` appels simultanés et `providers.max_concurrency` par fournisseur ; délai d'un appel **120 s** ; nouvelles tentatives : **2** au plus pour `rate_limited`, `provider_unavailable`, `timeout` (et une coupure réseau), après **2 s** puis **8 s**, ou `Retry-After` plafonné à **30 s** ; les autres erreurs sont définitives.
- Mesures : `t0` = envoi ; `ttft_ms` = premier événement `text` non vide ; `total_ms` = `finish` ou fin du flux ; `tokens_per_s` = tokens de sortie hors raisonnement ÷ ((`total_ms` − `ttft_ms`) / 1000), seulement si la génération dure plus de **100 ms** ; usage absent → tokens estimés (caractères ÷ 4) et `tokens_estimated` = vrai ; coût = coût du fournisseur s'il existe (`cost_source` `provider`), sinon (entrée × prix d'entrée + (sortie + raisonnement) × prix de sortie) ÷ 1 000 000 (`computed`) ; réponse tronquée à **200 000** caractères ; message d'erreur masqué (`redact`).
- Découpage : une tranche ne lance plus d'appel ni de nouvelle tentative après **10 min** (`SLICE_MS = 600_000`), attend les appels en cours puis enfile la tranche suivante (délai maximal d'une tranche ≈ 12 min, sous les 14 min de la file).
- `ai_usage` : une ligne par appel facturé (origine `run` ou `quick_try` ; `judge` au plan 4).
- Essai rapide : tâche `quick_try` sur la voie rapide (second worker, types `['quick_try']`, intervalle 1 s), délai 120 s, sans nouvelle tentative, résultat gardé dans `jobs.progress`, coût dans `ai_usage`, aucun résultat de série créé.
- Point différé du plan 1, à traiter avant toute nouvelle scène 3D : la sonde `hasWebGL` libère son contexte (`WEBGL_lose_context`), et `useThreeScene` passe en repli 2D sur `webglcontextlost`.
- Après fusion dans `main` : **ne pas déployer** ; envoyer un message à la session principale (`local_2daa5432-7530-4a4f-b71c-c5bd7955c869`) avec la liste des nouvelles variables d'environnement (aucune prévue pour ce plan).

## Review Focus

1. **Redémarrage ou deuxième processus en pleine série** (LiteSpeed lance un processus par nom d'hôte) : une seule tâche `run_execute` active par série, aucun appel en double, les résultats `running` orphelins repassent `pending` sans consommer de tentative, le coût n'est compté qu'une fois. → tests en Task 8 et Task 9.
2. **Plafond atteint avec des appels en vol** : les appels lancés réservent leur coût maximal ; aucun nouvel appel ne fait dépasser le plafond, la série passe en pause motif `budget`, et relever le plafond puis reprendre termine la série. → tests en Task 9.
3. **Test modifié, archivé ou dont une pièce jointe est retirée après le lancement** : l'instantané ne change pas et la série lit toujours le fichier de la pièce jointe. → tests en Task 4 et Task 7.
4. **Fichier déguisé** : `.png` contenant du HTML, SVG, PDF de 11 Mo, image vide : refus clair avant écriture définitive ; rien n'est jamais servi en ligne dans le navigateur. → tests en Task 4.
5. **Essai rapide pendant une longue série** : la réponse arrive sans attendre la fin de la tranche en cours (voie rapide), et une requête de suivi ne dure jamais plus de quelques millisecondes. → tests en Task 1 et Task 10.

---

## Structure des fichiers (plan 3)

```
server/src/
  db/schema/tests.ts                 # tests, test_attachments, suites, suite_tests
  db/schema/runs.ts                  # runs, run_models, run_tests, results, ai_usage
  modules/tests/  tests.repo.ts  tests.service.ts  tests.routes.ts  scoring-config.ts
                  attachments.ts  filetype.ts  suites.service.ts  suites.routes.ts  quick-try.ts
  modules/runs/   estimate.ts  runs.repo.ts  runs.service.ts  runs.routes.ts  snapshot.ts
                  engine.ts  call.ts  run-job.ts  progress.ts
  modules/usage/  usage.ts
server/drizzle/0002_*.sql
web/src/
  api/tests.ts  api/runs.ts
  pages/admin/TestsPage.tsx  pages/admin/TestEditorPage.tsx  pages/admin/SuitesPage.tsx
  pages/RunsPage.tsx  pages/LaunchRunPage.tsx  pages/RunPage.tsx
  components/tests/{ScoringConfigForm,AttachmentsField,QuickTryPanel}.tsx
  components/runs/{LiveMatrix,ActivityFeed,RunControls,RunMetricsTable}.tsx
  three/live-flow-scene.ts  three/LiveFlowFallback.tsx
```

---

### Task 1: Prérequis : WebGL, faux fournisseur, voie rapide de la file, masquage borné

**Files:**
- Modify : `web/src/three/animation-policy.ts`, `web/src/three/useThreeScene.ts`, `web/src/three/ThreeStage.tsx`, `server/src/modules/providers/fake.ts`, `server/src/modules/jobs/queue.ts` (`claimJob`), `server/src/modules/jobs/worker.ts` (`startWorker`, `runWorkerOnce`), `server/src/index.ts`, `server/src/modules/errors/report.ts` (`mask`)
- Test : `web/src/three/animation-policy.test.ts`, `web/src/three/ThreeStage.test.tsx`, `server/test/fake-provider.test.ts`, `server/test/jobs.test.ts`, `server/test/errors-report.test.ts`

**Interfaces:**
- Produces :
  - `hasWebGL()` mémorise son résultat (un seul contexte de sonde par page) et libère le contexte de sonde par `getExtension('WEBGL_lose_context')?.loseContext()` ; `resetWebGLProbe()` (tests).
  - `type SceneFactory` : le retour gagne `setData?(data: unknown): void` ; `useThreeScene(factory, canvasRef, data?: unknown)` appelle `scene.setData(data)` à la création et à chaque changement de `data` ; sur `webglcontextlost` du canevas : `preventDefault()`, arrêt de la boucle, `dispose()`, statut `fallback`. `<ThreeStage factory fallback data? className? />` transmet `data`.
  - Faux fournisseur : un identifiant de modèle inconnu prend le profil `fake-equilibre` (au lieu de `model_not_found`) ; le tirage aléatoire intègre un compteur d'appels par (modèle, prompt) tenu au niveau du module, pour qu'une nouvelle tentative sur `fake-instable` puisse réussir ; `resetFakeCallCounters()` (tests). Les directives `[[fake:…]]` restent déterministes.
  - `claimJob(db, workerId, now, types?: string[])` ne réserve que ces types s'ils sont donnés ; `startWorker(deps, handlers, { intervalMs, types? })`.
  - `index.ts` démarre un second worker « voie rapide » `{ types: ['quick_try'], intervalMs: 1000 }` (identifiant suffixé `:rapide`), arrêté avec le premier.
  - `mask()` tronque le message à **20 000** caractères **avant** `redact` (la pile l'est déjà).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// web/src/three/animation-policy.test.ts
test('hasWebGL libère le contexte de sonde et mémorise le résultat', () => {
  const loseContext = vi.fn(); /* getContext simulé renvoyant { getExtension: () => ({ loseContext }) } */
  expect(hasWebGL()).toBe(true); expect(hasWebGL()).toBe(true);
  expect(loseContext).toHaveBeenCalledTimes(1); expect(getContextSpy).toHaveBeenCalledTimes(1);
});
// web/src/three/ThreeStage.test.tsx
test('perte du contexte WebGL → repli 2D', async () => { /* useThreeScene avec une fabrique simulée ; dispatchEvent(new Event('webglcontextlost')) → repli rendu, dispose appelé */ });
test('setData reçoit les données initiales puis chaque mise à jour', async () => { /* rerender avec data différent */ });
// server/test/fake-provider.test.ts
test('modèle inconnu → profil fake-equilibre, pas model_not_found', async () => { /* model 'gpt-x' */ });
test('fake-instable : une nouvelle tentative du même appel peut réussir', async () => {
  // trouver un prompt dont le 1er appel échoue ; un des 5 appels suivants réussit
});
// server/test/jobs.test.ts
test('claimJob filtré par types : la voie rapide ne prend que quick_try', async () => {
  await enqueue(db, { type: 'run_execute' }, now); await enqueue(db, { type: 'quick_try' }, now);
  expect((await claimJob(db, 'w', now, ['quick_try']))!.type).toBe('quick_try');
  expect(await claimJob(db, 'w', now, ['quick_try'])).toBeNull();
});
// server/test/errors-report.test.ts
test('un message de 2 Mo est masqué en moins de 200 ms', async () => { /* 'a-'.repeat(1_000_000) + 'key=x' */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run web/src/three server/test/fake-provider.test.ts server/test/jobs.test.ts server/test/errors-report.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** les points de l'interface.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: prérequis du plan 3 (contexte WebGL, voie rapide de la file, faux fournisseur)"`

---

### Task 2: Schéma des tests, des séries et de la consommation

**Files:**
- Create : `server/src/db/schema/tests.ts`, `server/src/db/schema/runs.ts`, `server/drizzle/0002_*.sql` (généré)
- Modify : `drizzle.config.ts`
- Test : `server/test/runs-schema.test.ts`

**Interfaces:**
- Produces (Drizzle, colonnes `snake_case` en base) :
  - `tests` : `id`, `name` (varchar 200), `category` (varchar 100), `tags` (JSON, tableau), `systemPrompt` (`MEDIUMTEXT` nullable), `userPrompt` (`MEDIUMTEXT`), `temperature` (`DECIMAL(3,2)`, `mode: 'number'`, défaut 0.2), `maxTokens` (int, défaut 1000), `scoringMethod` (enum `judge` | `expected` | `manual`), `scoringConfig` (JSON), `archivedAt` (nullable), `createdAt`, `updatedAt` ; index sur `category`.
  - `testAttachments` : `id`, `testId` (FK `tests.id` `ON DELETE CASCADE`), `originalName` (varchar 255), `mime` (enum des 4 types), `size` (int), `storagePath` (varchar 500, relatif à `DATA_DIR`), `sha256` (char 64), `pages` (int nullable), `deletedAt` (nullable), `createdAt`.
  - `suites` : `id`, `name` (varchar 200, unique), `description` (text nullable), `createdAt`, `updatedAt` ; `suiteTests` : `suiteId` (FK cascade), `testId` (FK `RESTRICT`), `position` (int) ; clé primaire (`suiteId`, `testId`).
  - `runs` : `id`, `name` (varchar 200), `suiteId` (nullable, `SET NULL`), `judgeModelId` (nullable), `repetitions` (int), `concurrency` (int), `budgetUsd` (`DECIMAL(10,4)` nullable), `status` (enum `queued` | `running` | `paused` | `completed` | `interrupted`), `pauseReason` (enum `user` | `budget`, nullable), `modelsCostUsd` et `judgeCostUsd` (`DECIMAL(12,6)`, défaut 0), `weights` (JSON `{ quality, speed, cost, reliability }`), `activeJobId` (char 36 nullable), `createdBy` (FK `users.id`), `createdAt`, `startedAt`, `completedAt` (nullables).
  - `runModels` : `runId` (FK cascade), `modelId` (FK `RESTRICT`), `addedAt` ; clé primaire (`runId`, `modelId`).
  - `runTests` : `id`, `runId` (FK cascade), `testId` (FK `RESTRICT`), `position`, `snapshot` (JSON `TestSnapshot`, Task 7).
  - `results` : `id`, `runId`, `runTestId` (FK cascade), `modelId`, `repetition` (int), `status` (enum `pending` | `running` | `done` | `error` | `timeout` | `unsupported`), `attempts` (int, défaut 0), `responseText` (`MEDIUMTEXT` nullable), `finishReason` (varchar 20 nullable), `inputTokens`, `outputTokens`, `reasoningTokens` (int nullables), `tokensEstimated` (bool, défaut faux), `ttftMs`, `totalMs` (int nullables), `tokensPerS` (`DECIMAL(10,2)` nullable), `costUsd` (`DECIMAL(12,6)` nullable), `costSource` (enum `computed` | `provider`, nullable), `errorCode` (varchar 50 nullable), `errorMessage` (text nullable), `scoreStatus` (enum `pending` | `done` | `awaiting_manual` | `judge_failed`, défaut `pending`), `autoScore` (`DECIMAL(4,2)` nullable), `judgeRationale` (text nullable), `judgeCostUsd` (`DECIMAL(12,6)` nullable), `overrideScore` (`DECIMAL(4,2)` nullable), `overrideBy` (char 36 nullable), `startedAt`, `completedAt` (nullables) ; **unique** (`runId`, `runTestId`, `modelId`, `repetition`) ; index (`runId`, `status`).
  - `aiUsage` : `id`, `origin` (enum `run` | `judge` | `quick_try`), `runId` (nullable), `modelId`, `inputTokens`, `outputTokens`, `reasoningTokens` (int), `costUsd` (`DECIMAL(12,6)`), `createdAt` ; index sur `createdAt`.
  - Toutes les colonnes décimales en `mode: 'number'`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test('migration 0002 : les dix tables existent', async () => { /* SELECT sur tests … ai_usage */ });
test('résultat unique par série, test, modèle et répétition', async () => { /* doublon → Duplicate (dans cause) */ });
test('un test référencé par une suite ou une série ne peut pas être supprimé en base (RESTRICT)', async () => { /* … */ });
test('décimaux relus en nombres', async () => { /* temperature 0.2, costUsd 0.000123 */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/runs-schema.test.ts` — Expected: FAIL.

- [ ] **Step 3: Écrire les schémas et générer la migration** — Run: `npx drizzle-kit generate` — Expected: un seul nouveau fichier `server/drizzle/0002_*.sql`, sans modification des tables existantes.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: tables des tests, des suites, des séries et de la consommation"`

---

### Task 3: API des tests et configuration de notation

**Files:**
- Create : `server/src/modules/tests/scoring-config.ts`, `tests.repo.ts`, `tests.service.ts`, `tests.routes.ts`
- Modify : `server/src/app.ts`
- Test : `server/test/scoring-config.test.ts`, `server/test/tests-api.test.ts`

**Interfaces:**
- Consumes : tables (Task 2), `app.requireAdmin`, `audit` (plan 1).
- Produces :
  - `scoringConfigSchema(method)` et `parseScoringConfig(method: ScoringMethod, raw: unknown): ScoringConfig` (Zod, valeurs des Global Constraints ; regex compilée, erreur `validation` « Expression régulière invalide »).
  - `type TestInput = { name; category; tags: string[]; systemPrompt: string | null; userPrompt; temperature: number; maxTokens: number; scoringMethod; scoringConfig }`.
  - `type PublicTest = TestInput & { id; archivedAt: string | null; attachments: PublicAttachment[]; usedInRuns: number; createdAt; updatedAt }`, `type PublicAttachment = { id; originalName; mime; size; pages: number | null; sha256 }`.
  - `createTestsService(deps: { db; clock; config })` → `list({ archived?: boolean; category?: string; tag?: string; q?: string })`, `get(id)`, `create(actor, input)`, `update(actor, id, input)`, `remove(actor, id): Promise<'deleted' | 'archived'>`, `restore(actor, id)`, `categories(): Promise<string[]>`, `tags(): Promise<string[]>`.
  - Routes **A** : `GET /api/tests`, `GET /api/tests/meta` (`{ categories, tags }`), `GET /api/tests/:id`, `POST /api/tests`, `PUT /api/tests/:id`, `DELETE /api/tests/:id` (→ `{ outcome: 'deleted' | 'archived' }`), `POST /api/tests/:id/restore`.
  - `remove` : test utilisé par au moins une série → archivé ; sinon supprimé avec ses fichiers et retiré des suites. Audit : `test_created`, `test_updated`, `test_archived`, `test_deleted`, `test_restored`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// server/test/scoring-config.test.ts
test.each([
  ['expected', { mode: 'exact', expected: 'Paris' }, { mode: 'exact', expected: 'Paris', ignoreCase: true, ignoreAccents: false }],
  ['expected', { mode: 'contains', items: ['a', 'b'] }, { mode: 'contains', items: ['a', 'b'], ignoreCase: true }],
  ['expected', { mode: 'regex', pattern: '^\\d+$', flags: 'i' }, { mode: 'regex', pattern: '^\\d+$', flags: 'i' }],
  ['judge', { criteria: 'Exactitude' }, { criteria: 'Exactitude' }],
  ['manual', {}, {}],
])('%s valide', (m, raw, parsed) => { expect(parseScoringConfig(m, raw)).toEqual(parsed); });
test.each([
  ['expected', { mode: 'regex', pattern: '(', flags: '' }, /Expression régulière invalide/],
  ['expected', { mode: 'regex', pattern: 'a', flags: 'x' }, /validation|drapeau/i],
  ['expected', { mode: 'contains', items: [] }, /validation|items/i],
  ['judge', { criteria: '' }, /validation|criteria/i],
])('%s refusé', (m, raw, re) => { expect(() => parseScoringConfig(m, raw)).toThrow(re); });
// server/test/tests-api.test.ts
test('créer, lire, modifier un test ; valeurs par défaut 0,2 et 1 000', async () => { /* … */ });
test('max tokens 16 001 et température 2,1 refusés', async () => { /* 400 validation */ });
test('supprimer un test jamais utilisé → deleted ; utilisé par une série → archived, toujours lisible', async () => { /* seed run_tests */ });
test('liste : archivés exclus par défaut, filtres catégorie, tag et recherche', async () => { /* … */ });
test('un Utilisateur reçoit 403 sur toutes les routes /api/tests', async () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/scoring-config.test.ts server/test/tests-api.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** dans le style de `server/src/modules/catalog/` (Zod `.strict()`, service, routes, audit).

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: API des tests et configuration de notation"`

---

### Task 4: Pièces jointes des tests

**Files:**
- Create : `server/src/modules/tests/filetype.ts`, `server/src/modules/tests/attachments.ts`
- Modify : `server/src/modules/tests/tests.routes.ts`, `server/src/app.ts` (enregistrement de `@fastify/multipart` : `fileSize` 10 Mo, `files` 1), `package.json`
- Test : `server/test/filetype.test.ts`, `server/test/attachments-api.test.ts`

**Interfaces:**
- Consumes : `testAttachments`, `runTests` (Task 2), service des tests (Task 3), `config.dataDir`.
- Produces :
  - `detectFileType(head: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf' | null` (signatures : PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, WebP `RIFF????WEBP`, PDF `%PDF-`).
  - `countPdfPages(buf: Buffer): number` (occurrences de `/Type /Page` hors `/Pages`, minimum 1).
  - `MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024`, `MAX_ATTACHMENTS_PER_TEST = 10`.
  - `addAttachment(deps, actor, testId, file: { filename: string; stream: Readable }): Promise<PublicAttachment>` — écrit dans un fichier temporaire du même dossier, vérifie taille et signature, calcule SHA-256 et pages, puis renomme ; tout refus supprime le fichier temporaire.
  - `removeAttachment(deps, actor, testId, attachmentId): Promise<'deleted' | 'detached'>` — référencée par un instantané de série (`run_tests.snapshot.attachments[].id`) → `deletedAt` posé, fichier gardé ; sinon ligne et fichier supprimés.
  - `readAttachment(deps: { dataDir: string }, a: { storagePath: string }): Promise<Buffer>` (utilisé par le moteur et l'essai rapide, Tasks 8 et 10) — chemin résolu sous `DATA_DIR` uniquement, refus de tout chemin qui en sort.
  - Routes **A** : `POST /api/tests/:id/attachments` (multipart, champ `file`) → 201 `PublicAttachment` ; `DELETE /api/tests/:id/attachments/:attachmentId` ; `GET /api/tests/:id/attachments/:attachmentId/download` (`Content-Disposition: attachment; filename*=UTF-8''…`, `X-Content-Type-Options: nosniff`).
  - Codes : `unsupported_file_type` (415, « Type de fichier non pris en charge : PNG, JPEG, WebP ou PDF »), `file_too_large` (413, « Fichier trop volumineux (10 Mo au plus) »), `too_many_attachments` (409).
  - Les pièces jointes `deletedAt` ne figurent plus dans `PublicTest.attachments`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// server/test/filetype.test.ts
test.each([[png, 'image/png'], [jpeg, 'image/jpeg'], [webp, 'image/webp'], [pdf, 'application/pdf'], [Buffer.from('<html>'), null], [Buffer.from('<svg'), null], [Buffer.alloc(0), null]])('%#', (b, t) => { expect(detectFileType(b)).toBe(t); });
test('PDF de 3 pages', () => { expect(countPdfPages(pdf3)).toBe(3); });
// server/test/attachments-api.test.ts (DATA_DIR = dossier temporaire du test)
test('dépôt d’un PNG : 201, fichier sous DATA_DIR/attachments/<testId>/, empreinte SHA-256', async () => { /* … */ });
test('HTML renommé en .png → 415, aucun fichier laissé', async () => { /* readdir vide */ });
test('PDF de 11 Mo → 413, aucun fichier laissé', async () => { /* … */ });
test('onzième pièce jointe → 409', async () => { /* … */ });
test('téléchargement : en-têtes attachment et nosniff', async () => { /* … */ });
test('pièce jointe d’un instantané : retirée du test, fichier conservé', async () => { /* seed run_tests avec snapshot.attachments[0].id */ });
test('nom d’origine malveillant (../../x) sans effet sur le chemin', async () => { /* … */ });
test('Utilisateur : 403', async () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/filetype.test.ts server/test/attachments-api.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** en s'inspirant de `$AO/server/src/modules/documents/filetype.ts` et du dépôt de `documents.routes.ts` (flux vers fichier temporaire, contrôle de taille pendant l'écriture). `npm install @fastify/multipart@^10.1`.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: pièces jointes des tests (signature, 10 Mo, stockage hors du dossier public)"`

---

### Task 5: Suites

**Files:**
- Create : `server/src/modules/tests/suites.service.ts`, `suites.routes.ts`
- Modify : `server/src/app.ts`
- Test : `server/test/suites-api.test.ts`

**Interfaces:**
- Produces :
  - `type PublicSuite = { id; name; description: string | null; tests: { id; name; category; scoringMethod; archived: boolean; attachmentCount: number }[]; createdAt; updatedAt }`
  - Routes **A** : `GET /api/suites`, `GET /api/suites/:id`, `POST /api/suites` (`{ name, description?, testIds: string[] }`), `PUT /api/suites/:id` (même corps ; `testIds` donne l'ordre, positions réécrites 0..n−1), `POST /api/suites/:id/duplicate` (nom « <nom> (copie) », suffixe numéroté si pris), `DELETE /api/suites/:id`.
  - Codes : `suite_name_taken` (409), `test_not_found` (400 si un identifiant est inconnu), doublon d'identifiant dans `testIds` → 400 `validation`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test('créer une suite ordonnée puis réordonner', async () => { /* testIds [b, a, c] → positions 0, 1, 2 dans cet ordre */ });
test('dupliquer : « Suite (copie) » puis « Suite (copie 2) »', async () => { /* … */ });
test('test archivé : reste dans la suite, marqué archived', async () => { /* … */ });
test('nom déjà pris → 409 ; test inconnu → 400', async () => { /* … */ });
test('Utilisateur : 403', async () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/suites-api.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter.**

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: suites de tests"`

---

### Task 6: Estimation d'une série

**Files:**
- Create : `server/src/modules/runs/estimate.ts`, `server/src/modules/runs/snapshot.ts`
- Test : `server/test/estimate.test.ts`

**Interfaces:**
- Produces :
  - `type TestSnapshot = { testId; name; category; tags: string[]; systemPrompt: string | null; userPrompt; temperature; maxTokens; scoringMethod; scoringConfig; attachments: { id; originalName; mime; size; sha256; pages: number | null; storagePath }[] }` et `snapshotOf(test: PublicTest & { attachments avec storagePath }): TestSnapshot` (pièces jointes non retirées).
  - `type ModelForEstimate = { id; name; inputPricePerM; outputPricePerM; supportsVision; supportsPdf; medianTotalMs: number | null }`
  - `estimateInputTokens(s: TestSnapshot): number`, `isSupported(s: TestSnapshot, m: Pick<ModelForEstimate, 'supportsVision' | 'supportsPdf'>): boolean`
  - `estimateRun(input: { tests: TestSnapshot[]; models: ModelForEstimate[]; repetitions: number; concurrency: number; judge: ModelForEstimate | null }): RunEstimate` avec `type RunEstimate = { calls: number; unsupported: number; modelsMaxCostUsd: number; judgeMaxCostUsd: number; maxCostUsd: number; durationSeconds: number; perModel: { modelId; calls; unsupported; maxCostUsd }[]; warnings: string[] }` ; formules des Global Constraints ; avertissements : « Le modèle juge fait partie des modèles évalués » et « Le juge ne gère pas les pièces jointes de N tests notés par le juge ».
  - `maxCallCostUsd(s: TestSnapshot, m): number` (réutilisé par le plafond, Task 9).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test('tokens d’entrée : caractères ÷ 4 + 1 500 par image + 800 par page de PDF', () => {
  expect(estimateInputTokens(snap({ systemPrompt: 'a'.repeat(10), userPrompt: 'b'.repeat(30), attachments: [img(), pdf(3)] }))).toBe(10 + 1500 + 2400);
});
test('coût maximal d’un appel', () => {
  // 1 000 tokens d'entrée à 2 $/M + max_tokens 1 000 à 10 $/M = 0,012 $
  expect(maxCallCostUsd(snap({ userPrompt: 'x'.repeat(4000), maxTokens: 1000 }), model({ inputPricePerM: 2, outputPricePerM: 10 }))).toBeCloseTo(0.012, 9);
});
test('combinaisons non supportées exclues du coût et comptées à part', () => { /* image + modèle sans vision */ });
test('24 tests × 6 modèles × 2 répétitions = 288 appels', () => { /* … */ });
test('juge : seulement les tests notés par le juge, 800 tokens de sortie', () => { /* … */ });
test('durée : médiane historique par modèle, 10 s par défaut, ÷ concurrence', () => {
  // modèle A médiane 4 s × 10 appels + modèle B inconnu 10 s × 10 appels, concurrence 4 → 35 s
});
test('avertissement si le juge est évalué', () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/estimate.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** (fonctions pures, sans base).

- [ ] **Step 4: Vérifier le succès** — même commande — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: estimation du coût et de la durée d'une série"`

---

### Task 7: Création et lecture des séries

**Files:**
- Create : `server/src/modules/runs/runs.repo.ts`, `runs.service.ts`, `runs.routes.ts`, `run-job.ts`, `progress.ts`
- Modify : `server/src/app.ts`
- Test : `server/test/runs-api.test.ts`

**Interfaces:**
- Consumes : `estimateRun`, `snapshotOf`, `isSupported` (Task 6), catalogue (`PublicModel.available`, plan 2), service des tests et suites (Tasks 3 à 5), `enqueue` (plan 1).
- Produces :
  - `type Weights = { quality: number; speed: number; cost: number; reliability: number }` (défaut 50 / 20 / 20 / 10).
  - `type RunInput = { name: string; suiteId?: string; testIds: string[]; modelIds: string[]; repetitions: number; concurrency: number; judgeModelId?: string | null; budgetUsd?: number | null; weights?: Weights }` (`testIds` dans l'ordre voulu ; avec `suiteId`, l'ordre de la suite).
  - `enqueueRunJob(db: DbOrTx, runId: string, now: Date): Promise<string>` (`run-job.ts`) — dans une transaction, `SELECT … FOR UPDATE` de la série ; si `activeJobId` désigne une tâche `queued` ou `running`, la renvoie ; sinon crée une tâche `run_execute` `{ runId }` et l'enregistre dans `activeJobId`.
  - `createRunsService(deps: { db; clock; registry; config })` → `estimate(input)`, `create(actor, input)`, `list()`, `get(id)`, `progress(id)`, `results(id)`.
  - Création, dans une transaction : `runs` (`queued`), `run_models`, `run_tests` (instantanés), tous les `results` (`unsupported` directement pour les combinaisons non supportées, `scoreStatus` `awaiting_manual` pour un test manuel), puis `enqueueRunJob`.
  - Refus : modèle non `available` → 409 `model_unavailable` ; test archivé ou inconnu → 400 `test_not_found` ; test noté par le juge sans `judgeModelId` → 400 `judge_required` ; juge non `available` → 409 `model_unavailable` ; pondération dont la somme ≠ 100 → 400 `validation`.
  - `type RunSummary = { id; name; status; pauseReason; suiteName: string | null; modelCount; testCount; repetitions; judgeModelName: string | null; modelsCostUsd; judgeCostUsd; budgetUsd; createdAt; startedAt; completedAt; counts: StatusCounts }`, `type StatusCounts = { pending; running; done; error; timeout; unsupported; total }`.
  - `type RunProgress = { status; pauseReason; counts: StatusCounts; modelsCostUsd; judgeCostUsd; budgetUsd: number | null; startedAt: string | null; elapsedMs: number; etaSeconds: number | null; running: { modelId; testName }[]; activity: { resultId; testName; modelId; modelName; color; status; totalMs: number | null; costUsd: number | null; completedAt: string }[]; matrix: { runTestId; testName; cells: { modelId; pending; running; done; failed; unsupported }[] }[]; models: { id; name; color }[] }` (`activity` = 20 derniers résultats terminés ; `etaSeconds` = restants × moyenne observée de `total_ms` ÷ concurrence, `null` sans mesure).
  - `type ResultRow = { id; runTestId; testName; category; modelId; modelName; color; repetition; status; attempts; responseText: string | null; finishReason; inputTokens; outputTokens; reasoningTokens; tokensEstimated; ttftMs; totalMs; tokensPerS; costUsd; costSource; errorCode; errorMessage; scoreStatus; completedAt }`.
  - Routes : **A** `POST /api/runs/estimate` (corps `RunInput` → `RunEstimate`, sans rien créer), **A** `POST /api/runs` (201 `RunSummary`) ; connecté : `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/progress`, `GET /api/runs/:id/results`.

- [ ] **Step 1: Écrire les tests qui échouent** (faux fournisseur, catalogue semé avec `seedProvider` / `seedModel`)

```ts
test('estimate ne crée rien', async () => { /* compte des runs inchangé */ });
test('créer une série : instantanés, résultats, tâche run_execute unique, statut queued', async () => {
  expect(res.statusCode).toBe(201); expect(await count(results)).toBe(tests * models * reps);
  expect(await activeJobs(runId)).toHaveLength(1);
});
test('image + modèle sans vision → résultat unsupported dès la création', async () => { /* … */ });
test('modifier puis archiver le test après création : instantané inchangé', async () => { /* GET results → testName d'origine */ });
test('enqueueRunJob appelé deux fois en parallèle → une seule tâche active', async () => { /* Promise.all */ });
test('modèle indisponible (clé manquante) → 409 model_unavailable ; test juge sans juge → 400 judge_required', async () => { /* … */ });
test('progress : compteurs, matrice test × modèle et activité', async () => { /* résultats semés dans divers états */ });
test('Utilisateur : lit séries, progression et résultats ; 403 sur estimate et création', async () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/runs-api.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter.**

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: création, estimation et suivi des séries"`

---

### Task 8: Moteur d'exécution (`run_execute`)

**Files:**
- Create : `server/src/modules/runs/call.ts`, `server/src/modules/runs/engine.ts`, `server/src/modules/usage/usage.ts`
- Modify : `server/src/modules/jobs/handlers.ts` (`run_execute`)
- Test : `server/test/run-call.test.ts`, `server/test/engine.test.ts`

**Interfaces:**
- Consumes : `Registry` (plan 2), `ProviderError` (`retryable`, `retryAfterMs`), `readAttachment` (Task 4), `maxCallCostUsd` (Task 6), `enqueueRunJob` (Task 7), `redact`.
- Produces :
  - `type CallOutcome = { status: 'done' | 'error' | 'timeout'; text: string; finishReason: string | null; inputTokens; outputTokens; reasoningTokens: number | null; tokensEstimated: boolean; ttftMs: number | null; totalMs: number; tokensPerS: number | null; costUsd: number | null; costSource: 'computed' | 'provider' | null; errorCode: string | null; errorMessage: string | null; retryable: boolean; retryAfterMs: number | null }`
  - `measureCall(adapter: ProviderAdapter, req: GenerateRequest, model: { inputPricePerM; outputPricePerM }, deps: { now: () => number; signal?: AbortSignal; timeoutMs?: number }): Promise<CallOutcome>` — délai 120 s (`AbortSignal.any` avec le signal de la tâche) ; mesures et coût des Global Constraints ; une erreur de flux après du texte garde ce texte.
  - `buildRequest(snapshot: TestSnapshot, apiModelId: string, readFile: (a) => Promise<Buffer>): Promise<GenerateRequest>`
  - `recordUsage(db, u: { origin; runId: string | null; modelId; inputTokens; outputTokens; reasoningTokens; costUsd; now }): Promise<void>` et `monthSpend(db, now): Promise<{ totalUsd: number; judgeUsd: number }>` (plan 5).
  - `executeRunSlice(deps: EngineDeps, job: Job, ctx: JobContext): Promise<void>` avec `type EngineDeps = { db; registry; config; sleep?: (ms, signal) => Promise<void>; sliceMs?: number; onResultFinished?: (resultId: string) => Promise<void> }` — dans l'ordre :
    1. charge la série ; sort si `activeJobId !== job.id` (tâche périmée) ou si le statut n'est ni `queued` ni `running` ;
    2. passe la série `running` (`startedAt` au premier passage) ; remet `pending` les résultats `running` de la série (`attempts` − 1, minimum 0) ;
    3. lit les résultats `pending` dans l'ordre (répétition, position du test, modèles en alternance) ;
    4. lance les appels en respectant `runs.concurrency` et `providers.max_concurrency` ; avant chaque lancement, relit le statut (pause → plus de lancement) et contrôle le plafond (Task 9) ; un appel passe le résultat `running`, `attempts` + 1, `startedAt` ;
    5. à la fin d'un appel : `done` → résultat complet, coût ajouté atomiquement à `runs.models_cost_usd`, `recordUsage`, puis `onResultFinished` ; erreur réessayable avec `attempts` ≤ 2 et tranche non échue → attente (2 s puis 8 s, ou `Retry-After` ≤ 30 s) et nouvel appel ; tranche échue → résultat `pending` (`attempts` gardé) ; sinon `error` ou `timeout` définitif avec code et message masqué ;
    6. après `sliceMs` (600 000) : plus aucun lancement ; attend les appels en cours ;
    7. s'il reste des `pending` et que la série est `running` → `enqueueRunJob` pour la tranche suivante (même transaction que la remise à zéro de `activeJobId`) ; s'il n'en reste aucun ni `running` → `completed`, `completedAt`, `activeJobId` null ; en pause → `activeJobId` null.
  - `ctx.reportProgress({ done, total })` au moins toutes les 60 s (signe de vie de la file).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// server/test/run-call.test.ts (adaptateur simulé émettant des événements datés par une horloge injectée)
test('ttft = premier texte non vide, le raisonnement ne compte pas', async () => { /* reasoning à 100 ms, texte à 400 ms → ttftMs 400 */ });
test('tokens/s = sortie hors raisonnement ÷ phase de génération ; null si < 100 ms', async () => { /* … */ });
test('usage absent → estimé (caractères ÷ 4), tokensEstimated vrai', async () => { /* … */ });
test('coût du fournisseur prioritaire (provider), sinon calculé (computed) avec raisonnement au prix de sortie', async () => { /* … */ });
test('réponse tronquée à 200 000 caractères', async () => { /* … */ });
test('120 s sans fin → timeout réessayable', async () => { /* horloge et signal simulés */ });
test('erreur au milieu du flux : texte gardé, erreur renvoyée masquée', async () => { /* message contenant sk-… */ });
// server/test/engine.test.ts (faux fournisseur, sleep instantané, base de test)
test('série complète : tous les résultats done, coût cumulé = Σ résultats = Σ ai_usage, statut completed', async () => { /* … */ });
test('ordre : alternance des modèles dans une répétition', async () => { /* concurrence 1 : ordre de startedAt */ });
test('concurrence globale et par fournisseur jamais dépassées', async () => { /* adaptateur instrumenté compte les appels simultanés : max ≤ 4 et ≤ 2 par fournisseur */ });
test('[[fake:429]] puis succès : deux nouvelles tentatives au plus, délais 2 s puis 8 s', async () => { /* sleep enregistré */ });
test('erreur définitive (401) : status error, pas de nouvelle tentative', async () => { /* … */ });
test('tranche : après sliceMs, plus de lancement, tranche suivante enfilée, une seule tâche active', async () => { /* sliceMs 50 ms, horloge contrôlée */ });
test('tâche périmée (activeJobId différent) : ne fait rien', async () => { /* … */ });
test('résultats running orphelins remis en pending au début de la tranche, tentative rendue', async () => { /* … */ });
test('onResultFinished appelé une fois par résultat done', async () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/run-call.test.ts server/test/engine.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — file de lancement en mémoire de la tranche ; compteur global et compteurs par fournisseur ; `Promise` par appel suivie dans un ensemble ; les écritures de fin d'appel dans une transaction courte.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: moteur d'exécution des séries (concurrence, mesures, tentatives, tranches)"`

---

### Task 9: Contrôle des séries : pause, plafond, ajout de modèle, relance, reprise

**Files:**
- Modify : `server/src/modules/runs/engine.ts`, `runs.service.ts`, `runs.routes.ts`, `run-job.ts`, `server/src/modules/jobs/scheduler-loop.ts` (appel de `recoverRuns`), `server/src/modules/jobs/tick.routes.ts`
- Test : `server/test/run-control.test.ts`

**Interfaces:**
- Consumes : moteur (Task 8), service (Task 7), `maxCallCostUsd` (Task 6).
- Produces :
  - Plafond dans le moteur : avant chaque lancement, si `models_cost_usd + judge_cost_usd + réservations en vol + maxCallCostUsd(appel) > budgetUsd` → série `paused`, `pauseReason` `budget`, plus aucun lancement (les appels en vol se terminent) ; chaque appel lancé réserve son coût maximal jusqu'à sa fin.
  - Service et routes **A** : `POST /api/runs/:id/pause` (→ `paused`, `user`), `POST /api/runs/:id/resume` (depuis `paused` ou `interrupted` → `queued` + `enqueueRunJob` ; 409 `budget_exceeded` si la pause est `budget` et que le plafond n'a pas été relevé au-dessus de la dépense), `POST /api/runs/:id/retry-errors` (`error` et `timeout` → `pending`, `attempts` 0, puis reprise), `POST /api/runs/:id/models` (`{ modelIds }` : `run_models` et résultats manquants, `unsupported` calculé, puis `queued` + `enqueueRunJob` ; modèles déjà présents ignorés ; 409 `model_unavailable`), `PATCH /api/runs/:id` (`{ budgetUsd?: number | null; weights?: Weights }`).
  - `recoverRuns(db, now): Promise<{ enqueued: number; interrupted: number }>` — séries `queued` ou `running` sans tâche active (`activeJobId` nul ou tâche `done` / `failed`) : tâche `failed` → série `interrupted` ; sinon `enqueueRunJob`. Appelée par la boucle du planificateur et par `/internal/tick` (réponse enrichie de `runsEnqueued`).
  - Audit : `run_created` (Task 7), `run_paused`, `run_resumed`, `run_models_added`, `run_errors_retried`, `run_updated`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test('pause : les appels en vol se terminent, aucun nouveau lancement, puis reprise jusqu’au bout', async () => { /* … */ });
test('plafond : jamais dépassé par les appels lancés, pause budget ; relever puis reprendre termine la série', async () => {
  // plafond = coût maximal de 3 appels ; concurrence 4
  expect(run.modelsCostUsd).toBeLessThanOrEqual(budget); expect(run).toMatchObject({ status: 'paused', pauseReason: 'budget' });
});
test('reprendre sans relever le plafond → 409 budget_exceeded', async () => { /* … */ });
test('ajout d’un 7ᵉ modèle à une série terminée : seuls ses résultats sont exécutés', async () => {
  // startedAt des résultats existants inchangés, nouveaux résultats done, série completed
});
test('relancer les erreurs : error et timeout repassent pending avec attempts 0, puis done', async () => { /* … */ });
test('redémarrage : résultats running + tâche failed → série interrupted ; reprendre la termine', async () => { /* … */ });
test('recoverRuns : série running sans tâche active → une tâche enfilée, pas deux (appels parallèles)', async () => { /* … */ });
test('deux workers sur la même série : un seul exécute (activeJobId), aucun appel en double', async () => { /* deux runWorkerOnce simultanés */ });
test('Utilisateur : 403 sur pause, resume, retry-errors, models, PATCH', async () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/run-control.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter.**

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: pause, plafond, ajout de modèle, relance des erreurs et reprise des séries"`

---

### Task 10: Essai rapide

**Files:**
- Create : `server/src/modules/tests/quick-try.ts`
- Modify : `server/src/modules/tests/tests.routes.ts`, `server/src/modules/jobs/handlers.ts` (`quick_try`)
- Test : `server/test/quick-try.test.ts`

**Interfaces:**
- Consumes : `measureCall`, `buildRequest`, `recordUsage` (Task 8), `snapshotOf` (Task 6), `readAttachment` (Task 4), voie rapide (Task 1).
- Produces :
  - Routes **A** : `POST /api/tests/try` (`{ testId, modelId }` → 202 `{ jobId }` ; 409 `model_unavailable` ; 400 `unsupported_attachment` si le modèle ne gère pas une pièce jointe du test) et `GET /api/tests/try/:jobId` → `{ status: 'queued' | 'running' | 'done' | 'failed'; outcome?: CallOutcome & { modelName: string } }`.
  - Gestionnaire `quick_try` : `maxAttempts` 1 ; construit la requête depuis l'état **enregistré** du test, appelle `measureCall` (120 s), écrit l'issue dans `jobs.progress` (`{ outcome }`), `recordUsage` origine `quick_try` ; aucune ligne `results`.
  - Une tâche d'essai n'est lisible que si elle est de type `quick_try` (sinon 404).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test('essai rapide : 202 puis done avec texte, métriques et coût ; ai_usage quick_try ; aucun résultat de série', async () => {
  // POST, runWorkerOnce(voie rapide), GET
});
test('erreur du fournisseur : status done avec outcome.status error et message masqué', async () => { /* [[fake:500]] */ });
test('la voie rapide traite l’essai pendant qu’une tranche de série occupe le worker principal', async () => {
  // run_execute bloqué (adaptateur lent) sur le worker principal ; quick_try terminé par le worker rapide
});
test('GET d’un identifiant de tâche d’un autre type → 404 ; Utilisateur → 403', async () => { /* … */ });
test('GET répond immédiatement (pas d’attente du résultat)', async () => { /* durée < 200 ms */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/quick-try.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter.**

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: essai rapide d'un test sur un modèle (file rapide)"`

---

### Task 11: Interface : tests et éditeur de test

Utiliser le skill **`frontend-design`** ; référence : écran « Éditeur de test » de `maquettes/ecrans-nuit.html` (lignes 209-244).

**Files:**
- Create : `web/src/api/tests.ts`, `web/src/pages/admin/TestsPage.tsx`, `web/src/pages/admin/TestEditorPage.tsx`, `web/src/components/tests/ScoringConfigForm.tsx`, `web/src/components/tests/AttachmentsField.tsx`, `web/src/components/tests/QuickTryPanel.tsx`
- Modify : `web/src/app/routes.tsx` (`/admin/tests`, `/admin/tests/nouveau`, `/admin/tests/:id`), `web/src/app/AppShell.tsx` (ADMIN : « Tests »), `web/src/api/messages.ts` (codes des Tasks 3, 4, 10)
- Test : `web/src/pages/admin/TestsPage.test.tsx`, `web/src/pages/admin/TestEditorPage.test.tsx`, `web/src/components/tests/QuickTryPanel.test.tsx`

**Interfaces:**
- Consumes : routes des Tasks 3, 4 et 10 ; `listModels()` (plan 2) pour le choix du modèle.
- Produces : `web/src/api/tests.ts` → types miroirs ; `listTests(filters)`, `getTest(id)`, `testsMeta()`, `createTest(body)`, `updateTest(id, body)`, `deleteTest(id)`, `restoreTest(id)`, `uploadAttachment(testId, file, onProgress?)` (`XMLHttpRequest` + `FormData`, en-tête `x-csrf-token`, erreurs par `errorFromResponse`), `deleteAttachment(testId, id)`, `attachmentDownloadUrl(testId, id)`, `startQuickTry(testId, modelId)`, `getQuickTry(jobId)`, `listSuites()` … (Task 12 complète).

- [ ] **Step 1: Écrire les tests qui échouent**

```tsx
test('liste : filtres catégorie, tag, recherche ; « Afficher les archivés »', async () => { /* … */ });
test('éditeur : valeurs par défaut 0,2 et 1 000 ; max tokens 16 001 refusé avant envoi', async () => { /* … */ });
test('méthode « Réponse attendue » : modes exact / contient / regex ; regex invalide signalée', async () => { /* … */ });
test('méthode « IA-juge » : critères obligatoires, référence facultative', async () => { /* … */ });
test('pièces jointes : dépôt par glisser-déposer, barre de progression, refus 415 affiché en français', async () => { /* … */ });
test('supprimer un test utilisé → message « Test archivé (utilisé par une série) »', async () => { /* outcome archived */ });
test('essai rapide : enregistre, lance, interroge toutes les 2 s, affiche réponse, premier token, débit, coût', async () => { /* vi.useFakeTimers */ });
test('essai rapide : modèles non disponibles absents de la liste', async () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project web web/src/pages/admin/TestsPage.test.tsx web/src/pages/admin/TestEditorPage.test.tsx web/src/components/tests` — Expected: FAIL.

- [ ] **Step 3: Implémenter** selon la maquette : formulaire en deux colonnes (prompts à gauche ; paramètres, notation et pièces jointes à droite), panneau « Essai rapide » sous l'éditeur ; réponse affichée en texte échappé (aucun HTML interprété).

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project web && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: écrans des tests, éditeur et essai rapide"`

---

### Task 12: Interface : suites

Utiliser le skill **`frontend-design`**.

**Files:**
- Create : `web/src/pages/admin/SuitesPage.tsx`
- Modify : `web/src/api/tests.ts` (suites), `web/src/app/routes.tsx` (`/admin/suites`), `web/src/app/AppShell.tsx` (ADMIN : « Suites »)
- Test : `web/src/pages/admin/SuitesPage.test.tsx`

**Interfaces:**
- Consumes : routes de la Task 5.
- Produces : `listSuites()`, `getSuite(id)`, `createSuite(body)`, `updateSuite(id, body)`, `duplicateSuite(id)`, `deleteSuite(id)`.

- [ ] **Step 1: Écrire les tests qui échouent**

```tsx
test('créer une suite en choisissant des tests', async () => { /* … */ });
test('réordonner au clavier (boutons Monter / Descendre) puis enregistrer : testIds dans le nouvel ordre', async () => { /* … */ });
test('glisser-déposer réordonne la liste', async () => { /* fireEvent dragStart / drop */ });
test('dupliquer et supprimer', async () => { /* … */ });
test('test archivé signalé dans la suite', async () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project web web/src/pages/admin/SuitesPage.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implémenter** (glisser-déposer HTML5 natif et boutons accessibles, sans nouvelle dépendance).

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project web && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: écran des suites"`

---

### Task 13: Interface : lancer une série (assistant en 4 étapes)

Utiliser le skill **`frontend-design`** ; référence : écran « Lancer une série » de `maquettes/ecrans-nuit.html` (lignes 169-191).

**Files:**
- Create : `web/src/api/runs.ts`, `web/src/pages/LaunchRunPage.tsx`
- Modify : `web/src/app/routes.tsx` (`/series/nouvelle`, Admin)
- Test : `web/src/pages/LaunchRunPage.test.tsx`

**Interfaces:**
- Consumes : routes des Tasks 7 et 9, `listSuites`, `listTests`, `listModels`.
- Produces (`web/src/api/runs.ts`) : types miroirs (`RunInput`, `RunEstimate`, `RunSummary`, `RunProgress`, `ResultRow`) ; `estimateRun(body)`, `createRun(body)`, `listRuns()`, `getRun(id)`, `getRunProgress(id)`, `getRunResults(id)`, `pauseRun(id)`, `resumeRun(id)`, `retryRunErrors(id)`, `addRunModels(id, modelIds)`, `updateRun(id, patch)` ; clés `RUNS_KEY`.

- [ ] **Step 1: Écrire les tests qui échouent**

```tsx
test('étape 1 : une suite ou des tests à la carte', async () => { /* … */ });
test('étape 2 : seuls les modèles disponibles sont sélectionnables, capacités affichées', async () => { /* … */ });
test('étape 3 : répétitions 1 à 5, juge, concurrence, plafond, pondération (somme 100)', async () => { /* … */ });
test('étape 4 : récapitulatif avec appels, non supportés, coût maximal, durée et avertissements', async () => { /* estimateRun simulé */ });
test('« Lancer » crée la série et ouvre sa page', async () => { /* navigation /series/:id */ });
test('juge requis si un test est noté par le juge', async () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project web web/src/pages/LaunchRunPage.test.tsx` — Expected: FAIL.

- [ ] **Step 3: Implémenter** selon la maquette (indicateur d'étapes, cartes de modèles avec logo et capacités, récapitulatif chiffré en Noto Sans Mono).

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project web && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: assistant de lancement d'une série"`

---

### Task 14: Interface : liste des séries et suivi en direct

Utiliser le skill **`frontend-design`** ; référence : écran « Suivi en direct » de `maquettes/ecrans-nuit.html` (lignes 192-208 et la scène de la ligne 353).

**Files:**
- Create : `web/src/pages/RunsPage.tsx`, `web/src/pages/RunPage.tsx`, `web/src/components/runs/LiveMatrix.tsx`, `ActivityFeed.tsx`, `RunControls.tsx`, `RunMetricsTable.tsx`, `web/src/three/live-flow-scene.ts`, `web/src/three/LiveFlowFallback.tsx`
- Modify : `web/src/app/routes.tsx` (`/series`, `/series/:id`), `web/src/app/AppShell.tsx` (EXPLORER : « Séries »)
- Test : `web/src/pages/RunsPage.test.tsx`, `web/src/pages/RunPage.test.tsx`, `web/src/three/live-flow-scene.test.ts`

**Interfaces:**
- Consumes : `web/src/api/runs.ts` (Task 13), `ThreeStage` avec `data` (Task 1), `<RemoteModelsDialog />` non requis.
- Produces :
  - `liveFlowScene: SceneFactory` — un nœud central (le prompt) et un nœud par modèle (couleur du modèle) en arc ; une particule par appel en cours entre le centre et le nœud du modèle ; un éclair bref au nœud à chaque résultat terminé (vert `#4FD1A5` réussi, rouge `#FF7A7A` en erreur) ; `setData(d: LiveFlowData)` avec `type LiveFlowData = { models: { id; color }[]; running: { modelId }[]; finished: { resultId; modelId; ok: boolean }[] }` ; moitié moins de particules si `isMobile` ; `dispose()` complet et `renderer.forceContextLoss()` (modèle : `fanout-scene.ts`).
  - `<LiveFlowFallback data />` : SVG statique équivalent (nœuds et nombre d'appels en cours).
  - `RunPage` : en-tête (nom, suite, modèles × répétitions, juge, coût modèles + juge, statut) ; pendant `queued` / `running` / `paused` : vue en direct (barre de progression, dépense et plafond, durée restante estimée, `LiveMatrix`, `ActivityFeed`, scène), interrogation toutes les **2 s** arrêtée quand la série est `completed` ou que l'onglet est caché ; `RunControls` (Admin) : Pause / Reprendre (message clair sur pause budget, champ pour relever le plafond), Relancer les erreurs, Ajouter un modèle (modèles disponibles hors série) ; après `completed` : `RunMetricsTable` (par modèle : réussis, erreurs, premier token médian, débit médian, coût moyen ; le classement noté arrive au plan 4).

- [ ] **Step 1: Écrire les tests qui échouent**

```tsx
// RunsPage
test('liste : statut, suite, modèles, coût, dates ; bouton « Lancer une série » pour l’Admin seulement', async () => { /* … */ });
// RunPage
test('vue en direct : progression, matrice test × modèle, fil d’activité', async () => { /* getRunProgress simulé */ });
test('interrogation toutes les 2 s, arrêtée à completed', async () => { /* vi.useFakeTimers ; compte des appels */ });
test('pause budget : message et champ de plafond ; reprendre envoie PATCH puis resume', async () => { /* … */ });
test('Utilisateur : aucun bouton de contrôle', async () => { /* … */ });
test('série terminée : tableau des métriques par modèle', async () => { /* getRunResults simulé */ });
test('sans WebGL : repli SVG de la scène', async () => { /* … */ });
// web/src/three/live-flow-scene.test.ts
test('fonctions pures de la scène : positions des nœuds en arc, nombre de particules (moitié sur mobile)', () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project web web/src/pages/RunsPage.test.tsx web/src/pages/RunPage.test.tsx web/src/three/live-flow-scene.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — isoler la géométrie (positions, nombre de particules) dans des fonctions pures exportées et testées ; la scène ne fait que dessiner.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project web && npm run typecheck && npm run build` — Expected: PASS ; Three.js reste dans un fragment séparé.

- [ ] **Step 5: Commit** — `git commit -m "feat: liste des séries et suivi en direct"`

---

### Task 15: Documentation, vérification complète et parcours dans le navigateur

**Files:**
- Modify : `README.md` (tests, suites, séries, essai rapide en local avec `AIC_FAKE_LLM=1`), `docs/deploiement.md` (voie rapide de la file ; une série reprend seule après un redémarrage ; `DATA_DIR/attachments` à conserver entre les déploiements), spec §16 ligne 2 (« à mesurer au premier déploiement du plan 3 : série de démonstration à 4 appels simultanés, mémoire résidente »)

- [ ] **Step 1: Mettre à jour la documentation.**

- [ ] **Step 2: Vérification complète** — Run: `npx vitest run && npm run typecheck && npm run build` — Expected: PASS.

- [ ] **Step 3: Parcours dans le navigateur** (contrôleur, `AIC_FAKE_LLM=1`) : créer deux tests (dont un avec une image), une suite, essai rapide, lancer une série 2 tests × 3 modèles × 2 répétitions, suivre la vue en direct jusqu'au bout, pause puis reprise, ajout d'un modèle, relance des erreurs (`[[fake:500]]`), compte Utilisateur en lecture seule.

- [ ] **Step 4: Commit** — `git commit -m "docs: tests, suites et séries"`
