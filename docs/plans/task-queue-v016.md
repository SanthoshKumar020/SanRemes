# Task queue v0.1.6 implementation plan

**Goal:** turn the v0.1.5 task-queue foundation into working multi-bot
coordination: the Jobs page shows the queue, bots hand work to each other
through it, every task's spend is accounted per bot, and a bot that hits its
cap stops claiming — while the Job Bot claims queued work by itself.

**For agentic workers:** implement the slices in order; each slice lands with
focused tests (`pnpm vitest run <file>`) and leaves `server/index.ts` at
exactly 15258 lines. Steps use checkbox (`- [ ]`) syntax for tracking.

## What v0.1.5 shipped (do not rebuild it)

- `shared/tasks.ts` — `taskSchema`, `taskStateSchema`
  (`queued | claimed | running | done | failed`), `taskAttemptSchema`
  (`{ at, result, botId? }`), `tasksFileSchema` (`{ version: 1, tasks }`).
- `server/tasks-store.ts` — `TasksStore` over `tasks.json` in `DATA_DIR`,
  modelled on `JobsStore`: zod validation, atomic whole-file rewrite via
  `writeFileAtomic`, in-memory cache + `version` counter, unreadable file
  replaced with defaults on the next save. `create / get / list(state?) /
  claim / complete / fail`. Claim succeeds only from `queued` and sets
  assignee + lock + history entry together; complete/fail accept only
  `claimed | running` held by the calling bot, release the lock, and append
  the outcome to `history`.
- `server/routes/task-queue.ts` — `createTaskQueueRoutes({ store, botExists? })`:
  `POST /api/tasks` (201), `GET /api/tasks` (optional `?state=` filter),
  `POST /api/tasks/:id/claim`, `/complete`, `/fail` (404 unknown task/bot,
  409 not-queued / not-claimed / locked-by-another). The module is **not
  wired into `server/index.ts` yet** — see slice 1.
- Naming that must not be confused: `server/routes/tasks.ts` is the
  conversation-task routes (`TaskRouteDeps`, `createTaskRoutes`); the queue
  is `task-queue.ts` / `createTaskQueueRoutes`. Likewise a queue `Task` is
  not a conversation `TaskRecord` in `server/store.ts`.

## Deliberate gaps in v0.1.5 (v0.1.6 closes them)

1. No route is wired: `index.ts` was not touched (file-size ratchet).
2. Nothing moves a task to `running`: the state exists, no transition does.
3. No requeue: a `failed` task stays failed; a `claimed` task whose bot died
   stays locked.
4. No cost attribution: turns are costed per bot already (`usage-caps.ts`),
   but nothing ties a turn's spend to the task it served.
5. No UI: no page reads `/api/tasks`.

## Global constraints

- Node runs server TS directly via `--experimental-strip-types`; imports use
  explicit `.ts` extensions; type-only imports must be `import type`.
- `server/index.ts` stays at exactly 15258 lines: wire the routes by
  extending the existing line-322 import chain and the existing
  `ROUTES.push(createJobBotRoutes(...))` statement, never by adding lines.
  `scripts/testing/index-route-ratchet.test.ts` enforces the related rule.
- New HTTP routes are modules under `server/routes/` (`server/routes/README.md`):
  a factory with explicit deps, never an `if` block in `index.ts`.
- `tasks.json` stays the single store: no Postgres, no second server, no new
  file per task. Whole-file rewrite only; `version` bumps only on change.
- One process writes the file, so the synchronous read-modify-write in
  `TasksStore` is the atomicity guarantee — same as `JobsStore.enqueue`.
  Do not add a lockfile or a second writer.
- Comments follow `AGENTS.md`: only what the code cannot say.
- i18n: every user-facing string on the new UI goes through the locale files;
  `pnpm i18n:check` must stay valid.

## Slice 1 — Wire the routes (half a day)

- [ ] In `server/index.ts`, add `TasksStore` + `createTaskQueueRoutes` to the
      line-322 import chain and a `ROUTES.push(createTaskQueueRoutes({
      store: new TasksStore({ dataDir: DATA_DIR }), botExists: (id) =>
      Boolean(store.bot(id)) }))` onto the `createJobBotRoutes` push
      statement. Verify `wc -l server/index.ts` is still 15258.
- [ ] Auth: the routes run behind the existing auth gate (`handleRequest`
      runs the table after it), like the Jobs routes. No new auth scheme.
- [ ] Scope: confirm the paths are covered by the scope rules keyed by path
      in `server/request-auth.ts`; if `/api/tasks` falls outside the
      authenticated surface, add it there and nowhere else.
