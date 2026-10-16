import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { APP_ROOT } from '../lib/paths.js';

// Interface compilée par Vite, sous la racine de l'application (indépendant du répertoire courant).
export const DEFAULT_WEB_ROOT = path.join(APP_ROOT, 'dist', 'web');

const NON_SPA_PREFIXES = ['/api/', '/internal/', '/share/'];
const NON_SPA_EXACT = new Set(['/api', '/internal', '/health', '/share']);
const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;

function pathnameOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function hasExtension(pathname: string): boolean {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last.includes('.');
}

/**
 * Sert l'interface compilée (Vite) depuis `root` :
 * - un chemin avec extension est servi tel quel (404 JSON s'il n'existe pas) ;
 * - tout autre GET hors `/api/`, `/internal/`, `/share/` et `/health` renvoie `index.html` (routage côté client).
 * Si le dossier n'existe pas (tests d'API, serveur lancé sans build), rien n'est enregistré.
 */
export async function registerStatic(app: FastifyInstance, root: string): Promise<void> {
  if (!existsSync(path.join(root, 'index.html'))) {
    app.log.warn({ root }, 'interface compilée introuvable : seules les routes d’API sont servies');
    return;
  }

  await app.register(fastifyStatic, { root, serve: false });

  app.get('/*', async (req, reply) => {
    const pathname = pathnameOf(req.url);
    if (NON_SPA_EXACT.has(pathname) || NON_SPA_PREFIXES.some((p) => pathname.startsWith(p))) {
      return reply.callNotFound();
    }
    if (hasExtension(pathname)) {
      // Fichiers Vite fingerprintés : mise en cache longue ; les autres (logo…) sont revalidés via ETag.
      if (pathname.startsWith('/assets/')) {
        return reply.sendFile(pathname, { maxAge: ONE_YEAR_MS, immutable: true });
      }
      return reply.sendFile(pathname);
    }
    // index.html n'est jamais mis en cache : il référence les fichiers fingerprintés du dernier build.
    return reply.header('cache-control', 'no-cache').sendFile('index.html', { cacheControl: false });
  });
}
