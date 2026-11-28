# Managed agents

The sidebar's **Managed agents** page lists long-running agents with their
schedule, last run and next run, and lets you create one, run one now, pause or
resume it, and delete it. The same page holds where work runs, the cloud
sessions list, the hosted batches list, and the usage report for billing.

The list comes from `GET /api/managed-agents`
(`server/routes/managed-agents.ts`, store and runner in
`server/managed-agents.ts`): definitions in `managed-agents.json`, run history
in the same file, spend caps read from the usage ledger (`agentSpend`). A run
now is `POST /api/managed-agents/:id/run`, which answers 202 at once and runs
the agent in the background through the executor the hand-off decision resolves
(`server/executors.ts`, `server/cloud-handoff.ts`). Due agents tick every 60
seconds on the server. Cloud sessions come from `GET /api/cloud-sessions`
(`server/routes/cloud-sessions.ts`) and hosted batches from
`GET /api/hosted-batches` (`server/routes/hosted-batches.ts`), both through the
same executor registry; the usage report comes from
`GET /api/cloud-usage/report` (`server/routes/cloud-usage.ts`,
`server/cloud-usage-report.ts`).

A restart does not lose the work: agents and their run history persist in
`managed-agents.json`, and the next tick picks the schedule up from
`nextRunAt`. A run in flight when the server restarts has no durable in-flight
record, so it leaves no run row — the same limit as a chat turn cut by a crash
(Phase 3 notes) — and the agent simply runs again at its next due time.

## Automated checks

```sh
pnpm exec vitest run server/executors.test.ts server/cloud-handoff.test.ts server/managed-agents.test.ts server/cloud-usage-report.test.ts server/routes/managed-agents.test.ts server/routes/cloud-sessions.test.ts server/routes/hosted-batches.test.ts server/routes/cloud-usage.test.ts
```

**What it does not prove:** the page itself in a browser (no browser test
covers it yet), and a real cloud executor — the cloud side is a stub that
refuses in plain words until Cloud infrastructure exists (see
`docs/plans/phase5-notes.md`, "Needs hosted infrastructure").
