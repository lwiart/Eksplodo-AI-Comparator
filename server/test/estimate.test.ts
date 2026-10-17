import { describe, expect, test } from 'vitest';
import {
  estimateInputTokens,
  estimateRun,
  isSupported,
  maxCallCostUsd,
  type ModelForEstimate,
} from '../src/modules/runs/estimate.js';
import { snapshotOf, type TestSnapshot } from '../src/modules/runs/snapshot.js';
import type { AttachmentRow } from '../src/modules/tests/tests.repo.js';

type SnapAttachment = TestSnapshot['attachments'][number];

const img = (id = 'img'): SnapAttachment => ({
  id,
  originalName: 'a.png',
  mime: 'image/png',
  size: 10,
  sha256: 'h',
  pages: null,
  storagePath: `attachments/t/${id}`,
});
const pdf = (pages: number, id = 'pdf'): SnapAttachment => ({
  id,
  originalName: 'a.pdf',
  mime: 'application/pdf',
  size: 10,
  sha256: 'h',
  pages,
  storagePath: `attachments/t/${id}`,
});

let seq = 0;
const snap = (over: Partial<TestSnapshot> = {}): TestSnapshot => ({
  testId: `t${++seq}`,
  name: 'Test',
  category: 'Cat',
  tags: [],
  systemPrompt: null,
  userPrompt: 'x',
  temperature: 0.2,
  maxTokens: 1000,
  scoringMethod: 'manual',
  scoringConfig: {},
  attachments: [],
  ...over,
});
const model = (over: Partial<ModelForEstimate> = {}): ModelForEstimate => ({
  id: `m${++seq}`,
  name: 'Modèle',
  inputPricePerM: 1,
  outputPricePerM: 1,
  supportsVision: true,
  supportsPdf: true,
  medianTotalMs: null,
  ...over,
});

describe('estimateInputTokens', () => {
  test('caractères ÷ 4 + 1 500 par image + 800 par page de PDF', () => {
    expect(
      estimateInputTokens(snap({ systemPrompt: 'a'.repeat(10), userPrompt: 'b'.repeat(30), attachments: [img(), pdf(3)] })),
    ).toBe(10 + 1500 + 2400);
  });
  test('arrondi au supérieur', () => {
    expect(estimateInputTokens(snap({ userPrompt: 'b'.repeat(5) }))).toBe(2);
  });
  test('PDF sans nombre de pages : une page', () => {
    expect(estimateInputTokens(snap({ userPrompt: '', attachments: [{ ...pdf(1), pages: null }] }))).toBe(800);
  });
});

describe('isSupported', () => {
  test('image : vision requise ; PDF : lecture de PDF requise ; texte seul : toujours', () => {
    const noVision = { supportsVision: false, supportsPdf: true };
    const noPdf = { supportsVision: true, supportsPdf: false };
    expect(isSupported(snap(), { supportsVision: false, supportsPdf: false })).toBe(true);
    expect(isSupported(snap({ attachments: [img()] }), noVision)).toBe(false);
    expect(isSupported(snap({ attachments: [img()] }), noPdf)).toBe(true);
    expect(isSupported(snap({ attachments: [pdf(1)] }), noPdf)).toBe(false);
    expect(isSupported(snap({ attachments: [pdf(1)] }), noVision)).toBe(true);
  });
});

describe('maxCallCostUsd', () => {
  test('coût maximal d’un appel', () => {
    // 1 000 tokens d'entrée à 2 $/M + max_tokens 1 000 à 10 $/M = 0,012 $
    expect(
      maxCallCostUsd(snap({ userPrompt: 'x'.repeat(4000), maxTokens: 1000 }), model({ inputPricePerM: 2, outputPricePerM: 10 })),
    ).toBeCloseTo(0.012, 9);
  });
});

