# Phase 3 notes — Cowork completeness (resume-after-restart, running-tasks surface, one-click VPS attach, cross-device hand-off, parallel local sessions)

Built 2026-11-28 on base `6b92f6f6` (Phase 2). No version bump, no release, no push.

## What was built

### 1. Long-task durability: resume after restart

- **Task queue** (`server/tasks-store.ts`, `server/routes/task-queue.ts`): a store opened over a data dir left by a previous process reconciles claimed or running tasks back to queued, with the lock cleared and the assignee kept, so a restart never leaves a task stuck behind a dead lock. The reconciliation is a history entry ("interrupted by restart"), not a failed attempt, so it does not count against the retry budget.
- **Batches** (`server/batch-runner/batch-runner.ts`, `server/routes/batches.ts`): the batch runner now persists every batch to `batches.json` in the data dir (memory-only when no data dir is given, preserving the old behaviour) and can resume one: `POST /api/internal/batches/:id/resume` re-runs only the prompts that never ran, in order. `GET /api/internal/batches/:id` reports a batch plus live status counts. The production runner is constructed with the data dir (`server/index.ts`).
- **Chat turns cut by shutdown**: already covered before this phase — `noteTurnsCutByShutdown` appends a "turn interrupted — SanRemes restarted" notice on a graceful shutdown. A turn cut by a crash has no durable in-flight record (turn state lives in the in-memory coordinator), so there is nothing to resume from; see "Deferred" below.

### 2. Running-tasks surface

