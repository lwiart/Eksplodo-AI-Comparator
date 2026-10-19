# Eksplodo – Comparateur IA : spécification de conception (V1)

- **Date :** 2026-10-16
- **Statut :** validée section par section en brainstorming, en attente de relecture de ce document
- **Projet de référence :** `Code-appels offre` (app `ao.eksplodo.fr`), dont on reprend la stack, l'hébergement, la file de tâches, l'authentification et le journal des erreurs
- **Maquettes validées :** [`maquettes/`](../../../maquettes/) (`resultats-nuit.html`, `ecrans-nuit.html`, `connexion-fanout.html` pour la page de connexion)

---

## 1. Objectif

Une application web hébergée qui compare des modèles d'IA de plusieurs fournisseurs sur des tests que l'on écrit soi-même, puis qui les **note et les classe** sur quatre critères : qualité, vitesse, coût et fiabilité.

Deux usages :
- **Veille et benchmark** : quand un nouveau modèle sort, on l'ajoute à une série existante et on le compare aux autres sans tout relancer.
- **Démonstration client** : une interface spectaculaire (thème « Nuit », animations Three.js) et des **pages de partage publiques** qui servent aussi à la prospection Eksplodo.

### Critères de réussite V1

1. L'Admin connecte au moins OpenRouter, Anthropic, Google et un fournisseur compatible OpenAI (Mistral ou DeepSeek) en saisissant leur clé dans l'écran « Fournisseurs », et voit pour chacun l'état « clé enregistrée (…a4f2) », « clé manquante » ou « clé illisible », ainsi que le résultat de « Tester la connexion ».
2. Il crée un test avec pièce jointe (image ou PDF) et l'une des trois méthodes de notation, puis le vérifie avec l'**essai rapide**.
3. Il lance une série de 24 tests × 6 modèles × 2 répétitions. Elle se termine seule sur Hostinger, survit à un redémarrage de l'application et respecte son plafond de dépense.
4. Il ajoute un 7ᵉ modèle à cette série : seules les combinaisons manquantes sont exécutées.
5. Un utilisateur invité par e-mail consulte les résultats et note à l'aveugle les tests en notation manuelle, sans jamais accéder à l'administration.
6. Un lien de partage public affiche le podium, les verdicts et les graphes d'une série, sans compte et avec ou sans les coûts.
7. L'ensemble tourne en local sans clé ni dépense grâce au faux fournisseur (`AIC_FAKE_LLM=1`).

---

## 2. Périmètre

### Inclus en V1

- Fournisseurs de trois types : **compatible OpenAI** (OpenAI, Mistral, DeepSeek, Qwen/DashScope, Kimi/Moonshot, OpenRouter, Groq, xAI, Ollama en local…, et des agrégateurs comme OpenRouter, Requesty ou Eden AI), **Anthropic** et **Google Gemini**. L'Admin ajoute les fournisseurs et **saisit leur clé API dans l'interface** ; elle est stockée **chiffrée** (AES-256-GCM) avec la clé maîtresse `APP_ENCRYPTION_KEY`. Le modèle juge utilise le même mécanisme.
- Catalogue de modèles, avec un assistant d'ajout qui interroge `/models`. Pour OpenRouter, les prix et les capacités sont importés automatiquement.
- **Nouveautés OpenRouter** : détection quotidienne des modèles apparus dans le catalogue OpenRouter et absents du catalogue local.
- Tests (prompt système, prompt utilisateur, pièces jointes image ou PDF, paramètres, catégorie, tags) et suites de tests.
- Trois méthodes de notation : **IA-juge**, **réponse attendue** (exacte, contient, regex) et **manuelle à l'aveugle** par plusieurs évaluateurs.
- **Essai rapide** d'un test sur un modèle depuis l'éditeur.
- Séries : estimation du coût avant lancement, exécution en tâche de fond, **suivi en direct**, **pause et reprise**, **relance des erreurs**, **plafond de dépense**, **ajout de modèles après coup**, recalcul des notes.
- Résultats : classement pondéré (curseurs), podium, graphes, réponses côte à côte, détail par catégorie, constellation 3D.
- Tableau de bord : chiffres clés, dépense du mois, évolution de la qualité par suite, nouveautés, dernières séries.
- Fiche modèle : prix, capacités, état de la clé, chiffres clés, radar par catégorie, historique.
- Comptes : un rôle **Admin** et un rôle **Utilisateur**, avec invitation par e-mail et lien d'invitation copiable en secours.
- **Liens de partage publics** en lecture seule, avec verdicts rédigés, option « masquer les coûts » et bouton « Audit gratuit » vers eksplodo.fr.
- Export CSV des résultats et version imprimable (PDF par le navigateur) de la page de partage.
- Journal des erreurs, `/health`, déploiement Hostinger documenté.

### Hors V1

- Conversations en plusieurs tours (historique de messages) dans un test.
- Appels d'outils et sorties structurées comme critères de test.
- Classement général entre séries différentes (les notes de vitesse et de coût sont relatives à une série, voir §8.4).
- Planification automatique de séries récurrentes.
- Connecteurs dédiés pour les fournisseurs dont l'API n'est compatible avec aucun des trois types.

---

## 3. Utilisateurs et rôles

| Fonction | Admin | Utilisateur | Lien de partage (sans compte) |
|---|---|---|---|
| Fournisseurs, modèles, prix | configure | consulte la fiche des modèles | — |
| Tests et suites | crée, modifie, archive | — | — |
| Séries | lance, met en pause, complète, relance, recalcule | consulte | une série précise, en lecture |
| Résultats et graphes | consulte, enregistre la pondération par défaut | consulte (curseurs locaux, non enregistrés) | consulte la vue publique |
| Notation manuelle | note et **impose** une note finale | **note à l'aveugle** | — |
| Comptes | invite, change le rôle, désactive | modifie son mot de passe | — |
| Liens de partage | crée, édite les verdicts, révoque | — | — |

