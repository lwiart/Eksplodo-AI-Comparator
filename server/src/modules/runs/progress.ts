import type { ResultStatus, RunRow } from './runs.repo.js';

export type StatusCounts = {
  pending: number;
  running: number;
  done: number;
  error: number;
  timeout: number;
  unsupported: number;
  /** Réponses vides : la réflexion du modèle a épuisé la limite de tokens. */
  truncated: number;
  total: number;
};

export type MatrixCell = { modelId: string; pending: number; running: number; done: number; failed: number; unsupported: number; truncated: number };

export type RunProgress = {
  status: RunRow['status'];
  pauseReason: RunRow['pauseReason'];
  counts: StatusCounts;
  /** Notes du juge en attente (résultats `done` de tests notés par le juge) : « Notation en cours » sans appel restant. */
  judgePending: number;
  modelsCostUsd: number;
  judgeCostUsd: number;
  budgetUsd: number | null;
  /** Après une pause budget : coût maximal du prochain appel (le moins cher en attente), à ajouter à la dépense pour reprendre. */
  nextCallMaxCostUsd: number | null;
  startedAt: string | null;
  elapsedMs: number;
  etaSeconds: number | null;
  running: { modelId: string; testName: string }[];
  activity: {
    resultId: string;
    testName: string;
    modelId: string;
    modelName: string;
    color: string;
    status: ResultStatus;
    totalMs: number | null;
    costUsd: number | null;
    completedAt: string;
    /** Durée et coût masqués : question manuelle que l'Utilisateur n'a pas encore notée. */
    hiddenUntilScored: boolean;
  }[];
  matrix: { runTestId: string; testName: string; cells: MatrixCell[] }[];
  models: { id: string; name: string; color: string }[];
};

/** Nombre de résultats terminés présentés dans l'activité récente. */
export const ACTIVITY_LIMIT = 20;

export function emptyCounts(): StatusCounts {
  return { pending: 0, running: 0, done: 0, error: 0, timeout: 0, unsupported: 0, truncated: 0, total: 0 };
}

/** Additionne des comptes par statut. */
export function countsOf(rows: { status: ResultStatus; n: number }[]): StatusCounts {
  const c = emptyCounts();
  for (const r of rows) {
    c[r.status] += r.n;
    c.total += r.n;
  }
  return c;
}

export type ProgressInput = {
  run: RunRow;
  now: Date;
  models: { id: string; name: string; color: string }[];
  runTests: { id: string; name: string }[];
  cells: { runTestId: string; modelId: string; status: ResultStatus; n: number }[];
  running: { modelId: string; testName: string }[];
  activity: (Omit<RunProgress['activity'][number], 'completedAt'> & { completedAt: Date | null })[];
  /** Moyenne observée de `total_ms` des résultats `done` ; `null` sans mesure. */
  averageTotalMs: number | null;
  nextCallMaxCostUsd: number | null;
  judgePending: number;
};

/** Assemble l'avancement d'une série à partir des lectures du dépôt. */
export function buildProgress(input: ProgressInput): RunProgress {
  const { run, now } = input;
  const counts = countsOf(input.cells);
  const remaining = counts.pending + counts.running;
  const etaSeconds =
    input.averageTotalMs === null ? null : (remaining * input.averageTotalMs) / Math.max(1, run.concurrency) / 1000;
  const elapsedMs = run.startedAt ? Math.max(0, (run.completedAt ?? now).getTime() - run.startedAt.getTime()) : 0;

  const byCell = new Map<string, MatrixCell>();
  const cellOf = (runTestId: string, modelId: string): MatrixCell => {
    const key = `${runTestId}|${modelId}`;
    let cell = byCell.get(key);
    if (!cell) {
      cell = { modelId, pending: 0, running: 0, done: 0, failed: 0, unsupported: 0, truncated: 0 };
      byCell.set(key, cell);
    }
    return cell;
  };
  for (const c of input.cells) {
    const cell = cellOf(c.runTestId, c.modelId);
    if (c.status === 'error' || c.status === 'timeout') cell.failed += c.n;
    else cell[c.status] += c.n;
  }

  return {
    status: run.status,
    pauseReason: run.pauseReason,
    counts,
    judgePending: input.judgePending,
    modelsCostUsd: run.modelsCostUsd,
    judgeCostUsd: run.judgeCostUsd,
    budgetUsd: run.budgetUsd,
    nextCallMaxCostUsd: input.nextCallMaxCostUsd,
    startedAt: run.startedAt?.toISOString() ?? null,
    elapsedMs,
    etaSeconds,
    running: input.running,
    activity: input.activity.map((a) => ({ ...a, completedAt: a.completedAt!.toISOString() })),
    matrix: input.runTests.map((t) => ({
      runTestId: t.id,
      testName: t.name,
      cells: input.models.map((m) => cellOf(t.id, m.id)),
    })),
    models: input.models,
  };
}
