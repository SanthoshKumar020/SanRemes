# SanRemes Phase 1 — Ownership Map

Fork of OpenMausBot (Apache 2.0) at `d5bdd06f`, 33 commits on `master` to
`cb861783` at the time of writing. All counts are from `git ls-files` +
`wc -l` on the tracked tree; line counts include tests and fixtures.
Attribution is from `git log` / `git diff d5bdd06f..HEAD` — post-fork
commits are SanRemes-original, everything else is upstream-derived unless
named below. **sanremes-web (the Next.js site) is a separate repo and is
already SanRemes-original; it is not in these counts.**

## Corrected totals

- **9,775 tracked files, 2,478,246 lines.** The 627,793-line figure in the
  Phase 1 brief is wrong: it came from `git ls-files | xargs wc -l | tail -1`,
  which keeps only the last `xargs` chunk's subtotal. The single-pass count
  (`git ls-files | xargs cat | wc -l`) is 2,478,246.
- The eight modules below hold 7,721 files / 1,606,715 lines. The remaining
  2,054 files / 871,531 lines sit outside them: `docs/` (1,241 files),
  `scripts/` (370), `companion/` (89), `evals/` (81),
  `third_party/` (48), `connector/` (48), `relay/` (34),
  `deploy/` (28), `build/` (26), `.github/` (26), `public/`, `brand/`,
  and 45 root-level files.

## Per-module table

| Module | Files | Lines | Test files | Post-fork: files added / touched | Net lines since fork |
|---|---|---|---|---|---|
| `server/` | 3,989 | 828,678 | 2,076 | 37 / 2,088 | +9,136 |
| `src/` | 2,510 | 586,481 | 1,164 | 25 / 652 | +3,262 |
| `electron/` | 575 | 120,568 | 43 | 0 / 310 | +1 |
| `shared/` | 319 | 22,784 | 86 | 2 / 87 | +225 |
| `cloudflare/` | 79 | 21,919 | 16 | 0 / 38 | 0 |
| `packages/` | 134 | 17,717 | 0 | 0 / 35 | +2 |
| `apps/` | 96 | 6,013 | 0 | 0 / 60 | 0 |
| `skills/` | 19 | 2,555 | 0 | 0 / 12 | −2 |

"Touched" is inflated by the rebrand rename churn (added ≈ deleted in most
modules); "net lines" is the honest measure of new SanRemes code. Over half
of `server/` files (2,076 of 3,989) and nearly half of `src/` (1,164 of
2,510) are tests.

### `server/` — bot runtime, drivers, routes

- **SanRemes-original:** Job Bot v1 (`ca608241`) and v2 (`cb861783`):
  `routes/job-bot.ts`, `jobs-store.ts`, `jobs-run.ts` (task queue),
  `jobs-resume.ts`, `resume-extract.ts`, `resume-parse.ts` (+ tests).
  Nod merge phases 1–4 (`801f9a8a`, `a1c767aa`, `06bf41c9`, `7867a801`):
  `memory-notes.ts`, `memory-notes-routes.ts`, `memory-trust.ts`,
  `browser-trust.ts`, `self-improvement.ts`. Browser errands / page watches
  (`7a5b10a6`, `88a5b981`, `aaeaa1b2`): `browser-errands.ts`,
  `routes/browser-watches.ts`. Local-model / Qwen work (`32a55979`,
  `678fa405`, `6c202fc0`, `3b503950`, `23751308`, `32207169`, `fa83d89d`):
  `ollama-setup.ts`, `decider/chat.ts`, driver timeout/context fixes.
- **Unverified:** the browser-engine `closeOnce` fix in
  `server/browser-engine.ts` — the symbol exists, but `git log -S closeOnce`
  shows it arriving inside the fork commit `d5bdd06f` itself, so git cannot
  separate it from the upstream snapshot. Treat as presumed SanRemes, not
  proven.
- **Upstream-derived:** everything else — the bot host, drivers, MCP
  bridge, meetings bot, browser driver, model manifest, cache keep-warm.

### `src/` — desktop UI

- **SanRemes-original:** Job Bot UI (`components/jobs/`,
  `components/SidebarJobsRow.tsx`); the rebrand itself (SR mark and logo
  wiring `920bcf00`, `e095a559`, `40efea67`; locale/name renames `62fda10d`,
  `99ca73cb`); first-run Qwen setup UI (`fa83d89d`).
- **Upstream-derived:** the rest of the UI, including the mascot system
  (`lib/mascot.ts`, `components/CursorAvatar.tsx`) — SanRemes-branded (SR
  mark, no upstream mouse art) but built on the upstream avatar engine.

### `electron/` — desktop shell, packaging

- **SanRemes-original:** SR app/web/installer icons (`40efea67`); Ollama
  bundled in the Windows installer (`23751308`); Chrome for Testing pin
  (`3d90a695`).
- **Upstream-derived:** the rest of the shell and build config. Net +1 line
  since the fork: almost entirely rebrand churn.

### `shared/` — wire types, shared contracts

- **SanRemes-original:** `shared/jobs.ts` (Job Bot wire types, +131 lines in
  `ca608241`) and one other added file.
