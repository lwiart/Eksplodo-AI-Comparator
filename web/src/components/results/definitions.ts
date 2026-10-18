// Définitions des critères du classement, affichées dans les bulles d'aide, à l'impression et dans l'export XLSX.
// Copie conforme dans server/src/modules/scoring/definitions.ts (un test serveur vérifie que les deux restent identiques).

export const DEFINITIONS = {
  global:
    'Moyenne pondérée, sur 100, des quatre critères (qualité, vitesse, coût, fiabilité) selon la pondération choisie. Un critère sans note est retiré et les poids restants sont répartis.',
  quality:
    'Note moyenne des réponses du modèle, sur 100. Pour chaque réponse : la note imposée par un Admin s’il y en a une, sinon la note de la méthode du test (réponse attendue, juge IA ou moyenne des notes manuelles). Moyenne des répétitions, puis moyenne des tests notés.',
  speed:
    'Moyenne de deux notes de 20 à 100 sur une échelle logarithmique, comparées aux autres modèles de la série : délai avant le premier token (plus court = mieux) et débit en tokens par seconde (plus haut = mieux). Médianes des réponses réussies.',
  cost: 'Coût moyen par réponse réussie, noté de 20 à 100 sur une échelle logarithmique par rapport aux autres modèles de la série : le moins cher obtient 100.',
  reliability:
    'Part des appels réussis parmi les appels terminés (réussis, erreurs et délais dépassés), en pourcentage. Un test que le modèle ne peut pas traiter (pièce jointe non prise en charge) ne compte pas.',
} as const;

export type DefinitionKey = keyof typeof DEFINITIONS;

export const DEFINITION_LABELS: Record<DefinitionKey, string> = {
  global: 'Score global',
  quality: 'Qualité',
  speed: 'Vitesse',
  cost: 'Coût',
  reliability: 'Fiabilité',
};
