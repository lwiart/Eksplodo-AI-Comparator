# Eksplodo · Comparateur IA

Application web qui permet de comparer les réponses de plusieurs modèles d'IA. Ce dépôt contient les fondations (plan 1) : serveur Fastify 5 + Drizzle + MariaDB, interface React 19 + Vite + Tailwind v4, comptes (invitation, connexion, rôles `admin` / `user`), file de tâches, journal des erreurs et déploiement Hostinger.

## Prérequis

- Node.js 24 (`.nvmrc`)
- Une base MariaDB 11.8 : le serveur de test écoute sur `127.0.0.1:3307` (`root` / `test`). Le plus simple : `docker compose up -d db` ; tout MariaDB local équivalent convient (collation `utf8mb4_unicode_ci`).

## Démarrage

```
cp .env.example .env     # puis ajuster les valeurs (voir docs/deploiement.md pour leur signification)
docker compose up -d db
npm install
npm run dev              # API sur :3000 + Vite sur :5173 (proxy /api, /internal, /health vers l'API)
```

Dans `.env`, renseigner `APP_ENCRYPTION_KEY` (clé maîtresse qui chiffre les clés des fournisseurs ; obligatoire, sans elle l'application ne démarre pas) :

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Ajouter aussi `AIC_FAKE_LLM=1` pour travailler sans appel réel : un faux fournisseur répond à la place des fournisseurs (ignoré en production).

Les clés API des fournisseurs ne se mettent pas dans `.env` : elles se saisissent dans l'écran **Fournisseurs** (Admin) et sont enregistrées chiffrées en base.

Le développement lit `.env`. Pour l'aperçu dans Claude Code, `.claude/launch.json` définit deux configurations séparées : `comparateur-api` (API, port 3000) et `comparateur-web` (Vite, port 5173).

## Tests, suites et séries (plan 3)

- **Test** : un prompt (avec pièces jointes éventuelles : images, PDF, 10 Mo par fichier, dix au plus) que l'on veut soumettre à plusieurs modèles.
- **Suite** : un regroupement de tests, pour les lancer ensemble.
- **Essai rapide** : un test envoyé à quelques modèles, sans créer de série. Il passe par la voie rapide de la file (un second worker dédié aux tâches `quick_try`), donc il n'attend pas les longues tâches d'une série.
- **Série** : le lancement de tests (ou d'une suite) × modèles × répétitions. Un assistant la prépare avec une estimation de coût ; la vue en direct suit les appels, permet pause et reprise, l'ajout d'un modèle et la relance des erreurs. Une série reprend seule après un redémarrage du serveur.

### Essai en local sans appel réel

Avec `AIC_FAKE_LLM=1` dans `.env`, un faux fournisseur répond à la place des vrais (ignoré en production). Des directives écrites dans un prompt déclenchent un comportement précis :

| Directive | Effet |
|---|---|
| `[[fake:429]]` | Erreur 429 (limite de débit) |
| `[[fake:500]]` | Erreur 500 (serveur) |
| `[[fake:timeout]]` | L'appel ne répond jamais (jusqu'à l'expiration) |
| `[[fake:refusal]]` | Réponse de refus |
| `[[fake:cut]]` | Flux coupé en cours de réponse, sans fin ni usage |
| `[[fake:reasoning]]` | Ajoute des jetons de raisonnement |
| `[[fake:length]]` | Réponse coupée à `max_tokens` (fin de génération `length`) |

Parcours rapide : `npm run dev`, créer un test dont le prompt contient par exemple `[[fake:500]]`, le lancer en essai rapide ou en série, puis utiliser « Relancer les erreurs » pour constater la reprise.

## Notation et résultats (plan 4)

Chaque test se note selon l'une de ses trois méthodes. Toutes les notes vont de 0 à 10 ; la note finale d'un résultat est la note imposée par un Admin s'il y en a une, sinon la note de sa méthode.

- **Réponse attendue** (`server/src/modules/scoring/expected.ts`) : `exact` (espaces de début et de fin retirés, espaces multiples réduits, options de casse et d'accents) vaut 10 ou 0 ; `contains` vaut 10 × éléments trouvés ÷ total, arrondi au dixième ; `regex` vaut 10 ou 0, testée sur les 50 000 premiers caractères de la réponse, en moins d'une seconde (au-delà : 0, « Expression trop lente »).
- **Juge** (`judge-prompt.ts`, `judge-parse.ts`, `judge-items.ts`) : le modèle juge reçoit le prompt du test, les critères, la référence éventuelle, les pièces jointes qu'il sait lire et la réponse évaluée entre balises `<reponse_a_evaluer>`, sans le nom du modèle évalué (température 0, 800 tokens au plus). Il répond en JSON `{ "score", "rationale" }`, validé strictement ; une réponse illisible déclenche un seul nouvel appel, puis la note échoue. Ses appels sont des éléments de la série : ils partagent la concurrence, le plafond par fournisseur et le plafond de dépense, et sont comptés avec l'origine `judge`. Leur coût est suivi à part et n'est jamais imputé au modèle évalué. La série ne passe `completed` qu'une fois les notes du juge rendues.
- **Manuelle à l'aveugle** (`manual.service.ts`) : chaque compte (Utilisateur ou Admin) note les réponses d'une question, désignées par des lettres A, B, C… sans nom de modèle ni métrique, avec une note entière de 0 à 10 et un commentaire facultatif. L'ordre des lettres est propre à chaque compte : il est calculé par HMAC-SHA256 avec une clé secrète dérivée de `APP_ENCRYPTION_KEY`, donc un compte ne peut pas le recalculer. Une question n'est proposée (et ne peut être notée) qu'une fois toutes ses réponses arrivées. Tant qu'un Utilisateur n'a pas noté toute la question, ni les réponses ni les métriques ni les notes de ce test ne lui sont envoyées (résultats détaillés, réponses côte à côte, export CSV) ; dans le classement, le podium et la fiche modèle, ce test compte comme non noté pour lui (moyenne des évaluateurs et note imposée retirées), seuls les agrégats de vitesse, de coût et de fiabilité par modèle incluent ses réponses. Les modèles sont révélés une fois la question notée. La note d'un résultat est la moyenne des évaluateurs ; l'écart-type n'est visible que de l'Admin (onglet « Écarts entre évaluateurs »). Sans aucune note, le résultat reste en attente et n'entre pas dans la qualité.

L'Admin peut **imposer une note** à un résultat terminé (0 à 10, une décimale ; elle remplace la note de la méthode, l'action est journalisée) et **relancer le juge** sur un résultat, un test ou toute la série, éventuellement avec un autre juge. Le **juge par défaut** se règle dans Admin → Fournisseurs (réglage `scoring.default_judge_model_id`) et est proposé par l'assistant de lancement.

### Page de résultats

Podium, curseurs de pondération, graphes (qualité contre vitesse, qualité par catégorie), classement, constellation 3D (repli sans WebGL) et réponses côte à côte pour un test choisi. Le **score global** (`server/src/modules/scoring/aggregate.ts`) est la moyenne pondérée de quatre notes avec la pondération de la série (défaut : qualité 50, vitesse 20, coût 20, fiabilité 10) :

- qualité : moyenne, sur les tests notés, de la moyenne des répétitions notées ;
- vitesse : moyenne de deux notes logarithmiques (médiane du premier token, plus bas = mieux ; médiane du débit, plus haut = mieux) ;
- coût : note logarithmique du coût moyen par réponse réussie (plus bas = mieux) ;
- fiabilité : réussis ÷ (réussis + erreurs + délais dépassés) × 10, les `unsupported` exclus.

Une note logarithmique va de 2 à 10 selon la position de la valeur entre le plus petit et le plus grand des modèles de la série (10 si toutes les valeurs sont égales ou s'il n'y a qu'un modèle ; valeur nulle ou négative ignorée). Un critère sans note est retiré et les poids restants sont renormalisés ; un modèle sans aucun test noté n'a pas de rang et reste hors du podium.

**Export CSV** (`csv.ts`) : une ligne par résultat, UTF-8 avec BOM, séparateur `;`, virgule décimale. Toute cellule qui commence par `=`, `+`, `-`, `@`, une tabulation ou un retour chariot est préfixée par `'` (protection contre l'injection de formules).

**Fiche modèle** : chiffres clés (qualité moyenne, fiabilité, premier token et débit médians avec leur rang), radar par catégorie contre la moyenne des modèles et historique des séries.

### Directive du faux fournisseur pour le juge

Avec `AIC_FAKE_LLM=1`, la directive `[[fake:judge=<texte>]]` placée n'importe où dans un prompt (`server/src/modules/providers/fake.ts`) fait répondre le faux fournisseur par `<texte>` tel quel, jusqu'au premier `]]`, sans panne tirée au sort ni autre directive. Pour imposer une note de juge, le texte est le JSON attendu :

```
[[fake:judge={"score": 7.5, "rationale": "Réponse correcte mais incomplète."}]]
```

Le prompt d'un test étant transmis au juge, la directive écrite dans un test noté par le juge fixe sa note ; un texte qui n'est pas du JSON valide sert à tester le nouvel appel puis l'échec de la note.

## Partage et tableau de bord (plan 5)

### Liens de partage (Admin)

Depuis une série, le bouton « Partager » (`web/src/components/sharing/ShareDialog.tsx`) crée un lien vers une page publique en lecture seule. Le formulaire demande :

- un titre et une introduction facultative ;
- jusqu'à six **verdicts** (titre, modèle éventuel de la série, phrase). Trois sont proposés d'après le classement à la pondération de la série : « Meilleur compromis » (meilleur score global), « Meilleure qualité » et « Le moins cher » (absent si aucun modèle n'a de coût) ;
- deux options, désactivées par défaut : **Afficher les coûts** et **Afficher les réponses**.

Le jeton fait 24 octets aléatoires en base64url, soit **32 caractères** (`server/src/modules/sharing/token.ts`). Il n'est affiché qu'**une seule fois**, à la création ou à la régénération ; seule son empreinte SHA-256 (hex) est stockée en base, donc un lien perdu ne peut pas être retrouvé, seulement régénéré.

Admin → Liens de partage (`/admin/partages`) liste les liens avec leur **compteur de vues** et permet de les modifier, de les **désactiver** ou réactiver, de **régénérer** le jeton (l'ancien lien renvoie alors 404), et de les **supprimer** (la suppression d'une série supprime aussi ses liens). Le réglage **URL « Audit gratuit »** (`sharing.audit_url`, défaut `https://eksplodo.fr`, `https://` obligatoire, 300 caractères au plus) est sur la même page ; il alimente le bouton de la page publique. Création, modification, régénération, suppression et changement d'URL sont journalisés (`share_link_created`, `share_link_updated`, `share_link_regenerated`, `share_link_deleted`, `audit_url_changed`).

### Page publique `/p/<jeton>`

- **Sans compte** : la page n'a ni menu ni lien vers l'application. Elle n'appelle que `GET /share/:token` (hors `/api`, sans session) ; aucun appel à `/api/*`.
- **Liste blanche** (`public-share.ts`) : la réponse est construite champ par champ. Aucun identifiant interne (utilisateur, modèle, série, résultat : les modèles sont désignés par des clés opaques `m1`, `m2`…), aucune configuration de fournisseur, aucune note individuelle d'évaluateur. Les agrégats couvrent tous les évaluateurs, sans masquage de l'aveugle : c'est la publication de l'Admin. Avec « Afficher les réponses », la page montre le texte des réponses terminées, leur note finale et l'appréciation du juge.
- **Accès** : un lien inconnu, désactivé ou régénéré renvoie le même 404 (« Lien introuvable ou désactivé »). La route est limitée à **60 consultations par minute et par IP**, n'est jamais mise en cache (`no-store`) et porte `x-robots-tag: noindex` ; la page `/p/*` a aussi un `noindex`. Chaque consultation réussie incrémente le compteur de vues.
- **Coûts masqués** : aucun montant (coût moyen, coût total) ni note de coût n'est publié. En revanche, le rang et le score global restent ceux de la pondération de la série, coût compris. Un lecteur attentif peut donc en déduire la **position relative des coûts** entre modèles, mais pas les montants.

### Version imprimable

Le bouton « Version imprimable » ouvre la boîte d'impression du navigateur ; choisir « Enregistrer au format PDF ». Une feuille `@media print` (`web/src/theme/theme.css`, limitée à la page publique) masque la 3D, les boutons et le sélecteur, remplace le podium animé par un podium statique et passe le fond en blanc.

### Tableau de bord

`/` (`server/src/modules/dashboard/`, `web/src/pages/DashboardPage.tsx`) :

- **chiffres clés** : séries lancées (total et mois en cours), modèles suivis, réponses à noter ;
- **dépense du mois** (dont la part du juge) et **nouveaux modèles** : pour l'Admin seulement ; un Utilisateur voit la même page sans ces deux éléments ;
- **évolution de la qualité par suite** : qualité de chaque modèle sur les 6 dernières séries terminées de la suite choisie, en ordre chronologique, avec le juge de chaque série ;
- **dernières séries** (5) avec le vainqueur (rang 1 à la pondération de la série), marqué « provisoire » tant que la série n'est pas terminée.

Pour un Utilisateur, toute qualité affichée (vainqueur, évolution) respecte le masquage de l'aveugle : les questions qu'il n'a pas encore notées comptent comme non notées.

## Commandes

| Commande | Rôle |
|---|---|
| `npm run dev` | API + Vite en mode développement |
| `npm test` | Tests (Vitest) ; nécessite la base de test sur le port 3307 |
| `npm run typecheck` | Vérification TypeScript (serveur, web, outils) |
| `npm run build` | Construit `dist/web` et `dist/server` |
| `npm start` | Lance `dist/server/index.js` |

## Documentation

- Spécification : [`docs/superpowers/specs/2026-10-16-comparateur-ia-design.md`](docs/superpowers/specs/2026-10-16-comparateur-ia-design.md)
- Plan 1 (fondations) : [`docs/superpowers/plans/2026-10-16-plan-1-fondations.md`](docs/superpowers/plans/2026-10-16-plan-1-fondations.md)
- Maquettes : [`maquettes/`](maquettes/)
- Déploiement Hostinger : [`docs/deploiement.md`](docs/deploiement.md)
