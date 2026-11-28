# Enterprise admin

The admin surface for teams: who may do what, how long evidence is kept, compliance mode, and
the Motion paid toggle. It is an API surface; there is no Settings page for it yet.

## Who may do what

Three team roles come from the Admin's pairing claim: owner, admin, member (`server/cloud-team.ts`).
What each may do here is in `server/team-capabilities.ts`:

| Capability | Owner | Admin | Member |
|---|---|---|---|
| Read the audit posture (`GET /api/admin/retention`, `/api/admin/compliance`, `/api/admin/motion`) | yes | yes | no |
| Export the audit log (`GET /api/decisions?from&to`, `/api/decisions.csv`, `/api/admin-activity.csv`) | yes | yes | no |
| Change retention (`PUT /api/admin/retention`) | yes | no | no |
| Change compliance mode (`PUT /api/admin/compliance`) | yes | no | no |
| Change the Motion toggle (`PUT /api/admin/motion`) | yes | no | no |

No fourth team role was added: roles are assigned by the Admin, and this machine cannot invent one the
Admin will not issue. The finer distinction this phase enforces is the owner/admin split on settings
changes: retention and compliance settings change what evidence is kept, so only the owner changes them.
An admin reads and exports the audit log but cannot rewrite its keeping. `GET /api/admin/capabilities`
reports the caller's own role and capabilities.

On a server one person uses, the owner is the loopback caller or a session with the admin scope and no
team role. A member sees only their own rows through the existing per-viewer filtering on
`/api/decisions` and `/api/admin-activity`; the admin endpoints above refuse members outright.

## Audit-log export

The decision log already had a JSON list (`GET /api/decisions`, limit only) and a CSV export with a
date range (`GET /api/decisions.csv?from=YYYY-MM-DD&to=YYYY-MM-DD`). This phase adds the date range
to the JSON endpoint: `GET /api/decisions?from=2026-01-01&to=2026-01-31` returns
`{ decisions, total, from, to }`, capped at 5,000 rows. Admin activity exports the same way
(`GET /api/admin-activity`, `GET /api/admin-activity.csv`). Rows are redacted at write time and
scrubbed per viewer on a Team Cloud, as before.

## Retention policies

Phase 0 set retention for the decision log and the memory journal (`config.json`: `decisions` and
`memoryJournal`, 1–3650 days, environment variables `SANREMES_DECISION_RETENTION_DAYS` and
`SANREMES_MEMORY_JOURNAL_RETENTION_DAYS` win). This phase completes the set:

- **Usage ledger** (`config.json`: `usage.retentionDays`, environment
  `SANREMES_USAGE_RETENTION_DAYS`): the only store that had no retention at all. It is **off by
  default**: usage rows are billing evidence, so nothing deletes them unless the owner sets a window.
  The daily upkeep sweep (`server/host/start-upkeep.ts`) drops whole month files past the window.
- **Thread event logs**: already configurable (`threads.eventLogRetentionDays`); shown read-only by
  `GET /api/admin/retention`.
- **Task-workspace dependency folders**: already swept on a fixed 14-day idle window, gated by
  `SANREMES_TASK_WORKSPACE_RETENTION`; unchanged.

`GET /api/admin/retention` reports each store's effective days and where it came from
(`env`, `config`, `default`). `PUT /api/admin/retention` takes any of `decisionsDays`,
`memoryJournalDays`, `usageDays` (1–3650, or `null` to clear back to the default). A value the
environment sets is refused with the variable's name; change it there. Decisions and memory-journal
changes apply at the next restart (their prunes read the live config); usage applies on the next
daily sweep. Every change is a `retention.update` row in admin activity.

## Compliance mode

`PUT /api/admin/compliance` sets `auditStrict` (owner only). While it is on, retention can only go
up, never down: any `PUT /api/admin/retention` that would lower a window — including setting a
usage window where usage is currently kept forever — is refused. Switch strict mode off first to
lower anything.

These settings are controls, not certifications. **SanRemes claims no HIPAA, SOC 2, or any other
compliance attestation.** Attestations cost real audits; strict mode only makes the server keep
more evidence and refuse to keep less.

## Motion

MP4 explainers need a paid video-generation API, which SanRemes does not ship and has no key for.
The seam exists (`server/motion.ts`): a provider interface, a stub provider that refuses in plain
words ("Motion needs a paid video-generation key — none is configured"), and the paid toggle
(`PUT /api/admin/motion`, `{"paidEnabled": true | false}`, default off). `POST /api/admin/motion/generate`
refuses with 409 while the toggle is off and 501 with no provider attached. No paid API is called,
and no money moves. Motion is never presented as working.

## Phone companion

A thin phone web app over the Bot API, served as static files at `/companion/` (see
[Bot API](bot-api.md#apps-built-on-it)). It is a fresh client, not a revival of the removed phone
companion sidecar: no native app, no desktop features ported. It lists the bots saved on the phone,
reads and sends messages, shows running threads, and shows approvals as waiting for the person in
the SanRemes app — the Bot API cannot answer an approval from outside, and the companion does not
try.
