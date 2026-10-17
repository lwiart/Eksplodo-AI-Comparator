/** Notes de la scène : des entiers sur 100, affichés sans unité. */
export const MIN_SCORE = 64;
export const MAX_SCORE = 98;

export function randomScore(random: () => number = Math.random): number {
  return MIN_SCORE + Math.floor(random() * (MAX_SCORE - MIN_SCORE + 1));
}

export function formatScore(score: number): string {
  return String(Math.round(score));
}

/** Libellé d'un logo une fois le classement connu : médaille pour les trois premiers (rang 0, 1, 2), sinon le nombre seul. */
export function podiumLabel(rankIndex: number, score: number): string {
  const medal = ['🥇', '🥈', '🥉'][rankIndex];
  return medal ? `${medal} ${formatScore(score)}` : formatScore(score);
}
