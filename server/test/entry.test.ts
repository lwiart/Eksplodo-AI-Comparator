import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const entry = resolve(root, 'dist/server/index.js');

// Build complet (interface Vite + serveur), comme en production.
beforeAll(() => {
  const build = spawnSync('npm run build', { cwd: root, shell: true, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build échoué : ${build.stdout}${build.stderr}`);
}, 180_000);

// LiteSpeed (lsnode.js) charge le point d'entrée avec require() : aucun await de premier niveau toléré.
test('le point d’entrée se charge via require() sans ERR_REQUIRE_ASYNC_MODULE', () => {
  const res = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', entry], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(res.stderr).not.toContain('ERR_REQUIRE_ASYNC_MODULE');
  // Configuration absente : le démarrage doit échouer proprement avec le message de configuration.
  expect(res.stderr).toContain('Configuration invalide');
  expect(res.status).toBe(1);
}, 30_000);

// La CSP impose font-src 'self' : une police intégrée en data: serait bloquée en production.
test('le build n’intègre aucune police en data: dans le CSS', () => {
  const dir = join(root, 'dist/web/assets');
  const css = readdirSync(dir).filter((f) => f.endsWith('.css'));
  expect(css.length).toBeGreaterThan(0);
  for (const f of css) expect(readFileSync(join(dir, f), 'utf8')).not.toContain('data:font');
});