describe('estimateRun', () => {
  const base = { repetitions: 1, concurrency: 4, judge: null };

  test('combinaisons non supportées exclues du coût et comptées à part', () => {
    const tests = [snap({ userPrompt: 'x'.repeat(4000), maxTokens: 1000 }), snap({ userPrompt: '', maxTokens: 1000, attachments: [img()] })];
    const withVision = model({ inputPricePerM: 2, outputPricePerM: 10 });
    const noVision = model({ inputPricePerM: 2, outputPricePerM: 10, supportsVision: false });
    const e = estimateRun({ ...base, repetitions: 2, tests, models: [withVision, noVision] });
    expect(e.calls).toBe(8);
    expect(e.unsupported).toBe(2);
    const perNoVision = e.perModel.find((p) => p.modelId === noVision.id)!;
    expect(perNoVision).toMatchObject({ calls: 4, unsupported: 2 });
    // sans vision : seul le test texte est facturé (0,012 $ × 2 répétitions)
    expect(perNoVision.maxCostUsd).toBeCloseTo(0.024, 9);
    // avec vision : texte 0,012 + image (1 500 × 2 $/M + 1 000 × 10 $/M = 0,013), × 2
    expect(e.perModel.find((p) => p.modelId === withVision.id)!.maxCostUsd).toBeCloseTo(0.05, 9);
    expect(e.modelsMaxCostUsd).toBeCloseTo(0.074, 9);
    expect(e.maxCostUsd).toBeCloseTo(0.074, 9);
  });

  test('24 tests × 6 modèles × 2 répétitions = 288 appels', () => {
    const tests = Array.from({ length: 24 }, () => snap());
    const models = Array.from({ length: 6 }, () => model());
    const e = estimateRun({ ...base, repetitions: 2, tests, models });
    expect(e.calls).toBe(288);
    expect(e.unsupported).toBe(0);
    expect(e.perModel).toHaveLength(6);
    expect(e.perModel.every((p) => p.calls === 48)).toBe(true);
  });

  test('juge : seulement les tests notés par le juge, 800 tokens de sortie', () => {
    const judged = snap({
      userPrompt: 'a'.repeat(400),
      maxTokens: 500,
      scoringMethod: 'judge',
      scoringConfig: { criteria: 'c'.repeat(200), reference: 'r'.repeat(200) },
    });
    const manual = snap({ scoringMethod: 'manual' });
    const judge = model({ inputPricePerM: 3, outputPricePerM: 15 });
    const m = model({ inputPricePerM: 0, outputPricePerM: 0 });
    const e = estimateRun({ ...base, repetitions: 2, tests: [judged, manual], models: [m], judge });
    // entrée = 800 car. ÷ 4 + 500 + 300 = 1 000 tokens ; sortie 800 ; 2 appels de juge
    const perCall = (1000 * 3 + 800 * 15) / 1_000_000;
    expect(e.judgeMaxCostUsd).toBeCloseTo(2 * perCall, 9);
    expect(e.maxCostUsd).toBeCloseTo(e.modelsMaxCostUsd + e.judgeMaxCostUsd, 9);
  });

  test('juge : les appels non supportés (non exécutés) ne sont pas jugés', () => {
    const judged = snap({ attachments: [img()], scoringMethod: 'judge', scoringConfig: { criteria: 'c' } });
    const judge = model({ inputPricePerM: 1, outputPricePerM: 1 });
    const e = estimateRun({ ...base, tests: [judged], models: [model({ supportsVision: false })], judge });
    expect(e.judgeMaxCostUsd).toBe(0);
  });

  test('durée : médiane historique par modèle, 10 s par défaut, ÷ concurrence', () => {
    const tests = Array.from({ length: 10 }, () => snap());
    const a = model({ medianTotalMs: 4000 });
    const b = model({ medianTotalMs: null });
    // (4 s × 10 + 10 s × 10) ÷ 4 = 35 s
    expect(estimateRun({ ...base, tests, models: [a, b] }).durationSeconds).toBe(35);
  });

  test('avertissement si le juge est évalué', () => {
    const m = model();
    const e = estimateRun({ ...base, tests: [snap()], models: [m], judge: m });
    expect(e.warnings).toContain('Le modèle juge fait partie des modèles évalués');
    expect(estimateRun({ ...base, tests: [snap()], models: [m], judge: model() }).warnings).toEqual([]);
  });

  test('avertissement si le juge ne gère pas les pièces jointes des tests qu’il note', () => {
    const judged = (attachments: SnapAttachment[]) =>
      snap({ attachments, scoringMethod: 'judge', scoringConfig: { criteria: 'c' } });
    const tests = [judged([img()]), judged([pdf(2)]), judged([]), snap({ attachments: [img()] })];
    const judge = model({ supportsVision: false, supportsPdf: false });
    const e = estimateRun({ ...base, tests, models: [model()], judge });
    expect(e.warnings).toEqual(['Le juge ne gère pas les pièces jointes de 2 tests notés par le juge']);
  });

  test('aucun juge : coût du juge nul', () => {
    const e = estimateRun({ ...base, tests: [snap({ scoringMethod: 'judge', scoringConfig: { criteria: 'c' } })], models: [model()] });
    expect(e.judgeMaxCostUsd).toBe(0);
  });
});

describe('snapshotOf', () => {
  const row = (id: string, deletedAt: Date | null): AttachmentRow => ({
    id,
    testId: 't',
    originalName: `${id}.png`,
    mime: 'image/png',
    size: 5,
    storagePath: `attachments/t/${id}`,
    sha256: 'abc',
    pages: null,
    deletedAt,
    createdAt: new Date(),
  });
  const test_ = {
    id: 'test-1',
    name: 'N',
    category: 'C',
    tags: ['a'],
    systemPrompt: 'S',
    userPrompt: 'U',
    temperature: 0.5,
    maxTokens: 200,
    scoringMethod: 'judge' as const,
    scoringConfig: { criteria: 'x' },
    archivedAt: null,
    usedInRuns: 3,
    createdAt: 'd',
    updatedAt: 'd',
  };

  test('copie les champs utiles, ignore les pièces jointes retirées, garde storagePath', () => {
    const s = snapshotOf(test_, [row('a', null), row('b', new Date())]);
    expect(s).toEqual({
      testId: 'test-1',
      name: 'N',
      category: 'C',
      tags: ['a'],
      systemPrompt: 'S',
      userPrompt: 'U',
      temperature: 0.5,
      maxTokens: 200,
      scoringMethod: 'judge',
      scoringConfig: { criteria: 'x' },
      attachments: [
        { id: 'a', originalName: 'a.png', mime: 'image/png', size: 5, sha256: 'abc', pages: null, storagePath: 'attachments/t/a' },
      ],
    });
  });

  test('copie profonde : modifier le test ensuite ne change pas l’instantané', () => {
    const s = snapshotOf(test_, []);
    test_.tags.push('b');
    expect(s.tags).toEqual(['a']);
  });
});