- **Server** (`shared/running-tasks.ts`, `server/running-tasks.ts`, `server/routes/running-tasks.ts`): `GET /api/running` lists everything working right now — live turns (coordinator, including the host's own "source" turn and turns waiting on an answer), routine runs, tasks a bot holds, unfinished batches — oldest first. Rows are filtered to what the signed-in person may see (bot visible, and chat visible for chat rows).
- **UI** (`src/components/RunningTasksPage.tsx`, `src/lib/running-tasks.ts`): a sidebar **Running** page (Tools, next to Jobs) that polls every 5 seconds and shows each row's kind, title, bot, and how long it has been running. A row opens its chat; **Stop** ends that bot's work now (`POST /api/turns/stop`) and **Pause** pauses the bot, which also stops its work now (`POST /api/paused`). Both endpoints already existed; the page reuses them.
- **Wiring** (`src/state/store.tsx`, `src/App.tsx`, `src/components/SidebarFooterNav.tsx`, `src/components/lazy-screens.tsx`): new `running` view and `showRunning` action. `server/index.ts` is unchanged in line count (15,202); `src/state/store.tsx` is unchanged (3,258) — both edits are in place.

### 3. VPS attach, verify, detach

- **Server** (`server/routes/vps-attach.ts`): `POST /api/vps/verify` runs `docker -H ssh://<alias> info` and reports `ok` / `unreachable` / `docker`, with a plain-words message and the `ssh <alias> true` hint when the host cannot be reached. `POST /api/vps/attach` verifies first, then refuses in plain words when the bot is busy, is already on a different server, or the server cannot be reached, and is a no-op when the bot is already on that server. `POST /api/vps/detach` refuses while a live container is still on the server (naming the `docker rm -f` command) and detaches anyway when the server cannot be reached, naming what may be left behind — a server that cannot be reached never traps a bot.
- **UI** (`src/components/keys/VpsServerEditor.tsx`): each named server in Settings → API keys → Self-hosted VPS now has a **Test connection** button next to Save, showing the server's plain-words answer inline. The per-bot server picker already existed in Bot settings → Computer; the attach/detach endpoints are the same path the picker writes (`vpsAlias` / `cloudBackend`).

### 4. Cross-device hand-off

- **Server** (`server/routes/task-queue.ts`, `server/tasks-store.ts`): `GET /api/tasks/:id/export` returns a versioned export of one task; `POST /api/tasks/import` queues a fresh copy on this home, keeping the original's notes and history plus a "handed off from another home" entry. The live turn itself cannot move — it runs in the first device's memory — so the imported copy always starts queued and the turn must be stopped first or left to finish. Documented in `docs/multi-device.md` ("Handing one task to another device").

### 5. Parallel sessions (local)

- **Server** (`server/parallel-sessions.ts`, `server/routes/parallel-sessions.ts`): `POST /api/parallel-sessions` starts a session for a queued task on its own branch (`sanremes/<taskId>`) in its own git worktree under `<dataDir>/parallel-worktrees/<taskId>`, so sessions never fight over one checkout. The worktree is made first, then the task is claimed; if the claim races away, the worktree and branch are removed. `GET /api/parallel-sessions/:id` refreshes the session and reports merge conflicts (`diff --name-only --diff-filter=U`) in plain words; it never merges, rebases, or checks anything out. `POST /api/parallel-sessions/:id/pr` opens a PR with `gh pr create` and refuses a conflicted session or a missing `gh` in plain words. `POST /api/parallel-sessions/:id/close` records the close only — it never deletes a worktree or branch. Sessions persist in `parallel-sessions.json` in the data dir.

## Verification

Gates on the final tree (base `6b92f6f6` plus this work, uncommitted):

- Focused tests: **62 passed, 0 failed** across 9 files (`tasks-store` 14, `batch-runner` 8, `routes/batches` 5, `routes/task-queue` 12, `running-tasks` 3 + `routes/running-tasks` 2, `routes/vps-attach` 8, `parallel-sessions` 8 + `routes/parallel-sessions` 2). Full `pnpm test` never finishes on this VM; focused runs are the accepted standard. The file-size ratchet passes (1 passed).
- Typecheck: pass (`tsc -b && tsc -p tsconfig.server.json && tsc -p packages/phone-protocol/tsconfig.json`), run alone.
- Lint: **0 warnings, 0 errors** (`oxlint --deny-warnings`, 7,795 files).
- i18n: valid, **16 languages**, 12,220 English strings (`node scripts/generate-locale.mjs --check`).
- Isolated fixture doctor: `"ok": true`, `"problems": []` at `http://127.0.0.1:22087`. The fixture also exercised the new endpoints live: `GET /api/running` returned an empty list, `GET /api/parallel-sessions` returned an empty list, `POST /api/vps/verify` with a bogus alias returned a plain-words refusal, and a task was created, exported, and imported back with the hand-off history entry. Fixture server log: `/tmp/sanremes-verification-evidence/server-1795847478973-8365.log`. Recipe: `docs/verification/running-tasks.md`.

## Cloud-dependent (Phase 5)

These items from the Phase 3 plan need real Cloud infrastructure that does not exist locally. They were not faked; the local equivalents above are what shipped instead.

- **Parallel CLOUD sessions** (plan row 21, cloud side): multiple agent sessions sharing a repo and opening PRs from hosted machines. Local equivalent built: parallel local sessions on worktrees (section 5). The hosted side needs Cloud runners, per-session machines, and hosted git credentials.
- **Cloud hand-off as the default** (plan row 22, cloud side): a task started on one device continuing on another without the person exporting and importing it. Local equivalent built: task export/import through the already-connected home (section 4). The default needs a Cloud service that holds the in-flight task state between devices.
- **Managed cloud environments** (plan row 46, cloud side): a remote computer that SanRemes provisions and runs for the person, with no server of their own. Local equivalent built: one-click attach/verify/detach for the person's own VPS (section 3). The managed side needs a Cloud host that provisions machines and bills for them.
- **Managed agents platform** (plan row 44, cloud side): hosted agents that run without the person's computer on. Nothing local stands in for this; it is entirely Phase 5.

## Deferred (local, with reasons)

- **Resume of a chat turn cut by a crash**: no durable in-flight turn record exists (turn state lives in the in-memory coordinator), so a crashed turn cannot be resumed — it is reported as interrupted only when the shutdown was graceful. Building a durable turn journal is a bigger change than this phase; the graceful-shutdown notice already covers the common case.
- **Parallel-sessions UI**: the API is done and sessions are visible through the task queue plus `GET /api/parallel-sessions`, but the Running page lists turns, routines, tasks, and batches only — no per-session section. A session's work already surfaces as its claimed task row.
- **Per-bot VPS attach picker UI**: the picker already exists in Bot settings → Computer, and the new endpoints plus the Settings "Test connection" button are the productised path. No second picker was added.
- **Running page in a browser**: no browser test covers the page itself; the server list and the page's API calls are covered by the focused suites and the live fixture checks above.
