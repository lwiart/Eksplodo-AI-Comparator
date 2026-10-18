#!/usr/bin/env node
// Fixe la limite de sortie (maxTokens) de tous les tests actifs de l'application, via l'API, avec un compte Admin.
//
//   node scripts/set-max-tokens.mjs [--value 16000] [--url https://ia.eksplodo.fr] [--dry-run]
//
// Seuls les tests dont la limite diffère sont modifiés (chaque modification est journalisée par l'application). Les
// séries existantes ne changent pas : elles gardent les tests tels qu'ils étaient à leur lancement. Aucun appel à un
// modèle d'IA : rien n'est facturé.
import { openAdminSession, readArgs } from './lib/admin-session.mjs';

const { option, flag } = readArgs(process.argv.slice(2));
const value = Number(option('--value', '16000'));
const baseUrl = option('--url', 'https://ia.eksplodo.fr').replace(/\/+$/, '');
const dryRun = flag('--dry-run');
if (!Number.isInteger(value) || value < 1 || value > 16_000) throw new Error('--value : entier de 1 à 16000');

console.log(`Application : ${baseUrl} · limite visée : ${value} tokens${dryRun ? ' (essai à blanc)' : ''}`);
const session = await openAdminSession(baseUrl);
try {
  const listed = await session.call('GET', '/api/tests?archived=false');
  const all = listed.tests ?? listed;
  const todo = all.filter((t) => t.maxTokens !== value);
  console.log(`${all.length} tests actifs, ${todo.length} à modifier.`);
  for (const t of todo) {
    if (!dryRun) {
      await session.call('PUT', `/api/tests/${t.id}`, {
        name: t.name,
        category: t.category,
        tags: t.tags,
        systemPrompt: t.systemPrompt,
        userPrompt: t.userPrompt,
        temperature: t.temperature,
        maxTokens: value,
        scoringMethod: t.scoringMethod,
        scoringConfig: t.scoringConfig,
      });
    }
    console.log(`  ${dryRun ? '~' : '✓'} ${t.name} : ${t.maxTokens} → ${value}`);
  }
  console.log(dryRun ? 'Essai à blanc : rien n\'a été modifié.' : 'Terminé.');
} finally {
  await session.close();
}
