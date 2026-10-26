# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Eksplodo · Comparateur IA: the same tests (prompts, images, PDF) are sent to several AI models, the answers are scored (expected answer, AI judge or blind manual scoring), then models are ranked on quality, speed, cost and reliability. Functional rules live in `docs/developpement.md` (scoring, score formula, sharing) and `docs/deploiement.md`; the original spec is `docs/superpowers/specs/2026-10-16-comparateur-ia-design.md`.

## Commands

```bash
docker compose up -d db          # MariaDB 11.8 on 127.0.0.1:3307 (root / test), required by server tests and dev
npm run dev                      # API (tsx watch, :3000) + Vite (:5173, proxies /api, /internal, /health)
npm run typecheck                # server, web and node tsconfigs
npm test                         # all Vitest projects (server + web) + coverage summary (report: coverage/index.html)
npx vitest run server/test/run-control.test.ts            # one file
npx vitest run web/src/pages/RunPage.test.tsx -t "série terminée"   # one test by name
npx vitest run --project server  # or --project web
npm run build                    # dist/web (Vite) + dist/server (tsc)
```

Local dev reads `.env` (copy `.env.example`). `APP_ENCRYPTION_KEY` is mandatory; `AIC_FAKE_LLM=1` swaps every provider for a fake one (no paid call; prompt directives like `[[fake:500]]`, `[[fake:length]]` trigger errors or truncation, see `docs/developpement.md`). Provider API keys are never in `.env`: they are entered in the Fournisseurs screen and stored encrypted (AES-256-GCM) in the database.

Admin scripts (`npm run import:tests`, `export:tests`, `set:max-tokens`, `set:criteria`) call a running app's API with an Admin account; e-mail and password are typed at the prompt (`scripts/lib/admin-session.mjs`).

## Architecture

Single Node process: Fastify serves the API and the built SPA (`server/src/plugins/static.ts`). `server/src/index.ts` starts the HTTP server, two job workers (main queue, plus a fast lane for `quick_try`) and a scheduler loop; `startup.ts` runs Drizzle migrations (`server/drizzle/`, generated with drizzle-kit from `server/src/db/schema/*`) and installs the first-run seed (`server/seed/`, once per database lifetime).

**Server modules** (`server/src/modules/<domain>/`): `*.routes.ts` (Zod validation, `app.requireAdmin` / connected guards) → `*.service.ts` (business rules, transactions) → `*.repo.ts` (Drizzle queries). Errors are `ValidationError` / `ConflictError` / `NotFoundError` / `AppError` from `server/src/errors.ts`, mapped to HTTP codes. Mutating requests need the CSRF header `x-csrf-token` (cookie `aic_csrf`), which `web/src/api/client.ts` adds.

**Runs (séries)** are the core flow:
- Launch copies each test into `run_tests.snapshot` (`modules/runs/snapshot.ts`): a run never re-reads the live test, so later edits to a test do not change it (except `rerunResults` with `refreshMaxTokens`, which copies the current `maxTokens`).
- One `results` row per (run test, model, repetition). Retrying or re-running updates that row in place; there is no attempt history.
- Execution is a DB-backed job queue (`modules/jobs/queue.ts`, table `jobs`). Only the job in `runs.activeJobId` may work on a run. `modules/runs/engine.ts` (`executeRunSlice`) runs in slices of `SLICE_MS`, claims a result with a conditional `pending → running` update, respects run concurrency, per-provider limits and the run budget (pauses with reason `budget`), then chains the next slice. Judge calls are items of the same run.
- Control actions (pause, resume, retry errors, cancel pending, rerun a selection, add models, rescore) live in `modules/runs/runs.service.ts` and `modules/scoring/rescore.ts`, and take a row lock via `withLockedRun`.
- A process restart leaves in-flight results `running`; the run is picked up again once its job is stale (`STALE_AFTER_MS`, 15 min) or via `recoverRuns`.

**Provider calls**: adapters in `modules/providers/` (`anthropic.ts`, `openai-compatible.ts` with an OpenRouter parser, `google.ts`, `fake.ts`) behind `registry.ts`, all streaming. `modules/runs/call.ts` holds `CALL_TIMEOUT_MS` (10 min) and `withReasoningMargin`: the limit sent is the test's `maxTokens` + 4000 reasoning margin, capped at `MAX_REQUEST_TOKENS` (also the editor/API maximum, kept in sync in `tests.routes.ts`, `tests/seed.ts`, `TestEditorPage.tsx`, `scripts/set-max-tokens.mjs`). An empty answer cut by the limit is stored as `truncated`. Anthropic reports reasoning inside `outputTokens` with no `reasoningTokens`.

**Scoring**: `modules/scoring/aggregate.ts` computes per-model quality as the mean over tests of the mean of scored repetitions, using only `done` results (errors, timeouts and truncated answers are excluded from quality; errors and timeouts count against reliability). The final score is the Admin override when set, otherwise the method's score. Rankings are computed at read time; nothing aggregated is stored. Blind manual scoring hides answers, metrics and scores from a User until they have scored the question (`maskHiddenRow`).

**Web** (`web/src/`): React 19 + React Router (`app/routes.tsx`), TanStack Query with keys exported from `api/*.ts`, pages in `pages/`, domain components in `components/<domain>/`. Colors are Tailwind 4 theme tokens in `theme/theme.css` (`@theme`); a light theme overrides the same tokens under `html[data-theme="light"]` (toggle in the account menu, `app/preferences.ts`), where `--color-white` means "strong text" and becomes dark, so use `text-[#fff]` for text that must stay white on a dark surface. Public share pages (`/p/<token>`) are built field by field by `modules/sharing/public-share.ts`.

## Tests

- Server tests (`server/test/`) hit a real MariaDB: each test creates a throwaway database `test_<12 hex>` through `helpers/test-db.ts` and builds the app with `helpers/test-app.ts`. A crashed run can leave orphan `test_*` databases that slow later runs; only those may be dropped.
- Web tests (`web/src/**/*.test.tsx`, jsdom) mock the HTTP layer with `vi.mock('../../api/client')` and a stubbed `apiFetch`.
- Vitest runs at most 4 workers (`vitest.config.ts`).

## Conventions

- UI text and code comments are in French. Unknown values display as `-` (`DASH` in `web/src/components/results/format.ts`).
- Deployment is described in `docs/deploiement.md`. A deploy restarts the process and interrupts running series (see above).
