# Plan 1 – Fondations : plan de réalisation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une application « Eksplodo · Comparateur IA » déployée sur `ia.eksplodo.fr`, avec base MariaDB, comptes Admin / Utilisateur par invitation, file de tâches planifiée, journal des erreurs et coque d'interface au thème « Nuit » (Tailwind, gerbe Three.js sur la connexion), prête à accueillir les fournisseurs et modèles (plan 2).

**Architecture:** Un seul processus Node (Fastify 5) sert l'API `/api/*`, l'interface React compilée et un worker qui lit la table `jobs` ; un cron Hostinger appelle `POST /internal/tick` toutes les 15 min. Le socle est une **copie raisonnée de l'app AO** (`$AO`, voir Global Constraints), dont on retire les organisations, le RAG, la veille et le chiffrement des secrets : chaque tâche de portage dit quels fichiers copier, ce qu'il faut adapter et quels tests reprendre.

**Tech Stack:** Node.js 24, TypeScript strict (ESM), Fastify 5, Zod, Drizzle ORM + mysql2 + drizzle-kit, MariaDB 11.8 (Docker en local), @node-rs/argon2, Nodemailer, luxon, React 19 + Vite + React Router + TanStack Query, Tailwind CSS v4, @fontsource, Three.js, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-16-comparateur-ia-design.md` (sections 3, 4, 5.1, 5.5, 11, 12, 13, 14, 15 et 16 pour ce plan). Maquettes : `docs/superpowers/maquettes/`.

### Feuille de route des plans

| Plan | Contenu | Prérequis |
|---|---|---|
| **1 – Fondations** (ce document) | Socle serveur, base, comptes et invitations, file de tâches, journal des erreurs, coque d'interface « Nuit » et gerbe 3D, mise en production | — |
| 2 – Fournisseurs et modèles | Adaptateurs, faux fournisseur, état des clés, catalogue, assistant `/models`, nouveautés OpenRouter, fiche modèle | Plan 1 |
| 3 – Tests et séries | Éditeur, pièces jointes, essai rapide, suites, estimation, moteur, pause, plafond, vue en direct | Plan 2 |
| 4 – Notation et résultats | Réponse attendue, juge, notation à l'aveugle, classement, page de résultats, constellation | Plan 3 |
| 5 – Partage et tableau de bord | Liens publics, verdicts, impression, tableau de bord | Plan 4 |

## Global Constraints

- **Projet de référence** : `$AO` = `C:\Users\laure\OneDrive\Bureau\Claude directory\Code-appels offre` (dépôt `lwiart/Eksplodo-appels-doffres`). On **lit** ce dossier, on n'y écrit jamais.
- Node.js **24** (`.nvmrc` : `24`, `engines.node` : `>=24`), TypeScript `strict: true` + `noUncheckedIndexedAccess`, modules ESM ; un seul `package.json` à la racine ; sources `server/` et `web/`, build dans `dist/server` et `dist/web`.
- **Aucun `await` de premier niveau** dans le graphe de modules du serveur (LiteSpeed charge `dist/server/index.js` avec `require()`).
- `.npmrc` : `include=dev`.
- Format d'erreur API unique : `{ "error": { "code": string, "message": string, "reference"?: string } }`, messages en français.
- Identifiants UUID v4 (`crypto.randomUUID()`) en `CHAR(36)` ; dates UTC en `DATETIME(3)`.
- Rôles : `admin` | `user`. Statuts de compte : `invited` | `active` | `disabled`.
- Mots de passe argon2id, **12 caractères minimum**. Invitation valable **72 h**, réinitialisation **24 h**, usage unique, jetons hachés en SHA-256 ; émettre un nouveau lien invalide les précédents du même compte et du même objet.
- Session : cookie **`aic_session`** `HttpOnly`, `SameSite=Lax`, `Secure` en production, expiration glissante **7 jours**. CSRF : cookie **`aic_csrf`** + en-tête `x-csrf-token` sur toute requête modifiante.
- Connexion : 5 échecs consécutifs → compte verrouillé **15 min** ; **10 tentatives / 15 min par IP** sur les routes d'authentification (constantes de `$AO`).
- File de tâches : constantes de `$AO/server/src/modules/jobs/queue.ts` et `worker.ts` inchangées (`DEFAULT_MAX_ATTEMPTS = 4`, `BACKOFF_MS = [60_000, 600_000, 3_600_000]`, `STALE_AFTER_MS = 15 min`, `JOB_TIMEOUT_MS = 14 min`, `INTERRUPTED_RETRY_MS = 60_000`). Fuseau de planification `Europe/Paris`.
- Variables d'environnement du plan 1 : `NODE_ENV`, `PORT` (défaut 3000), `APP_BASE_URL`, `DATABASE_URL`, `DATA_DIR`, `CRON_SECRET` (≥ 32 caractères), `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` (tous ou aucun), `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (facultatives, les deux ou aucune). **Pas d'`APP_ENCRYPTION_KEY`** : aucune donnée chiffrée en base.
- Aucun secret dans le dépôt ; `.env.example` documente les noms avec des valeurs factices. Les tests n'appellent jamais de service payant ni de vrai SMTP.
- Base de test : `docker compose up -d db` (MariaDB 11.8, port hôte **3307**, `root` / `test`, `utf8mb4_unicode_ci`). Développement : même conteneur, base `aic`.
- Ports de développement : API **3000**, Vite **5173** (proxy `/api`, `/internal`, `/health` vers l'API).
- Titre de l'application : **« Eksplodo · Comparateur IA »** ; nom du paquet `eksplodo-comparateur-ia`.
- Interface en français, thème « Nuit » (spec §11.1) : fonds `#00131D` / `#011F2E` / `#032A3D` (dégradé radial vers `#06405D`), lignes `rgba(120,190,230,.14)` et `.28`, texte `#D8ECF5`, secondaire `#7FA3B5`, orange `#F0631F`, pêche `#FFB48A`, bleus `#3FA2E0` / `#0C659D` / `#7CC4EF`, succès `#4FD1A5`, erreur `#FF7A7A` ; grille de points ; cartes arrondies 18 px ; boutons et pastilles 100 px. Polices auto-hébergées via `@fontsource` : Archivo (titres 700-800), Instrument Sans (texte), Noto Sans Mono (étiquettes, chiffres). Logo : `docs/brand/eksplodo-icon-white.png`.
- Toute tâche d'interface utilise le skill **`frontend-design`** en partant des maquettes `docs/superpowers/maquettes/`.
- Toute action sur Hostinger (création de site, de base, variables, envoi, build, cron) est **visible de l'extérieur** : demander l'accord explicite de Laurent avant chacune. Ne jamais appeler `hosting_nodejs_replace-environment-variables` (remplace toutes les variables).

## Review Focus

1. **E-mail saisi avec majuscules ou espaces** (`" Laurent@Eksplodo.FR "`) : connexion, invitation et amorçage fonctionnent comme en minuscules, et deux comptes ne diffèrent jamais seulement par la casse. → tests en Task 3.
2. **Lien d'invitation ou de réinitialisation réutilisé, expiré, régénéré, ou compte désactivé entre-temps** : le lien est refusé avec un message clair, sans activer le compte ni changer le mot de passe. → tests en Task 4.
3. **L'Admin se bloque lui-même** : désactiver ou rétrograder le dernier Admin actif (y compris soi-même) est refusé. → tests en Task 5.
4. **Un Utilisateur appelle une route Admin, ou un compte est désactivé pendant sa session** : 403 sur la route Admin, et la session du compte désactivé est refusée dès la requête suivante. → tests en Task 3 et Task 5.
5. **Machine sans WebGL ou avec « réduire les animations »** (portable de démonstration) : la page de connexion reste utilisable, avec le visuel 2D et sans animation. → tests en Task 8.

---

## Structure des fichiers (plan 1)

```
package.json  .npmrc  .nvmrc  .env.example  tsconfig.json  tsconfig.server.json  tsconfig.web.json  tsconfig.node.json
vite.config.ts  vitest.config.ts  drizzle.config.ts  docker-compose.yml  README.md
server/
  src/
    index.ts                  # démarrage : config → base (migrations + amorçage sous verrou) → app → worker → planificateur
    app.ts                    # buildApp(deps)
    startup.ts                # withStartupLock, prepareDatabase
    errors.ts                 # AppError et sous-classes
    config/config.ts          # loadConfig, configWarnings
    lib/clock.ts  lib/paths.ts  lib/crypto.ts
    db/client.ts  db/migrate.ts
    db/schema/core.ts         # users, invitations, sessions, settings, audit_log
    db/schema/jobs.ts  db/schema/errors.ts
    plugins/auth.ts  plugins/csrf.ts  plugins/logging.ts  plugins/rate-limit.ts  plugins/static.ts
    modules/auth/actor.ts  sessions.ts  invitations.ts  auth.routes.ts  bootstrap.ts
    modules/users/users.repo.ts  users.service.ts  users.routes.ts
    modules/audit/audit.ts
    modules/mail/mailer.ts  templates.ts
    modules/jobs/queue.ts  worker.ts  scheduler.ts  scheduler-loop.ts  tick.routes.ts  handlers.ts  schedules.ts
    modules/errors/capture.ts  report.ts  reference.ts  severity.ts  notifications.ts  mail-reporter.ts  errors.routes.ts
  drizzle/                    # migrations générées
  test/
    helpers/test-db.ts  test-app.ts  test-clock.ts
    *.test.ts                 # un fichier par module
web/
  index.html
  public/                     # favicon, icône
  src/
    main.tsx
    theme/theme.css           # Tailwind v4 (@import "tailwindcss"; @theme { … }), polices, fond
    api/client.ts  api/messages.ts  api/users.ts  api/errors.ts
    auth/AuthProvider.tsx
    app/routes.tsx  app/AppShell.tsx  app/AuthLayout.tsx  app/preferences.ts
    three/useThreeScene.ts  three/animation-policy.ts  three/burst-scene.ts  three/BurstFallback.tsx  three/ThreeStage.tsx
    components/ui/            # Button, Card, Chip, Field, Dialog (Radix), CopyLink
    pages/LoginPage.tsx  InvitationPage.tsx  ResetPasswordPage.tsx  AccountPage.tsx  DashboardPage.tsx  AccessDeniedPage.tsx
    pages/admin/UsersPage.tsx  pages/admin/ErrorLogPage.tsx
docs/deploiement.md
```

---

### Task 1: Socle du projet et du serveur

**Files:**
- Create (copiés de `$AO` puis adaptés) : `package.json`, `.npmrc`, `.nvmrc`, `tsconfig.json`, `tsconfig.server.json`, `tsconfig.web.json`, `tsconfig.node.json`, `vitest.config.ts`, `server/src/errors.ts`, `server/src/lib/clock.ts`, `server/src/lib/paths.ts`, `server/src/plugins/logging.ts`
- Create : `.env.example`, `server/src/config/config.ts`, `server/src/app.ts` (squelette), `server/src/index.ts` (squelette)
- Test : `server/test/config.test.ts`, `server/test/app.test.ts`, `server/test/logging.test.ts` (copié), `server/test/entry.test.ts` (copié)

**Interfaces:**
- Produces :
  - `type AppConfig = { nodeEnv: 'development'|'test'|'production'; port: number; appBaseUrl: string; databaseUrl: string; dataDir: string; cronSecret: string; smtp: { host: string; port: number; user: string; pass: string; from: string } | null; bootstrapAdmin: { email: string; password: string } | null }`
  - `loadConfig(env: NodeJS.ProcessEnv): AppConfig` et `configWarnings(config): string[]` (reprise de `$AO`)
  - `type Clock = () => Date`, `systemClock`
  - `AppError` (`code`, `status`, `extra?`), `NotFoundError`, `ForbiddenError`, `UnauthorizedError`, `ValidationError`, `ConflictError`, `RateLimitedError` (copie de `$AO/server/src/errors.ts`)
  - `type AppDeps = { config: AppConfig; clock: Clock; webRoot?: string; logStream?: LogStream }` (étendu en Task 2 par `db`, `workerStatus` ; en Task 4 par `mailer` ; en Task 6 par `schedules`)
  - `buildApp(deps: AppDeps): Promise<FastifyInstance>`

- [ ] **Step 1: Initialiser le projet** — copier depuis `$AO` `package.json`, `.npmrc`, `.nvmrc`, les quatre `tsconfig*.json` et `vitest.config.ts`. Adapter `package.json` : `name` = `eksplodo-comparateur-ia` ; garder les scripts `dev`, `prebuild`, `build`, `start`, `test`, `typecheck` ; **dépendances conservées** : `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/static`, `@node-rs/argon2`, `@tanstack/react-query`, `drizzle-orm`, `fastify`, `luxon`, `mysql2`, `nodemailer`, `react`, `react-dom`, `react-router-dom`, `zod` ; **retirées** : `@anthropic-ai/sdk`, `@fastify/multipart`, `@tiptap/*`, `docx`, `fast-xml-parser`, `fflate`, `htmlparser2`, `mammoth`, `sanitize-html`, `unpdf` (et leurs `@types`) ; dev conservées à l'identique, plus `drizzle-kit`. Créer `.env.example` avec les variables du plan (Global Constraints) en valeurs factices, `DATA_DIR=./data`, `DATABASE_URL=mysql://root:test@127.0.0.1:3307/aic`. Lancer `npm install`.

- [ ] **Step 2: Écrire les tests qui échouent**

```ts
// server/test/config.test.ts
const base = { NODE_ENV: 'test', APP_BASE_URL: 'http://localhost:3000', DATABASE_URL: 'mysql://u:p@127.0.0.1:3307/x',
  DATA_DIR: '/tmp/aic', CRON_SECRET: 'x'.repeat(32) };
test('valeurs par défaut', () => {
  const c = loadConfig(base);
  expect(c.port).toBe(3000); expect(c.smtp).toBeNull(); expect(c.bootstrapAdmin).toBeNull();
});
test('variable vide = absente', () => { expect(loadConfig({ ...base, SMTP_HOST: '' }).smtp).toBeNull(); });
test('SMTP partiel refusé', () => { expect(() => loadConfig({ ...base, SMTP_HOST: 'smtp.hostinger.com' })).toThrow(/SMTP/); });
test('CRON_SECRET trop court refusé', () => { expect(() => loadConfig({ ...base, CRON_SECRET: 'court' })).toThrow(/CRON_SECRET/); });
test('amorçage : e-mail sans mot de passe refusé', () => {
  expect(() => loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAIL: 'a@b.fr' })).toThrow(/BOOTSTRAP_ADMIN_PASSWORD/);
});
test('amorçage : mot de passe de moins de 12 caractères refusé', () => {
  expect(() => loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAIL: 'a@b.fr', BOOTSTRAP_ADMIN_PASSWORD: 'court' })).toThrow(/12/);
});
test('amorçage : e-mail normalisé', () => {
  const c = loadConfig({ ...base, BOOTSTRAP_ADMIN_EMAIL: ' Laurent@Eksplodo.FR ', BOOTSTRAP_ADMIN_PASSWORD: 'p'.repeat(12) });
  expect(c.bootstrapAdmin).toEqual({ email: 'laurent@eksplodo.fr', password: 'p'.repeat(12) });
});
test('APP_ENCRYPTION_KEY n’est plus exigée', () => { expect(() => loadConfig(base)).not.toThrow(); });

// server/test/app.test.ts
test('AppError → format d’erreur unique', async () => { /* route /boom qui lève NotFoundError('Introuvable') */
  expect(res.statusCode).toBe(404); expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Introuvable' } });
});
test('erreur inattendue → 500 sans fuite du message', async () => { /* route /crash qui lève Error('secret interne') */
  expect(res.statusCode).toBe(500); expect(res.json().error.code).toBe('internal'); expect(res.body).not.toContain('secret interne');
});
test('route inconnue → 404 au format unique', async () => { expect(res.json().error.code).toBe('not_found'); });
```

Copier `$AO/server/test/entry.test.ts` (absence d'`await` de premier niveau) et `$AO/server/test/logging.test.ts` tels quels. Dans cette tâche, le gestionnaire d'erreur 500 journalise seulement (le journal des erreurs arrive en Task 6) ; le test 500 n'attend donc pas encore de `reference`.

- [ ] **Step 3: Vérifier l'échec** — Run: `npx vitest run --project server` — Expected: FAIL (modules introuvables).

- [ ] **Step 4: Implémenter** — `config.ts` : partir de `$AO/server/src/config/config.ts`, retirer `APP_ENCRYPTION_KEY`, `VOYAGE_API_KEY` et `ANTHROPIC_API_KEY`, ajouter `BOOTSTRAP_ADMIN_PASSWORD` (règle « les deux ou aucune », mot de passe ≥ 12 caractères, e-mail passé par `trim().toLowerCase()`). Copier `errors.ts`, `lib/clock.ts`, `lib/paths.ts`, `plugins/logging.ts`. `app.ts` : reprendre de `$AO/server/src/app.ts` la création Fastify (`loggerOptions`, `trustProxy` à un saut), helmet (CSP **sans** `fonts.googleapis.com` ni `fonts.gstatic.com` : `fontSrc: ["'self'"]`, `styleSrc: ["'self'"]`, `imgSrc: ["'self'", 'data:', 'blob:']`), le gestionnaire d'erreurs et le 404. `index.ts` : fonction `main()` non attendue au premier niveau, `process.loadEnvFile('.env')` hors production si le fichier existe, `loadConfig`, `configWarnings`, `buildApp`, `listen({ port, host: '0.0.0.0' })`, arrêt propre sur `SIGTERM` / `SIGINT`.

- [ ] **Step 5: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS, aucune erreur de type.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: socle serveur Fastify, configuration et format d'erreur"`

---

### Task 2: Base de données, schéma, migrations et démarrage

**Files:**
- Create (copiés de `$AO`) : `docker-compose.yml`, `drizzle.config.ts`, `server/src/db/client.ts`, `server/src/db/migrate.ts`, `server/src/startup.ts`, `server/test/helpers/test-db.ts`, `server/test/helpers/test-clock.ts`
- Create (adaptés) : `server/src/db/schema/core.ts`, `server/src/db/schema/jobs.ts` (copie), `server/src/db/schema/errors.ts`, `server/drizzle/0000_*.sql` (généré)
- Modify : `server/src/app.ts` (`/health`), `server/src/index.ts`
- Test : `server/test/db.test.ts`, `server/test/startup.test.ts`, `server/test/health.test.ts`

**Interfaces:**
- Consumes : `AppConfig`, `buildApp` (Task 1).
- Produces :
  - `type Db`, `createDb(url): { db: Db; close(): Promise<void> }`, `poolOf(db)` (copie de `$AO`)
  - `runMigrations(db: Db): Promise<void>`, `MIGRATIONS_FOLDER`
  - `withStartupLock<T>(db, name: string, fn: () => Promise<T>): Promise<T>` et `prepareDatabase(deps: { db; config; clock; logger }): Promise<void>` (d'après `$AO/server/src/startup.ts`, **sans** `mailer` : l'amorçage par mot de passe n'envoie rien ; l'appel à l'amorçage est branché en Task 4)
  - Tables : `users` (`id`, `email` unique, `name`, `passwordHash` nullable, `role` enum `admin`|`user`, `status` enum `invited`|`active`|`disabled` défaut `invited`, `failedLoginCount`, `lockedUntil`, `lastLoginAt`, `createdAt`), `invitations` (copie de `$AO`), `sessions` (copie), `settings` (copie), `auditLog` (copie **sans** `orgId`), `jobs` (copie), `errorEvents` (copie **sans** `orgId`)
  - `createTestDb(): Promise<{ db; url; destroy() }>`, `createEmptyTestDb()`, `createTestClock(start: Date): TestClock`
  - `AppDeps` étendu : `db: Db`, `workerStatus?: () => 'running' | 'stopped'`

- [ ] **Step 1: Copier l'outillage** — `docker-compose.yml`, `drizzle.config.ts` (liste de schémas réduite à `core.ts`, `jobs.ts`, `errors.ts`), `db/client.ts`, `db/migrate.ts`, `startup.ts`, `test/helpers/test-db.ts`, `test/helpers/test-clock.ts`. Lancer `docker compose up -d db`.

- [ ] **Step 2: Écrire les tests qui échouent**

```ts
// server/test/db.test.ts
test('migrations appliquées sur une base vierge', async () => { /* createTestDb() puis SELECT sur users, invitations, sessions, settings, audit_log, jobs, error_events */ });
test('e-mail unique sans tenir compte de la casse', async () => {
  // insère 'laurent@eksplodo.fr' puis 'LAURENT@eksplodo.fr' (collation utf8mb4_unicode_ci)
  await expect(insertSecond()).rejects.toThrow(/Duplicate/);
});
test('aucune colonne org_id', async () => {
  const [rows] = await poolOf(db).query("SELECT TABLE_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'org_id'");
  expect(rows).toEqual([]);
});
// server/test/health.test.ts
test('GET /health : base joignable', async () => { expect(res.json()).toEqual({ status: 'ok', db: 'ok', worker: 'stopped' }); });
test('GET /health : base injoignable → 503', async () => { expect(res.statusCode).toBe(503); expect(res.json()).toMatchObject({ status: 'degraded', db: 'down' }); });
```

Copier `$AO/server/test/startup.test.ts` (verrou nommé, migrations concurrentes) en retirant les cas liés aux organisations et aux clés chiffrées.

- [ ] **Step 3: Vérifier l'échec** — Run: `npx vitest run --project server server/test/db.test.ts server/test/health.test.ts` — Expected: FAIL.

- [ ] **Step 4: Écrire les schémas et générer la migration** — `core.ts` d'après `$AO/server/src/db/schema/core.ts` sans `organizations` ni `org_id` (rôles `admin` | `user`) ; `jobs.ts` copié ; `errors.ts` copié sans `org_id`. Run: `npx drizzle-kit generate` — Expected: un seul fichier `server/drizzle/0000_*.sql`.

- [ ] **Step 5: Brancher** — `/health` repris de `$AO/server/src/app.ts` sans la partie `sources` : `{ status: 'ok', db: 'ok', worker }`, 503 si `SELECT 1` échoue en plus de 2 s (le report de l'erreur `db_unreachable` est branché en Task 6). `index.ts` : `createDb`, `prepareDatabase` (migrations sous verrou), `buildApp({ …, db, workerStatus })`, fermeture de la base à l'arrêt.

- [ ] **Step 6: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: base MariaDB, schéma des comptes, migrations et /health"`

---

### Task 3: Sessions, connexion, CSRF et garde de rôle

**Files:**
- Create (copiés de `$AO` puis adaptés) : `server/src/lib/crypto.ts`, `server/src/modules/auth/actor.ts`, `server/src/modules/auth/sessions.ts`, `server/src/modules/users/users.repo.ts`, `server/src/plugins/auth.ts`, `server/src/plugins/csrf.ts`, `server/src/plugins/rate-limit.ts`, `server/src/modules/auth/auth.routes.ts` (connexion, déconnexion, `me`, changement de mot de passe), `server/test/helpers/test-app.ts`
- Modify : `server/src/app.ts`
- Test : `server/test/crypto.test.ts`, `server/test/actor.test.ts`, `server/test/auth.test.ts`, `server/test/rate-limit.test.ts`

**Interfaces:**
- Consumes : `Db`, tables `users` et `sessions` (Task 2).
- Produces :
  - `hashPassword`, `verifyPassword`, `generateToken(): { token; hash }`, `hashToken(token)` (copie de `$AO/server/src/lib/crypto.ts` **sans** `encryptSecret` / `decryptSecret`)
  - `type Role = 'admin' | 'user'`, `type Actor = { userId: string; role: Role; email: string; name: string }`, `normalizeEmail(email): string`, `assertRole(actor, ...roles): void` (lève `ForbiddenError`)
  - `SESSION_TTL_MS`, `createSession`, `resolveSession(db, token, now): Promise<Actor | null>`, `destroySession`, `destroyUserSessions` (copie, sans `destroyOrgSessions`)
  - `createUsersRepo(db)` (sans filtres d'organisation), `type UserRow`
  - `SESSION_COOKIE = 'aic_session'`, `CSRF_COOKIE = 'aic_csrf'`, `registerAuth(app, deps)` (décorateurs `request.actor`, `app.requireActor`, **`app.requireAdmin`**), `registerCsrf(app, config)`, `registerRateLimit(app)`, `AUTH_RATE_LIMIT`
  - `type PublicUser = { id: string; email: string; name: string; role: Role }`
  - Routes : `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/password` (`{ currentPassword, newPassword }`, détruit les autres sessions du compte)
  - `buildTestApp(opts?): Promise<TestApp>`, `seedUser(db, { email, role, status?, password? }): Promise<UserRow>`, `loginAs(app, email, password): Promise<{ cookie: string; csrf: string }>`

- [ ] **Step 1: Écrire les tests qui échouent** — copier `$AO/server/test/crypto.test.ts` (sans les cas de chiffrement), `actor.test.ts` (réécrit pour `admin` | `user`, sans portée d'organisation), `auth.test.ts` et `rate-limit.test.ts` en retirant tout ce qui concerne les organisations et la réinitialisation en libre-service. Ajouter :

```ts
test('connexion insensible à la casse et aux espaces', async () => {
  await seedUser(db, { email: 'laurent@eksplodo.fr', role: 'admin', password: 'motdepasse-12' });
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ' Laurent@Eksplodo.FR ', password: 'motdepasse-12' } });
  expect(res.statusCode).toBe(200); expect(res.json().user.role).toBe('admin');
});
test('cookies aic_session et aic_csrf posés', async () => { expect(cookieNames(res)).toEqual(expect.arrayContaining(['aic_session', 'aic_csrf'])); });
test('requireAdmin : un Utilisateur reçoit 403', async () => {
  app.get('/api/_admin-probe', { preHandler: app.requireAdmin }, async () => ({ ok: true }));
  // session d'un compte role 'user'
  expect(res.statusCode).toBe(403); expect(res.json().error.code).toBe('forbidden');
});
test('compte désactivé pendant la session → 401 à la requête suivante', async () => {
  // connexion, puis UPDATE users SET status = 'disabled', puis GET /api/auth/me
  expect(res.statusCode).toBe(401);
});
test('changement de mot de passe : ancien mot de passe exigé, autres sessions fermées', async () => {
  // deux sessions, POST /api/auth/password depuis la première ; la seconde reçoit 401 ; mauvais currentPassword → 400 'invalid_password'
});
test('nouveau mot de passe de moins de 12 caractères refusé', async () => { expect(res.json().error.code).toBe('validation'); });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/auth.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — copier puis adapter les fichiers listés : supprimer `orgId`, `orgScopeFor`, `userScopeOf`, `allOrgsScope`, la vérification « organisation suspendue » de `resolveSession`, et la route `POST /api/auth/password/forgot`. Ajouter `app.requireAdmin` dans `plugins/auth.ts` (= `requireActor` puis `assertRole(actor, 'admin')`). Ajouter la route `POST /api/auth/password`. `test-app.ts` : d'après `$AO`, réduit aux options `now` et `schedules`, avec `testConfig()` conforme au nouveau `AppConfig`.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: sessions, connexion, CSRF et garde Admin"`

---

### Task 4: E-mails, invitations, réinitialisation et premier Admin

**Files:**
- Create (copiés de `$AO` puis adaptés) : `server/src/modules/mail/mailer.ts`, `server/src/modules/mail/templates.ts`, `server/src/modules/auth/invitations.ts`, `server/src/modules/audit/audit.ts`, `server/src/modules/auth/bootstrap.ts`
- Modify : `server/src/modules/auth/auth.routes.ts`, `server/src/startup.ts`, `server/src/index.ts`, `server/src/app.ts`, `server/test/helpers/test-app.ts`
- Test : `server/test/mailer.test.ts`, `server/test/invitations.test.ts`, `server/test/bootstrap.test.ts`

**Interfaces:**
- Consumes : `generateToken`, `hashToken`, `hashPassword`, `createUsersRepo`, `normalizeEmail` (Task 3).
- Produces :
  - `interface Mailer { send(msg: MailMessage): Promise<void> }`, `createSmtpMailer`, `createFakeMailer(): Mailer & { sent: MailMessage[] }`, `createLogMailer(logger, production)` (copie)
  - `escapeHtml`, `invitationEmail(p: { name: string; link: string }): MailBody`, `resetEmail(p: { name: string; link: string }): MailBody`, `errorAlertEmail`, `errorDigestEmail` (copiés ; les autres modèles de `$AO` sont supprimés). Libellés : « Eksplodo · Comparateur IA ».
  - `INVITE_TTL_MS = 72 * 3600_000`, `RESET_TTL_MS = 24 * 3600_000`
  - `issueInvitation(db, userId: string, purpose: 'invite' | 'reset', now: Date): Promise<string>` → jeton en clair ; **marque comme utilisées** les invitations non utilisées du même compte et du même objet
  - `invitationLink(config, purpose, token): string` → `${appBaseUrl}/invitation/${token}` ou `${appBaseUrl}/reinitialiser/${token}`
  - `redeemInvitation(db, token, purpose, { name?, password }, now)` (copie)
  - Routes publiques : `POST /api/auth/invitations/accept` (`{ token, name, password }`), `POST /api/auth/password/reset` (`{ token, password }`)
  - `audit(db, e: { actorUserId: string | null; action: string; targetType: string; targetId?: string; details?: unknown }): Promise<void>`
  - `ensureBootstrapAdmin(deps: { db; config; clock; logger? }): Promise<'created' | 'skipped'>`
  - `AppDeps` étendu : `mailer: Mailer`

- [ ] **Step 1: Écrire les tests qui échouent** — copier `$AO/server/test/mailer.test.ts` et `invitations.test.ts` (sans les organisations), puis ajouter :

```ts
test('invitation acceptée : compte actif, mot de passe défini, session ouverte', async () => { /* … */ });
test('lien réutilisé refusé', async () => { expect(second.json().error.code).toBe('invitation_invalid'); });
test('lien expiré (72 h + 1 ms) refusé', async () => { clock.advance(72 * 3600_000 + 1); expect(res.json().error.code).toBe('invitation_invalid'); });
test('régénérer invalide le lien précédent', async () => {
  const t1 = await issueInvitation(db, u.id, 'invite', clock.now());
  const t2 = await issueInvitation(db, u.id, 'invite', clock.now());
  expect((await accept(t1)).statusCode).toBe(400); expect((await accept(t2)).statusCode).toBe(200);
});
test('compte désactivé entre-temps : lien refusé, compte inchangé', async () => { /* status reste 'disabled' */ });
test('réinitialisation valable 24 h, change le mot de passe et ferme les sessions', async () => { /* … */ });

// server/test/bootstrap.test.ts
test('crée l’Admin actif depuis la config', async () => {
  const r = await ensureBootstrapAdmin({ db, config: { ...testConfig(), bootstrapAdmin: { email: 'laurent@eksplodo.fr', password: 'p'.repeat(12) } }, clock });
  expect(r).toBe('created'); // users : role 'admin', status 'active', passwordHash vérifiable
});
test('ne fait rien s’il existe déjà un Admin, même désactivé', async () => { expect(r).toBe('skipped'); });
test('ne fait rien sans configuration', async () => { expect(r).toBe('skipped'); });
test('deux démarrages simultanés → un seul Admin', async () => {
  await Promise.all([prepareDatabase(deps), prepareDatabase(deps)]);
  expect(await countAdmins(db)).toBe(1);
});
test('le mot de passe n’apparaît dans aucun journal', async () => { expect(logs.join('\n')).not.toContain('p'.repeat(12)); });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/invitations.test.ts server/test/bootstrap.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — copier et adapter (`orgName` retiré des modèles, constantes de durée ci-dessus). `bootstrap.ts` est **réécrit** : s'il n'existe aucun utilisateur `role = 'admin'` (quel que soit le statut) et que `config.bootstrapAdmin` est défini, insérer l'Admin `active` avec `hashPassword(password)` et le nom « Admin », dans une transaction tolérante au doublon (`ER_DUP_ENTRY` → `'skipped'`), puis `audit(action: 'bootstrap_admin')`. `startup.ts` : `prepareDatabase` appelle `ensureBootstrapAdmin` après les migrations, sous le même verrou. `index.ts` : mailer SMTP si configuré, sinon `createLogMailer`.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: invitations, réinitialisation par l'Admin et premier Admin"`

---

### Task 5: API des utilisateurs (Admin)

**Files:**
- Create (adaptés de `$AO`) : `server/src/modules/users/users.service.ts`, `server/src/modules/users/users.routes.ts`
- Modify : `server/src/app.ts`
- Test : `server/test/users.test.ts`

**Interfaces:**
- Consumes : `issueInvitation`, `invitationLink`, `invitationEmail`, `resetEmail`, `Mailer`, `audit`, `destroyUserSessions`, `app.requireAdmin`.
- Produces :
  - `type PublicUserWithStatus = PublicUser & { status: 'invited' | 'active' | 'disabled'; lastLoginAt: string | null; createdAt: string }`
  - `type IssuedLink = { link: string; expiresAt: string; mail: 'sent' | 'failed' | 'not_configured' }`
  - `createUsersService(deps: { db; mailer; config; clock })` → `listUsers()`, `inviteUser(actor, { email, name, role }): Promise<{ user: PublicUserWithStatus } & IssuedLink>`, `regenerateInvite(actor, id): Promise<IssuedLink>`, `issueReset(actor, id): Promise<IssuedLink>`, `updateUser(actor, id, { role?, status? }): Promise<PublicUserWithStatus>`
  - Routes (toutes `requireAdmin`) : `GET /api/users`, `POST /api/users`, `POST /api/users/:id/invite-link`, `POST /api/users/:id/reset-link`, `PATCH /api/users/:id`

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test('inviter renvoie le lien une seule fois et envoie l’e-mail', async () => {
  const res = await post('/api/users', { email: ' Nouveau@Client.fr ', name: 'Camille', role: 'user' });
  expect(res.statusCode).toBe(201); expect(res.json().link).toMatch(/\/invitation\/[A-Za-z0-9_-]{32,}$/);
  expect(res.json().mail).toBe('sent'); expect(mailer.sent[0].to).toBe('nouveau@client.fr');
  expect((await get('/api/users')).body).not.toContain(res.json().link.split('/').pop());
});
test('SMTP absent → mail "not_configured", lien quand même renvoyé', async () => { /* mailer = createLogMailer */ });
test('échec d’envoi → mail "failed", lien utilisable', async () => { /* mailer qui lève */ });
test('e-mail déjà utilisé (autre casse) → 409 "email_taken"', async () => { /* … */ });
test('régénérer le lien : nouveau lien, l’ancien est refusé', async () => { /* … */ });
test('lien de réinitialisation réservé aux comptes actifs', async () => { expect(resInvited.json().error.code).toBe('user_not_active'); });
test('désactiver ferme les sessions du compte', async () => { /* puis /api/auth/me du compte → 401 */ });
test('dernier Admin actif : ni désactivation ni rétrogradation, y compris de soi-même', async () => {
  expect((await patch(`/api/users/${admin.id}`, { status: 'disabled' })).json().error.code).toBe('last_admin');
  expect((await patch(`/api/users/${admin.id}`, { role: 'user' })).json().error.code).toBe('last_admin');
});
test('avec deux Admins actifs, l’un peut rétrograder l’autre', async () => { /* 200 */ });
test('un Utilisateur reçoit 403 sur toutes les routes /api/users', async () => { /* GET, POST, PATCH, invite-link, reset-link */ });
test('chaque action est auditée', async () => { /* audit_log : user_invited, invite_regenerated, reset_issued, user_updated */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/users.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — partir de `$AO/server/src/modules/users/users.service.ts` et `users.routes.ts` : retirer organisations et Managers ; `inviteUser` crée le compte `invited`, émet l'invitation, tente l'envoi et renvoie le lien quel que soit le résultat de l'envoi ; la garde « dernier Admin actif » compte les Admins `active` hors compte modifié, dans la même transaction. Validation Zod : `name` 1 à 200 caractères, `role` ∈ `admin` | `user`.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: API Admin des utilisateurs et liens copiables"`

---

### Task 6: File de tâches, planificateur, `/internal/tick` et journal des erreurs

**Files:**
- Create (copiés de `$AO` puis adaptés) : `server/src/modules/jobs/queue.ts`, `worker.ts`, `scheduler.ts`, `scheduler-loop.ts`, `tick.routes.ts`, `handlers.ts` ; `server/src/modules/errors/capture.ts`, `report.ts`, `reference.ts`, `severity.ts`, `notifications.ts`, `mail-reporter.ts`, `errors.routes.ts`
- Create : `server/src/modules/jobs/schedules.ts`
- Modify : `server/src/app.ts` (500 → `reportError`, `/health` → `deferError`), `server/src/index.ts` (worker, planificateur, écouteur des erreurs graves, `reportingMailer`)
- Test : `server/test/jobs.test.ts`, `scheduler.test.ts`, `scheduler-loop.test.ts`, `errors-report.test.ts`, `errors-capture.test.ts`, `errors-notifications.test.ts`, `errors-mail-reporter.test.ts`, `errors-api.test.ts` (copiés et adaptés)

**Interfaces:**
- Consumes : `Db`, tables `jobs` et `error_events`, `Mailer`, `errorAlertEmail`, `errorDigestEmail`, `app.requireAdmin`.
- Produces :
  - Depuis `queue.ts` (copie) : `type Job`, `type JobInput = { type: string; payload?: unknown; runAt?: Date; dedupeKey?: string; maxAttempts?: number }`, `type JobContext`, `type JobHandler = (job: Job, ctx: JobContext) => Promise<void>`, `type JobHandlers = Record<string, JobHandler>`, `enqueue(db, input, now): Promise<string | null>`, `InterruptedError`, `updateProgress`, `recoverStaleJobs`
  - `startWorker(deps, handlers, { intervalMs })` → `{ status(): 'running' | 'stopped'; stop(): Promise<void> }`, `runWorkerOnce`, `JOB_TIMEOUT_MS`
  - `type ScheduleEntry`, `scheduleDueJobs`, `startSchedulerLoop`
  - `createJobHandlers(deps: { db; mailer; config; clock; logger }): JobHandlers` → `errors_purge`, `error_alert`, `error_digest` (les plans suivants y ajoutent leurs types)
  - `appSchedules(): ScheduleEntry[]` → `errors-purge` à `03:30` et `error-digest` à `07:30` (horaires de `$AO`)
  - `reportError(db, input: ErrorInput, now): Promise<string>` (référence `E-XXXXX`), `deferError`, `flushPendingErrors`, `reportJobFailure`
  - Routes Admin : `GET /api/admin/errors`, `GET /api/admin/errors/summary`, `GET /api/admin/errors/by-reference/:reference`, `POST /api/admin/errors/resolve`, `GET|PUT /api/admin/settings/notifications`
  - `POST /internal/tick` (en-tête `x-cron-secret`, comparaison à temps constant) → `{ recovered, failedStale, scheduled }`
  - `AppDeps` étendu : `schedules: ScheduleEntry[]`

- [ ] **Step 1: Copier les tests** listés depuis `$AO/server/test/` ; retirer `orgId`, les organisations et les origines propres à l'app AO (collecte, documents, analyse) ; garder les cas génériques : verrouillage d'une tâche par un seul worker, reprise après redémarrage sans consommer de tentative, délais croissants, délai de 14 min, tâche orpheline remise en file après 15 min, idempotence du planificateur par créneau, regroupement des erreurs identiques à moins d'une heure, masquage des clés et des jetons `Bearer`, mode d'alerte `none` | `daily` | `immediate`, `/internal/tick` refusé sans secret ou avec un secret faux.

```ts
// ajout dans server/test/errors-api.test.ts
test('un Utilisateur reçoit 403 sur /api/admin/errors', async () => { expect(res.statusCode).toBe(403); });
test('erreur 500 d’une route : référence E-XXXXX renvoyée et enregistrée', async () => {
  expect(res.json().error.reference).toMatch(/^E-[A-Z0-9]{5}$/);
});
test('masquage : une clé sk-… et un paramètre key= n’atteignent jamais error_events', async () => {
  // message d'erreur contenant 'sk-or-v1-abcdef0123456789' et 'https://x/models?key=AIzaSy123'
  expect(row.message).not.toMatch(/sk-or-v1-abcdef|AIzaSy123/);
});
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project server server/test/jobs.test.ts server/test/errors-api.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — copier et adapter (`orgId` retiré des types et des requêtes ; liens de la page Admin vers `/admin/erreurs`). **Ajouter au masquage** de `report.ts` les motifs `sk-[A-Za-z0-9_-]{8,}`, `AIza[0-9A-Za-z_-]{10,}` et le paramètre d'URL `key=…`. Brancher dans `app.ts` le gestionnaire 500 et `/health` comme dans `$AO`. `index.ts` : `startWorker` (intervalle 2 s), `startSchedulerLoop` (60 s), `setGraveListener(createGraveListener(...))`, arrêt propre en 10 s maximum.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run --project server && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: file de tâches, planificateur, tick et journal des erreurs"`

---

### Task 7: Socle de l'interface : Vite, Tailwind « Nuit », coque et authentification côté client

Utiliser le skill **`frontend-design`** ; référence visuelle : `docs/superpowers/maquettes/resultats-nuit.html` (barre latérale, cartes, pastilles, boutons).

**Files:**
- Create : `vite.config.ts` (copie de `$AO`, proxy ajouté pour `/health`), `web/index.html` (titre « Eksplodo · Comparateur IA », `lang="fr"`), `web/public/` (favicon dérivé de `docs/brand/eksplodo-icon-white.png`, `logo-icon-white.png`)
- Create : `web/src/main.tsx`, `web/src/theme/theme.css`, `web/src/api/client.ts` et `web/src/api/messages.ts` (copiés de `$AO`), `web/src/auth/AuthProvider.tsx` (adapté), `web/src/app/routes.tsx`, `web/src/app/AppShell.tsx`, `web/src/app/AuthLayout.tsx`, `web/src/app/preferences.ts`, `web/src/components/ui/{Button,Card,Chip,Field,Dialog,CopyLink}.tsx`, `web/src/pages/{DashboardPage,AccessDeniedPage}.tsx`
- Create (copié de `$AO`) : `server/src/plugins/static.ts` ; Modify : `server/src/app.ts`
- Test : `web/src/api/client.test.ts` (copié), `web/src/app/AppShell.test.tsx`, `web/src/app/routes.test.tsx`, `web/src/app/preferences.test.ts`, `server/test/static.test.ts` (copié)

**Interfaces:**
- Consumes : `GET /api/auth/me`, `POST /api/auth/logout`, cookie `aic_csrf` (Task 3).
- Produces :
  - `apiFetch<T>(path, init?): Promise<T>`, `class ApiError { code; message; status; reference? }` (copie : lit `aic_csrf` au lieu de `eao_csrf`)
  - `messageFor(code: string): string` (copie, complétée des codes `last_admin`, `email_taken`, `invitation_invalid`, `user_not_active`, `invalid_password`)
  - `useAuth(): { user: PublicUser | null; loading: boolean; refresh(): Promise<void>; logout(): Promise<void> }`
  - `<AppShell />` : barre latérale (logo + « Eksplodo » / « COMPARATEUR IA » en Noto Sans Mono), sections **EXPLORER** (Tableau de bord ; les entrées Séries, Modèles et À noter sont ajoutées par les plans 2 à 4) et **ADMIN** (Utilisateurs, Journal des erreurs), visible seulement pour `role === 'admin'` ; menu du compte (Mon compte, interrupteur « Animations », Déconnexion) ; tiroir sous 800 px
  - `getAnimationsPreference(): boolean` / `setAnimationsPreference(on: boolean): void` (clé `aic.animations` dans `localStorage`, défaut `true`, lecture et écriture protégées par `try/catch`)
  - Routes : `/connexion`, `/invitation/:token`, `/reinitialiser/:token` (publiques) ; `/`, `/compte` (connecté) ; `/admin/utilisateurs`, `/admin/erreurs` (Admin, sinon `AccessDeniedPage`)

- [ ] **Step 1: Mettre en place Vite et Tailwind** — installer `tailwindcss`, `@tailwindcss/vite`, `@fontsource/archivo`, `@fontsource/instrument-sans`, `@fontsource/noto-sans-mono`, `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-switch` ; dev : `@testing-library/react`, `@testing-library/user-event`, `@testing-library/dom`, `jsdom`. `theme.css` : `@import "tailwindcss";` puis `@theme` avec les couleurs des Global Constraints (`--color-night-0: #00131D`, `--color-night-1: #011F2E`, `--color-night-2: #032A3D`, `--color-ink: #D8ECF5`, `--color-mute: #7FA3B5`, `--color-orange: #F0631F`, `--color-peach: #FFB48A`, `--color-sky: #7CC4EF`, `--color-blue: #3FA2E0`, `--color-blue-deep: #0C659D`, `--color-good: #4FD1A5`, `--color-bad: #FF7A7A`, `--font-display: Archivo`, `--font-sans: "Instrument Sans"`, `--font-mono: "Noto Sans Mono"`), fond `body` (dégradé radial et grille de points de la maquette), `color-scheme: dark`.

- [ ] **Step 2: Écrire les tests qui échouent**

```tsx
// web/src/app/AppShell.test.tsx
test('Admin : section ADMIN visible', () => { renderShell({ role: 'admin' }); expect(screen.getByText('ADMIN')).toBeInTheDocument(); expect(screen.getByRole('link', { name: 'Utilisateurs' })).toBeInTheDocument(); });
test('Utilisateur : aucune entrée Admin', () => { renderShell({ role: 'user' }); expect(screen.queryByText('ADMIN')).toBeNull(); expect(screen.queryByRole('link', { name: 'Utilisateurs' })).toBeNull(); });
test('logo et titre présents', () => { expect(screen.getByAltText('Eksplodo')).toBeInTheDocument(); expect(screen.getByText('COMPARATEUR IA')).toBeInTheDocument(); });
// web/src/app/routes.test.tsx
test('non connecté → redirigé vers /connexion', async () => { /* … */ });
test('Utilisateur sur /admin/utilisateurs → page « Accès refusé »', async () => { /* … */ });
// web/src/app/preferences.test.ts
test('animations activées par défaut', () => { expect(getAnimationsPreference()).toBe(true); });
test('préférence mémorisée', () => { setAnimationsPreference(false); expect(getAnimationsPreference()).toBe(false); });
test('localStorage indisponible → défaut sans erreur', () => { /* getItem qui lève */ expect(getAnimationsPreference()).toBe(true); });
```

- [ ] **Step 3: Vérifier l'échec** — Run: `npx vitest run --project web` — Expected: FAIL.

- [ ] **Step 4: Implémenter** les fichiers listés. `DashboardPage` : en-tête « Bonjour {name} » et carte d'état vide « Les séries et les classements arriveront ici. ». `static.ts` copié de `$AO` (repli SPA vers `index.html`, sauf `/api`, `/internal`, `/health`, `/share`).

- [ ] **Step 5: Vérifier le succès** — Run: `npx vitest run && npm run typecheck && npm run build` — Expected: PASS ; `dist/web/index.html` et `dist/server/index.js` existent.

- [ ] **Step 6: Vérifier dans le navigateur** — `npm run dev` puis ouvrir `http://localhost:5173` avec un compte créé par `BOOTSTRAP_ADMIN_*` dans `.env` : coque conforme à la maquette, menu Admin visible ; avec un compte `user`, menu Admin absent.

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: socle de l'interface, thème Nuit et coque"`

---

### Task 8: Three.js (gerbe Eksplodo) et pages d'authentification

Utiliser le skill **`frontend-design`** ; référence : onglet « Connexion » de `docs/superpowers/maquettes/ecrans-nuit.html` (fonction `burst`).

**Files:**
- Create : `web/src/three/animation-policy.ts`, `web/src/three/useThreeScene.ts`, `web/src/three/burst-scene.ts`, `web/src/three/BurstFallback.tsx`, `web/src/three/ThreeStage.tsx`
- Create : `web/src/pages/LoginPage.tsx`, `web/src/pages/InvitationPage.tsx`, `web/src/pages/ResetPasswordPage.tsx`, `web/src/pages/AccountPage.tsx`
- Test : `web/src/three/animation-policy.test.ts`, `web/src/three/ThreeStage.test.tsx`, `web/src/pages/LoginPage.test.tsx`, `web/src/pages/InvitationPage.test.tsx`

**Interfaces:**
- Consumes : `getAnimationsPreference` (Task 7), routes d'authentification (Tasks 3 et 4).
- Produces (réutilisées par les plans 3 à 5 pour la constellation, les flux en direct et la page publique) :
  - `type SceneFactory = (ctx: { THREE: typeof import('three'); canvas: HTMLCanvasElement; width: number; height: number; isMobile: boolean }) => { render(dtSeconds: number): void; resize(width: number, height: number): void; dispose(): void }`
  - `shouldAnimate(s: { reducedMotion: boolean; userPreference: boolean; pageVisible: boolean; inViewport: boolean }): boolean`
  - `hasWebGL(): boolean`
  - `useThreeScene(factory: SceneFactory, canvasRef: RefObject<HTMLCanvasElement>): { status: 'loading' | 'running' | 'paused' | 'fallback' }` — `import('three')` dynamique ; boucle `requestAnimationFrame` active seulement si `shouldAnimate(...)` ; écoute `visibilitychange`, `IntersectionObserver`, `matchMedia('(prefers-reduced-motion: reduce)')` et la préférence ; `setPixelRatio(Math.min(devicePixelRatio, 2))` ; `dispose()` au démontage
  - `<ThreeStage factory fallback={<BurstFallback />} className />` : rend le canevas, ou le repli si `hasWebGL()` est faux ; si les animations sont désactivées, rend une seule image fixe de la scène
  - `burstScene: SceneFactory` : 140 rayons (orange `#F0631F` un sur sept, `#7CC4EF` un sur trois, sinon `#0C659D`), cœur `#011F2E`, anneau orange, halo, étoiles ; 60 rayons et pas d'étoiles si `isMobile`
  - `<BurstFallback />` : SVG statique de la même gerbe, aux mêmes couleurs

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// web/src/three/animation-policy.test.ts
test.each([
  [{ reducedMotion: false, userPreference: true, pageVisible: true, inViewport: true }, true],
  [{ reducedMotion: true, userPreference: true, pageVisible: true, inViewport: true }, false],
  [{ reducedMotion: false, userPreference: false, pageVisible: true, inViewport: true }, false],
  [{ reducedMotion: false, userPreference: true, pageVisible: false, inViewport: true }, false],
  [{ reducedMotion: false, userPreference: true, pageVisible: true, inViewport: false }, false],
])('shouldAnimate(%o) = %s', (s, expected) => { expect(shouldAnimate(s)).toBe(expected); });
```
```tsx
// web/src/three/ThreeStage.test.tsx (jsdom n'a pas WebGL)
test('sans WebGL : le repli SVG est rendu, sans canevas', () => {
  render(<ThreeStage factory={burstScene} fallback={<BurstFallback />} />);
  expect(screen.getByTestId('burst-fallback')).toBeInTheDocument(); expect(document.querySelector('canvas')).toBeNull();
});
// web/src/pages/LoginPage.test.tsx
test('connexion réussie → tableau de bord', async () => { /* apiFetch simulé */ });
test('identifiants faux → message générique en français', async () => { expect(await screen.findByRole('alert')).toHaveTextContent(/identifiants/i); });
test('formulaire utilisable sans WebGL', async () => { expect(screen.getByLabelText('E-mail')).toBeEnabled(); expect(screen.getByTestId('burst-fallback')).toBeInTheDocument(); });
// web/src/pages/InvitationPage.test.tsx
test('mot de passe de moins de 12 caractères : erreur avant envoi', async () => { /* … */ });
test('lien invalide → message « Ce lien n’est plus valable » et lien vers la connexion', async () => { /* … */ });
```

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project web web/src/three web/src/pages` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — installer `three` et `@types/three`. Pages selon la maquette « Connexion » : carte translucide sur la gerbe (décalée à gauche sur grand écran, centrée en fond sur mobile), champs E-mail et Mot de passe, bouton orange « Se connecter », mention « ACCÈS SUR INVITATION UNIQUEMENT ». `InvitationPage` : nom + mot de passe + confirmation. `ResetPasswordPage` : mot de passe + confirmation. `AccountPage` : changement de mot de passe (`POST /api/auth/password`) et interrupteur « Animations ».

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run && npm run typecheck && npm run build` — Expected: PASS ; le fichier JS principal ne contient pas Three.js (un fragment séparé contient `three`).

- [ ] **Step 5: Vérifier dans le navigateur** — page de connexion animée ; avec l'émulation `prefers-reduced-motion: reduce`, image fixe ; onglet masqué puis réaffiché, l'animation reprend ; taille mobile (375 px), formulaire lisible. Mesurer le temps d'image dans le panneau Performance (cible : moins de 16 ms par image sur le portable de démonstration) et noter le résultat dans le message de commit.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: gerbe Three.js et pages d'authentification"`

---

### Task 9: Écrans Admin : utilisateurs et journal des erreurs

Utiliser le skill **`frontend-design`** (cartes, tableaux et pastilles de la maquette `resultats-nuit.html`).

**Files:**
- Create : `web/src/api/users.ts`, `web/src/api/errors.ts` (adapté de `$AO`), `web/src/pages/admin/UsersPage.tsx`, `web/src/pages/admin/ErrorLogPage.tsx` (adapté de `$AO`)
- Modify : `web/src/app/routes.tsx`
- Test : `web/src/pages/admin/UsersPage.test.tsx`, `web/src/pages/admin/ErrorLogPage.test.tsx` (adapté de `$AO`)

**Interfaces:**
- Consumes : routes `/api/users*` (Task 5), `/api/admin/errors*` et `/api/admin/settings/notifications` (Task 6), `<CopyLink />`, `<Dialog />` (Task 7).
- Produces : `listUsers()`, `inviteUser(body)`, `regenerateInvite(id)`, `issueReset(id)`, `updateUser(id, patch)` dans `web/src/api/users.ts`.

- [ ] **Step 1: Écrire les tests qui échouent**

```tsx
test('inviter : le lien s’affiche une fois avec un bouton Copier et l’état de l’e-mail', async () => {
  // POST simulé → { link, mail: 'not_configured' }
  expect(await screen.findByDisplayValue(/\/invitation\//)).toBeInTheDocument();
  expect(screen.getByText(/e-mail non envoyé.*SMTP/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Copier' })).toBeInTheDocument();
});
test('fermer la fenêtre fait disparaître le lien', async () => { expect(screen.queryByDisplayValue(/\/invitation\//)).toBeNull(); });
test('compte invité : action « Régénérer le lien » ; compte actif : « Lien de réinitialisation »', async () => { /* … */ });
test('erreur last_admin affichée en français', async () => { expect(await screen.findByRole('alert')).toHaveTextContent(/dernier Admin/i); });
test('pastilles de statut : Invité, Actif, Désactivé', async () => { /* … */ });
```

Copier `$AO/web/src/pages/admin/ErrorLogPage.test.tsx` en retirant les filtres et colonnes « organisation ».

- [ ] **Step 2: Vérifier l'échec** — Run: `npx vitest run --project web web/src/pages/admin` — Expected: FAIL.

- [ ] **Step 3: Implémenter** — `UsersPage` : tableau (nom, e-mail, rôle, statut, dernière connexion), bouton « Inviter » (fenêtre : e-mail, nom, rôle), actions par ligne (changer le rôle, désactiver ou réactiver, régénérer le lien ou lien de réinitialisation), fenêtre du lien avec `<CopyLink />` et la phrase « Ce lien ne sera plus affiché : copiez-le maintenant. ». `ErrorLogPage` : portage de `$AO` (synthèse 24 h / 7 j, filtres, détail, « Marquer comme traitée », mode d'alerte), restylé « Nuit ». Compteur des erreurs graves non traitées dans le menu Admin de `AppShell`.

- [ ] **Step 4: Vérifier le succès** — Run: `npx vitest run && npm run typecheck` — Expected: PASS.

- [ ] **Step 5: Vérifier dans le navigateur** — inviter un compte en local (SMTP absent) → lien copié → ouvert dans une fenêtre privée → compte créé → connexion en Utilisateur : pas de menu Admin, `/admin/utilisateurs` affiche « Accès refusé ».

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: écrans Admin des utilisateurs et du journal des erreurs"`

---

### Task 10: Documentation et mise en production sur Hostinger

Chaque action Hostinger ci-dessous demande l'**accord explicite de Laurent** juste avant d'être faite. Utiliser le skill `hostinger:deploy-to-hosting` et le connecteur Hostinger (outils `hosting_*`).

**Files:**
- Create : `README.md`, `docs/deploiement.md` (sur le modèle de `$AO/docs/deploiement.md` : variables, build, cron, redéploiement, journaux, contraintes LiteSpeed), `server/src/diag.routes.ts` (temporaire, supprimé en fin de tâche)
- Modify : `docs/superpowers/specs/2026-10-16-comparateur-ia-design.md` (§16 : résultat des vérifications 1 et 7)

- [ ] **Step 1: Rédiger `README.md` et `docs/deploiement.md`** — prérequis, commandes (`docker compose up -d db`, `npm run dev`, `npm test`, `npm run build`), variables du plan 1, procédure `git archive --format=zip -o app.zip HEAD` → envoi dans `public_html` → build (Node 24, type `fastify`, script `build`, entrée `dist/server/index.js`, sortie `.`), cron `*/15 * * * *` : `curl -s -X POST -H "x-cron-secret: <CRON_SECRET>" https://ia.eksplodo.fr/internal/tick`, ajout d'une clé API par hPanel puis « Appliquer les modifications ».

- [ ] **Step 2: Ajouter la route temporaire `GET /internal/diag`** protégée par `x-cron-secret` (401 sinon) : `{ nodeVersion, uptimeSeconds, memory: process.memoryUsage(), mariadbVersion }`, et le paramètre `?waitSeconds=N` (N ≤ 120) qui attend N secondes avant de répondre (vérification 1 de la spec : coupure des requêtes longues par LiteSpeed).

- [ ] **Step 3: Préparer le site (accord de Laurent requis)** — créer le site Node.js `ia.eksplodo.fr` sur la commande `59552280` ; créer la base avec `hosting_databases_setup-website` ; Laurent saisit dans hPanel `NODE_ENV=production`, `APP_BASE_URL=https://ia.eksplodo.fr`, `DATA_DIR=/home/u355159080/data/eksplodo-ia`, `CRON_SECRET` (généré : `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`), `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` et, s'il le souhaite, `SMTP_*` (boîte proposée `ia@eksplodo.fr`).

- [ ] **Step 4: Déployer (accord de Laurent requis)** — `git archive --format=zip -o app.zip HEAD`, envoi TUS dans `public_html` (`hosting_files_generate-upload-url`), `hosting_nodejs_start-build` avec les réglages du Step 1 ; suivre `hosting_nodejs_build` jusqu'à `completed` (en cas d'échec : `hosting_nodejs_build-logs` puis `hosting_nodejs_analyse-failed-build`). Expected : `curl -s https://ia.eksplodo.fr/health` → `{"status":"ok","db":"ok","worker":"running"}`.

- [ ] **Step 5: Vérifications de la spec** — Run: `curl -s -m 130 -H "x-cron-secret: $CRON_SECRET" "https://ia.eksplodo.fr/internal/diag?waitSeconds=90"` — Expected : réponse JSON après environ 90 s. Si la requête est coupée avant, noter la durée et **décider avec Laurent** : l'essai rapide (plan 3) passera par une tâche et un suivi par interrogation. Noter aussi `memory.rss` au repos.

- [ ] **Step 6: Recette (accord de Laurent pour le cron)** — connexion avec le compte d'amorçage ; Laurent retire ensuite `BOOTSTRAP_ADMIN_PASSWORD` et `BOOTSTRAP_ADMIN_EMAIL` dans hPanel ; invitation d'un Utilisateur (lien copié ou e-mail) et connexion ; page de connexion animée sur le portable de démonstration ; création du cron hPanel et vérification de la réponse `{"recovered":0,"failedStale":0,"scheduled":…}`.

- [ ] **Step 7: Retirer la route de diagnostic** — supprimer `server/src/diag.routes.ts` et son enregistrement, redéployer (accord de Laurent), vérifier que `/internal/diag` renvoie 404. Reporter les résultats des vérifications 1 et 7 dans §16 de la spec.

- [ ] **Step 8: Commit et push** — `git add -A && git commit -m "docs: déploiement Hostinger et résultats des vérifications" && git push`
