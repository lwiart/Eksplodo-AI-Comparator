import { apiFetch } from './client';

// Types miroirs de server/src/modules/scoring/manual.service.ts.
export type TodoItem = { runTestId: string; runId: string; runName: string; testName: string; answers: number; scoredByMe: number };

export type BlindAnswer = { letter: string; responseText: string; myScore: number | null; myComment: string | null };

/** Question à l'aveugle : `reveal` n'est présent que lorsque le compte a noté toutes les réponses. */
export type BlindQuestion = {
  runTestId: string;
  runName: string;
  testName: string;
  systemPrompt: string | null;
  userPrompt: string;
  attachments: { index: number; originalName: string; mime: string }[];
  answers: BlindAnswer[];
  complete: boolean;
  reveal?: { letter: string; modelName: string; color: string }[];
};

export type ManualScoreInput = { letter: string; score: number; comment?: string };

export type SpreadItem = {
  resultId: string;
  runTestId: string;
  testName: string;
  modelName: string;
  raters: number;
  mean: number | null;
  stdDev: number | null;
  scores: { userName: string; score: number; comment: string | null }[];
};

export const TODO_KEY = ['scoring', 'todo'] as const;
export const questionKey = (runTestId: string) => ['scoring', 'question', runTestId] as const;

const enc = encodeURIComponent;

export async function getTodo(): Promise<TodoItem[]> {
  return (await apiFetch<{ items: TodoItem[] }>('/api/scoring/todo')).items;
}

/** Nombre de questions que le compte n'a pas encore notées en entier. */
export const countToScore = (items: TodoItem[]): number => items.filter((i) => i.scoredByMe < i.answers).length;

export function getQuestion(runTestId: string): Promise<BlindQuestion> {
  return apiFetch<BlindQuestion>(`/api/scoring/questions/${enc(runTestId)}`);
}

export function saveQuestionScores(runTestId: string, scores: ManualScoreInput[]): Promise<BlindQuestion> {
  return apiFetch<BlindQuestion>(`/api/scoring/questions/${enc(runTestId)}/manual`, { method: 'PUT', body: { scores } });
}

export const attachmentUrl = (runTestId: string, index: number): string =>
  `/api/scoring/questions/${enc(runTestId)}/attachments/${index}`;

export async function getSpread(runId: string): Promise<SpreadItem[]> {
  return (await apiFetch<{ items: SpreadItem[] }>(`/api/scoring/runs/${enc(runId)}/spread`)).items;
}