- [ ] Verify with the isolated fixture (`docs/verification/README.md`):
      launch, `POST /api/tasks`, `GET /api/tasks`, claim/complete round
      trip, keep the log path as evidence.

## Slice 2 — claimed → running, stale locks, requeue (one day)

- [ ] `TasksStore.start(id, botId)`: `claimed` → `running`, only by the
      locking bot, history entry `{ result: "started" }`. Returns the same
      `null | "not-claimed" | "not-locked-by"` shape as `complete`/`fail`.
- [ ] `POST /api/tasks/:id/start` in `task-queue.ts`, same 404/409 shapes.
- [ ] Stale lock: a `claimed` task whose `lockedAt` is older than a lease
      (start with 30 minutes; no config surface yet) may be re-claimed by
      another bot — `claim` treats an expired lease as queued, and appends
      `{ result: "lock expired" }` to history before the new claim entry.
      The lease is a constant in `tasks-store.ts`, not a setting.
- [ ] `TasksStore.requeue(id)`: `failed` → `queued`, clears assignee and
      lock, history entry `{ result: "requeued" }`. `POST
      /api/tasks/:id/requeue` (person only — the route table already
      authenticates; no bot may call it: refuse when the caller is a bot
      turn, same way the Jobs approve path is person-gated).
- [ ] Retry cap: `requeue` refuses when the task already has 3 `failed`
      history entries; the route answers 409 with the attempt count. The
      person can still delete the task (slice 3) and recreate it.

## Slice 3 — Jobs-page queue UI (two days)

- [ ] Client: `src/lib/tasks.ts` following `src/lib/jobs.ts` (`request<T>`
      helper, one function per endpoint). No new fetch plumbing.
- [ ] Jobs page: a Queue section listing tasks newest first with state,
      assignee bot name, lock age, and history (expandable per task).
      Filter chips for the five states; a create form (title + goal +
      optional assignee picker from the bot roster).
