# Déploiement - Eksplodo · Comparateur IA

Application Node.js hébergée chez Hostinger (compte `u355159080`), site **https://ia.eksplodo.fr**.

## Vue d'ensemble

- Hostinger compile l'application sur le serveur (`npm install` puis `npm run build`) et lance `dist/server/index.js` derrière LiteSpeed.
- Base MariaDB 11.8 sur le même serveur : connexion `127.0.0.1:3306` sur Hostinger (jamais `localhost`, qui peut résoudre en IPv6), `127.0.0.1:3307` en local.
- Les fichiers persistants vivent hors du dossier de l'application : `DATA_DIR=/home/u355159080/data/eksplodo-ia` (le dossier de l'application est remplacé à chaque déploiement).
- Au démarrage : verrou nommé MariaDB, migrations, création du premier Admin (si `BOOTSTRAP_ADMIN_EMAIL`), écoute HTTP, puis worker de tâches.

## Variables d'environnement (hPanel → Sites web → ia.eksplodo.fr → Variables d'environnement)

| Variable | Valeur / rôle |
|---|---|
| `NODE_ENV` | `production` (obligatoire : cookies sécurisés, HSTS, journaux sans secrets) |
| `PORT` | Facultative (3000 par défaut) ; Hostinger la fournit |
| `APP_BASE_URL` | `https://ia.eksplodo.fr` |
| `DATA_DIR` | `/home/u355159080/data/eksplodo-ia` |
| `CRON_SECRET` | ≥ 32 caractères, utilisé par la tâche cron. Génération : `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Tous ou aucun. Boîte proposée : `ia@eksplodo.fr`, serveur `smtp.hostinger.com`, port `465`. Sans SMTP, les e-mails sont seulement journalisés. |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DATABASE_URL` | Créées automatiquement par Hostinger avec la base. Ne pas modifier. |
| `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` | Les deux ou aucune. Uniquement pour créer le tout premier Admin : **à retirer des variables après la première connexion**. |

Aucune clé de chiffrement n'est nécessaire (`APP_ENCRYPTION_KEY` n'existe pas) : aucune donnée n'est chiffrée en base.

