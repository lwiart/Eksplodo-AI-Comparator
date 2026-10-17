const MESSAGES: Record<string, string> = {
  unauthorized: 'Votre session a expiré. Reconnectez-vous.',
  invalid_credentials: 'E-mail ou mot de passe incorrect.',
  forbidden: "Vous n'avez pas les droits nécessaires pour cette action.",
  validation: 'Certaines informations sont invalides. Vérifiez la saisie.',
  rate_limited: 'Trop de tentatives. Réessayez dans quelques minutes.',
  invitation_invalid: "Ce lien n'est plus valide. Demandez-en un nouveau.",
  invalid_password: 'Le mot de passe actuel est incorrect.',
  weak_password: 'Le mot de passe doit contenir au moins 12 caractères.',
  email_taken: 'Un compte existe déjà avec cet e-mail.',
  user_not_active: "Ce compte n'est pas actif.",
  user_not_invited: "Ce compte n'est pas en attente d'activation : l'invitation ne peut pas être renvoyée.",
  user_not_activated: "Ce compte n'a pas encore été activé : renvoyez plutôt l'invitation.",
  last_admin: "Impossible : c'est le dernier Admin actif, il doit en rester au moins un.",
  key_missing: "Aucune clé n'est enregistrée pour ce fournisseur : saisissez-la d'abord.",
  key_unreadable: 'La clé enregistrée est illisible (la clé maîtresse du serveur a changé) : ressaisissez-la.',
  provider_error: 'Le fournisseur a refusé la requête.',
  provider_name_taken: 'Un fournisseur porte déjà ce nom.',
  model_exists: 'Ce modèle est déjà dans le catalogue pour ce fournisseur.',
  file_too_large: 'Fichier trop volumineux : 10 Mo au plus.',
  unsupported_file_type: 'Type de fichier non pris en charge : PNG, JPEG, WebP ou PDF.',
  too_many_attachments: 'Dix pièces jointes au plus par test.',
  model_unavailable: 'Ce modèle est indisponible (inactif, ou fournisseur sans clé utilisable).',
  unsupported_attachment: 'Ce modèle ne gère pas une des pièces jointes du test.',
  suite_name_taken: 'Une suite porte déjà ce nom.',
  test_not_found: 'Un des tests choisis n’existe plus. Rechargez la page.',
  not_found: "Cet élément n'existe plus. Rechargez la page.",
  csrf: 'Votre session a expiré, rechargez la page.',
  internal: "Une erreur inattendue s'est produite. Réessayez dans quelques instants.",
  network: 'Le serveur ne répond pas. Vérifiez votre connexion puis réessayez.',
};

const DEFAULT_MESSAGE = 'Une erreur est survenue. Réessayez.';

export function messageFor(code: string): string {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code]! : DEFAULT_MESSAGE;
}

/** Comme `messageForError`, mais le refus d'une clé mal formée garde le message précis du serveur. */
export function messageForKeyError(err: unknown): string {
  const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown };
  if (code === 'validation' && typeof message === 'string' && message.startsWith('Clé API invalide')) return message;
  return messageForError(err);
}

/** Message à afficher pour une erreur quelconque (ApiError ou autre). */
export function messageForError(err: unknown): string {
  const { code, reference } = (err ?? {}) as { code?: unknown; reference?: unknown };
  if (code === 'internal' && typeof reference === 'string' && reference !== '') {
    return `${messageFor(code)} Si le problème persiste, communiquez la référence ${reference} à votre administrateur.`;
  }
  return typeof code === 'string' ? messageFor(code) : DEFAULT_MESSAGE;
}
