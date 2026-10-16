export const MIN_PASSWORD_LENGTH = 12;

/** Contrôle côté client avant envoi (le serveur refait les mêmes vérifications) ; renvoie le message d'erreur ou null. */
export function validateNewPassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`;
  if (password !== confirm) return 'Les mots de passe ne correspondent pas.';
  return null;
}
