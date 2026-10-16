import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Premier dossier contenant un package.json en remontant depuis `startDir`. */
export function findAppRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Racine de l'application introuvable (aucun package.json au-dessus de ${startDir})`);
    dir = parent;
  }
}

/**
 * Racine de l'application, déduite de l'emplacement de ce module et non du répertoire courant : identique depuis
 * `dist/server/lib/paths.js` (production, chargé par require()) et `server/src/lib/paths.ts` (tsx, tests).
 */
export const APP_ROOT = findAppRoot(path.dirname(fileURLToPath(import.meta.url)));