- **Upstream-derived:** everything else, including the `MAUS_COLOR_NAMES`
  identifiers (internal, kept deliberately — see below).

### `cloudflare/` — control plane / workers

- **SanRemes-original:** none. Net 0 lines since the fork.
- **Upstream-derived:** all of it. Note: `control-plane/wrangler.jsonc:33`
  states plainly that the `sanremes.si` zone lives on the Supamaus
  Cloudflare account — moving it needs his own Cloudflare account + DNS;
  it cannot be moved from here.

### `packages/` — shared libraries (incl. phone protocol)

- **SanRemes-original:** trivial — Nod phases touched
  `phone-protocol/src/routines.ts` (7-line changes). Net +2 lines.
- **Upstream-derived:** everything else, including the vendored
  `open-bot-avatar` engine (its LICENSE is kept at
  `packages/phone-protocol/src/open-bot-avatar/LICENSE`, per NOTICE).

### `apps/` — docs site and small apps

- **SanRemes-original:** none. Net 0 lines since the fork.
- **Upstream-derived:** all of it. The docs site's `siteUrl` was repointed
  in Phase 1 from `https://docs.openmausbot.com` to the SanRemes GitHub
  repository (`apps/docs/lib/shared.ts:5`); it stays a placeholder until a
  real SanRemes docs domain exists.

### `skills/` — agent skills

- **SanRemes-original:** none. Net −2 lines since the fork.
- **Upstream-derived:** all of it. The social-posts template adapts
  MiniMock; attribution is in NOTICE and in the template itself.

## Full-rewrite order and effort (solo developer)

Basis: ~2,000 net new lines per week of tested, working solo code. Line
counts include tests and fixtures, which a rewrite would re-derive rather
than reproduce line-for-line — so treat these as order-of-magnitude, not a
schedule. Even at an aggressive 5,000 lines/week the eight modules alone
are ~6 years.

| # | Module | Lines | Effort at ~2,000 lines/wk |
|---|---|---|---|
| 1 | `server/` | 828,678 | ~414 wks (~8.0 yrs) |
| 2 | `src/` | 586,481 | ~293 wks (~5.6 yrs) |
| 3 | `electron/` | 120,568 | ~60 wks (~1.2 yrs) |
| 4 | `shared/` | 22,784 | ~11 wks |
| 5 | `cloudflare/` | 21,919 | ~11 wks |
| 6 | `packages/` | 17,717 | ~9 wks |
| 7 | `apps/` | 6,013 | ~3 wks |
| 8 | `skills/` | 2,555 | ~1–2 wks |
| | **Eight modules** | **1,606,715** | **~803 wks (~15.4 yrs)** |
| | **Whole repo (2,478,246 lines)** | | **~1,239 wks (~24 yrs)** |

Order is biggest/highest-value first, with one practical note: `shared/`
is small and is a dependency of `server/` and `src/`, so in a real rewrite
it would go first or alongside `server/`, not fourth. The honest headline:
**a full rewrite is a multi-year solo effort — decade-scale, not a phase.**
Phase 1's job is rebrand completion and license hygiene, not replacement.

## What Phase 1 changed vs what is intentionally kept

**Changed in Phase 1 (this fork):**

- Rebrand: OpenMausBot/MausBot names → SanRemes in branding, locales and
  UI; SR mark and logo assets (`brand/`, `public/app-icon.*`); the
  `enterprise/` directory deleted (no enterprise layer, no license key).
- License hygiene: `LICENSING.md` documents the fork; `CLA.md` replaced —
  no CLA is required, contributions are under Apache 2.0 (the upstream CLA
  only covered the deleted `enterprise/` directory); the CLA-enforcement
  workflow (`.github/workflows/contributors.yml`) removed; `CONTRIBUTING.md`
  corrected to match. `.github/FUNDING.yml` points at `SanthoshKumar020`.
- Features: Nod merge phases 1–4 (memory, trust layer, browser sandbox,
  self-improvement loop), Job Bot v1+v2, Qwen as default local model with
  Ollama bundling and first-run setup, browser errands/page watches.

**Intentionally kept, and why:**

- Apache 2.0 `LICENSE` text and the `NOTICE` attribution, including the
  `Copyright 2026 Milind Soni and OpenMausBot contributors` header — Apache
  2.0 §4 requires retaining upstream copyright/attribution notices in
  derivative works. Removing them would breach the license.
- `third_party/` vendored code and its licenses — same obligation.
- `MAUS_*` / `omb_` internal identifiers — they are code identifiers, not
  branding; renaming them is churn with no legal benefit and real regression
  risk.
- BotMRR format names — a data-format name, not a trademark use in
  SanRemes branding.
- Upstream issue links (`github.com/milind-soni/OpenMausBot/issues/...`) in
  code comments, tests and docs — they document provenance and are the
  "reasonable and customary use in describing the origin of the Work"
  Apache 2.0 §6 permits.
- Upstream fork attribution in `README.md`, `LICENSING.md` and `NOTICE` —
  required honesty about origin, not branding.
