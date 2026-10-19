/** Tri de colonne : clé et sens ; `null` = ordre d'origine. */
export type SortState<K extends string> = { key: K; dir: 'asc' | 'desc' } | null;

/**
 * Clic sur un en-tête : premier sens (`first`), puis l'autre, puis retour à l'ordre d'origine. Un clic sur une autre
 * colonne repart de son premier sens.
 */
export function nextSort<K extends string>(current: SortState<K>, key: K, first: 'asc' | 'desc'): SortState<K> {
  if (current?.key !== key) return { key, dir: first };
  return current.dir === first ? { key, dir: first === 'asc' ? 'desc' : 'asc' } : null;
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/** Tri stable selon une valeur numérique ou textuelle ; les valeurs absentes restent en fin, quel que soit le sens. */
export function sortBy<T>(items: T[], value: (item: T) => number | string | null | undefined, dir: 'asc' | 'desc'): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return items
    .map((item, index) => ({ item, index, v: value(item) }))
    .sort((a, b) => {
      const an = a.v === null || a.v === undefined || (typeof a.v === 'number' && Number.isNaN(a.v));
      const bn = b.v === null || b.v === undefined || (typeof b.v === 'number' && Number.isNaN(b.v));
      if (an || bn) return an === bn ? a.index - b.index : an ? 1 : -1;
      const c = typeof a.v === 'string' || typeof b.v === 'string' ? collator.compare(String(a.v), String(b.v)) : (a.v as number) - (b.v as number);
      return c === 0 ? a.index - b.index : sign * c;
    })
    .map((x) => x.item);
}

/** Valeur d'`aria-sort` pour une colonne. */
export function ariaSort<K extends string>(sort: SortState<K>, key: K): 'ascending' | 'descending' | undefined {
  return sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;
}
