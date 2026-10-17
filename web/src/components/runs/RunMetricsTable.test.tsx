import { render, screen, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { ResultRow } from '../../api/runs';
import { median, modelMetrics, RunMetricsTable } from './RunMetricsTable';

const row = (over: Partial<ResultRow>): ResultRow => ({
  id: 'x',
  runTestId: 'rt',
  testName: 'T',
  category: 'C',
  modelId: 'm1',
  modelName: 'A',
  color: '#F0631F',
  repetition: 1,
  status: 'done',
  attempts: 1,
  responseText: '',
  finishReason: 'stop',
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: null,
  tokensEstimated: false,
  ttftMs: null,
  totalMs: null,
  tokensPerS: null,
  costUsd: null,
  costSource: null,
  errorCode: null,
  errorMessage: null,
  scoreStatus: 'pending',
  completedAt: null,
  hiddenUntilScored: false,
  ...over,
});

test('médiane : impaire, paire, vide', () => {
  expect(median([9, 1, 5])).toBe(5);
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(median([])).toBeNull();
});

test('métriques par modèle : réussis, erreurs (erreur + délai), médianes des réussis, coût moyen par réponse réussie', () => {
  const metrics = modelMetrics([
    row({ ttftMs: 400, tokensPerS: 50, costUsd: 0.002 }),
    row({ modelId: 'm2', modelName: 'B', color: '#3FA2E0', status: 'unsupported' }),
    row({ ttftMs: 600, tokensPerS: 70, costUsd: 0.004 }),
    row({ status: 'error', ttftMs: 99 }),
    row({ status: 'timeout' }),
    row({ status: 'pending' }),
  ]);
  expect(metrics).toEqual([
    { modelId: 'm1', modelName: 'A', color: '#F0631F', successes: 2, errors: 2, medianTtftMs: 500, medianTokensPerS: 60, meanCostUsd: 0.003 },
    { modelId: 'm2', modelName: 'B', color: '#3FA2E0', successes: 0, errors: 0, medianTtftMs: null, medianTokensPerS: null, meanCostUsd: null },
  ]);
});

test('réponses masquées avant notation (mesures nulles) : réussites comptées, mesures « — »', () => {
  const hidden = { hiddenUntilScored: true, attempts: null, responseText: null, finishReason: null, inputTokens: null, outputTokens: null, completedAt: null };
  const rows = [row(hidden), row(hidden)];
  expect(modelMetrics(rows)).toEqual([
    { modelId: 'm1', modelName: 'A', color: '#F0631F', successes: 2, errors: 0, medianTtftMs: null, medianTokensPerS: null, meanCostUsd: null },
  ]);
  render(<RunMetricsTable rows={rows} />);
  const cells = within(screen.getByRole('row', { name: /A/ })).getAllByRole('cell');
  expect(cells.map((c) => c.textContent)).toEqual(['2', '0', '—', '—', '—']);
});