- [ ] Per-task actions, gated on state: Claim (person claims on a bot's
      behalf — sends that bot's id), Start, Complete (with result text),
      Fail (with result text), Requeue (failed only). Every action shows the
      route's 409 reason verbatim when it fails.
- [ ] Delete: `TasksStore.remove(id)` + `DELETE /api/tasks/:id`, person
      only, only for `queued | done | failed`. A `claimed | running` task
      must be failed first — the route says so in its 409.
- [ ] i18n keys for every new string; `pnpm i18n:check` green.
- [ ] Verify headlessly per `docs/verification/chat-ui.md`: create, claim,
      complete in the real renderer against the isolated fixture.

## Slice 4 — Delegation between bots (two days)

- [ ] `TasksStore.delegate(id, fromBotId, toBotId)`: only from `queued`, or
      from `claimed | running` when `fromBotId` holds the lock. Sets
      `assigneeBotId`, releases the old lock when held, state back to
      `queued`, history entry `{ result: "delegated to <bot name>", botId:
      fromBotId }`. Unknown `toBotId` is refused by the route's `botExists`
      check before the store is touched.
- [ ] `POST /api/tasks/:id/delegate` with `{ botId, toBotId }`, same 404/409
      shapes. A bot delegates by calling it from its own turn; the person
      delegates from the queue UI (slice 3's Claim control becomes
      Claim/Delegate).
- [ ] Handoff text: when a bot delegates, the route (or the delegating turn)
      posts the task's `goal` plus the delegating bot's last history result
      into the new assignee's thread as its starting prompt — reuse the
      coordinator's hand-off path (`coordinator.job` / `startTurn(botId,
      prompt, ...)`), the same way `createJobBotRoutes` starts a Job Apply
      Bot turn. Do not invent a second hand-off mechanism.
- [ ] Rule: a bot may delegate only a task it holds or that is queued and
      assigned to it; it may never take a task off another bot. Enforce in
      the store, test both refusals.
- [ ] Chief routing: if a Chief bot exists for the team, a task created with
      no assignee is offered to the Chief first (Chief claims or delegates);
      otherwise it sits `queued` for any bot to claim. No new role system —
      reuse the existing Chief/team concepts only.

## Slice 5 — Per-bot cost ledger + auto-pause (two days)

- [ ] Attribution: `usage-caps.ts` already records every turn as a row with
      `botId` + `costUsd` (`noteUsage`) and already computes per-bot caps
      (`effectiveCaps` → `bots: Record<string, CapLimits>`, `capStates(...,
      botId?)`, `reachedCap(..., { botId })`). Do not build a second ledger
      file. The task ledger is a read view over those rows.
- [ ] `GET /api/tasks/ledger?botId=&month=` — per-bot spend for the month
      (USD + tokens, from `usageTotals`), plus per-task spend: a turn
      started for a task carries the task id (thread the task id through
      `startTurn`'s options the way the Job Bot threads `jobId` today), and
      the ledger groups that turn's rows under the task. Tasks with no
      attributed turn show `null`, not zero — zero would claim the work was
      free.
- [ ] Auto-pause: `claim` refuses with 409 `reason: "cap-reached"` when
      `reachedCap` reports the claiming bot's cap reached. The queue UI
      shows the cap state from `capStates` next to each bot in the assignee
      picker, and the ledger view shows the month's spend against the cap.
- [ ] Spend alert: when a bot crosses 80% of its cap (`CAP_WARN_PERCENT`),
      the existing `spendAlertText` / `takeSpendAlert` path fires once per
      bot per month — reuse it, do not add a second alert pipeline.
- [ ] Person override: the person can raise a bot's cap in Settings →
      Spending (existing surface); the queue never lets a bot raise its own.

## Slice 6 — Job Bot claims tasks (two days)

- [ ] Picker: on a schedule (reuse the routines system — a routine that
      runs the Job Bot, not a new timer) or when the person presses
      "Claim next" on the Jobs page, the Job Bot lists `queued` tasks
      (oldest first), skips any whose `assigneeBotId` names another bot,
      and claims the first one whose `goal` it can attempt. One claim per
      run: it finishes or fails that task before claiming another.
- [ ] Execution: claim → `start` when its turn starts → work the `goal` in
      its own thread → `complete` with a result line, or `fail` with the
      plain reason. The turn's reply is the result text: reuse the Job Bot
      `onSettled` pattern from `createJobBotRoutes` (`startSearch` /
      `startApply`), which already parses a turn's reply and records the
      outcome.
- [ ] Failure policy: a failed Job Bot task is requeued by the person or by
      slice 2's retry cap (3 attempts, then it stays `failed` for the
      person). The Job Bot never requeues its own failure.
- [ ] Concurrency: two bots claiming the same task at once is already
      decided by the store — the second gets 409. The Job Bot treats 409 as
      "someone else took it" and moves on to the next queued task, not as an
      error.
- [ ] Verify end to end in the isolated fixture with the fake engine:
      create a task, run the Job Bot routine, assert the task reaches `done`
      with the fake engine's result in history, and the ledger shows the
      turn's (fake) cost.

## Slice 7 — Hardening and release

- [ ] Focused tests for every new store method and route, following
      `server/tasks-store.test.ts` and `server/routes/task-queue.test.ts`.
- [ ] `pnpm typecheck`, `pnpm lint` (`oxlint --deny-warnings`), `pnpm
      i18n:check` green; `wc -l server/index.ts` still 15258.
- [ ] Isolated-fixture evidence for the queue UI and the Job Bot claim flow
      (log paths kept, per `docs/verification/README.md`).
- [ ] Version bump + changelog entry owned by the coordinator, not this plan.

## Open questions (decide before slice 4)

1. Should a bot be able to create tasks, or only the person? v0.1.5 lets any
   authenticated caller create; if bots creating tasks is unwanted, gate
   `POST /api/tasks` to the person in slice 1.
2. Lease length (slice 2): 30 minutes is a guess. A long-running research
   task legitimately holds a lock for hours — consider a heartbeat
   (`POST /api/tasks/:id/heartbeat` refreshing `lockedAt`) instead of a
   longer lease.
3. Ledger month boundaries: `monthKeyOf` is UTC in `usage-caps.ts`; the
   Jobs page shows local days. Confirm which the ledger uses before slice 5.

## Risks

- **Two writers:** if a second process ever writes `tasks.json` (backup
  restore, Cloud sync), the read-modify-write checkout can lose a claim.
  Mitigation: the file is owned by the server process only; restores go
  through the server, never by copying the file under it.
- **Lock expiry vs. long turns:** a bot mid-turn when its lease expires
  loses the task to another bot and its `complete` then 409s. The heartbeat
  in open question 2 is the fix; until then the lease must stay longer
  than the longest normal turn.
- **Cost attribution gaps:** turns started outside a task (person chatting
  directly) have no task id and never appear in the per-task ledger — that
  is by design, but the per-bot monthly total still counts them.
- **Scope creep:** Paperclip's org chart, RBAC, and multi-user half does not
  fit a single-user desktop app. This plan deliberately takes only the
  queue, delegation, and cost-cap ideas; see
  `~/workspace/repo-analysis/paperclip-analysis.md` for the full analysis.
