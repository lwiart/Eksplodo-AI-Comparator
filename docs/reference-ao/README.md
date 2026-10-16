# Eksplodo - Appels d'offres

Application web de veille sur les appels d'offres publics (BOAMP, TED) avec recherche par mots-clés et rédaction assistée de réponses à partir des documents internes de l'entreprise.

**État : en développement.** Le plan 1 (fondations : authentification, organisations, utilisateurs, file de tâches, déploiement Hostinger) est en cours de finalisation avant la première mise en production ; la veille et la rédaction assistée viendront avec les plans suivants.

## Prérequis

- Node.js 24 (voir `.nvmrc`) ;
- MariaDB 11.8 pour les tests : `docker compose up -d db` (port 3307, mot de passe root `test`).

## Commandes

```sh
npm install
cp .env.example .env   # puis adapter les valeurs (développement)
npm run dev            # API Fastify (port 3000) + interface Vite (port 5173)
npm test               # tests serveur et interface (Vitest) ; nécessite la base de test sur 127.0.0.1:3307
npm run typecheck
npm run build          # interface dans dist/web, serveur dans dist/server
npm start              # lance dist/server/index.js
```

## Documentation

- Spécification : [`docs/superpowers/specs/2026-10-10-veille-appels-offres-design.md`](docs/superpowers/specs/2026-10-10-veille-appels-offres-design.md)
- Plan 1 (fondations) : [`docs/superpowers/plans/2026-10-10-plan-1-fondations.md`](docs/superpowers/plans/2026-10-10-plan-1-fondations.md)
- Contraintes d'hébergement (Hostinger) : [`docs/superpowers/notes/2026-10-spike-hostinger.md`](docs/superpowers/notes/2026-10-spike-hostinger.md)
