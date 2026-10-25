#!/usr/bin/env node
// Remplace les critères de juge de tests de l'application, via l'API, avec un compte Admin.
//
//   node scripts/set-criteria.mjs [fichier.json] [--url https://ia.eksplodo.fr] [--dry-run]
//
// Le fichier liste des corrections { name, before, after } (par défaut docs/tests/notation-sur-100.json). Un test n'est
// modifié que si son critère actuel est exactement `before` : un critère déjà corrigé ou retouché depuis est laissé tel
// quel et signalé. Chaque modification est journalisée par l'application. Les séries existantes ne changent pas : elles
// gardent les tests tels qu'ils étaient à leur lancement. Aucun appel à un modèle d'IA : rien n'est facturé.
import { readFileSync } from 'node:fs';
import { openAdminSession, readArgs } from './lib/admin-session.mjs';

const { option, flag, free } = readArgs(process.argv.slice(2));
const file = free ?? 'docs/tests/notation-sur-100.json';
const baseUrl = option('--url', 'https://ia.eksplodo.fr').replace(/\/+$/, '');
const dryRun = flag('--dry-run');

const { corrections } = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(corrections) || corrections.length === 0) throw new Error(`${file} : aucune correction`);

console.log(`Application : ${baseUrl} · ${corrections.length} corrections de ${file}${dryRun ? ' (essai à blanc)' : ''}`);
const session = await openAdminSession(baseUrl);
try {
  const all = [];
  for (const archived of ['false', 'true']) {
    const res = await session.call('GET', `/api/tests?archived=${archived}`);
    all.push(...(res.tests ?? res));
  }
  let changed = 0;
  const tests = (n) => (n > 1 ? `${n} tests` : `${n} test`);
  for (const c of corrections) {
    const t = all.find((x) => x.name === c.name);
    const current = t?.scoringConfig?.criteria;
    if (!t) console.log(`  - absent : ${c.name}`);
    else if (t.scoringMethod !== 'judge') console.log(`  - pas noté par le juge, laissé tel quel : ${c.name}`);
    else if (current === c.after) console.log(`  = déjà corrigé : ${c.name}`);
    else if (current !== c.before) console.log(`  ! critère modifié depuis, laissé tel quel : ${c.name}`);
    else {
      if (!dryRun) {
        await session.call('PUT', `/api/tests/${t.id}`, {
          name: t.name,
          category: t.category,
          tags: t.tags,
          systemPrompt: t.systemPrompt,
          userPrompt: t.userPrompt,
          temperature: t.temperature,
          maxTokens: t.maxTokens,
          scoringMethod: t.scoringMethod,
          scoringConfig: { ...t.scoringConfig, criteria: c.after },
        });
      }
      changed += 1;
      console.log(`  ${dryRun ? '~' : '✓'} ${c.name}`);
    }
  }
  console.log(dryRun ? `Essai à blanc : ${tests(changed)} ${changed > 1 ? 'seraient modifiés' : 'serait modifié'}, rien n'a été envoyé.` : `Terminé : ${tests(changed)} ${changed > 1 ? 'modifiés' : 'modifié'}.`);
} finally {
  await session.close();
}
