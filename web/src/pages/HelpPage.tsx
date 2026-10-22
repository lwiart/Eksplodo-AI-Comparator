import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { DEFINITION_LABELS, DEFINITIONS, type DefinitionKey } from '../components/results/definitions';
import { Card } from '../components/ui/Card';
import { Chip } from '../components/ui/Chip';

type Section = { id: string; title: string; adminOnly?: boolean; body: ReactNode };

const P = 'm-0 text-sm leading-relaxed text-ink';
const UL = 'm-0 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ink';

/** Lien interne de l'aide, vers une page de l'application. */
function To({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="font-semibold text-sky no-underline hover:underline">
      {children}
    </Link>
  );
}

const SCORE_KEYS: DefinitionKey[] = ['global', 'quality', 'speed', 'cost', 'reliability'];

const SECTIONS: Section[] = [
  {
    id: 'principe',
    title: 'Le principe',
    body: (
      <>
        <p className={P}>
          Le comparateur pose les mêmes questions à plusieurs modèles d’IA, note leurs réponses et les classe selon la qualité, la
          vitesse, le coût et la fiabilité.
        </p>
        <ul className={UL}>
          <li>
            <b>Test</b> : une question posée aux modèles (prompt, pièces jointes éventuelles) et sa méthode de notation.
          </li>
          <li>
            <b>Suite</b> : une liste ordonnée de tests à lancer ensemble.
          </li>
          <li>
            <b>Série</b> : un comparatif, c’est-à-dire des tests passés sur plusieurs modèles, avec réponses, notes et classement.
          </li>
          <li>
            <b>Modèle</b> : un modèle d’IA d’un fournisseur (OpenAI, Anthropic, Google, Mistral, OpenRouter…), avec ses prix et ses
            capacités.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'premiers-pas',
    title: 'Premiers pas',
    adminOnly: true,
    body: (
      <ol className="m-0 flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-relaxed text-ink">
        <li>
          <To to="/admin/fournisseurs">Fournisseurs</To> : ajoutez un fournisseur et sa clé d’API (chiffrée en base, jamais réaffichée),
          testez la connexion, puis ajoutez ses modèles depuis la liste du fournisseur. Choisissez aussi le juge par défaut.
        </li>
        <li>
          <To to="/admin/tests">Tests</To> : créez vos questions, ou partez du jeu de tests fourni au premier déploiement.
        </li>
        <li>
          <To to="/admin/suites">Suites</To> : regroupez les tests à lancer ensemble (facultatif : une série peut aussi partir d’une
          sélection de tests).
        </li>
        <li>
          <To to="/series">Séries</To> : lancez une série, suivez-la en direct, puis lisez les résultats.
        </li>
      </ol>
    ),
  },
  {
    id: 'tableau-de-bord',
    title: 'Tableau de bord',
    body: (
      <p className={P}>
        La page d’accueil résume l’activité : séries lancées, modèles suivis, réponses à noter, dépenses du mois, dernières séries et
        évolution de la qualité des modèles d’une série à l’autre. Cliquez sur un modèle dans la légende d’un graphe pour le mettre
        en évidence.
      </p>
    ),
  },
  {
    id: 'lancer',
    title: 'Lancer une série',
    adminOnly: true,
    body: (
      <>
        <p className={P}>
          Depuis <To to="/series">Séries</To>, « Nouvelle série » guide le lancement en quelques étapes :
        </p>
        <ul className={UL}>
          <li>les tests, choisis un par un ou par suite ;</li>
          <li>les modèles comparés, et le juge IA si des tests sont notés par le juge ;</li>
          <li>le nombre de répétitions (chaque test est posé plusieurs fois à chaque modèle) et le nombre d’appels en parallèle ;</li>
          <li>un plafond de dépense facultatif : la série se met en pause avant tout appel qui pourrait le dépasser.</li>
        </ul>
        <p className={P}>
          Le coût maximal et la durée sont estimés avant le lancement. La série tourne ensuite sur le serveur : vous pouvez fermer la
          page.
        </p>
      </>
    ),
  },
  {
    id: 'suivre',
    title: 'Suivre une série',
    body: (
      <>
        <p className={P}>
          Pendant la série, la page montre l’avancement, la dépense, les appels en cours et le fil d’activité. La matrice{' '}
          <b>Progression par test et par modèle</b> reste affichée une fois la série terminée : elle montre d’un coup d’œil les
          réponses réussies, en erreur ou tronquées.
        </p>
        <p className={P}>Les Admins disposent de commandes :</p>
        <ul className={UL}>
          <li>
            <b>Mettre en pause</b> / <b>Reprendre</b> : les appels en cours se terminent, aucun nouveau n’est lancé.
          </li>
          <li>
            <b>Annuler les tests en attente</b> : les appels pas encore lancés passent en erreur « annulé », sans être facturés.
          </li>
          <li>
            <b>Relancer les erreurs</b> : rejoue les réponses en erreur, en délai dépassé ou tronquées (dont les appels annulés).
          </li>
          <li>
            <b>Ajouter un modèle</b> : le nouveau modèle passe les mêmes tests.
          </li>
          <li>
            <b>Ajouter les nouveaux tests de la suite</b> : apparaît quand des tests ont été ajoutés à la suite après le
            lancement ; les tests choisis sont passés par tous les modèles de la série, qui reprend aussitôt.
          </li>
          <li>
            <b>Retirer un modèle</b> : série en pause ou terminée ; ses réponses et ses notes sont supprimées définitivement, la
            dépense déjà engagée reste comptée.
          </li>
          <li>
            <b>Relever le plafond et reprendre</b> : après une pause due au plafond de dépense.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'resultats',
    title: 'Lire les résultats',
    body: (
      <ul className={UL}>
        <li>
          <b>Podium</b> et <b>Pondération</b> : le classement se recalcule aussitôt quand vous changez le poids de chaque critère.
          « Exporter » télécharge le classeur Excel de la série.
        </li>
        <li>
          <b>Constellation</b>, <b>Qualité et vitesse</b> : chaque modèle est un point ; cliquez sur un point ou sur la légende pour voir
          le détail. La zone orangée en haut à droite est idéale.
        </li>
        <li>
          <b>Classement détaillé</b> : cliquez sur un en-tête pour trier ; la flèche indique le sens (croissant ou décroissant), un
          troisième clic revient au classement.
        </li>
        <li>
          <b>Qualité par catégorie de test</b> : la note de chaque modèle par catégorie, triable dans les deux sens. Un clic sur une note
          affiche les réponses de ce modèle pour toute la catégorie.
        </li>
        <li>
          <b>Réponses côte à côte</b> : filtrez par catégorie, test, modèle et statut (toutes, tronquées, en erreur) ; « Tous les tests »
          les affiche l’un sous l’autre. Le nom d’un test ouvre son détail (prompts, résultat attendu).
        </li>
        <li>
          <b>Métriques par modèle</b> : réponses, premier token, débit et coût, une fois la série terminée.
        </li>
      </ul>
    ),
  },
  {
    id: 'corriger',
    title: 'Corriger une note ou relancer des réponses',
    adminOnly: true,
    body: (
      <ul className={UL}>
        <li>
          <b>Imposer une note</b> : remplace la note d’une réponse (elle prime sur toute autre note).
        </li>
        <li>
          <b>Relancer le juge</b> : sur une réponse, un test ou toute la série, éventuellement avec un autre juge. Les réponses ne sont
          pas regénérées.
        </li>
        <li>
          <b>Relancer une sélection</b> : cochez « Relancer » sur les réponses voulues (ou « Cocher ces réponses » pour un test), puis
          « Relancer la sélection ». Réponses et notes sont effacées puis rejouées avec la limite de tokens actuelle de chaque test.
          Utile après avoir relevé la limite d’un test dont les réponses étaient tronquées. Les appels sont facturés.
        </li>
      </ul>
    ),
  },
  {
    id: 'notation',
    title: 'Méthodes de notation',
    body: (
      <>
        <ul className={UL}>
          <li>
            <b>Réponse attendue</b> : note automatique, par comparaison exacte, présence d’éléments ou expression régulière.
          </li>
          <li>
            <b>IA-juge</b> : un modèle juge note la réponse selon les critères du test, avec une justification affichée sous la réponse.
          </li>
          <li>
            <b>Manuelle</b> : les comptes notent eux-mêmes, à l’aveugle.
          </li>
        </ul>
        <p className={P}>
          <To to="/a-noter">À noter</To> liste les questions qui attendent vos notes. Les réponses y sont anonymes (lettres A, B, C…) ;
          les noms des modèles apparaissent une fois vos notes enregistrées. La note d’une réponse est la moyenne des évaluateurs ;
          l’onglet « Écarts entre évaluateurs » montre où ils divergent.
        </p>
      </>
    ),
  },
  {
    id: 'scores',
    title: 'Les scores',
    body: (
      <dl className="m-0 flex flex-col gap-3">
        {SCORE_KEYS.map((k) => (
          <div key={k}>
            <dt className="font-display text-sm font-bold text-white">{DEFINITION_LABELS[k]}</dt>
            <dd className="m-0 mt-0.5 text-sm leading-relaxed text-ink">{DEFINITIONS[k]}</dd>
          </div>
        ))}
      </dl>
    ),
  },
  {
    id: 'tokens',
    title: 'Limite de tokens et réponses tronquées',
    body: (
      <>
        <p className={P}>
          Chaque test fixe une limite de sortie (« Max tokens », 50 000 au plus). Le modèle reçoit cette limite plus une marge de 4 000
          tokens pour sa réflexion, sans dépasser 50 000. Un modèle qui réfléchit longtemps peut épuiser la limite avant d’écrire : sa
          réponse est alors <b>tronquée</b>, facturée mais pas notée.
        </p>
        <p className={P}>
          Pour corriger : relevez la limite du test, puis relancez les réponses concernées. Une série garde les réglages des tests tels
          qu’ils étaient à son lancement, sauf pour les réponses relancées. Un appel est abandonné au bout de 10 minutes sans réponse.
        </p>
      </>
    ),
  },
  {
    id: 'modeles',
    title: 'Modèles',
    body: (
      <>
        <p className={P}>
          <To to="/modeles">Modèles</To> présente le catalogue : prix, capacités (images, PDF), fenêtre de contexte et statistiques. La
          fiche d’un modèle montre ses chiffres clés, son radar par catégorie et l’historique de ses séries.
        </p>
        <p className={P}>
          Pour les Admins, « Vérifier les capacités » envoie trois très petits appels (texte, image, PDF) pour savoir ce que chaque
          modèle accepte, et lit la fenêtre de contexte dans la liste des modèles du fournisseur quand il la publie.
        </p>
      </>
    ),
  },
  {
    id: 'partage',
    title: 'Partager des résultats',
    adminOnly: true,
    body: (
      <p className={P}>
        Le bouton « Partager » d’une série crée une page publique en lecture seule, accessible sans compte : titre, introduction,
        verdicts (meilleur compromis, meilleure qualité…), avec en option les coûts et les réponses. <To to="/admin/partages">Liens de partage</To>{' '}
        liste ces liens pour les modifier ou les couper.
      </p>
    ),
  },
  {
    id: 'administration',
    title: 'Administration',
    adminOnly: true,
    body: (
      <ul className={UL}>
        <li>
          <To to="/admin/utilisateurs">Utilisateurs</To> : invitations par e-mail, rôles (Admin ou Utilisateur), comptes désactivés.
        </li>
        <li>
          <To to="/admin/tests">Tests</To> : prompt système et utilisateur, température, limite de tokens, tags, pièces jointes (images,
          PDF) et méthode de notation. Un test déjà utilisé par une série est archivé plutôt que supprimé.
        </li>
        <li>
          <To to="/admin/erreurs">Journal des erreurs</To> : erreurs techniques de l’application, à consulter puis marquer comme
          traitées.
        </li>
      </ul>
    ),
  },
  {
    id: 'preferences',
    title: 'Préférences',
    body: (
      <p className={P}>
        Le menu de votre compte, en bas à gauche, donne accès à <To to="/compte">Mon compte</To> (nom, mot de passe), aux
        interrupteurs <b>Animations</b> et <b>Mode clair</b>, et à la déconnexion. Animations et mode clair sont mémorisés dans ce
        navigateur.
      </p>
    ),
  },
];

/** Aide : comment fonctionne le comparateur, fonctionnalité par fonctionnalité (les parties Admin pour les Admins seulement). */
export function HelpPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const sections = SECTIONS.filter((s) => isAdmin || !s.adminOnly);
  return (
    <div className="mx-auto max-w-[900px]">
      <header className="mb-5">
        <h1 className="m-0 font-display text-[30px] leading-[1.1] font-extrabold tracking-[-0.01em] text-white">Aide</h1>
        <p className="mt-2 mb-0 max-w-prose text-sm text-mute">
          Comment fonctionne le comparateur.{isAdmin ? '' : ' Certaines fonctions (lancement des séries, tests, partage) sont réservées aux Admins.'}
        </p>
      </header>
      <Card className="mb-4">
        <nav aria-label="Sommaire de l’aide">
          <ol className="m-0 grid list-none gap-x-6 gap-y-1.5 p-0 text-sm sm:grid-cols-2">
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-sky no-underline hover:underline">
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </Card>
      <div className="flex flex-col gap-4">
        {sections.map((s) => (
          <Card key={s.id} id={s.id} className="flex scroll-mt-4 flex-col gap-3">
            <h2 className="m-0 flex flex-wrap items-center gap-2 font-display text-lg font-bold text-white">
              {s.title}
              {s.adminOnly ? <Chip>Admin</Chip> : null}
            </h2>
            {s.body}
          </Card>
        ))}
      </div>
    </div>
  );
}
