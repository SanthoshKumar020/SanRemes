# Phase 5 notes — Cloud and managed platform (managed agents, cloud-session coordination, hosted batch, cloud hand-off default, usage metering)

Built 2026-11-28 on base `7cd6fe49` (Phase 4). No version bump, no release, no push.

## What was built

### 1. Managed agents (plan row 44)

- **Store** (`server/managed-agents.ts`, wire types in `shared/managed-agents.ts`): a named definition — bot, instructions, schedule (manual, daily, interval, or follows a linked routine), allowed tools, spend cap in dollars or tokens over a day or month, executor preference — persisted in `managed-agents.json`, with run history (completed / failed / stopped, executor, duration, reported usage, plain-words error), pause/resume, and create-from-routine (daily and plain interval schedules map over; cron, once, limit-reset and windowed interval schedules follow the routine instead, schedule type `routine`).
- **Runner** (`runManagedAgent`, `runDueManagedAgents`): a cap stop is recorded and never executed; a failure is recorded in plain words; a success books its reported usage to the ledger. A run already going refuses a second one. Due agents tick every 60 seconds from the server (`server/index.ts`), skipping the tick while a move freeze is in force.
- **Routes** (`server/routes/managed-agents.ts`): `GET/POST /api/managed-agents`, `POST /api/managed-agents/from-routine`, `GET/PATCH/DELETE /api/managed-agents/:id`, `POST …/run` (202, runs in the background), `POST …/pause|resume`. Runs are filtered to what the signed-in person may see.
- **UI** (`src/components/ManagedAgentsPage.tsx`, `src/lib/managed-agents.ts`): a sidebar **Managed agents** page (Tools, next to Running) with the agent list, create form, run now, pause/resume, delete, last/next run, and the hand-off and usage sections below.

### 2. Parallel cloud sessions (plan row 21, hosted side)

- **Executor contract** (`server/executors.ts`): one interface for running a prompt, starting/refreshing a session, opening its PR, and closing it. The local implementation delegates to the Phase 3 worktree/session code (`server/parallel-sessions.ts`) with the same `sanremes/<taskId>` branch convention; the cloud implementation is a stub that refuses every call in plain words ("No cloud executor is attached").
- **Routes** (`server/routes/cloud-sessions.ts`): `GET/POST /api/cloud-sessions`, `GET /api/cloud-sessions/:id`, `POST …/pr`, `POST …/close`, resolved through the executor registry. The local and cloud session routes share one `ParallelSessionStore` instance, so the two lists can never diverge.

### 3. Hosted batch service (plan row 49, hosted side)

- **Routes** (`server/routes/hosted-batches.ts`): `POST /api/hosted-batches` takes a batch definition (bot + prompts) and a target executor; the executor is decided before anything is queued, so a cloud target with no cloud executor attached falls back to local with a plain-words note and nothing is created twice. A local job runs in the background through the Phase 0 `BatchRunner`, one prompt per queued task. `GET /api/hosted-batches[/:id]` lists jobs and their per-item results.

### 4. Cloud hand-off as default

- **Decision** (`server/cloud-handoff.ts`, `server/routes/managed-agents.ts`): one setting, `GET/PUT /api/cloud-handoff`, with preference `auto` | `local` | `cloud`. The default is local until a cloud executor is attached; asking for cloud without one falls back to local and says so. The attachment point is the existing Cloud path (a Cloud home is itself the cloud executor; see "Needs hosted infrastructure" below) — no new cloud was invented. Managed agents, cloud sessions and hosted batches all resolve through the same registry (`createExecutorRegistry`).

### 5. Usage-based billing hooks

- **Ledger** (`server/usage-ledger.ts`): two new trigger kinds, `managed-agent` (agent id, name, executor, run id) and `cloud-job` (job id, label, executor), so the existing ledger, caps engine and usage pages can read them.
- **Report** (`server/cloud-usage-report.ts`, `server/routes/cloud-usage.ts`): `GET /api/cloud-usage/report` returns per-agent and per-job totals (runs, input/output tokens, cost, runs without reported usage) as JSON, or as CSV with `?format=csv` for the Cloud site to bill from. It carries amounts and counts only: no prices are invented, no payment form exists, no money moves.
- **Caps** (`server/managed-agents.ts`): `agentSpend` sums an agent's ledger rows over its cap period; a reached dollar or token cap stops the agent in plain words. The honest limit, stated in the UI and below: a cap can only stop an agent on usage its runs report. A local run through a bot turn reports no token counts here (the turn's own usage row is booked by the turn pipeline under its own trigger), so a token cap cannot stop a local run — the server-wide usage caps are what stop it.

## Verification

