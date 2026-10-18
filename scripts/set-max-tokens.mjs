#!/usr/bin/env node
// Fixe la limite de sortie (maxTokens) des tests actifs de l'application, via l'API, avec un compte Admin.
//
//   node scripts/set-max-tokens.mjs [--value 16000] [--url https://ia.eksplodo.fr] [--dry-run]
//   node scripts/set-max-tokens.mjs --map limites.json [--url …] [--dry-run]
//
// Avec --value, tous les tests actifs reçoivent la même limite ; avec --map (fichier JSON { "nom du test": limite }),
// chaque test listé reçoit sa limite et les autres ne changent pas. Seuls les tests dont la limite diffère sont modifiés
// (chaque modification est journalisée par l'application). Les séries existantes ne changent pas : elles gardent les
// tests tels qu'ils étaient à leur lancement. Aucun appel à un modèle d'IA : rien n'est facturé.
import { readFileSync } from 'node:fs';
import { openAdminSession, readArgs } from './lib/admin-session.mjs';

const { option, flag } = readArgs(process.argv.slice(2));
const mapFile = option('--map', null);
const value = Number(option('--value', '16000'));
const baseUrl = option('--url', 'https://ia.eksplodo.fr').replace(/\/+$/, '');
const dryRun = flag('--dry-run');
const valid = (n) => Number.isInteger(n) && n >= 1 && n <= 16_000;

const map = mapFile ? JSON.parse(readFileSync(mapFile, 'utf8')) : null;
if (map) {
  for (const [name, n] of Object.entries(map)) if (!valid(n)) throw new Error(`${mapFile} : limite invalide pour « ${name} » (entier de 1 à 16000)`);
} else if (!valid(value)) {
  throw new Error('--value : entier de 1 à 16000');
}
const targetOf = (t) => (map ? map[t.name] : value);

console.log(`Application : ${baseUrl} · ${map ? `limites de ${mapFile}` : `limite visée : ${value} tokens`}${dryRun ? ' (essai à blanc)' : ''}`);
const session = await openAdminSession(baseUrl);
try {
  const listed = await session.call('GET', '/api/tests?archived=false');
  const all = listed.tests ?? listed;
  const todo = all.filter((t) => targetOf(t) !== undefined && t.maxTokens !== targetOf(t));
  if (map) {
    const unknown = Object.keys(map).filter((name) => !all.some((t) => t.name === name));
    if (unknown.length > 0) console.warn(`Absents de l'application (ignorés) : ${unknown.join(', ')}`);
  }
  console.log(`${all.length} tests actifs, ${todo.length} à modifier.`);
  for (const t of todo) {
    const target = targetOf(t);
    if (!dryRun) {
      await session.call('PUT', `/api/tests/${t.id}`, {
        name: t.name,
        category: t.category,
        tags: t.tags,
        systemPrompt: t.systemPrompt,
        userPrompt: t.userPrompt,
        temperature: t.temperature,
        maxTokens: target,
        scoringMethod: t.scoringMethod,
        scoringConfig: t.scoringConfig,
      });
    }
    console.log(`  ${dryRun ? '~' : '✓'} ${t.name} : ${t.maxTokens} → ${target}`);
  }
  console.log(dryRun ? 'Essai à blanc : rien n\'a été modifié.' : 'Terminé.');
} finally {
  await session.close();
}