- **Premier Admin** : au démarrage, si aucun Admin n'existe et que `BOOTSTRAP_ADMIN_EMAIL` et `BOOTSTRAP_ADMIN_PASSWORD` sont définis, le compte est créé (mot de passe haché). Ces deux variables sont à retirer ensuite. Aucun SMTP n'est nécessaire pour démarrer.
- **Invitations** : l'Admin saisit un e-mail et un rôle ; un lien valable 72 h est envoyé par le SMTP Hostinger. Le lien est **affiché une fois à l'Admin** à la création, avec un bouton « Copier », pour qu'il puisse le transmettre lui-même si l'envoi échoue ou que le SMTP n'est pas configuré. Seul le haché du jeton étant stocké, le lien ne peut pas être réaffiché ensuite : le bouton « Régénérer le lien » en émet un nouveau et invalide l'ancien.
- **Mot de passe oublié** : pas de demande en libre-service. L'Admin génère un lien de réinitialisation (valable 24 h), envoyé par e-mail et affiché pour être copié, selon le même principe.
- Plusieurs Admins sont possibles : le rôle est un champ du compte.

---

## 4. Architecture

### 4.1 Vue d'ensemble

```
                   ┌──────────────── Processus Node unique (Hostinger) ────────────────┐
 Navigateur ──────▶│  Fastify  /api/*  ──▶ modules métier ──▶ MariaDB (127.0.0.1)        │
 (React SPA)       │  /share/* (API publique restreinte)                                │
                   │  + sert l'interface React compilée                                 │
                   │  Worker de tâches (table jobs) : séries, notation, catalogue       │
                   └──────────────▲─────────────────────────────┬────────────────────────┘
 Cron Hostinger ───(toutes les 15 min, POST /internal/tick)─────┘ ├──▶ API compatibles OpenAI
                                                                  ├──▶ API Anthropic
                                                                  ├──▶ API Google Gemini
                                                                  ├──▶ OpenRouter /models (catalogue)
                                                                  └──▶ SMTP Hostinger (invitations)
```

- **Un seul processus Node** sert l'API, l'interface compilée et exécute les tâches de fond, comme l'app AO.
- **Séries** : l'API crée les résultats « en attente » et une tâche `run_execute` ; le worker exécute les appels avec une concurrence limitée ; l'interface suit l'avancement par interrogation régulière (toutes les 2 s).
- **Toutes les mesures de temps sont prises côté serveur**, sur le flux renvoyé par le fournisseur : elles ne dépendent ni du navigateur ni du proxy LiteSpeed.

### 4.2 Hébergement

