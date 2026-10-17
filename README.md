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
