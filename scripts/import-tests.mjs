#!/usr/bin/env node
// Ajoute à l'application les tests d'un fichier JSON (et la suite qui les regroupe), via l'API, avec un compte Admin.
//
//   node scripts/import-tests.mjs [fichier.json] [--url https://ia.eksplodo.fr] [--dry-run]
//
// L'e-mail et le mot de passe sont demandés au clavier (le mot de passe n'est pas affiché), ou lus dans
// AIC_EMAIL et AIC_PASSWORD. Un test dont le nom existe déjà est laissé tel quel ; la suite n'est créée que si
// aucune suite ne porte déjà ce nom. Aucun appel à un modèle d'IA : rien n'est facturé.
import { readFileSync } from 'node:fs';
import { openAdminSession, readArgs } from './lib/admin-session.mjs';

const { option, flag, free } = readArgs(process.argv.slice(2));
const file = free ?? 'docs/tests/codage-avance.json';
const baseUrl = option('--url', 'https://ia.eksplodo.fr').replace(/\/+$/, '');
const dryRun = flag('--dry-run');

const data = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(data.tests) || data.tests.length === 0) throw new Error(`${file} : aucun test à importer`);

console.log(`Application : ${baseUrl}`);
console.log(`Fichier : ${file} (${data.tests.length} tests${data.suite ? `, suite « ${data.suite.name} »` : ''})`);
if (dryRun) {
  for (const t of data.tests) console.log(`  - ${t.name} (${t.category}, ${t.scoringMethod})`);
  console.log('Essai à blanc : rien n\'a été envoyé.');
  process.exit(0);
}

const session = await openAdminSession(baseUrl);
try {
  const existing = new Map();
  for (const archived of ['false', 'true']) {
    const res = await session.call('GET', `/api/tests?archived=${archived}`);
    for (const t of res.tests ?? res) existing.set(t.name, t.id);
  }
  const ids = [];
  for (const t of data.tests) {
    if (existing.has(t.name)) {
      console.log(`  = déjà présent : ${t.name}`);
      ids.push(existing.get(t.name));
      continue;
    }
    const created = await session.call('POST', '/api/tests', t);
    ids.push((created.test ?? created).id);
    console.log(`  + ajouté : ${t.name}`);
  }
  if (data.suite) {
    const suites = await session.call('GET', '/api/suites');
    if ((suites.suites ?? suites).some((s) => s.name === data.suite.name)) {
      console.log(`Suite « ${data.suite.name} » déjà présente : laissée telle quelle.`);
    } else {
      await session.call('POST', '/api/suites', { name: data.suite.name, description: data.suite.description ?? null, testIds: ids });
      console.log(`Suite « ${data.suite.name} » créée avec ${ids.length} tests.`);
    }
  }
  console.log('Terminé.');
} finally {
  await session.close();
}
