# Phase 6 notes — Enterprise and out-of-scope tail (rows 2, 9, 39, 41-rest, 45)

Built 2026-11-28 on base `9aaec342` (Phase 5). No version bump, no release, no push.

## What was built

### 1. Finer roles (row 41, rest)

- **Capability table** (`server/team-capabilities.ts`): the three Admin-assigned team roles
  (owner/admin/member, `server/cloud-team.ts`) mapped onto five admin capabilities. The finer
  distinction enforced is the owner/admin split on settings changes: retention, compliance-mode
  and Motion changes are owner-only; admins read and export the audit log but cannot rewrite its
  keeping; members get neither. The caller's role is read from the session's team role, or from the
  admin scope when the Admin gave no role (a personal Cloud, a paired owner device); a service-trust
  loopback caller gets nothing.
- **No fourth role was added.** Roles are assigned by the Admin's pairing claim; this machine cannot
  invent a role the Admin will not issue. The table is written so a future Admin-issued role maps
  onto it instead of needing a new check per route. Per-bot grants were not extended: the existing
  grants model (bot visibility, `visibleTo`) has no notion of an audit-scoped grant, and inventing
  one the Admin cannot assign would be unenforceable.

### 2. Retention policies, completed (row 41, rest)

Phase 0 covered the decision log and the memory journal. What was left:

- **Usage ledger** (`server/usage-ledger.ts`, `server/config.ts`, `server/host/start-upkeep.ts`):
  the only store with no retention at all. New opt-in `usage.retentionDays` (1–3650, env
  `SANREMES_USAGE_RETENTION_DAYS` wins), **off by default** — usage rows are billing evidence, so
  nothing deletes them unless the owner says so. The daily upkeep sweep drops whole month files
  past the window (`pruneUsage`); the current month is never removed. Thread event logs were already
  configurable and task-workspace folders already swept on a fixed 14-day window; both unchanged.
- **Admin routes** (`server/routes/admin-enterprise.ts`, registered in `server/routes/table.ts`
  with no `server/index.ts` change): `GET /api/admin/capabilities`, `GET/PUT /api/admin/retention`
  (decisions/memoryJournal/usage days, `null` clears), with the environment-wins refusal and the
  strict-mode ratchet below. Decisions/memory-journal changes apply at the next restart (their
  prunes read the live config); usage applies on the next daily sweep. Changes are `retention.update`
  rows in admin activity.

### 3. Audit-log export (row 41, rest)

The CSV export with a date range already existed (`GET /api/decisions.csv`, `GET
/api/admin-activity.csv`). The gap was JSON: `GET /api/decisions` took only a limit. It now takes
`from`/`to` (`YYYY-MM-DD`, at most a year apart) and returns `{ decisions, total, from, to }`,
capped at 5,000 rows (`server/routes/status.ts`). No new combined export endpoint was added: the
existing endpoints already scrub rows per viewer on a Team Cloud, and a new module could not
replicate that filtering — exporting unscrubbed rows would have leaked members' private
conversations to admins.

### 4. Compliance-mode settings (row 41, rest)

- **Store** (`server/admin-settings.ts`): `admin-settings.json` (0600), `{ auditStrict, motionPaid }`,
  both default off.
- **Strict mode**: while on, retention can only go up, never down — any `PUT /api/admin/retention`
  that would lower a window, including setting a usage window where usage is currently kept forever,
  is refused in plain words.
- **No compliance attestation is claimed anywhere** — in code, copy, or docs. Strict mode is a
  control over what evidence the server keeps, not a certification. Attestations cost real audits.

### 5. Mobile companion (row 2)

- **Fresh thin client** (`public/companion/index.html`, `app.js`, `app.css`): served as static files
  at `/companion/` by the existing static server, so it loads on a phone browser with no sign-in —
  the same public path as the rest of the bundle. It is not a revival of the removed phone companion
  sidecar and not a native app.
- **Over the Bot API only**: each bot is added with the address and key from its Bot API card; the
  key stays in the phone browser's storage and goes only to the saved address. Bots list, read +
  send a message (POST with `wait: 0`, then poll the thread status), running threads across bots.
- **Approvals are shown, never answered**: a thread at `needs_approval` says plainly to answer it
  in the SanRemes app. The Bot API cannot give an approval from outside, and the companion does not
  try — adding an approval endpoint for a bearer key would be a new security surface, not a client
  feature.