- Hostinger Business Web Hosting, compte `u355159080` (le même que l'app AO).
- Nouveau site Node.js **`ia.eksplodo.fr`**, avec sa propre base MariaDB 11.8 (créée par `hosting_databases_setup-website`, qui injecte `DB_*` et `DATABASE_URL`).
- Fichiers persistants hors du dossier de l'app : `DATA_DIR=/home/u355159080/data/eksplodo-ia` (pièces jointes des tests).
- Contraintes reprises de l'app AO (voir son `docs/deploiement.md`) :
  - aucun `await` de premier niveau dans le serveur, car LiteSpeed charge le point d'entrée avec `require()` ;
  - écoute possible sur un socket Unix et un seul proxy de confiance ;
  - `.npmrc` contenant `include=dev` ;
  - plusieurs processus peuvent démarrer en même temps : migrations et amorçage sous verrou nommé MariaDB ;
  - le dossier de l'app est remplacé à chaque déploiement.

### 4.3 Stack

| Couche | Choix |
|---|---|
| Langage | TypeScript (serveur et client) |
| Runtime | Node.js 24 |
| Serveur HTTP | Fastify 5 (`@fastify/cookie`, `helmet`, `multipart`, `rate-limit`, `static`) |
| Validation | Zod (schémas partagés client / serveur) |
| Base de données | MariaDB via Drizzle ORM + `mysql2`, migrations drizzle-kit |
| Mots de passe | argon2id (`@node-rs/argon2`) |
| E-mail | Nodemailer via SMTP Hostinger |
| Client | React 19 + Vite + React Router + TanStack Query |
| Styles | **Tailwind CSS v4**, jetons du thème « Nuit » (§11.1) |
| Composants | composants maison sur primitives Radix (dialogues, menus, curseurs, onglets) |
| Graphes | Recharts, stylés selon le thème |
| 3D | **Three.js**, chargé à la demande (`import()` dynamique) |
| Polices | Archivo, Instrument Sans, Noto Sans Mono, auto-hébergées via `@fontsource` (aucun appel à Google Fonts) |
| IA | `@anthropic-ai/sdk` pour Anthropic ; `fetch` + lecteur SSE maison pour les API compatibles OpenAI et Gemini |
| Tests | Vitest ; MariaDB réelle (Docker, port 3307) ; `fastify.inject` pour l'API |

### 4.4 Organisation du code

```
server/
  src/
    app.ts  index.ts  startup.ts
    config/                # lecture et validation des variables d'environnement (zod)
    db/                    # client, migrations, schéma Drizzle
      schema/  core.ts  catalog.ts  tests.ts  runs.ts  sharing.ts  jobs.ts  errors.ts
    lib/                   # clock, paths, sse (lecteur de flux), concurrence
    modules/
      auth/                # sessions, invitations, amorçage, garde de rôle (repris de l'app AO)
      users/
      mail/
      providers/
        types.ts           # interface ProviderAdapter + types communs
        openai-compatible.ts  anthropic.ts  google.ts  fake.ts
        registry.ts        # fournisseur → adaptateur + clé déchiffrée au moment de l'appel
        errors.ts          # normalisation des erreurs fournisseur
      catalog/             # modèles, assistant /models, import OpenRouter, nouveautés
      tests/               # tests, pièces jointes, suites, essai rapide
      runs/                # création, estimation, moteur (run_execute), pause, plafond, ajout de modèle
      scoring/             # réponse attendue, IA-juge, notation manuelle, agrégation et classement
      sharing/             # liens publics, vue publique, verdicts
      dashboard/
      usage/               # consommation IA (ai_usage)
      jobs/                # file, worker, planificateur, /internal/tick (repris de l'app AO)
      errors/              # journal des erreurs (repris de l'app AO)
  drizzle/                 # migrations SQL
  test/
    fixtures/              # flux SSE enregistrés par fournisseur, réponses /models, PDF et image d'exemple
web/
  src/
    theme/                 # jetons Tailwind « Nuit », polices
    three/                 # scènes 3D (constellation, gerbe, flux en direct), repli 2D
    components/  pages/  api/
docs/
  brand/                   # logo Eksplodo et icône blanche
  superpowers/specs/  superpowers/plans/
maquettes/                 # maquettes HTML validées (design, écrans, animations)
  deploiement.md
```

Chaque module expose une interface claire. Les adaptateurs de fournisseurs sont remplaçables par le faux fournisseur dans les tests et en démonstration.

---

## 5. Modèle de données

Toutes les tables utilisent des identifiants UUID v4 en `CHAR(36)` (comme l'app AO) et des dates UTC en `DATETIME(3)`.

### 5.1 Comptes (repris de l'app AO, simplifiés : pas d'organisations)

- `users` : e-mail (unique), nom, `role` (`admin` | `user`), hachage du mot de passe, `status` (`active` | `disabled`), dates.
- `sessions` : identifiant haché, utilisateur, expiration glissante.
- `invitations` : e-mail, rôle, jeton haché, expiration (72 h), état d'envoi (`sent` | `failed` | `not_configured`), date d'utilisation.
- `audit_log` : actions sensibles (invitations, rôles, désactivations, liens de partage, suppressions).

### 5.2 Catalogue

- `providers` : nom, `type` (`openai_compatible` | `anthropic` | `google`), `base_url`, **`api_key_encrypted`** (clé API chiffrée en AES-256-GCM avec `APP_ENCRYPTION_KEY`, nullable), **`api_key_last4`** (4 derniers caractères, pour l'affichage masqué « …a4f2 »), `max_concurrency` (2 par défaut), `enabled`. **La clé en clair n'est jamais stockée, renvoyée ni journalisée.**
- `models` : fournisseur, `api_model_id`, nom affiché, couleur d'affichage, prix entrée et sortie par million de tokens (`DECIMAL(10,4)`), `price_source` (`manual` | `openrouter`), `supports_vision`, `supports_pdf`, fenêtre de contexte, `enabled`, dates.
- `openrouter_catalog` : identifiant OpenRouter, nom, prix, modalités d'entrée, `first_seen_at`, `dismissed_at`.

### 5.3 Tests

- `tests` : nom, catégorie, tags (JSON), prompt système, prompt utilisateur, température, max tokens, `scoring_method` (`judge` | `expected` | `manual`), `scoring_config` (JSON validé par Zod, §8), `archived_at`, dates.
- `test_attachments` : test, nom d'origine, type MIME (`image/png`, `image/jpeg`, `image/webp`, `application/pdf`), taille (10 Mo maximum), chemin dans `DATA_DIR/attachments/<test_id>/<uuid>`, empreinte SHA-256, nombre de pages pour un PDF.
- `suites` : nom, description. `suite_tests` : suite, test, position.

### 5.4 Séries

- `runs` : nom, suite d'origine (facultative), modèle juge (facultatif), répétitions (1 à 5), concurrence globale (4 par défaut), plafond de dépense (facultatif), `status` (`queued` | `running` | `paused` | `completed` | `interrupted`), `pause_reason` (`user` | `budget`), coût cumulé des modèles, coût cumulé du juge, **pondération par défaut** (JSON), auteur, dates de création, de lancement et de fin.
- `run_models` : série, modèle, date d'ajout.
- `run_tests` : série, test, position et **instantané** (JSON : prompts, paramètres, méthode et configuration de notation, références des pièces jointes). Modifier un test après coup ne change pas les séries existantes.
- `results` (unique sur série + test + modèle + répétition) :
  - `status` : `pending` | `running` | `done` | `error` | `timeout` | `unsupported` ;
  - `attempts` ;
  - texte de la réponse (`MEDIUMTEXT`, tronqué à 200 000 caractères), `finish_reason` ;
  - `input_tokens`, `output_tokens`, `reasoning_tokens`, `tokens_estimated` (booléen) ;
  - `ttft_ms`, `total_ms`, `tokens_per_s` ;
  - `cost_usd` (`DECIMAL(12,6)`), `cost_source` (`computed` | `provider`) ;
  - `error_code`, `error_message` (masqué) ;
  - `score_status` : `pending` | `done` | `awaiting_manual` | `judge_failed` ;
  - `auto_score` (note de la réponse attendue ou du juge), `judge_rationale`, `judge_cost_usd` ;
  - `override_score`, `override_by` ;
  - `completed_at`.
- `manual_scores` (unique sur résultat + utilisateur) : note entière de 0 à 100, commentaire, date.

### 5.5 Partage, consommation, interne

- `share_links` : série, jeton haché (le jeton en clair n'est montré qu'à la création ; l'Admin peut le régénérer), titre, introduction, verdicts (JSON : libellé, modèle, texte), `show_costs`, `show_responses`, `active`, nombre de vues, auteur, dates.
- `ai_usage` : origine (`run` | `judge` | `quick_try`), série éventuelle, modèle, tokens, coût, date. C'est la source de la « dépense du mois ».
- `settings` : réglages clé/valeur (URL du bouton « Audit gratuit », juge par défaut, pondération par défaut).
- `jobs`, `error_events` : repris de l'app AO.

---

## 6. Fournisseurs et modèles

### 6.1 Interface commune

```ts
interface ProviderAdapter {
  generate(req: GenerateRequest, signal: AbortSignal): AsyncIterable<GenerateEvent>;
  listModels(): Promise<RemoteModel[]>;
}
type GenerateRequest = {
  model: string; system?: string; prompt: string;
  attachments: { mime: string; base64: string; filename: string }[];
  temperature?: number; maxTokens: number;
};
type GenerateEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; costUsd?: number }
  | { type: 'finish'; reason: 'stop' | 'length' | 'refusal' | 'content_filter' | 'other' };
```

Les erreurs sont levées sous forme de `ProviderError` normalisée (§12.1).

### 6.2 Adaptateurs

| Type | Appel | Pièces jointes | Usage | Liste des modèles |
|---|---|---|---|---|
| `openai_compatible` | `POST {base}/chat/completions`, `stream: true`, `stream_options.include_usage` | images en `image_url` (URI `data:`) ; PDF en partie `file` (`file_data`) seulement si le modèle déclare `supports_pdf` | dernier événement `usage` ; pour OpenRouter, demande du coût réel (`usage.include`) | `GET {base}/models` |
| `anthropic` | SDK officiel, `messages.stream` | blocs `image` et `document` en base64 | événements `message_start` et `message_delta` | `GET /v1/models` |
| `google` | `POST …/models/{id}:streamGenerateContent?alt=sse` | parties `inline_data` | `usageMetadata` (dont `thoughtsTokenCount`) | `GET …/models` |
| `fake` | aucun appel réseau | toutes acceptées | tokens simulés | liste fixe |

- **Faux fournisseur** (`AIC_FAKE_LLM=1`, ignoré en production) : il simule une latence avant le premier token, un débit, des erreurs 429 et 5xx, des timeouts et des refus, à partir d'une graine. Il sert aux tests, au développement et aux démonstrations hors ligne.
- **Clé** : l'Admin la saisit à la création du fournisseur ou par « Remplacer la clé » ; `registry.ts` la déchiffre au moment de l'appel. Sans clé, le fournisseur est « clé manquante » ; si `APP_ENCRYPTION_KEY` a changé, le déchiffrement échoue et le fournisseur est « clé illisible, ressaisissez-la » (comme dans l'app AO). Dans les deux cas, ses modèles ne peuvent être choisis ni dans une série ni dans un essai rapide. « Tester la connexion » interroge `listModels()` (moins de 15 s, donc dans la requête HTTP) et affiche le résultat normalisé.
- Fournisseurs préconfigurés à la première installation, **sans clé** (l'Admin les complète) : OpenRouter (`https://openrouter.ai/api/v1`), OpenAI (`https://api.openai.com/v1`), Anthropic (`https://api.anthropic.com`), Google (`https://generativelanguage.googleapis.com/v1beta`), Mistral (`https://api.mistral.ai/v1`), DeepSeek (`https://api.deepseek.com/v1`), Requesty (`https://router.requesty.ai/v1`) et Eden AI (`https://api.edenai.run/v3`, API compatible OpenAI, modèles nommés `fournisseur/modèle`). Si un agrégateur n'expose pas `/models`, l'Admin ajoute ses modèles à la main.

### 6.3 Ajout de modèles et nouveautés

- L'**assistant** interroge `listModels()` du fournisseur et propose une liste filtrable. Pour OpenRouter, les prix (convertis en $ par million) et les capacités (modalités `image` et `file`) sont préremplis. Pour les autres fournisseurs, l'Admin saisit les prix et coche les capacités.
- Prix Anthropic connus préremplis : Claude Opus 5.5 4 $ / 20 $, Claude Sonnet 5.5 2 $ / 10 $, Claude Haiku 5.5 0,10 $ / 0,50 $ par million de tokens (vérifiés le 2026-10-17).
- **Nouveautés** : la tâche planifiée `catalog_refresh` (tous les jours à 6 h, heure de Paris) lit `https://openrouter.ai/api/v1/models`, qui est public et ne demande pas de clé. Les modèles inconnus sont ajoutés à `openrouter_catalog` avec `first_seen_at`. La **première synchronisation marque tout comme déjà vu**, pour ne pas inonder le tableau de bord. Ensuite, le tableau de bord liste les modèles vus depuis moins de 30 jours, absents du catalogue local et non écartés, avec les boutons « Ajouter » (préremplit l'assistant sur le fournisseur OpenRouter) et « Ignorer ».

---

## 7. Tests et suites

- Éditeur (maquette « Éditeur de test ») : nom, catégorie, tags, prompts, pièces jointes par glisser-déposer, température (défaut 0,2), max tokens (défaut 1 000, maximum 32 000), méthode et configuration de notation.
- Les pièces jointes sont stockées dans `DATA_DIR`, ne sont jamais servies directement (téléchargement par l'API pour l'Admin) et sont envoyées aux modèles en base64.
- **Essai rapide** : l'Admin choisit un modèle disponible. Le serveur crée une tâche `quick_try` dans la file ; l'interface suit son avancement par interrogation (toutes les 2 s) et affiche la réponse, les métriques et, si la méthode le permet, la note automatique (réponse attendue ou juge). Timeout de l'appel : 120 s, comme dans une série. (Le proxy Hostinger coupe toute requête HTTP au-delà de 60 s, d'où le passage par la file.) Le coût est enregistré dans `ai_usage` avec l'origine `quick_try` ; la réponse est conservée avec la tâche le temps de l'affichage, sans créer de résultat de série.
- Un test utilisé dans une série est **archivé** au lieu d'être supprimé. Les séries gardent leur instantané (§5.4).
- Suites : liste ordonnée de tests, glisser-déposer pour l'ordre, duplication.

---

## 8. Séries, exécution et notation

### 8.1 Lancement (assistant en 4 étapes)

1. **Suite** (ou tests choisis à la carte).
2. **Modèles** : seuls les modèles dont le fournisseur a une clé enregistrée et lisible sont sélectionnables, avec leurs capacités affichées.
3. **Paramètres** : répétitions (1 à 5, défaut 1), modèle juge (défaut : réglage « juge par défaut »), concurrence, plafond de dépense facultatif, pondération par défaut.
4. **Récapitulatif et estimation** :
   - nombre d'appels et nombre de combinaisons « non supportées » (pièce jointe que le modèle ne gère pas) ;
   - **coût maximal estimé** : tokens d'entrée estimés (caractères ÷ 4, plus environ 1 500 tokens par image et 800 par page de PDF) × prix d'entrée, plus `max_tokens` × prix de sortie, plus la même estimation pour le juge ;
   - durée estimée : médiane historique du temps total de chaque modèle (10 s par défaut) × nombre d'appels ÷ concurrence.

À la confirmation, on crée `run_tests` (instantanés), `run_models` et tous les `results`. Les combinaisons non supportées passent directement en `unsupported`, sans appel. La tâche `run_execute` est enfilée.

### 8.2 Moteur (`run_execute`)

- **Ordre** : les résultats en attente sont triés par répétition, puis par position du test, puis **en alternant les modèles**. Un fournisseur lent ne bloque donc pas les autres, et les mesures de chaque modèle sont étalées dans le temps.
- **Concurrence** : au plus `runs.concurrency` appels simultanés (4 par défaut) et au plus `providers.max_concurrency` par fournisseur (2 par défaut). Les appels au juge partagent ce budget.
- **Mesures**, pour chaque appel :
  - `t0` = envoi de la requête ;
  - `ttft_ms` = premier événement `text` non vide (le raisonnement n'est pas compté) ;
  - `total_ms` = événement `finish` ou fin du flux ;
  - `tokens_per_s` = `output_tokens` hors raisonnement ÷ (`total_ms` − `ttft_ms`), seulement si la phase de génération dure plus de 100 ms ;
  - si le fournisseur ne renvoie pas l'usage, les tokens sont estimés (caractères ÷ 4) et `tokens_estimated` vaut vrai.
- **Coût** : coût réel renvoyé par le fournisseur s'il existe (OpenRouter), sinon (entrée × prix d'entrée + (sortie + raisonnement) × prix de sortie) ÷ 1 000 000.
- **Timeout** : 120 s par appel. **Nouvelles tentatives** : 2 au plus, pour 429, 5xx, timeout et coupure réseau, avec un délai croissant (2 s puis 8 s, ou la valeur de `Retry-After`). Les autres erreurs sont définitives.
- **Découpage dans le temps** : la tâche travaille au plus 10 minutes, laisse se terminer les appels en cours puis enfile sa suite. Cela respecte la limite de 14 minutes par tâche de la file de l'app AO.
- **Redémarrage** : au démarrage de l'app, les résultats `running` repassent en `pending` sans consommer de tentative, et la série reprend (mécanisme de reprise de l'app AO).
- **Pause** : `status = paused`. La tâche vérifie l'état avant chaque nouvel appel, termine les appels en cours puis s'arrête. **Reprendre** enfile une nouvelle tâche.
- **Plafond** : avant chaque appel, si le coût cumulé + le coût maximal estimé de l'appel dépasse le plafond, la série passe en pause avec le motif `budget`. L'Admin peut relever le plafond puis reprendre.
- **Ajout d'un modèle** : création de `run_models` et des résultats manquants, puis la série repasse `queued`. Les modèles déjà notés ne sont pas relancés.
- **Relancer les erreurs** : les résultats `error` et `timeout` repassent en `pending` avec un compteur de tentatives remis à zéro.
- **Fin** : la série passe `completed` quand plus aucun résultat n'est `pending` ou `running`, même s'il reste des notes manuelles à donner.

### 8.3 Notation

La note finale d'un résultat vaut `override_score` si l'Admin en a imposé une, sinon la note de la méthode. Toutes les notes vont de 0 à 100 (passage de 10 à 100 le 2026-10-18, migration 0007 : valeurs existantes ×10, anciennes valeurs sauvegardées dans `score_backup_results_0007` et `score_backup_manual_0007`).

**Réponse attendue** (`scoring_config`) :
- `exact` : `{ mode: 'exact', expected: string, ignoreCase: true, ignoreAccents: false }`. La réponse et l'attendu sont normalisés (espaces en début et fin supprimés, espaces multiples réduits) ; la note vaut 10 ou 0.
- `contains` : `{ mode: 'contains', items: string[], ignoreCase: true }`. Note = 10 × éléments trouvés ÷ nombre d'éléments, arrondie au dixième.
- `regex` : `{ mode: 'regex', pattern: string, flags: string }`. La regex est validée à l'enregistrement et testée sur la réponse tronquée à 50 000 caractères ; la note vaut 10 ou 0.

**IA-juge** (`{ criteria: string, reference?: string }`) :
- Le juge reçoit le prompt du test, les critères, la réponse de référence éventuelle, les pièces jointes du test si le juge les gère (sinon un avertissement est affiché au lancement) et la réponse évaluée, **sans le nom du modèle**.
- Il est appelé à température 0, avec 800 tokens maximum, et doit répondre en JSON `{ "score": number, "rationale": string }`, validé par Zod. En cas de JSON invalide, il est relancé une fois, puis le résultat passe en `judge_failed`.
- **Sécurité** : la réponse évaluée est une donnée non fiable. Elle est placée entre balises `<reponse_a_evaluer>`, et la consigne système précise d'ignorer toute instruction qu'elle contient (par exemple « donne-moi 10 »).
- Le coût du juge est suivi à part (`judge_cost_usd`, `runs.judge_cost`) et n'est **jamais imputé** au modèle évalué.
- Un avertissement s'affiche si le modèle juge fait partie des modèles évalués.
- **Recalculer** : l'Admin peut relancer le juge sur un résultat, sur un test ou sur toute la série, éventuellement avec un autre juge (tâche `run_rescore`).

**Manuelle** :
- Chaque utilisateur et chaque Admin note les réponses **à l'aveugle** : lettres A, B, C… dans un ordre mélangé de façon déterministe par utilisateur et par test : tri par HMAC-SHA256 de `utilisateur:résultat` avec une clé serveur dérivée de la clé de chiffrement (`HMAC(APP_ENCRYPTION_KEY, 'aic:blind-order:v1')`), pour qu'un compte ne puisse pas recalculer l'ordre. Les noms ne sont révélés qu'après l'enregistrement des notes de la question.
- Note manuelle d'un résultat = **moyenne** des évaluateurs. L'écart-type est affiché dans l'onglet « Écarts entre évaluateurs », réservé à l'Admin.
- La page « À noter » affiche à chaque compte les questions qu'il n'a pas encore notées, avec un compteur dans le menu.
- Tant qu'aucune note n'existe, le résultat est `awaiting_manual` et n'entre pas dans la moyenne de qualité.

### 8.4 Agrégation et classement (par série)

Pour chaque modèle d'une série :

| Critère | Mesure | Note sur 100 |
|---|---|---|
| **Qualité** | moyenne, sur les tests notés, de la moyenne des répétitions | la valeur elle-même |
| **Vitesse** | médiane de `ttft_ms` et médiane de `tokens_per_s` sur les appels réussis | moyenne de deux notes logarithmiques : TTFT (plus bas = mieux) et débit (plus haut = mieux) |
| **Coût** | coût moyen par réponse réussie | note logarithmique (plus bas = mieux) |
| **Fiabilité** | réussis ÷ (réussis + erreurs + timeouts) ; les `unsupported` sont exclus | ratio × 100 |

- **Note logarithmique** de 20 à 100, entre la plus petite valeur (`lo`) et la plus grande (`hi`) de la série : `20 + 80 × ln(x / lo) / ln(hi / lo)` quand une valeur haute est meilleure, et `20 + 80 × (1 − ln(x / lo) / ln(hi / lo))` sinon. Si tous les modèles sont égaux, ou s'il n'y en a qu'un, la note vaut 100. Un écart du simple au double pèse ainsi autant à 0,10 $ qu'à 1 $. Ce choix a été fait après la maquette, où l'échelle au prorata écrasait les modèles chers.
- **Score global** = moyenne pondérée des quatre notes. Pondération par défaut : qualité 50 %, vitesse 20 %, coût 20 %, fiabilité 10 %. Les curseurs de la page de résultats recalculent instantanément côté client ; l'Admin peut enregistrer la pondération comme défaut de la série, ce qui l'applique aussi à la page de partage.
- **Par catégorie** : qualité moyenne par catégorie de test.
- Un modèle dont aucun test n'est noté affiche « — » en qualité et n'apparaît pas sur le podium.
- Les notes de vitesse et de coût sont **relatives à la série**. Les comparaisons se font donc au sein d'une série, et c'est pour cela qu'on la complète plutôt que d'en créer une nouvelle.
- **Évolution dans le temps** (tableau de bord) : la **qualité**, qui est une note absolue, est comparée d'une série à l'autre pour une même suite. Le graphe précise le juge utilisé pour chaque série.

---

## 9. Résultats, tableau de bord et partage

### 9.1 Page de résultats (maquette `resultats-nuit.html`)

- En-tête : suite, modèles × répétitions, juge, coût total (modèles et juge), statut ; boutons « Ajouter un modèle », « Partager », « Exporter » (CSV).
- **Constellation 3D** : un astre par modèle (taille = qualité, vitesse d'orbite = débit, couleur = couleur du modèle), particules entre le centre et les astres, et caméra qui plonge au survol.
- **Podium** des trois premiers selon le score global, et **curseurs de pondération**.
- Graphe **qualité / vitesse** (nuage de points avec une « zone idéale ») et **qualité par catégorie**.
- **Classement détaillé** : rang, modèle, score global, qualité, premier token médian, débit médian, coût moyen, fiabilité.
- **Réponses côte à côte** pour un test choisi, avec la justification du juge et les métriques ; onglets « À l'aveugle » et « Écarts entre évaluateurs ».
- Pendant l'exécution, la même page affiche la **vue en direct** (maquette « Suivi en direct ») : progression, dépense, fil d'activité, matrice test × modèle et scène 3D des flux d'appels.

### 9.2 Tableau de bord

Chiffres clés (séries, modèles suivis, dépense du mois avec la part du juge, réponses à noter), évolution de la qualité pour une suite choisie, nouveautés OpenRouter, dernières séries. Un utilisateur voit la même page, sans la dépense ni les nouveautés.

### 9.3 Fiche modèle

Fournisseur, identifiant API, prix, capacités, état de la clé (enregistrée, manquante ou illisible ; jamais sa valeur), qualité moyenne, premier token et débit médians avec leur rang, fiabilité, radar par catégorie comparé à la moyenne des modèles, et historique des séries (rang, qualité, score global).

### 9.4 Liens de partage

- Création depuis une série : titre, introduction, verdicts (« Meilleur compromis », « Meilleure qualité », « Le moins cher »… avec texte libre), options `show_costs` et `show_responses`.
- **URL de la page** : `https://ia.eksplodo.fr/p/<jeton de 32 caractères>` ; ses données viennent de l'API publique `/share/:token`. Seule l'empreinte du jeton est stockée.
- La page publique n'a ni menu ni lien vers l'app. Elle affiche le logo, une gerbe 3D, le titre, les verdicts, le podium, les graphes, le classement (coûts masqués si demandé) et, en option, les réponses. Un bouton « Audit gratuit » pointe vers l'URL réglée (défaut `https://eksplodo.fr`).
- L'API publique `/share/:token` ne renvoie que les champs autorisés : aucun identifiant interne d'utilisateur, aucune configuration de fournisseur, aucune note individuelle d'évaluateur.
- **Version imprimable** : une feuille de style d'impression remplace la 3D par un podium statique, pour enregistrer un PDF depuis le navigateur.
- Les liens se désactivent ou se régénèrent à tout moment, et un compteur de vues est affiché.

---

## 10. API (principales routes)

Toutes les routes `/api/*` exigent une session, sauf l'authentification. Les routes marquées **A** exigent le rôle Admin.

- Authentification : `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/auth/invitations/:token/accept`, `POST /api/auth/password`.
- Utilisateurs **A** : `GET/POST /api/users/invitations`, `PATCH /api/users/:id` (rôle, statut).
- Catalogue : `GET /api/providers` (avec l'état de la clé, jamais sa valeur), **A** `POST/PATCH /api/providers` (champ `apiKey` en écriture seule), **A** `POST /api/providers/:id/test` (« Tester la connexion »), `GET /api/providers/:id/remote-models` **A**, `GET /api/models`, `GET /api/models/:id`, **A** `POST/PATCH /api/models`, `GET /api/catalog/new` **A**, `POST /api/catalog/:id/dismiss` **A**.
- Tests **A** : CRUD `/api/tests`, `POST /api/tests/:id/attachments`, `POST /api/tests/try` (crée la tâche d'essai rapide, renvoie son identifiant) et `GET /api/tests/try/:jobId` (état et résultat), CRUD `/api/suites`.
- Séries : `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/progress`, `GET /api/runs/:id/results`, `GET /api/runs/:id/export.csv` ; **A** `POST /api/runs/estimate`, `POST /api/runs`, `POST /api/runs/:id/{pause,resume,retry-errors,rescore}`, `POST /api/runs/:id/models`, `PATCH /api/runs/:id` (plafond, pondération).
- Notation : `GET /api/scoring/todo`, `GET /api/scoring/questions/:runTestId` (version anonymisée), `PUT /api/scoring/results/:id/manual` ; **A** `PUT /api/scoring/results/:id/override`.
- Partage : **A** CRUD `/api/share-links` ; public `GET /share/:token`.
- Tableau de bord : `GET /api/dashboard`.
- Interne : `POST /internal/tick` (en-tête `x-cron-secret`), `GET /health`.

Les erreurs ont la forme `{ error: { code, message, reference? } }`, avec des messages en français.

---

## 11. Interface

### 11.1 Thème « Nuit » (inspiré d'eksplodo.fr)

- **Logo** : icône fusée-écran d'Eksplodo en blanc avec halo orange (`docs/brand/eksplodo-icon-white.png`), suivie de « Eksplodo » et « COMPARATEUR IA » en Noto Sans Mono.
- **Couleurs** :
  - fonds : `#00131D`, `#011F2E`, `#032A3D`, avec un dégradé radial vers `#06405D` ;
  - lignes : `rgba(120,190,230,.14)` et `.28` ;
  - texte : `#D8ECF5`, texte secondaire `#7FA3B5` ;
  - accents : orange `#F0631F` et pêche `#FFB48A` (actions principales, vainqueur), bleus `#3FA2E0`, `#0C659D` et `#7CC4EF` ;
  - succès `#4FD1A5`, erreur `#FF7A7A`.
- **Fond** en grille de points comme sur eksplodo.fr, cartes translucides à coins arrondis (18 px), boutons et pastilles arrondis (100 px).
- **Typographies** : Archivo 700 à 800 pour les titres, Instrument Sans pour le texte, Noto Sans Mono pour les étiquettes et les chiffres.
- Interface en français, consultation possible sur mobile (menu en tiroir, 3D allégée).
- Le skill `frontend-design` sera utilisé pendant la réalisation des écrans, en partant des maquettes validées.

### 11.2 Écrans

| Écran | Rôles | Maquette |
|---|---|---|
| Connexion, acceptation d'invitation, changement de mot de passe | tous | « Connexion » (gerbe 3D) |
| Tableau de bord | tous (vue réduite pour Utilisateur) | « Tableau de bord » |
| Séries (liste) puis page d'une série (résultats ou vue en direct) | tous | `resultats-nuit.html`, « Suivi en direct » |
| Lancer une série | Admin | « Lancer une série » |
| Modèles (liste) et fiche modèle | tous | « Fiche modèle » |
| À noter et notation à l'aveugle | tous | « Notation à l'aveugle » |
| Fournisseurs (état des clés, `/models`) | Admin | — |
| Tests et suites, éditeur de test | Admin | « Éditeur de test » |
| Utilisateurs et invitations | Admin | — |
| Liens de partage (liste, édition des verdicts) | Admin | — |
| Page publique de partage | public | « Partage public » |

### 11.3 Three.js

- Trois scènes : **constellation** (résultats), **flux en direct** (série en cours) et **gerbe Eksplodo** (connexion et page publique). Elles reprennent les maquettes.
- Three.js est chargé par `import()` dynamique seulement sur ces écrans.
- Animation suspendue quand l'onglet est caché (`visibilitychange`) ou que la scène est hors de l'écran (`IntersectionObserver`).
- Respect de `prefers-reduced-motion` et interrupteur « Animations » dans le menu du compte (préférence mémorisée dans le navigateur).
- Si WebGL est indisponible, un rendu 2D en SVG remplace chaque scène.
- Pixel ratio limité à 2 et nombre de particules réduit sur mobile.

---

## 12. Erreurs, sécurité, observabilité

### 12.1 Erreurs des fournisseurs

| Cas | Code normalisé | Nouvelle tentative |
|---|---|---|
| 401 / 403 | `auth_invalid` (« clé invalide ou sans droit sur ce modèle ») | non |
| 404 modèle | `model_not_found` | non |
| 429 | `rate_limited` | oui |
| 5xx, coupure réseau | `provider_unavailable` | oui |
| plus de 120 s | `timeout` | oui |
| contexte trop long | `context_too_long` | non |
| refus ou filtrage | réponse conservée, `finish_reason` = `refusal` ou `content_filter` | non |

Les messages d'erreur sont masqués avant tout enregistrement : clés, jetons `Bearer` et paramètres d'URL `key=`.

### 12.2 Sécurité

- Mots de passe argon2id (12 caractères minimum). Sessions en cookie `HttpOnly`, `Secure` et `SameSite=Lax`, avec expiration glissante de 7 jours, stockées hachées.
- Protection CSRF sur toutes les requêtes modifiantes, limitation des tentatives de connexion (par IP et par compte), en-têtes de sécurité (helmet : CSP, HSTS…).
- **Contrôle du rôle sur chaque route côté serveur.** Les routes de notation vérifient que la question demandée est anonymisée pour un Utilisateur.
- Clés API des fournisseurs saisies par l'Admin, stockées chiffrées (AES-256-GCM, clé maîtresse `APP_ENCRYPTION_KEY` de 32 octets en base64, obligatoire et validée au démarrage) ; jamais renvoyées par l'API (seuls les 4 derniers caractères le sont, à l'Admin), jamais journalisées ni écrites dans le journal d'audit.
- Pièces jointes hors du dossier public, noms générés, types MIME vérifiés par signature de fichier.
- Les réponses des modèles sont des données non fiables : elles sont échappées à l'affichage (aucun HTML exécuté ; rendu Markdown assaini) et délimitées pour le juge (§8.3).
- Les prompts et les réponses ne sont jamais écrits dans les journaux techniques.
- `/internal/tick` est protégé par `CRON_SECRET`.

### 12.3 Observabilité

- **Journal des erreurs** repris de l'app AO : références `E-XXXXX`, regroupement, masquage, page Admin « Journal des erreurs » et récapitulatif par e-mail facultatif.
- **`GET /health`** : `db`, `worker`, séries en cours, et le nombre de fournisseurs configurés (actifs et munis d'une clé lisible).
- Les journaux sont structurés en JSON.

---

## 13. Tests (TDD)

- **Unitaires** :
  - lecteur SSE et adaptateurs sur des **flux enregistrés** pour chaque type de fournisseur : texte, raisonnement, usage, flux coupé, erreur en cours de flux ;
  - normalisation des erreurs ;
  - notation par réponse attendue (exact, contains, regex, accents, casse) ;
  - analyse de la réponse du juge (JSON valide, invalide, note hors bornes) ;
  - notes logarithmiques, pondération et moyennes des évaluateurs ;
  - estimation des coûts ;
  - mélange déterministe pour la notation à l'aveugle.
- **Intégration** (MariaDB Docker, port 3307), avec le faux fournisseur :
  - moteur de séries : alternance, concurrence globale et par fournisseur, nouvelles tentatives, timeout, reprise après redémarrage, découpage à 10 minutes, pause et reprise, plafond, ajout d'un modèle, relance des erreurs, recalcul des notes ;
  - instantanés : modifier un test ne change pas une série ;
  - nouveautés OpenRouter (première synchronisation silencieuse).
- **API** (`fastify.inject`) : un Utilisateur n'atteint aucune route **A** ; un lien de partage ne voit que sa série et les champs autorisés ; un lien révoqué renvoie 404 ; la notation anonymisée ne révèle pas le modèle.
- **Contraintes Hostinger** : test d'absence d'`await` de premier niveau dans le graphe du serveur (repris de l'app AO).
- **Interface** : vérification des parcours principaux dans le navigateur (connexion, lancement d'une série avec le faux fournisseur, suivi en direct, résultats, notation à l'aveugle, page de partage).
- Aucun appel payant dans les tests automatiques. Quelques tests « contrat » contre les vraies API pourront être lancés manuellement.

---

## 14. Déploiement

- Dépôt Git local, puis archive `git archive --format=zip -o app.zip HEAD`, envoyée dans `public_html` du site `ia.eksplodo.fr` et suivie d'un build (Node 24, type `fastify`, script `build`, entrée `dist/server/index.js`, dossier de sortie `.`).
- Variables d'environnement (hPanel) :
  - `NODE_ENV=production` ;
  - `APP_BASE_URL=https://ia.eksplodo.fr` ;
  - `DATA_DIR=/home/u355159080/data/eksplodo-ia` ;
  - `CRON_SECRET` ;
  - `DB_*` et `DATABASE_URL`, créées par Hostinger ;
  - `SMTP_*` (expéditeur proposé : `ia@eksplodo.fr`) ;
  - `BOOTSTRAP_ADMIN_EMAIL` et `BOOTSTRAP_ADMIN_PASSWORD`, au premier démarrage seulement ;
  - `APP_ENCRYPTION_KEY` (32 octets en base64), à conserver aussi dans un gestionnaire de mots de passe : sans elle, les clés des fournisseurs enregistrées deviennent illisibles.
- **Ajouter une clé de fournisseur** : écran « Fournisseurs » de l'app (« Remplacer la clé » puis « Tester la connexion ») ; aucune variable d'environnement ni redémarrage. L'API Hostinger remplace **toutes** les variables d'un coup : on ne l'utilise jamais.
- Cron hPanel toutes les 15 minutes : `curl -s -X POST -H "x-cron-secret: <CRON_SECRET>" https://ia.eksplodo.fr/internal/tick`.
- Vérification : `/health` renvoie `"status":"ok"`, `"db":"ok"` et `"worker":"running"`, puis on teste la page de connexion.
- Tout est documenté dans `docs/deploiement.md`. **Aucune action sur Hostinger** (création du site ou de la base, envoi, build) n'est faite sans l'accord explicite de l'utilisateur au moment voulu.

---

## 15. Découpage en plans

| Plan | Contenu | Livrable utilisable |
|---|---|---|
| **1. Fondations** | Squelette (copie raisonnée de l'app AO), config, base et migrations, auth (amorçage, sessions, invitations), utilisateurs, file de tâches et `/internal/tick`, journal des erreurs, `/health`, thème « Nuit » Tailwind et coque de l'interface (menu, connexion avec la gerbe 3D), premier déploiement sur `ia.eksplodo.fr` | App en ligne avec connexion et gestion des comptes |
| **2. Fournisseurs et modèles** | Trois adaptateurs + faux fournisseur, registre et état des clés, catalogue, assistant `/models`, import OpenRouter, nouveautés, fiche modèle | Catalogue opérationnel, clés vérifiées |
| **3. Tests et séries** | Éditeur de test, pièces jointes, essai rapide, suites, estimation, moteur `run_execute`, pause, plafond, ajout de modèle, relance, vue en direct | Séries complètes avec métriques |
| **4. Notation et résultats** | Réponse attendue, IA-juge, recalcul, notation à l'aveugle, agrégation et classement, page de résultats avec graphes et constellation 3D, export CSV | Classements et démonstration interne |
| **5. Partage et tableau de bord** | Liens publics, verdicts, version imprimable, tableau de bord et évolution de la qualité | Démonstration client et prospection |

Chaque plan est rédigé, relu puis exécuté l'un après l'autre.

---

## 16. Risques et vérifications préalables

| # | Risque / inconnue | Vérification |
|---|---|---|
| 1 | LiteSpeed coupe les requêtes longues de l'essai rapide (jusqu'à 90 s) | **Vérifié le 2026-10-17 : coupure à 60 s** (307 du proxy Hostinger). Décision validée par Laurent : l'essai rapide (§7) passe par une tâche de la file et un suivi par interrogation ; aucune requête HTTP ne doit dépasser 60 s |
| 2 | Nombre de connexions sortantes simultanées et mémoire sur l'hébergement mutualisé | Plan 3 livré : à mesurer au premier déploiement — série de démonstration à 4 appels simultanés avec mémoire résidente (RSS) ; pièces jointes lues en base64 à chaque appel |
| 3 | Différences de format entre fournisseurs : usage absent du flux, tokens de raisonnement, PDF acceptés ou non | Plan 2 : fixtures construites d'après la documentation publique de chaque fournisseur ; vérification sur un appel réel au premier essai rapide (plan 3), avec l'accord de Laurent pour la dépense |
| 4 | Limites de taille des pièces jointes en base64 selon les fournisseurs | Plan 3 : vérification à l'ajout de la pièce jointe (10 Mo par fichier) et message clair en cas de refus |
| 5 | Coût réel OpenRouter (`usage.cost`) disponible en streaming | Plan 2 : lecture de `usage.cost` dans le flux (fixture) ; vérification sur un appel réel au plan 3, sinon calcul avec les prix importés |
| 6 | Biais du juge (préférence pour les réponses longues ou pour son propre fournisseur) | Avertissement à l'écran, choix du juge par série, recalcul possible, notation manuelle en complément |
| 7 | Performance de la 3D sur des portables modestes en démonstration | Plan 1 : scène de connexion livrée (fragment Three.js chargé à la demande, pause hors écran, repli 2D, 60 rayons sur mobile). Temps d'image restant à mesurer par Laurent sur le portable de démonstration |

---

## 17. Décisions restant à prendre (non bloquantes)

- Adresse d'expédition des invitations (proposition : `ia@eksplodo.fr`).
- Modèle juge par défaut (proposition : Claude Sonnet 5.5, rapide et moins cher qu'Opus, à éviter quand on évalue des modèles Anthropic).
- Concurrence par défaut si Hostinger se montre limité (proposition : 4 au total, 2 par fournisseur).
