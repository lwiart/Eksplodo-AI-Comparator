/** Nombre à la française (virgule décimale, espace entre les milliers), sans décimales inutiles. */
export function formatNumber(n: number): string {
  const [int = '', dec] = String(n).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return dec ? `${grouped},${dec}` : grouped;
}

/** Prix « entrée / sortie $ » par million de tokens ; `null` quand l'un des deux est inconnu. */
export function formatPricePair(input: number | null, output: number | null): string | null {
  return input === null || output === null ? null : `${formatNumber(input)} / ${formatNumber(output)} $`;
}

/** Fenêtre de contexte abrégée pour les tableaux : 200000 → « 200 k », 1000000 → « 1 M ». */
export function formatContextShort(tokens: number | null): string {
  if (tokens === null) return '—';
  if (tokens >= 1_000_000) return `${formatNumber(Math.round((tokens / 1_000_000) * 10) / 10)} M`;
  return `${formatNumber(Math.round(tokens / 1000))} k`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
}