Après toute modification : cliquer sur **« Appliquer les modifications »** (l'étiquette « Modifications non enregistrées » doit disparaître). L'application redémarre.

> L'API Hostinger ne permet que de **remplacer l'ensemble** des variables (`hosting_nodejs_replace-environment-variables`) : ne jamais l'utiliser, sous peine de perdre `DB_PASSWORD` et la connexion à la base. Modifier les variables dans hPanel.

### Vérifier la collation de la base

Les adresses e-mail sont comparées par la base : sa collation doit être insensible à la casse, de la forme `utf8mb4_*_ci` (par exemple `utf8mb4_unicode_ci`). Vérification dans phpMyAdmin : `SELECT @@collation_database;`. Une collation `_bin` ou `_cs` rendrait `Laurent@exemple.fr` et `laurent@exemple.fr` distincts.

## Ajouter une clé API d'un fournisseur d'IA

Les fournisseurs et leurs clés arrivent avec le plan 2 ; les noms de variables prévus par la spécification sont :

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`.

Procédure : hPanel → Sites web → ia.eksplodo.fr → Variables d'environnement → ajouter la variable et sa valeur → **« Appliquer les modifications »**. L'application redémarre et prend la clé en compte. Ne jamais passer par l'API `hosting_nodejs_replace-environment-variables` (remplacement de tout l'ensemble).

## Déployer une nouvelle version

Tant que le dépôt GitHub n'est pas branché dans hPanel, le déploiement se fait par archive :

1. `git archive --format=zip -o app.zip HEAD` (seuls les fichiers commités sont inclus).
2. Envoyer `app.zip` dans `public_html` (gestionnaire de fichiers hPanel, ou envoi TUS via l'API `hosting_files_generate-upload-url`). **L'archive est consommée par chaque build : la renvoyer avant chaque nouveau build.**
3. Lancer le build : Node 24, type `fastify`, script `build`, fichier d'entrée `dist/server/index.js`, dossier de sortie `.`.
4. Vérifier : `https://ia.eksplodo.fr/health` → `{"status":"ok","db":"ok","worker":"running"}`, puis la page de connexion.

Plus tard (recommandé) : brancher GitHub dans hPanel (Sites web → Gérer → Avancé → Git) pour un déploiement automatique.

## Tâche cron (hPanel → Avancé → Tâches cron)

Toutes les 15 minutes (`*/15 * * * *`) :

```
curl -s -X POST -H "x-cron-secret: <CRON_SECRET>" https://ia.eksplodo.fr/internal/tick
```

Réponse attendue : `{"recovered":0,"failedStale":0,"scheduled":0}` (`scheduled` : nombre de tâches planifiées lancées). Le cron réveille l'application et déclenche les tâches planifiées ; tant qu'elle tourne, un planificateur interne fait de même toutes les 60 s (fuseau `Europe/Paris`).

## Diagnostic temporaire (`GET /internal/diag`)

Route provisoire, protégée par l'en-tête `x-cron-secret`, utilisée pour les vérifications de la spec §16 ; elle est retirée du code à la fin de la recette (ensuite : 404).

```
curl -s -m 130 -H "x-cron-secret: <CRON_SECRET>" "https://ia.eksplodo.fr/internal/diag?waitSeconds=90"
```

Réponse : `{ nodeVersion, uptimeSeconds, memory, mariadbVersion }`, après `waitSeconds` secondes (0 à 120). Elle sert à vérifier que LiteSpeed ne coupe pas les requêtes longues et à relever `memory.rss` au repos.

## Contraintes Hostinger à respecter dans le code

- LiteSpeed charge le point d'entrée avec `require()` : **aucun `await` de premier niveau** dans le serveur (vérifié par `server/test/entry.test.ts`).
- L'application peut écouter sur un socket Unix ; l'adresse IP du client vient de l'en-tête transmis par LiteSpeed (un seul proxy de confiance).
- `.npmrc` contient `include=dev` : sans cela, `NODE_ENV=production` empêcherait l'installation de TypeScript et Vite au moment du build.
- Plusieurs processus peuvent démarrer en même temps (un par nom d'hôte, y compris l'alias `*.hostingersite.com`) : migrations et amorçage sont protégés par un verrou nommé.

## Journaux et dépannage

- Journaux d'exécution : hPanel → Sites web → ia.eksplodo.fr → Journaux d'exécution (ou API `hosting_nodejs_runtime-logs`).
- Journaux de build : hPanel → Déploiements.
- E-mails : hPanel → E-mails → journaux d'envoi. Un e-mail « Delivered » vers Gmail peut tout de même arriver dans les spams pour un nouvel expéditeur : le marquer « non-spam ».
- Avertissement « adresse IP du client inconnue » dans les journaux : LiteSpeed ne transmet plus l'IP, la limitation par IP est alors désactivée (le verrouillage par compte reste actif).
- Les erreurs inattendues reçoivent une référence `E-XXXXX` visible par l'utilisateur ; elles sont consultables dans Admin → Journal des erreurs.

### Premier Admin bloqué

Si l'e-mail d'invitation du premier Admin n'a pas pu être envoyé (SMTP absent ou en erreur), l'invitation est invalidée automatiquement : configurer SMTP puis redémarrer l'application, une nouvelle invitation est émise. Une invitation valide (72 h) n'est pas réémise à chaque redémarrage.

### Migration interrompue

Si un démarrage a été interrompu en pleine migration (erreur « table already exists » à chaque démarrage) : comparer les tables présentes avec la dernière migration de `server/drizzle/`, supprimer les objets partiellement créés par la migration en échec (phpMyAdmin), puis redémarrer.
