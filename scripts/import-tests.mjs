#!/usr/bin/env node
// Ajoute à l'application les tests d'un fichier JSON (et la suite qui les regroupe), via l'API, avec un compte Admin.
//
//   node scripts/import-tests.mjs [fichier.json] [--url https://ia.eksplodo.fr] [--dry-run]
//
// L'e-mail et le mot de passe sont demandés au clavier (le mot de passe n'est pas affiché), ou lus dans
// AIC_EMAIL et AIC_PASSWORD. Un test dont le nom existe déjà est laissé tel quel ; la suite n'est créée que si
// aucune suite ne porte déjà ce nom. Aucun appel à un modèle d'IA : rien n'est facturé.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--url') ?? 'docs/tests/codage-avance.json';
const baseUrl = option('--url', 'https://ia.eksplodo.fr').replace(/\/+$/, '');
const dryRun = args.includes('--dry-run');

const data = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(data.tests) || data.tests.length === 0) throw new Error(`${file} : aucun test à importer`);

/** Question posée au clavier ; `hidden` masque la saisie (mot de passe). */
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.startsWith(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

// Petit gestionnaire de cookies : session et jeton CSRF renvoyés par le serveur.
const cookies = new Map();
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
async function call(method, path, body) {
  const headers = { accept: 'application/json', cookie: cookieHeader() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && cookies.has('aic_csrf')) headers['x-csrf-token'] = cookies.get('aic_csrf');
  const res = await fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} : ${res.status} ${json?.error?.message ?? text.slice(0, 200)}`);
  return json;
}

console.log(`Application : ${baseUrl}`);
console.log(`Fichier : ${file} (${data.tests.length} tests${data.suite ? `, suite « ${data.suite.name} »` : ''})`);
if (dryRun) {
  for (const t of data.tests) console.log(`  - ${t.name} (${t.category}, ${t.scoringMethod})`);
  console.log('Essai à blanc : rien n\'a été envoyé.');
  process.exit(0);
}

const email = process.env.AIC_EMAIL || (await ask('E-mail Admin : '));
const password = process.env.AIC_PASSWORD || (await ask('Mot de passe : ', true));

await call('GET', '/api/auth/me').catch(() => {}); // obtient le cookie CSRF
await call('POST', '/api/auth/login', { email, password });
const me = (await call('GET', '/api/auth/me')).user;
if (me?.role !== 'admin') throw new Error('Ce compte n\'est pas Admin : import impossible.');

try {
  const existing = new Map();
  for (const archived of ['false', 'true']) {
    const res = await call('GET', `/api/tests?archived=${archived}`);
    for (const t of res.tests ?? res) existing.set(t.name, t.id);
  }
  const ids = [];
  for (const t of data.tests) {
    if (existing.has(t.name)) {
      console.log(`  = déjà présent : ${t.name}`);
      ids.push(existing.get(t.name));
      continue;
    }
    const created = await call('POST', '/api/tests', t);
    const id = (created.test ?? created).id;
    ids.push(id);
    console.log(`  + ajouté : ${t.name}`);
  }
  if (data.suite) {
    const suites = await call('GET', '/api/suites');
    if ((suites.suites ?? suites).some((s) => s.name === data.suite.name)) {
      console.log(`Suite « ${data.suite.name} » déjà présente : laissée telle quelle.`);
    } else {
      await call('POST', '/api/suites', { name: data.suite.name, description: data.suite.description ?? null, testIds: ids });
      console.log(`Suite « ${data.suite.name} » créée avec ${ids.length} tests.`);
    }
  }
  console.log('Terminé.');
} finally {
  await call('POST', '/api/auth/logout').catch(() => {});
}
