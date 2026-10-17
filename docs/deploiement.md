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
| `PORT` | Facultative, numérique (3000 par défaut), utilisée en local ; LiteSpeed gère lui-même le socket sur Hostinger |
| `APP_BASE_URL` | `https://ia.eksplodo.fr` |
| `DATA_DIR` | `/home/u355159080/data/eksplodo-ia` |
| `CRON_SECRET` | ≥ 32 caractères, utilisé par la tâche cron. Génération : `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Tous ou aucun. Boîte proposée : `ia@eksplodo.fr`, serveur `smtp.hostinger.com`, port `465`. Sans SMTP, les e-mails sont seulement journalisés, sans le lien ni le texte : l'Admin copie alors le lien d'invitation ou de réinitialisation depuis l'écran « Utilisateurs » (boîte de dialogue du lien affichée à la création, ou après « Régénérer le lien » / « Lien de réinitialisation »). |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DATABASE_URL` | Créées automatiquement par Hostinger avec la base. Ne pas modifier. |
| `APP_ENCRYPTION_KEY` | **Obligatoire** (plan 2). Clé maîtresse de 32 octets encodée en base64, qui chiffre les clés API des fournisseurs enregistrées en base. Génération : `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **En garder une copie dans un gestionnaire de mots de passe** : si elle change ou se perd, les clés enregistrées deviennent illisibles et doivent être ressaisies. Sans elle, l'application ne démarre pas. |
| `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` | Les deux ou aucune. Uniquement pour créer le tout premier Admin : **à retirer des variables après la première connexion**. |

Seules les clés API des fournisseurs sont chiffrées en base (AES-256-GCM avec `APP_ENCRYPTION_KEY`).

Après toute modification : cliquer sur **« Appliquer les modifications »** (l'étiquette « Modifications non enregistrées » doit disparaître). L'application redémarre.

> L'API Hostinger ne permet que de **remplacer l'ensemble** des variables (`hosting_nodejs_replace-environment-variables`) : ne jamais l'utiliser, sous peine de perdre `DB_PASSWORD` et la connexion à la base. Modifier les variables dans hPanel.

### Vérifier la collation de la base

Les adresses e-mail sont comparées par la base : sa collation doit être insensible à la casse, de la forme `utf8mb4_*_ci` (par exemple `utf8mb4_unicode_ci`). Vérification dans phpMyAdmin : `SELECT @@collation_database;`. Une collation `_bin` ou `_cs` rendrait `Laurent@exemple.fr` et `laurent@exemple.fr` distincts.

## Ajouter une clé API d'un fournisseur d'IA

Les clés des fournisseurs se saisissent **dans l'application**, pas dans hPanel : Admin → Fournisseurs → « Remplacer la clé » (ou à la création d'un fournisseur), puis « Tester la connexion ». La clé est chiffrée avec `APP_ENCRYPTION_KEY` ; l'écran n'affiche ensuite que ses 4 derniers caractères (« …a4f2 »). Aucun redémarrage n'est nécessaire.

Fournisseurs préconfigurés à la première installation, sans clé : OpenRouter, OpenAI, Anthropic, Google, Mistral, DeepSeek, Requesty et Eden AI. On peut en ajouter d'autres (type compatible OpenAI, Anthropic ou Google).

États d'une clé sur l'écran Fournisseurs : « Clé enregistrée », « Clé manquante » ou « Clé illisible ». « Tester la connexion » vérifie la clé enregistrée.

Le catalogue OpenRouter (modèles et prix) est resynchronisé chaque jour à 06:00 (heure de Paris) par la tâche planifiée `catalog_refresh`, déclenchée par le planificateur interne ou par le cron ci-dessous.

« Clé illisible » sur un fournisseur : `APP_ENCRYPTION_KEY` a changé depuis l'enregistrement de la clé ; la ressaisir.

`AIC_FAKE_LLM=1` (faux fournisseur, sans appel réel) sert au développement local et n'a aucun effet en production.

## Déployer une nouvelle version

Tant que le dépôt GitHub n'est pas branché dans hPanel, le déploiement se fait par archive :

1. `git archive --format=zip -o app.zip HEAD` (seuls les fichiers commités sont inclus).
2. Envoyer `app.zip` dans `public_html` (gestionnaire de fichiers hPanel, ou envoi TUS via l'API `hosting_files_generate-upload-url`). **L'archive est consommée par chaque build : la renvoyer avant chaque nouveau build.**
3. Lancer le build : Node 24, type `fastify`, script `build`, fichier d'entrée `dist/server/index.js`, dossier de sortie `.`.
4. Vérifier : `https://ia.eksplodo.fr/health` → `{"status":"ok","db":"ok","worker":"running","providers":{"configured":N}}` (`N` : nombre de fournisseurs activés dont la clé est utilisable), puis la page de connexion. Une réponse 503 `{"status":"degraded","db":"down"}` signifie que la base est injoignable.

