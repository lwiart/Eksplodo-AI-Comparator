# Plan 5 « Partage et tableau de bord » : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** des liens de partage publics en lecture seule (verdicts rédigés, coûts et réponses en option, bouton « Audit gratuit », version imprimable) et un tableau de bord chiffré, avec l'évolution de la qualité par suite.

**Architecture :** un module serveur `sharing` (table `share_links`, jeton de 32 caractères dont seule l'empreinte SHA-256 est stockée, routes Admin `/api/share-links`, route publique `GET /share/:token` qui renvoie une projection en liste blanche). Un module serveur `dashboard` (`GET /api/dashboard`, `GET /api/dashboard/evolution`) qui réutilise `loadAggregateRows`, `aggregateRun`, `rankModels` et le masquage de l'aveugle du plan 4. Côté web, la page publique `/p/:token` est rendue **hors** `AuthProvider` et réutilise les composants de résultats ; les écrans Admin des liens et le tableau de bord complètent l'application.

**Tech Stack :** Fastify 5, Drizzle, MariaDB 11.8 ; React 19, React Query, Tailwind v4, Recharts, Three.js (scène `fanout-scene`, la « gerbe »).

**Spec :** `docs/superpowers/specs/2026-10-16-comparateur-ia-design.md` (§3, §5.5, §8.4 « Évolution dans le temps », §9.2, §9.4, §10, §11.2, §12.2, §13 ; maquettes « Tableau de bord » et « Partage public » de `maquettes/ecrans-nuit.html`).

## Global Constraints

- Route publique `GET /share/:token` (hors `/api`, sans session) ; page publique `https://ia.eksplodo.fr/p/<jeton de 32 caractères>`.
- Jeton : 24 octets aléatoires (`crypto.randomBytes`) en base64url, soit 32 caractères ; seule son empreinte SHA-256 (hex) est stockée ; le jeton en clair n'est montré qu'à la création ou à la régénération.
- Un lien inconnu, désactivé ou dont le jeton a été régénéré renvoie **404** avec le même message (« Lien introuvable ou désactivé ») : aucun oracle.
- L'API publique ne renvoie que les champs autorisés : **aucun identifiant interne** (ni utilisateur, ni modèle, ni série, ni résultat : les modèles y sont désignés par des clés opaques `m1`, `m2`…), aucune configuration de fournisseur, aucune note individuelle d'évaluateur ni commentaire.
- `show_costs = false` : aucun montant (coût moyen, coût total, coût par réponse) ni note de coût dans la réponse publique ; le score global reste celui de la pondération de la série.
- La pondération appliquée à la page publique est celle enregistrée sur la série (`runs.weights`).
- URL du bouton « Audit gratuit » : réglage `sharing.audit_url`, défaut `https://eksplodo.fr`, modifiable par l'Admin, `https://` obligatoire.
- La page publique n'a ni menu ni lien vers l'application ; elle ne fait **aucun appel à `/api/*`** (seulement `GET /share/:token`).
- Version imprimable : feuille `@media print` qui masque la 3D et les boutons et montre un podium statique ; enregistrement en PDF par le navigateur.
- Tableau de bord : un Utilisateur voit la même page **sans la dépense ni les nouveautés** ; toute qualité affichée à un Utilisateur respecte le masquage de l'aveugle (`hiddenQuestionsFor` / `withoutHiddenScores`).
- Évolution de la qualité : séries **terminées** d'une même suite, les 6 plus récentes, ordre chronologique ; chaque point indique le juge de la série.
- Journal d'audit : `share_link_created`, `share_link_updated`, `share_link_regenerated`, `share_link_deleted`, `audit_url_changed`.
- Aucune nouvelle variable d'environnement. Migration `0006`.
- Messages, commentaires et tests en français, accents compris ; erreurs au format `{ error: { code, message } }`.

## Review Focus

1. **Fuite par la page publique** : un champ ajouté sans réflexion (identifiant, note d'évaluateur, coût alors que `show_costs` est faux). Test : comparer les clés de la réponse publique à une liste blanche exacte et vérifier l'absence de tout UUID dans le JSON sérialisé (Task 2).
2. **Lien révoqué ou régénéré encore lisible** (cache, ancien jeton). Test : après désactivation, puis après régénération, l'ancien jeton renvoie 404 (Task 2).
3. **Tableau de bord qui révèle l'aveugle** : vainqueur d'une série ou courbe d'évolution calculés avec les notes manuelles des autres pour un Utilisateur qui n'a pas noté. Test API Utilisateur contre Admin (Task 3).
4. **Page publique qui dépend de la session** (appel `/api/auth/me`, redirection vers `/connexion`). Test web : seule `GET /share/:token` est appelée, aucune redirection (Task 5).
5. **Verdict qui pointe vers un modèle retiré de la série ou un texte trop long** cassant la page publique. Test : validation à l'enregistrement et affichage robuste d'un verdict sans modèle (Tasks 1 et 5).

---

### Task 1 : Liens de partage côté serveur (table, CRUD Admin, réglage « Audit gratuit »)

**Files :**
- Create : `server/src/db/schema/sharing.ts` (ajoutée à la liste `schema` de `drizzle.config.ts`), `server/drizzle/0006_*.sql` (généré par `npx drizzle-kit generate`), `server/src/modules/sharing/share-links.service.ts`, `server/src/modules/sharing/share-links.routes.ts`, `server/src/modules/sharing/token.ts`
- Modify : `server/src/app.ts` (enregistrement des routes), `drizzle.config.ts`
- Test : `server/test/share-links.test.ts`

**Interfaces :**
- Produces :
  - table `share_links` : `id` char(36), `run_id` (FK `runs`, suppression en cascade), `token_hash` char(64) unique, `title` varchar(120), `intro` text nullable, `verdicts` JSON (`{ label: string; modelId: string | null; text: string }[]`), `show_costs` bool (défaut faux), `show_responses` bool (défaut faux), `active` bool (défaut vrai), `view_count` int (défaut 0), `created_by` (FK `users`, `set null`), `created_at`, `updated_at` ;
  - `newShareToken(): { token: string; hash: string }` et `hashShareToken(token: string): string` dans `token.ts` ;
  - type `ShareLinkView = { id; runId; runName; title; intro; verdicts; showCosts; showResponses; active; viewCount; createdAt; updatedAt }` (jamais l'empreinte) ;
  - routes **Admin** : `GET /api/share-links?runId=` → `{ links: ShareLinkView[] }` ; `POST /api/share-links` (corps `{ runId, title, intro?, verdicts, showCosts, showResponses }`) → 201 `{ link: ShareLinkView, token }` ; `PATCH /api/share-links/:id` (mêmes champs sauf `runId`, plus `active`) → `{ link }` ; `POST /api/share-links/:id/regenerate` → `{ link, token }` ; `DELETE /api/share-links/:id` → 204 ;
  - `GET /api/settings/sharing` (Admin) → `{ auditUrl }` ; `PUT /api/settings/sharing` (Admin) corps `{ auditUrl }` → `{ auditUrl }` ; `getAuditUrl(db): Promise<string>` exporté pour la Task 2.
- Validation (Zod, `.strict()`) : `title` 1 à 120 caractères après `trim` ; `intro` 2 000 au plus ; 0 à 6 verdicts ; `label` 1 à 60 ; `text` 0 à 500 ; `modelId` nul ou modèle **de cette série** (`run_models`), sinon `ValidationError('verdict_model_not_in_run', 'Le modèle du verdict ne fait pas partie de la série')` ; `auditUrl` URL `https://` de 300 caractères au plus (`ValidationError('invalid_audit_url', …)`).

- [ ] **Step 1 : Écrire les tests qui échouent** (`fastify.inject`, helpers de `server/test/helpers/`)
  - `test('Admin : création → jeton de 32 caractères base64url, seule l’empreinte SHA-256 est en base, audit share_link_created')`
  - `test('Utilisateur : 403 sur toutes les routes /api/share-links et /api/settings/sharing')`
  - `test('verdict avec un modèle hors série → 400 verdict_model_not_in_run ; 7 verdicts → 400')`
  - `test('PATCH active=false puis true ; regenerate change l’empreinte et renvoie un nouveau jeton ; DELETE → 204 puis 404')`
  - `test('réglage audit : défaut https://eksplodo.fr ; http:// refusé ; enregistrement audité audit_url_changed')`
  - `test('aucune réponse ne contient token_hash ni l’empreinte')`
- [ ] **Step 2 : Vérifier l'échec** — Run : `npx vitest run --project server server/test/share-links.test.ts` — Expected : FAIL.
- [ ] **Step 3 : Implémenter** (service, routes, migration générée et relue, journal d'audit dans la même transaction que l'écriture).
- [ ] **Step 4 : Vérifier le succès** — Run : `npx vitest run --project server server/test/share-links.test.ts && npm run typecheck` — Expected : PASS.
- [ ] **Step 5 : Commit** — `git commit -m "feat: liens de partage côté serveur et réglage « Audit gratuit »"`

---

### Task 2 : API publique `GET /share/:token`

**Files :**
- Create : `server/src/modules/sharing/public-share.ts`, `server/src/modules/sharing/public.routes.ts`
- Modify : `server/src/app.ts`, `server/src/plugins/static.ts` (`/share/` y est déjà exclu de la SPA ; ajouter l'en-tête `X-Robots-Tag: noindex` sur `/p/*`), `vite.config.ts` (relais `/share` vers l'API)
- Test : `server/test/public-share.test.ts`, `server/test/static.test.ts` (ajouts)

**Interfaces :**
- Consumes : `hashShareToken`, `getAuditUrl` (Task 1) ; `loadAggregateRows`, `aggregateRun` (plan 4, **sans** masquage : c'est la publication de l'Admin, agrégats de tous les évaluateurs).
- Produces : `PublicShare` (type exporté, miroir web en Task 5) :
  ```ts
  type PublicModel = RankingModel & { modelId: `m${number}` }; // même forme que le classement, clé opaque
  type PublicShare = {
    title: string; intro: string | null; auditUrl: string; showCosts: boolean;
    run: { name: string; completedAt: string | null; modelCount: number; testCount: number; repetitions: number; judgeName: string | null; totalCostUsd: number | null };
    weights: Weights; categories: string[]; models: PublicModel[];
    verdicts: { label: string; text: string; model: { key: string; name: string; color: string } | null }[];
    responses: { testName: string; category: string; userPrompt: string; answers: { modelKey: string; repetition: number; text: string | null; finalScore: number | null; judgeRationale: string | null }[] }[] | null;
  };
  ```
  Avec `showCosts = false` : `run.totalCostUsd`, chaque `cost` et chaque `raw.meanCostUsd` valent `null`. `responses` vaut `null` si `show_responses` est faux ; sinon seulement les réponses réussies, sans coût, sans évaluateur ni commentaire. Un verdict dont le modèle n'est plus dans la série a `model: null`.
- Comportement : recherche par empreinte ; lien inconnu ou inactif → 404 `not_found` « Lien introuvable ou désactivé » ; `view_count` incrémenté par un `UPDATE … SET view_count = view_count + 1` atomique ; limite de 60 requêtes par minute et par IP (`@fastify/rate-limit`, configuration de route) ; `Cache-Control: no-store`.

- [ ] **Step 1 : Écrire les tests qui échouent**
  - `test('lien actif : 200 sans session ; clés de premier niveau exactement celles de PublicShare ; aucun UUID dans le JSON')`
  - `test('show_costs faux : aucun montant ni note de coût ; vrai : montants présents')`
  - `test('show_responses faux : responses null ; vrai : textes des réponses réussies, sans évaluateur, commentaire ni coût')`
  - `test('notes manuelles : seule la moyenne agrégée apparaît, jamais une note individuelle ni un nom d’évaluateur')`
  - `test('lien désactivé, inconnu ou ancien jeton après régénération → 404 avec le même message')`
  - `test('chaque consultation incrémente view_count ; 61e requête de la minute → 429')`
  - `test('verdict dont le modèle a été retiré : model null, sans erreur')`
  - `test('statique : /share/x n’est pas servi comme SPA ; /p/x renvoie index.html avec X-Robots-Tag noindex')`
- [ ] **Step 2 : Vérifier l'échec** — Run : `npx vitest run --project server server/test/public-share.test.ts server/test/static.test.ts` — Expected : FAIL.
- [ ] **Step 3 : Implémenter** la projection en liste blanche (construire l'objet champ par champ, jamais par étalement d'un objet interne).
- [ ] **Step 4 : Vérifier le succès** — même commande, puis `npm run typecheck` — Expected : PASS.
- [ ] **Step 5 : Commit** — `git commit -m "feat: API publique des liens de partage"`

---

### Task 3 : API du tableau de bord

**Files :**
- Create : `server/src/modules/dashboard/dashboard.service.ts`, `server/src/modules/dashboard/dashboard.routes.ts`
- Modify : `server/src/app.ts`
- Test : `server/test/dashboard.test.ts`

**Interfaces :**
- Consumes : `monthSpend` (`server/src/modules/usage/usage.ts`), `loadAggregateRows`, `hiddenQuestionsFor`, `withoutHiddenScores` (`results.service.ts`), `aggregateRun`, `rankModels` (`aggregate.ts`), le service de notation manuelle pour le nombre de questions à noter (`todo`).
- Produces :
  - `GET /api/dashboard` (connecté) →
    ```ts
    type Dashboard = {
      runs: { total: number; thisMonth: number };
      models: { tracked: number; providers: number };          // modèles actifs, fournisseurs actifs ayant au moins un modèle actif
      spend: { monthUsd: number; judgeUsd: number } | null;     // null pour un Utilisateur
      toScore: { questions: number; runName: string | null };   // questions où scoredByMe < answers, série de la plus récente
      recentRuns: { id: string; name: string; suiteName: string | null; status: RunStatus; modelCount: number;
                    winner: { name: string; color: string } | null; costUsd: number; completedAt: string | null; createdAt: string }[]; // 5 plus récentes
      evolutionSuites: { id: string; name: string }[];          // suites ayant au moins une série terminée, la plus récemment utilisée d'abord
    };
    ```
    `thisMonth` : séries créées depuis le début du mois civil, fuseau Europe/Paris (comme `monthSpend`). `winner` : rang 1 selon la pondération de la série, calculé avec le masquage de l'aveugle pour un Utilisateur ; `null` si aucun modèle n'a de qualité.
  - `GET /api/dashboard/evolution?suiteId=<uuid>` (connecté) → `{ suite: { id, name }, runs: { id: string; name: string; completedAt: string; judgeName: string | null }[], series: { modelId: string; name: string; color: string; points: (number | null)[] }[] }` : 6 dernières séries terminées de la suite, ordre chronologique ; `points[i]` est la qualité du modèle dans `runs[i]` (`null` s'il n'y figure pas ou n'a pas de qualité) ; masquage appliqué pour un Utilisateur ; suite inconnue → 404.

- [ ] **Step 1 : Écrire les tests qui échouent**
  - `test('Admin : chiffres clés, dépense du mois avec la part du juge, 5 dernières séries avec vainqueur')`
  - `test('Utilisateur : spend null ; vainqueur et évolution sans les notes manuelles des questions qu’il n’a pas notées')`
  - `test('toScore : nombre de questions incomplètes pour ce compte et nom de la série la plus récente')`
  - `test('évolution : 6 dernières séries terminées de la suite, ordre chronologique, juge par série, null pour un modèle absent')`
  - `test('évolution : suite inconnue → 404 ; série en cours exclue')`
- [ ] **Step 2 : Vérifier l'échec** — Run : `npx vitest run --project server server/test/dashboard.test.ts` — Expected : FAIL.
- [ ] **Step 3 : Implémenter** (requêtes groupées : un seul `loadAggregateRows` pour toutes les séries concernées).
- [ ] **Step 4 : Vérifier le succès** — même commande puis `npm run typecheck` — Expected : PASS.
- [ ] **Step 5 : Commit** — `git commit -m "feat: API du tableau de bord et évolution de la qualité"`

---

### Task 4 : Interface Admin des liens de partage

Utiliser le skill **`frontend-design`** ; cohérence avec la page de résultats et les écrans Admin existants.

**Files :**
- Create : `web/src/api/sharing.ts`, `web/src/components/sharing/ShareDialog.tsx`, `web/src/components/sharing/VerdictsEditor.tsx`, `web/src/pages/admin/ShareLinksPage.tsx`, `web/src/pages/admin/AuditUrlCard.tsx`
- Modify : `web/src/pages/RunPage.tsx` (bouton « Partager », Admin), `web/src/app/routes.tsx` (`/admin/partages`, Admin), `web/src/app/AppShell.tsx` (ADMIN : « Liens de partage »), `web/src/api/messages.ts`
- Test : `web/src/components/sharing/ShareDialog.test.tsx`, `web/src/pages/admin/ShareLinksPage.test.tsx`, `web/src/pages/admin/AuditUrlCard.test.tsx`

**Interfaces :**
- Consumes : routes de la Task 1 ; `getRanking` et `rankedRows` (plan 4) pour proposer les verdicts.
- Produces : client `listShareLinks(runId?)`, `createShareLink(body)`, `updateShareLink(id, patch)`, `regenerateShareLink(id)`, `deleteShareLink(id)`, `getSharingSettings()`, `saveSharingSettings(auditUrl)`, `shareUrl(token) = `${location.origin}/p/${token}`` ; `<ShareDialog runId />` : titre (prérempli avec le nom de la série), introduction, éditeur de verdicts prérempli avec trois propositions calculées sur le classement à la pondération de la série — « Meilleur compromis » (meilleur score global), « Meilleure qualité » (meilleure qualité), « Le moins cher » (plus petit coût moyen) — chacune modifiable ou supprimable, ajout jusqu'à 6 ; cases « Afficher les coûts » et « Afficher les réponses » ; après création, le lien complet est affiché **une seule fois** avec un bouton « Copier » et l'avertissement qu'il ne pourra plus être réaffiché. `ShareLinksPage` : tableau (série, titre, vues, actif, créé le) ; actions « Modifier » (même formulaire), « Désactiver » / « Réactiver », « Régénérer le lien » (confirmation, nouveau lien affiché une fois), « Supprimer » (confirmation) ; carte « URL du bouton « Audit gratuit » ».

- [ ] **Step 1 : Écrire les tests qui échouent**
  - `test('Partager : verdicts proposés à partir du classement, modifiables ; création → lien affiché une fois avec « Copier »')`
  - `test('bouton « Partager » absent pour un Utilisateur')`
  - `test('liste : désactiver, régénérer (confirmation, nouveau lien), supprimer (confirmation) ; compteur de vues affiché')`
  - `test('URL « Audit gratuit » : http:// refusé avec message français ; https:// enregistré')`
- [ ] **Step 2 : Vérifier l'échec** — Run : `npx vitest run --project web web/src/components/sharing web/src/pages/admin/ShareLinksPage.test.tsx web/src/pages/admin/AuditUrlCard.test.tsx` — Expected : FAIL.
- [ ] **Step 3 : Implémenter.**
- [ ] **Step 4 : Vérifier le succès** — Run : `npx vitest run --project web && npm run typecheck` — Expected : PASS.
- [ ] **Step 5 : Commit** — `git commit -m "feat: interface Admin des liens de partage"`

---

### Task 5 : Page publique `/p/:token`

Utiliser le skill **`frontend-design`** ; référence : écran « Partage public » de `maquettes/ecrans-nuit.html` (lignes 282 et suivantes).

**Files :**
- Create : `web/src/api/public-share.ts`, `web/src/pages/PublicSharePage.tsx`, `web/src/components/sharing/VerdictCards.tsx`, `web/src/components/sharing/PublicResponses.tsx`
- Modify : `web/src/main.tsx` (la route `/p/:token` est rendue **hors** `AuthProvider`), `web/src/components/results/RankingTable.tsx` (prop `hideCosts` qui retire la colonne coût), les composants de résultats si leur type d'entrée doit s'élargir à `PublicModel`
- Test : `web/src/pages/PublicSharePage.test.tsx`, `web/src/components/results/RankingTable.test.tsx` (ajout)

**Interfaces :**
- Consumes : `GET /share/:token` (Task 2) ; `Podium`, `QualitySpeedChart`, `CategoryChart`, `RankingTable`, `rankedRows` (plan 4) ; `ThreeStage` avec la scène `fanout-scene` et `FanoutFallback` (la gerbe).
- Produces : `getPublicShare(token): Promise<PublicShare>` (miroir du type de la Task 2) ; page : logo Eksplodo, gerbe 3D, titre, introduction (texte brut, retours à la ligne conservés), cartes de verdicts (libellé, pastille et nom du modèle, texte ; sans modèle : libellé et texte seuls), podium, nuage qualité × vitesse, barres par catégorie, classement (sans colonne coût si `showCosts` est faux), réponses en option (sélecteur de test, `<Markdown>`), bouton « Audit gratuit » (`auditUrl`, `target="_blank" rel="noopener noreferrer"`) ; lien 404 → page « Ce lien n'existe pas ou a été désactivé » sans aucun lien vers l'application ; 429 → « Trop de consultations, réessayez dans une minute ».

- [ ] **Step 1 : Écrire les tests qui échouent**
  - `test('page publique : titre, verdicts, podium, graphes et classement ; seule GET /share/:token est appelée ; aucun lien vers l’application')`
  - `test('showCosts faux : pas de colonne coût ni de montant affiché')`
  - `test('réponses affichées seulement si responses est non nul ; Markdown sans HTML')`
  - `test('lien inconnu : message dédié, pas de redirection vers /connexion')`
  - `test('verdict sans modèle : libellé et texte seuls')`
- [ ] **Step 2 : Vérifier l'échec** — Run : `npx vitest run --project web web/src/pages/PublicSharePage.test.tsx web/src/components/results/RankingTable.test.tsx` — Expected : FAIL.
- [ ] **Step 3 : Implémenter** (charger la page publique en `lazy()` ; Three.js et Recharts restent dans leurs fragments).
- [ ] **Step 4 : Vérifier le succès** — Run : `npx vitest run --project web && npm run typecheck && npm run build` — Expected : PASS.
- [ ] **Step 5 : Commit** — `git commit -m "feat: page publique de partage"`

---

### Task 6 : Version imprimable

**Files :**
- Create : `web/src/components/sharing/StaticPodium.tsx`
- Modify : `web/src/pages/PublicSharePage.tsx` (bouton « Version imprimable » → `window.print()`), `web/src/theme/theme.css` (bloc `@media print`)
- Test : `web/src/components/sharing/StaticPodium.test.tsx`, `web/src/pages/PublicSharePage.test.tsx` (ajout)

**Interfaces :**
- Produces : `<StaticPodium rows />` (podium en HTML/CSS pur, sans canvas) rendu avec la classe `print-only` ; la scène 3D, les boutons et le sélecteur de réponses portent `no-print` ; `@media print` : fond blanc, texte sombre, `.no-print { display: none }`, `.print-only { display: block }` (masqué à l'écran), graphes conservés, sauts de page évités dans les cartes (`break-inside: avoid`).

- [ ] **Step 1 : Écrire les tests qui échouent**
  - `test('StaticPodium : trois premiers sans canvas, modèle non noté absent')`
  - `test('« Version imprimable » appelle window.print ; la gerbe porte no-print et le podium statique print-only')`
- [ ] **Step 2 : Vérifier l'échec** — Run : `npx vitest run --project web web/src/components/sharing web/src/pages/PublicSharePage.test.tsx` — Expected : FAIL.
- [ ] **Step 3 : Implémenter.**
- [ ] **Step 4 : Vérifier le succès** — Run : `npx vitest run --project web && npm run typecheck` — Expected : PASS.
- [ ] **Step 5 : Commit** — `git commit -m "feat: version imprimable de la page de partage"`

---

### Task 7 : Tableau de bord

Utiliser le skill **`frontend-design`** ; référence : écran « Tableau de bord » de `maquettes/ecrans-nuit.html` (lignes 140-168).

**Files :**
- Create : `web/src/api/dashboard.ts`, `web/src/components/dashboard/KpiCards.tsx`, `web/src/components/dashboard/QualityEvolutionChart.tsx`, `web/src/components/dashboard/RecentRuns.tsx`
- Modify : `web/src/pages/DashboardPage.tsx` (remplace l'encart provisoire ; garde `NewModelsCard` pour l'Admin)
- Test : `web/src/pages/DashboardPage.test.tsx`, `web/src/components/dashboard/QualityEvolutionChart.test.tsx`

**Interfaces :**
- Consumes : routes de la Task 3.
- Produces : `getDashboard()`, `getEvolution(suiteId)` ; titre « Bonjour {prénom} » avec, pour l'Admin, le nombre de nouveautés si > 0 ; cartes : « Séries lancées » (total, « +N ce mois-ci »), « Modèles suivis » (N, « P fournisseurs »), « Dépense API · {mois} » (montant, « dont juge X $ ») pour l'Admin seulement, « Réponses à noter » (N, nom de la série, lien vers `/a-noter`) ; « Évolution de la qualité » : sélecteur de suite (`evolutionSuites`, la première par défaut), courbes Recharts par modèle (couleur du modèle), abscisse = séries, infobulle avec la date et le juge de la série, message « Aucune série terminée pour cette suite » ; « Dernières séries » : nom (lien), suite, modèles, vainqueur (pastille), coût, statut ; Recharts chargé en `lazy()`.

- [ ] **Step 1 : Écrire les tests qui échouent**
  - `test('Admin : quatre cartes dont la dépense avec la part du juge, nouveautés, dernières séries avec vainqueur')`
  - `test('Utilisateur : pas de dépense ni de nouveautés')`
  - `test('évolution : une courbe par modèle, juge de chaque série dans l’infobulle, changement de suite relu')`
  - `test('aucune série : états vides lisibles')`
- [ ] **Step 2 : Vérifier l'échec** — Run : `npx vitest run --project web web/src/pages/DashboardPage.test.tsx web/src/components/dashboard` — Expected : FAIL.
- [ ] **Step 3 : Implémenter.**
- [ ] **Step 4 : Vérifier le succès** — Run : `npx vitest run --project web && npm run typecheck && npm run build` — Expected : PASS.
- [ ] **Step 5 : Commit** — `git commit -m "feat: tableau de bord chiffré et évolution de la qualité"`

---

### Task 8 : Documentation, vérification complète et parcours dans le navigateur

**Files :**
- Modify : `README.md` (partage, page publique, impression, tableau de bord), `docs/deploiement.md` (migration `0006`, aucune variable nouvelle, route publique `/share/:token` et pages `/p/*` à laisser passer par le proxy Hostinger)

- [ ] **Step 1 : Mettre à jour la documentation.**
- [ ] **Step 2 : Vérification complète** — Run : `npx vitest run && npm run typecheck && npm run build` — Expected : PASS.
- [ ] **Step 3 : Parcours dans le navigateur** (contrôleur, `AIC_FAKE_LLM=1`) : créer un lien depuis une série (verdicts proposés, coûts masqués), ouvrir `/p/<jeton>` dans un onglet sans session, vérifier verdicts, podium, graphes, classement sans coûts, réponses, bouton « Audit gratuit », aperçu d'impression ; désactiver puis régénérer (ancien lien 404) ; tableau de bord Admin et Utilisateur ; évolution sur une suite ayant au moins deux séries terminées.
- [ ] **Step 4 : Commit** — `git commit -m "docs: partage et tableau de bord"`