- **Honest limits**: the Bot API has no list of bots or threads, so only the bots and conversations
  saved on the phone appear. No service worker, no offline cache, no push notifications.

### 6. Motion (row 9)

Scaffolding only, and deliberately so: a provider interface, a stub provider that refuses in plain
words ("Motion needs a paid video-generation key — none is configured"), and the paid toggle
(default off) in the admin settings (`server/motion.ts`, `server/admin-settings.ts`). `POST
/api/admin/motion/generate` refuses with 409 while the toggle is off and 501 with no provider
attached. **No paid API is called and no money moves.** Motion is never presented as working; the
seam exists so a future worker with a real key has a defined place to attach a provider.

## Deliberately not built

- **SSO / SAML / SCIM (row 39).** There is no enterprise buyer; the plan itself says "only if a real
  buyer needs it" and sizes it XL. What it would need: an identity-provider integration (SAML
  assertions or OIDC, plus a SCIM endpoint for provisioning/deprovisioning) and an admin UI for
  mapping provider groups to the three team roles — on top of the pairing-claim flow in
  `server/cloud-team.ts`, which an IdP would replace as the membership authority. Trigger to reopen:
  a real buyer asking for it. No code was written for it.
- **Claude Science (row 45).** Skipped unless a user asks for it. No code, no docs beyond this note.
- **A Settings page for the admin surface.** The surface is API + docs. A page would need new locale
  strings, a sidebar home, and DESIGN.md review; the API is usable now and the page is the natural
  follow-up.
- **A fourth team role, per-bot audit grants, and a combined audit-export endpoint.** Each is
  recorded above with the reason: unenforceable without the Admin, no grants model for it, or a
  privacy regression on Team Clouds.

## Verification

Gates on the final tree (base `9aaec342` plus this work, uncommitted):

- Focused tests: **28 passed, 0 failed** across 9 files (`team-capabilities` 3, `admin-settings` 2,
  `motion` 1, `usage-retention` 3, `host/start-upkeep` 7, `routes/admin-enterprise` 4,
  `routes/status-decisions-range` 1, `companion-assets` 4, `static-files` 3), plus regression suites
  (`decision-log`, `decision-log-retention`, `memory-journal-retention`, `routes/status-box`,
  `usage-ledger`, `admin-activity`, `file-size-ratchet`: 299 passed, 1 skipped). Full `pnpm test`
  never finishes on this VM; focused runs are the accepted standard. `server/index.ts` is unchanged
  at 15,202 lines, `server/config.ts` is unchanged at 1,227 lines, and no new file exceeds 1,000 lines.
- Typecheck: pass (`tsc -b && tsc -p tsconfig.server.json && tsc -p packages/phone-protocol/tsconfig.json`), run alone.
- Lint: **0 warnings, 0 errors** (`oxlint --deny-warnings`).
- i18n: no locale keys changed, so no check run (no new UI strings; the companion is static English copy).
- Isolated fixture doctor: `"ok": true`, `"problems": []` at `http://127.0.0.1:20816`. The fixture
  also exercised the new endpoints live (loopback owner): `GET /api/admin/capabilities` returned
  the owner role and all five capabilities; `GET /api/admin/retention` returned decisions 180
  (default), memory journal 180 (default), usage `null` (kept forever); `PUT /api/admin/retention`
  set usage to 365 (source `config`); strict mode on then lowering usage to 90 was refused with
  400; Motion toggle on then `POST /api/admin/motion/generate` was refused with 501 and the
  plain-words reason; `GET /companion/` returned 200 with the companion page. Fixture server log:
  `/tmp/sanremes-verification-evidence/server-1795852076482-23002.log`. Recipe:
  `docs/verification/enterprise-admin.md`.
- Pre-existing failure, not from this phase: `server/config.test.ts` "keeps a hosted tenant's
  control-plane secrets out of every child env, and only those" fails on the clean base `9aaec342`
  too (verified by stashing this phase's `config.ts` change and re-running: still 1 failed).
  It concerns a lowercase `omb_cloud_ready_token` leaking through the env strip, unrelated to the
  usage-retention schema addition.
- `vite build` needed `NODE_OPTIONS=--max-old-space-size=4096` on this VM (the default 2GB heap
  OOM'd at ~88s); with it the build completed in 1m 48s.