Plus tard (recommandé) : brancher GitHub dans hPanel (Sites web → Gérer → Avancé → Git) pour un déploiement automatique.

## Notation et résultats (plan 4)

- **Aucune nouvelle variable d'environnement.** L'ordre à l'aveugle de la notation manuelle utilise une clé dérivée de `APP_ENCRYPTION_KEY` (`HMAC(APP_ENCRYPTION_KEY, 'aic:blind-order:v1')`) : changer cette clé change donc aussi l'ordre des lettres déjà vues par les comptes, sans effet sur les notes enregistrées.
- **Migrations** : `0004` (table `manual_scores`) et `0005` (colonne `results.judge_claimed_by`) s'appliquent au démarrage comme les précédentes (`migrate` de `server/src/db/migrate.ts`, sous le verrou nommé). Rien à lancer à la main.
- **Coût du juge** : les appels du juge sont des appels facturés comme les autres. Leur coût entre dans la dépense du mois et dans le plafond de dépense de la série (réservation avant chaque appel), mais il est suivi à part (origine `judge`) et jamais imputé au modèle évalué.
- Le juge par défaut se règle dans Admin → Fournisseurs ; il n'a besoin d'aucune configuration serveur.

## Partage et tableau de bord (plan 5)

- **Aucune nouvelle variable d'environnement.**
- **Migration** : `0006` (table `share_links`) s'applique au démarrage comme les précédentes (`migrate` de `server/src/db/migrate.ts`, sous le verrou nommé). Rien à lancer à la main.
- **Routes publiques** : `GET /share/:token` et les pages `/p/*` passent par l'application Node, comme toutes les autres routes ; il n'y a rien à ajouter côté proxy ni dans hPanel.
- **Adresse IP du client** : la route publique est limitée à 60 consultations par minute et par IP (`server/src/plugins/rate-limit.ts`). Vérifier que le proxy transmet l'IP du client (`x-forwarded-for` ou `x-real-ip`) : sans elle, la limite par IP ne s'applique pas à ces requêtes et un avertissement est journalisé. Sur Hostinger, LiteSpeed la fournit (voir « Vérifications de la mise en production »).
- L'URL du bouton « Audit gratuit » se règle dans l'application (Admin → Liens de partage), pas par variable d'environnement.

## Tâche cron (hPanel → Avancé → Tâches cron)

Toutes les 15 minutes (`*/15 * * * *`) :

```
curl -s -X POST -H "x-cron-secret: <CRON_SECRET>" https://ia.eksplodo.fr/internal/tick
```

Réponse attendue : `{"recovered":0,"failedStale":0,"scheduled":0,"runsEnqueued":0}` (`scheduled` : nombre de tâches planifiées lancées ; `runsEnqueued` : nombre de séries sans tâche active remises en file). Le cron réveille l'application et déclenche les tâches planifiées ; tant qu'elle tourne, un planificateur interne fait de même toutes les 60 s (fuseau `Europe/Paris`).

## Séries, voie rapide et pièces jointes (plan 3)

