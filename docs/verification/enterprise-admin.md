# Enterprise admin

The admin surface for teams (docs/enterprise-admin.md): who may do what, retention policies,
compliance mode, the Motion paid toggle, and the audit-log export. The routes live in
`server/routes/admin-enterprise.ts` (registered in `server/routes/table.ts`, so no `server/index.ts`
change was needed); the capability table is `server/team-capabilities.ts`; the two toggles are in
`admin-settings.json` (`server/admin-settings.ts`); the Motion seam is `server/motion.ts`; usage
retention is `server/usage-ledger.ts` (`pruneUsage`) wired into the daily upkeep sweep
(`server/host/start-upkeep.ts`); the decisions date range is in `server/routes/status.ts`.

## Automated checks

```sh
pnpm exec vitest run server/team-capabilities.test.ts server/admin-settings.test.ts server/motion.test.ts server/usage-retention.test.ts server/host/start-upkeep.test.ts server/routes/admin-enterprise.test.ts server/routes/status-decisions-range.test.ts scripts/testing/companion-assets.test.ts
```

**What it does not prove:** the admin surface has no Settings page (API + docs only), the companion
page is not driven in a phone browser (its assets are asserted statically; the fixture check below
covers serving only), and Motion has no real provider — the stub refuses in plain words by design
(see `docs/plans/phase6-notes.md`).

## Isolated fixture checks

Launch a fixture with the built UI (the companion is a static file, so the fixture needs the
built bundle):

```sh
vite build
node --experimental-strip-types scripts/control-sanremes.ts launch
pnpm control:sanremes doctor --url http://127.0.0.1:PORT
```

Then, against the printed URL, with the fixture's loopback owner session:

- `GET /api/admin/capabilities` returns the owner role and all five capabilities.
- `GET /api/admin/retention` returns decisions 180 (default), memory journal 180 (default),
  usage `null` (kept forever unless set), and `strict: false`.
- `GET /api/admin/motion` returns `paidEnabled: false`, `provider: "none"`, `ready: false`.
- `GET /api/decisions?from=<first of this month>&to=<today>` returns the fixture's decision rows
  with a `total`.
- `GET /companion/` returns 200 and the companion page; `GET /companion/app.js` returns 200.

The 390px viewport check is manual, not fixture-driven: the control surface drives the
main renderer only (fixed entries, no arbitrary URL), and a direct headless Chrome launch is
blocked on this machine. Open `/companion/` in a 390px viewport and confirm the Bots, Running
and Settings tabs fit without sideways scrolling and the Settings form's inputs do not zoom on
focus. The static checks (`scripts/testing/companion-assets.test.ts`) assert the viewport,
safe-area insets and 16px inputs that make that layout hold.

Keep the JSON from the doctor run, the exact command sequence, and the fixture's printed log path.
A green unit test alone does not prove the live endpoints.
