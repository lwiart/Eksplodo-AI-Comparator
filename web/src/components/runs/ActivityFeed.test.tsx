import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { RunProgress } from '../../api/runs';
import { ActivityFeed } from './ActivityFeed';

type Activity = RunProgress['activity'][number];

const item = (over: Partial<Activity>): Activity => ({
  resultId: 'x',
  testName: 'Rédaction',
  modelId: 'm1',
  modelName: 'Claude Opus',
  color: '#F0631F',
  status: 'done',
  totalMs: 3100,
  costUsd: 0.002,
  completedAt: '2026-10-17T12:31:57.000Z',
  hiddenUntilScored: false,
  ...over,
});

test('fil d’activité : durée affichée, ou « Réponse reçue » quand elle est masquée avant notation', () => {
  render(
    <ActivityFeed
      activity={[item({ resultId: 'a' }), item({ resultId: 'b', modelName: 'GPT Test', totalMs: null, costUsd: null, hiddenUntilScored: true })]}
    />,
  );
  const [visible, hidden] = screen.getAllByRole('listitem');
  expect(visible).toHaveTextContent('Claude Opus');
  expect(visible).toHaveTextContent(/Réponse en 3,1\s?s/);
  expect(hidden).toHaveTextContent('GPT Test');
  expect(hidden).toHaveTextContent('Réponse reçue');
});

test('fil d’activité : réponse tronquée signalée comme telle', () => {
  render(<ActivityFeed activity={[item({ resultId: 't', status: 'truncated', totalMs: 9000 })]} />);
  expect(screen.getByRole('listitem')).toHaveTextContent('Tronquée : limite de tokens atteinte');
});