- **Voie rapide** : un second worker, dédié aux tâches `quick_try`, tourne à côté du worker principal. Les essais rapides ne sont donc pas bloqués par les longues tâches d'une série.
- **Reprise des séries** : une série reprend seule après un redémarrage. À l'arrêt propre (SIGTERM), la tâche en cours est remise en file et reprend **60 s plus tard**, sans tentative consommée. Après un arrêt brutal, la tâche est reprise après 15 minutes sans signe de vie, au passage suivant du planificateur (soit ≈ 16 minutes au plus). En outre, `recoverRuns` remet en file toute série sans tâche active, à chaque passage du planificateur et à chaque appel de `/internal/tick`.
- **Pièces jointes** : elles sont stockées dans `DATA_DIR/attachments` (hors du dossier de l'application) et doivent être conservées entre les déploiements ; sinon les tests qui en ont perdent leurs fichiers. Chaque appel les relit sur disque et les encode en base64.

## Vérifications de la mise en production (2026-10-17)

Faites avec une route de diagnostic provisoire, retirée ensuite du code (`/internal/diag` renvoie 404) :

| Vérification | Résultat |
|---|---|
| Versions | Node.js v24.21.0, MariaDB 11.8.9 |
| Mémoire au démarrage | RSS ≈ 230 Mo |
| Requête longue (90 s) | **Coupée à 60 s** par le proxy Hostinger (réponse 307 au lieu de la réponse de l'app) |
| Adresse IP du client | Fiable : LiteSpeed ajoute la vraie adresse en dernier dans `X-Forwarded-For` et écrase `X-Real-IP` ; des en-têtes falsifiés ne changent pas l'IP vue par l'app |

## Contraintes Hostinger à respecter dans le code

- LiteSpeed charge le point d'entrée avec `require()` : **aucun `await` de premier niveau** dans le serveur (vérifié par `server/test/entry.test.ts`).
- **Une requête HTTP ne peut pas durer plus de 60 s** (coupure du proxy Hostinger) : tout traitement potentiellement plus long (appels aux modèles d'IA, essai rapide compris) passe par la file de tâches, avec un suivi par interrogation depuis l'interface.
- LiteSpeed remplace l'écoute TCP par un socket Unix qu'il gère : rien à configurer ; `PORT` reste numérique (défaut 3000) et sert en local. L'adresse IP du client vient de l'en-tête transmis par LiteSpeed (un seul proxy de confiance).
- `.npmrc` contient `include=dev` : sans cela, `NODE_ENV=production` empêcherait l'installation de TypeScript et Vite au moment du build.
- Plusieurs processus peuvent démarrer en même temps (un par nom d'hôte, y compris l'alias `*.hostingersite.com`) : migrations et amorçage sont protégés par un verrou nommé.

## Journaux et dépannage

- Journaux d'exécution : hPanel → Sites web → ia.eksplodo.fr → Journaux d'exécution (ou API `hosting_nodejs_runtime-logs`).
- Journaux de build : hPanel → Déploiements.
- E-mails : hPanel → E-mails → journaux d'envoi. Un e-mail « Delivered » vers Gmail peut tout de même arriver dans les spams pour un nouvel expéditeur : le marquer « non-spam ».
- Avertissement « adresse IP du client inconnue » dans les journaux : LiteSpeed ne transmet plus l'IP, la limitation par IP est alors désactivée (le verrouillage par compte reste actif).
- Les erreurs inattendues reçoivent une référence `E-XXXXX` visible par l'utilisateur ; elles sont consultables dans Admin → Journal des erreurs.

### Premier Admin

Au démarrage, le premier Admin est créé directement avec le statut actif (sans e-mail ni invitation) à partir de `BOOTSTRAP_ADMIN_EMAIL` et `BOOTSTRAP_ADMIN_PASSWORD`, et seulement si aucun Admin n'existe encore (quel que soit son statut). Si l'adresse appartient déjà à un compte non Admin, rien n'est créé et les journaux d'exécution affichent l'avertissement « Premier Admin non créé : l'e-mail de BOOTSTRAP_ADMIN_EMAIL existe déjà (autre démarrage ou autre compte) ». Après la première connexion, retirer les deux variables dans hPanel.

### Migration interrompue

Si un démarrage a été interrompu en pleine migration (erreur « table already exists » à chaque démarrage) : comparer les tables présentes avec la dernière migration de `server/drizzle/`, supprimer les objets partiellement créés par la migration en échec (phpMyAdmin), puis redémarrer.
