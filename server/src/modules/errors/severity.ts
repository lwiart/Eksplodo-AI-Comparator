export type Severity = 'grave' | 'normale';

/**
 * Gravité de l'échec définitif d'un élément. Normale : ce qui tient à l'entrée de l'utilisateur ou à l'état métier
 * (une alerte pour une saisie invalide finirait ignorée) ; ces échecs portent `failSeverity: 'normale'`.
 * Grave : tout le reste (erreur inattendue, service externe en échec définitif).
 */
export function classifyElementFailure(err: unknown): Severity {
  return (err as { failSeverity?: unknown } | null)?.failSeverity === 'normale' ? 'normale' : 'grave';
}
