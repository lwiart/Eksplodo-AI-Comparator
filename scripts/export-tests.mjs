#!/usr/bin/env node
// Exporte le catalogue et les tests de l'application dans le jeu livré avec le dépôt : fournisseurs (sans clé), modèles,
// tests actifs (pièces jointes comprises) et suites, dans `server/seed/tests.json` et `server/seed/attachments/`. Ce jeu
// est installé automatiquement à la première mise en service d'une nouvelle base, jamais sur une installation existante.
//
//   node scripts/export-tests.mjs [--url https://ia.eksplodo.fr] [--out server/seed]
//
// Lecture seule côté application : aucun appel à un modèle d'IA, rien n'est modifié ni facturé.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openAdminSession, readArgs } from './lib/admin-session.mjs';

const { option } = readArgs(process.argv.slice(2));
const baseUrl = option('--url', 'https://ia.eksplodo.fr').replace(/\/+$/, '');
const outDir = option('--out', 'server/seed');
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' };

console.log(`Application : ${baseUrl}`);
const session = await openAdminSession(baseUrl);
try {
  const listed = await session.call('GET', '/api/tests?archived=false');
  const all = listed.tests ?? listed;
  const names = new Map();
  for (const t of all) names.set(t.name, (names.get(t.name) ?? 0) + 1);
  const duplicates = [...names].filter(([, n]) => n > 1).map(([name]) => name);
  if (duplicates.length > 0) console.warn(`Attention, noms en double (les suites les confondront) : ${duplicates.join(', ')}`);

  await rm(path.join(outDir, 'attachments'), { recursive: true, force: true });
  await mkdir(path.join(outDir, 'attachments'), { recursive: true });
  const tests = [];
  let files = 0;
  for (const [i, t] of all.entries()) {
    const attachments = [];
    for (const [k, a] of (t.attachments ?? []).entries()) {
      const content = await session.download(`/api/tests/${t.id}/attachments/${a.id}/download`);
      const file = `attachments/${String(i + 1).padStart(3, '0')}-${k + 1}.${EXT[a.mime] ?? 'bin'}`;
      await writeFile(path.join(outDir, file), content);
      attachments.push({ file, originalName: a.originalName });
      files++;
    }
    tests.push({
      name: t.name,
      category: t.category,
      tags: t.tags,
      systemPrompt: t.systemPrompt,
      userPrompt: t.userPrompt,
      temperature: t.temperature,
      maxTokens: t.maxTokens,
      scoringMethod: t.scoringMethod,
      scoringConfig: t.scoringConfig,
      attachments,
    });
  }

  // Fournisseurs (sans clé ni état de clé) et modèles, rattachés à leur fournisseur par son nom.
  const providersListed = await session.call('GET', '/api/providers');
  const providers = (providersListed.providers ?? providersListed).map((p) => ({ name: p.name, type: p.type, baseUrl: p.baseUrl, maxConcurrency: p.maxConcurrency }));
  const modelsListed = await session.call('GET', '/api/models');
  const models = (modelsListed.models ?? modelsListed).map((m) => ({
    provider: m.providerName,
    apiModelId: m.apiModelId,
    displayName: m.displayName,
    color: m.color,
    inputPricePerM: m.inputPricePerM,
    outputPricePerM: m.outputPricePerM,
    priceSource: m.priceSource,
    supportsVision: m.supportsVision,
    supportsPdf: m.supportsPdf,
    contextWindow: m.contextWindow,
    enabled: m.enabled,
  }));

  const suitesListed = await session.call('GET', '/api/suites');
  const suites = (suitesListed.suites ?? suitesListed).map((s) => ({
    name: s.name,
    description: s.description,
    tests: s.tests.filter((x) => !x.archived).map((x) => x.name),
  }));

  await writeFile(path.join(outDir, 'tests.json'), `${JSON.stringify({ version: 1, providers, models, tests, suites }, null, 2)}\n`);
  console.log(
    `Exporté dans ${outDir} : ${providers.length} fournisseurs (sans clé), ${models.length} modèles, ${tests.length} tests, ${files} pièces jointes, ${suites.length} suites.`,
  );
} finally {
  await session.close();
}
