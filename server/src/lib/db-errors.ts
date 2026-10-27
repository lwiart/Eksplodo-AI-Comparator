// Codes d'erreur MariaDB utiles au métier, et lecture de ces codes à travers les erreurs enveloppées (Drizzle range
// l'erreur du pilote mysql2 dans `cause`, parfois sur plusieurs niveaux).

/** Conflit d'instantané (innodb_snapshot_isolation) : la ligne lue a changé depuis le début de la transaction. */
export const ER_CHECKREAD = 1020;
/** Doublon sur une clé unique. */
export const ER_DUP_ENTRY = 1062;
/** Interblocage : MariaDB a annulé la transaction. */
export const ER_LOCK_DEADLOCK = 1213;

const MAX_DEPTH = 5;

/** Premier `errno` numérique trouvé sur l'erreur ou ses causes successives (cinq niveaux au plus). */
export function errnoOf(err: unknown): number | undefined {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < MAX_DEPTH; depth++) {
    const { errno, cause } = e as { errno?: unknown; cause?: unknown };
    if (typeof errno === 'number') return errno;
    e = cause;
  }
  return undefined;
}

/** Doublon sur une clé unique, reconnu par son `errno` ou son code texte, à n'importe quel niveau de cause. */
export function isDuplicateEntry(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < MAX_DEPTH; depth++) {
    const { code, errno, cause } = e as { code?: unknown; errno?: unknown; cause?: unknown };
    if (code === 'ER_DUP_ENTRY' || errno === ER_DUP_ENTRY) return true;
    e = cause;
  }
  return false;
}
