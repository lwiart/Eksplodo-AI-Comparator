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

Le développement lit `.env`. Pour l'aperçu dans Claude Code, `.claude/launch.json` définit deux configurations séparées : `comparateur-api` (API, port 3000) et `comparateur-web` (Vite, port 5173).

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