Gates on the final tree (base `7cd6fe49` plus this work, uncommitted):

- Focused tests: **96 passed, 0 failed** across 14 files (`executors` 7, `cloud-handoff` 5, `managed-agents` 15, `cloud-usage-report` 3, `routes/managed-agents` 3, `routes/cloud-sessions` 3, `routes/hosted-batches` 3, `routes/cloud-usage` 2, plus regression suites `usage-ledger`, `usage-trace/build`, `parallel-sessions`, `batch-runner`, `routes/parallel-sessions`, `routes/batches`). Full `pnpm test` never finishes on this VM; focused runs are the accepted standard. The file-size ratchet passes (1 passed); `server/index.ts` is unchanged at 15,202 lines and no new file exceeds 1,000 lines.
- Typecheck: pass (`tsc -b && tsc -p tsconfig.server.json && tsc -p packages/phone-protocol/tsconfig.json`), run alone.
- Lint: **0 warnings, 0 errors** (`oxlint --deny-warnings`).
- i18n: valid (`node scripts/generate-locale.mjs --check`).
- Isolated fixture doctor: `"ok": true`, `"problems": []` at `http://127.0.0.1:21997`. The fixture also exercised the new endpoints live: `GET /api/managed-agents` returned an empty list, `PUT /api/cloud-handoff` to `cloud` answered local with the plain-words note, a managed agent was created and its run-now completed on the local executor through the fake engine ("hello from fake claude"), a hosted batch was submitted and finished with the same fake reply, the agent was paused and deleted, and the usage CSV downloaded with headers only (no reported usage, as local runs report none). Fixture server log: `/tmp/sanremes-verification-evidence/server-1795850597417-18011.log`. Recipe: `docs/verification/managed-agents.md`.

## Needs hosted infrastructure

These are not built, and nothing above pretends they are. Each needs a real Cloud deployment to become live; how to verify each once it exists is noted.

- **A real cloud executor.** A machine (or pool) that implements the `AgentExecutor` interface in `server/executors.ts` — `runPrompt`, `startSession`, `refreshSession`, `openSessionPr`, `closeSession` — against a hosted repo and hosted git credentials, and registers itself with the executor registry. Verify: attach it, set the hand-off to `cloud`, run a managed agent and open a cloud session's PR; both must complete on the Cloud machine, and the agent's run must record `executor: "cloud"`.
- **Cloud executor attachment.** The handshake by which a Cloud home (or the Admin) proves a cloud executor to this server and the registry swaps the stub for it, plus what happens when it goes away mid-run (the run must fail in plain words, never hang). Verify: attach, detach, and detach mid-run; each state must read correctly from `GET /api/cloud-handoff` and `GET /api/cloud-sessions`.
- **Per-session machines and hosted git credentials.** Parallel cloud sessions need one hosted checkout per session and a credential that can push branches and open PRs without the person's laptop. Verify: two cloud sessions on one repo at once, both opening PRs, with no worktree or branch collision.
- **Cloud-side usage reporting.** The cloud executor must report input/output tokens and cost per run, so `agentSpend` and the usage report carry real numbers and the spend caps can stop a cloud run. Verify: a cloud run's tokens and cost appear in `GET /api/cloud-usage/report` and a token cap stops the next run.
- **Billing checkout on the Cloud site.** The usage report is the metering feed; the checkout itself lives on the external Cloud site and is not in this repo. Verify: the site reads `GET /api/cloud-usage/report?format=csv` for a Cloud home and bills the totals it shows.
- **Session records carry their executor.** `ParallelSession` has no executor field today, so refresh/PR/close go through the local executor — correct while only local sessions can exist, but a cloud-owned session must be refreshed and closed by its own executor. Verify: a cloud session's refresh and PR go to the cloud executor, not this computer.

## Deferred (with reasons)

- **Session executor field** (above): a one-field change to the Phase 3 session record and its zod schema; left out because no cloud-owned session can exist yet, and changing the record would ripple into Phase 3's tests for a field nothing can set.
- **Cloud-job ledger rows for local hosted batches**: a local batch's prompts run as bot turns whose usage the turn pipeline already books under its own trigger, so the batch books no `cloud-job` row of its own (a zero-token row would double-count turns in the Usage page). The jobs section of the usage report therefore fills only once a cloud executor reports usage.
- **Managed-agent runs through a linked routine's own firing**: an agent made from a routine follows the routine's schedule (`schedule: "routine"`) and the routine does the work; the agent's own run history covers manual runs and its own scheduled runs. Merging routine runs into the agent's history would double-report the same work.
- **The Managed Agents page in a browser**: no browser test covers the page itself; the server list and the page's API calls are covered by the focused suites and the live fixture checks above.
