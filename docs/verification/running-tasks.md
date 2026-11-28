# Running tasks: what's working right now

The sidebar's **Running** page lists everything working right now — live turns, routine runs, queued tasks held by a bot, and batch runs — oldest first, with how long each has been running. A row opens its chat; **Stop** ends that bot's work now and **Pause** pauses the bot (which also stops its work now). The page polls every 5 seconds.

The list comes from `GET /api/running` (`server/routes/running-tasks.ts`, rows collected in `server/running-tasks.ts`): live turns from the coordinator, routine runs from the routine manager, claimed or running tasks from the task queue, and unfinished batches from the batch runner. Rows are filtered to what the signed-in person may see: a row appears only if its bot is visible to them, and a chat row only if that chat is visible too.

A restart does not lose the work: tasks claimed or running when SanRemes restarts go back to the queue (`server/tasks-store.ts` reconciles them when the store opens), and an interrupted batch keeps its record in `batches.json` and can be resumed from where it stopped (`POST /api/internal/batches/:id/resume`). A chat turn cut by a graceful shutdown already gets a "turn interrupted — SanRemes restarted" notice in its chat; a turn cut by a crash has no durable record to resume from, so it is reported as interrupted rather than silently dropped.

## Automated checks

```sh
pnpm exec vitest run server/running-tasks.test.ts server/routes/running-tasks.test.ts server/tasks-store.test.ts server/batch-runner/batch-runner.test.ts server/routes/batches.test.ts server/routes/task-queue.test.ts
```

**What it does not prove:** the page itself in a browser (no browser test covers it yet), and a real restart of the app — the resume paths are covered by reopening the stores over the same data directory in the unit tests, not by restarting a fixture.
