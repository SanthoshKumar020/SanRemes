# SanRemes Phase 1 — Decision Log

Decisions made during Phase 1 (rebrand completion + license hygiene, 2026-11-27),
and the ones still needing the owner. Nothing in the open list was decided by
the agent — each needs his word.

## Decided

- **Product name: SanRemes.** The fork is rebranded throughout (UI, README,
  package.json, desktopName, docs). Fork attribution to OpenMausBot is kept
  in README / LICENSING.md / NOTICE — required honesty about origin, not
  branding.
- **Platforms: Web + Desktop first, Android parallel.** Per the roadmap.
  No platform work was started in Phase 1.
- **Rebrand required: yes.** Completed in Phase 1 except the flagged
  exceptions in the final report (upstream help link replaced with a
  SanRemes doc; `docs/ci.md` example org neutralised).
- **License for upstream-derived code: Apache 2.0, retained.** This is not
  a free choice — Apache 2.0 §4 requires keeping the license, copyright
  notices and NOTICE attributions on derivative code. "Remove Apache" is
  lawful only for fresh code. Fresh SanRemes code is likewise Apache 2.0
  unless a later license-model decision changes it.
- **Full rewrite: not attempted.** The repo is 9,775 tracked files /
  2,478,246 lines; a tested solo rewrite is ~1,239 weeks (~24 years) at
  2,000 lines/week. Phase 1 makes the fork legally clean and fully
  rebranded; progressive replacement is mapped in
  `docs/plans/phase1-ownership-map.md`.
- **Wire-format and internal identifiers kept:** BotMRR format names,
  `MAUS_*` / `omb_*` identifiers, and upstream issue/PR links in
  comments/tests/docs. Renaming them breaks shared packages or is churn
  with no legal benefit; issue links are provenance Apache 2.0 §6 permits.
- **`third_party/` untouched.** Vendored code keeps its own licenses.
- **Team library repointed:** the app's team library now reads from the
  `SanthoshKumar020/sanremes-teams` fork (MIT-licensed upstream
  team-templates repo, forked 2026-11-27).
- **Phone connector / companion sidecar: KEPT in Phase 1 — SUPERSEDED 2026-11-27 by commit `2f1fcd81` ("Remove phone connector and companion sidecar"), which deleted `companion/` (including `src/e2e/`), `relay/`, server phone code, Electron companion management, desktop phone UI, and Cloudflare phone surfaces; a future Android app will use the Bot API route, like the WhatsApp/Telegram bridges.** Removal was
  ordered and attempted, but verification showed it is not a standalone
  sidecar: the server runtime imports `companion/src/e2e/*` (relay crypto),
  `server/phone-relay.ts` is wired into `server/index.ts` (which Phase 1
  must not touch), all nine candidate phone-only `phone-protocol` modules
  are imported by desktop/server code, and the phone UI shares a devices
  page with computers/cloud. Deleting any of it breaks the build or strands
  live functionality. The reusable core for his own future Android app is
  `packages/phone-protocol/` (wire contract) and `companion/src/e2e/`
  (Noise-based relay crypto). A follow-up removal needs the `index.ts`
  no-touch rule lifted first — which the user then authorized, and the
  removal landed as commit `2f1fcd81`.
- **CLA: none required.** The upstream CLA only covered the deleted
  `enterprise/` directory; contributions are under Apache 2.0. The old
  CLA text (which granted rights to Milind Soni) was replaced and the
  CLA-enforcing workflow deleted.
- **No release in Phase 1.** No version bump, no installer build, no
  GitHub release. The commit is rebrand + license hygiene only.

## Open — needs the owner

- **License model for the SaaS future:** Apache 2.0 only / dual-license /
  proprietary core. (Roadmap §0.3 recommendation: open core or
  proprietary for SaaS. Not decided.)
- **Boat (cloud computer) strategy:** keep as an optional paid feature vs
  plan a replacement / abstraction layer. (Roadmap §0.3 recommendation:
  start with Boat, plan abstraction. Not decided.)
- **Repository visibility:** keep public vs move to a private monorepo
  (with a clear commercial dual-license if desired). Currently public.
- **Docs domain:** the docs site `siteUrl` is currently the GitHub
  repository URL — a placeholder until a real SanRemes docs domain exists.
  (Sitemap/robots are wrong until then.)
- **SanRemes organization name:** no SanRemes GitHub organization exists;
  `docs/ci.md` merge-queue guidance is worded neutrally until one does.
- **Phone-connector removal follow-up:** authorize unwiring the phone
  subsystem from `server/index.ts` (phone routes + `startPhoneRelay`),
  removing Electron companion management and the desktop phone-pairing UI,
  and only then deleting `companion/` (minus `e2e/` until the server relay
  goes), the phone-only `phone-protocol` modules, `relay/`, and the
  control-plane companion surfaces — in that order, with the same gates.
- **Robot form factor:** tabletop / mobile base / fixed kiosk. Later, not
  Phase 1. (Roadmap recommendation: tabletop or fixed first.)
- **PRD for the Web / Desktop / Android MVP:** roadmap §14 item 4 — not
  written in Phase 1; a later task.
- **`sanremes.si` zone:** lives on the Supamaus Cloudflare account.
  Moving it needs his own Cloudflare account + DNS.
