import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { beforeAll, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const entry = resolve(root, 'dist/server/index.js');

// Compile le serveur seul : la compilation de l'interface (vite) arrive avec la Task 7.
beforeAll(() => {
  const build = spawnSync('npx tsc -p tsconfig.server.json', { cwd: root, shell: true, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build échoué : ${build.stdout}${build.stderr}`);
}, 60_000);

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
