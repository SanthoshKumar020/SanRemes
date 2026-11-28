# Beta-features mapping — Claude Upcoming & Beta Features (28 Nov 2026 PDF)

Source: `~/workspace/user/files/Claude_Upcoming_Beta_Features_Detailed.pdf`
("Claude AI – Upcoming & Beta Features November 2026", compiled 28 Nov 2026).
It is an INDEPENDENT compilation, not an official Anthropic publication: build the
capability, never the brand name, and never claim a Claude feature ships in SanRemes.

Base: master `7e7f7f8e` (Phases 0–6 done). END STATE (updated 2026-11-28 13:45 IST — user ordered
a release): finish all groups, commit per feature group, push master AND main, verify
with `git ls-remote origin master main`, THEN cut a standard versioned release
v0.1.10 (patch bump from v0.1.9) including Phase 2–6 + all beta features, following
the proven release process (bump package.json + README download link; commit; push
master AND main; trigger **package-win.yml** on master, NEVER release.yml; download
installer + latest.yml; verify sha512/size, packaged contents, Ollama bundle, SR icon
hash `4f4a02ae721efed83d09f8f19fc2b157bf8afeaffe46501add2f4d17985b3baa`; browser-engine
asset stays pinned to the v0.1.1 release URL at `server/browser-engine-release.ts:49`;
`gh release create`; verify download URL 302; local copy under `~/workspace/` per the
`sanremes-installer-v019` pattern). Do NOT start the release until build + push are
fully done and verified.

## Status key

- ALREADY — in the repo from Phases 0–6; verify, close gaps only.
- BUILD — free/local equivalent to build in this job.
- STUB — deliberately left as a refusing stub (paid key / paid infra needed).
- NOT POSSIBLE — cannot be built free/local; reason recorded, no code.
- RECORD — documentation note only, no code.

## 1. Install Artifacts as Apps (Beta, all plans) — ALREADY + BUILD gap

Phase 1 built it: `electron/installed-app-window.mjs` (sandboxed, contextIsolated,
per-app partition, navigation locked to same origin, permission prompt defaulting to
Cancel), `installed-apps.json` records, PageTools "Install as app" button (Electron
only, published links only). Only fullscreen / clipboard-sanitised-write /
notifications are allowed for the artifact's own origin.
GAP vs the PDF: graduated permission levels — basic (browser-like), intermediate
(notifications, floating windows, menu-bar items), full computer access (run programs,
read/write/delete files, explicit user approval each time permissions change), and
re-confirmation when the underlying artifact changes.
Group A: build the graduated-permission gap. Files: `electron/installed-app-window.mjs`,
`electron/installed-apps*`, `electron/preload.cjs` bridge additions only, tests.

## 2. Computer Use expansion (Beta, Team/Enterprise) — PARTIAL, BUILD

SanRemes already has the machinery: agent browser over CDP (`server/browser/`),
screencast (`server/browser/cdp/screencast.ts`), lent Chrome, desktop policy for the
person's own Chrome (`server/browser/desktop/policy.ts` — that policy is about the
person's display Chrome, NOT the agent's computer use).
MISSING, to build: one coherent Computer Use capability on the agent browser — screen
view + click/type/scroll via the existing driver, per-site/app permission prompts,
a blocklist for high-risk domains, and action confirmation for sensitive operations.
Never auto-approve a sensitive action. Fallback for tools with no connector/API.
Group B: build it. Files: new `server/computer-use/*` (or extend `server/browser/*`
where the seam already exists — worker decides, coordinator approves the seam),
policy + blocklist + confirmation, tests. Do NOT touch the person's desktop policy.

## 3. Claude Meetings (Beta, Team/Enterprise, Google Meet) — BUILD

Nothing meeting-specific exists in the repo (only incidental "meeting" strings).
Build the free/local equivalent: a meeting companion a user starts from a Meet link
(the user joins/approves — NO unattended account automation, NO joining as a hidden
participant); structured notes + transcript capture through the browser surface
where observable; answers questions in-call via a bot; builds live artifacts
(Docs/Whiteboards) participants can see. Admin-gating is out of scope (no
Enterprise buyer); owner-only start is the local equivalent.
Group C: build it. Files: new `server/meetings/*`, routes module, sidebar page,
tests. Route registration left to the coordinator.

## 4. Claude Duet — proactive agent (Research Preview, waitlist, US Pro+) — PARTIAL, BUILD

Pieces exist: the morning brief (`server/host/brief.ts`, `server/host/brief-cards.ts`
— one server-built card a day, morning posting, what was done while away), routines
(`server/routines.ts`), managed agents (Phase 5). MISSING: a proactive agent that
composes the attention list (emails, tasks, decisions), offers to act, acts ONLY
after explicit approval, shows the exact intended action before any sensitive action
(send/message/payment — payments never), and keeps working while the user is offline
(the local server + managed agents are the offline VM equivalent).
Group D: build it on brief + routines + managed agents. Read-only use of
`server/managed-agents.ts` and `server/host/brief.ts` — do NOT modify them; new
`server/duet/*`, routes module, tests.

## 5. Claude Ship — PR agents (Beta, Team/Enterprise) — BUILD

Nothing Ship-specific exists. Build on Phase 3 parallel sessions
(`server/parallel-sessions.ts`, git worktree per task, `sanremes/<taskId>` branches):
review PRs against team policy/coding standards, propose and apply fixes, and
auto-approve PRs that meet configured policy rules — auto-approve ONLY under an
explicit user-configured policy, default OFF — plus a `/ship` command equivalent
through the bot command surface. No auto-merge without the policy saying so.
Group E: build it. Files: new `server/ship/*`, routes module, tests.

## 6. File transfers with connectors (Beta, Pro+) — BUILD

Not verified as built: the only "transfer" match is `server/cloud-computer-files.ts`
(the local/cloud computer file surface), not connector file transfer. Build: push a
generated/uploaded file into a connected app, or pull a file the app offers, without
download/re-upload — for the connectors SanRemes already has (Composio + custom
MCP). Map per-connector capability first; record per-connector gaps where the
connector's own API cannot move files.
Group F: map, then build. Files: new `server/connector-files/*`, routes module, tests.

## 7. Personal Finance (Beta, Pro+, US only, Plaid read-only) — NOT POSSIBLE

Plaid is a paid US service; the user is in India with no US bank accounts. No
free/local equivalent exists without Plaid and without paid APIs. Do NOT build.
Record only (this section).

## 8. Claude Sheets, Whiteboards & Data Enhancements — ALREADY + BUILD gap

Sheets (editable spreadsheet, `show_spreadsheet`, export) and Whiteboards are
Phase 1, ALREADY built. Data: a data engine exists (`server/data/engine.ts`,
`server/data/chart-compiler.ts`, `DataResultChip`). GAP to verify: live sharing of
dashboards + certified / query-backed data views that surface their sources.
Group G: verify what the data engine already does, build the missing live-sharing
and certified-view pieces (local sharing links over the existing share surface;
certified = a view pinned to a query + source, with the source shown, not a
certification claim). Files: `server/data/*` additions, routes module, tests.

## 9. Claude Motion (Beta, Team/Enterprise) — BUILT (Group K, free/local)

Phase 6 left a paid-gated stub (`server/motion.ts`, `server/admin-settings.ts`):
provider interface, stub refusing in plain words, owner-only paid toggle default
off, `POST /api/admin/motion/generate` 409/501. Group K built the free/local path
after all: `server/motion-local.ts` — a template-based animated explainer rendered
on this machine with ffmpeg (no model, no key, no network): the prompt's sentences
become title cards that fade in and out over alternating backgrounds with a sliding
accent bar, rendered as a real 1280x720 H.264 MP4. It needs ffmpeg and a TrueType
font on the machine (both present on this VM and on a stock Windows install via
`C:\Windows\Fonts\arial.ttf`); without either it refuses in plain words. The
seam in `server/motion.ts` gained `LOCAL_MOTION_ID`: a local provider is ready
without the paid toggle, and the paid gate applies to paid providers only. The
admin routes (`server/routes/admin-enterprise.ts`) now serve the local provider
when it is available: `GET /api/admin/motion` reports `provider: "local",
ready: true`, and `POST /api/admin/motion/generate` renders and returns the file
path; without ffmpeg/font it falls back to the paid stub path (409 when off, 501
when on). No money spent, no key bought. The paid stub stays for machines without
ffmpeg/font. Verified: a real MP4 rendered and ffprobe-checked in
`server/motion-local.test.ts`.

## 10. Enterprise & Platform Security — NOT POSSIBLE (EFS) + BUILD local equivalents

EFS (zero data retention, sealed safety data in a customer cloud bucket) needs
Anthropic infra: NOT POSSIBLE, no code. Local equivalents to BUILD (Group H):
self-serve IP allowlists for the Bot API; sign members out via the Admin API
(Phase 6 built the admin surface — extend it); centralised management of Desktop
settings; project tags for cost-code tracking and spend attribution on the Phase 5
usage metering (ledger + usage report exist — extend, do not rebuild); expanded
Compliance API data on the Phase 6 admin surface. No compliance attestation is
claimed anywhere (Phase 6 rule stands).
Group H: build. Files: `server/routes/admin-enterprise.ts` additions,
`server/admin-settings.ts`, `server/usage-ledger.ts`, `server/cloud-usage-report.ts`,
`server/request-auth.ts` (allowlist check), tests.

## 11. Managed Agents & Self-Hosting — PARTIAL, BUILD gaps

SanRemes IS self-hosted by design and Phase 5 built managed agents locally
(store, runner, routes, UI, executor interface with a cloud stub, usage metering).
GAPS vs the PDF: multi-agent orchestration, memory consolidation ("dreaming"),
outcome tracking for long-running agents. Group I builds the free/local gaps on
Phase 5's store/runner — read-only use of `server/managed-agents.ts` where possible,
new `server/managed-agents/*` helpers where a change is unavoidable (coordinator
approves any edit to the Phase 5 files). The real cloud executor, attachment
handshake, per-session machines, cloud usage reporting and billing checkout still
need hosted infrastructure (Phase 5 notes) — NOT in this job.

## 12. Unified Chat + Cowork ("One Claude") — PARTIAL, BUILD

Phase 3 built Cowork completeness. The merged experience to build: no mode picker —
the user describes the outcome and the agent decides how much agency, tool use and
file work is required; projects, connectors, Skills and memory carry over
seamlessly. Group J verifies whether a mode picker still exists in the UI and
removes/merges it per DESIGN.md, wires the agency decision into the existing
decider, and polishes the Phase 6 companion web app only where cheap (mobile UI
refresh equivalent). Files: chat/cowork UI + decider seam (worker maps first),
`public/companion/*` polish only. Record what is UI-only vs real.

## 13. Mobile & Desktop updates — RECORD + J polish

Mobile UI refresh: cosmetic; the companion web app is the local equivalent —
polish folded into Group J, nothing separate. Desktop release channels
(Stable/Latest): SanRemes releases via `package-win.yml` on master; the pipeline
does NOT change. RECORD only: a "Latest" channel maps to no SanRemes concept
beyond the existing master builds; no code.

## 14. Model notes — NOT APPLICABLE

Fable 5.2 / Mythos 5.2 / Opus 4.5 deprecation are Anthropic API matters. SanRemes
uses Groq free-tier + local Ollama and never calls the Anthropic API. No code,
no model work in this job. Record only.

## Groups and commit order

| Group | Feature | Commit prefix |
|---|---|---|
| A | Install-as-app graduated permissions | `Install as app:` |
| B | Computer Use (safe subset) | `Computer Use:` |
| C | Meetings | `Meetings:` |
| D | Duet (proactive agent) | `Duet:` |
| E | Ship (PR agents) | `Ship:` |
| F | Connector file transfers | `Connector files:` |
| G | Data live sharing + certified views | `Data:` |
| H | Enterprise security, local equivalents | `Enterprise security:` |
| I | Managed agents gaps (orchestration, dreaming, outcomes) | `Managed agents:` |
| J | One Claude unified experience + companion polish | `One Claude:` |
| K | Motion free/local path (ffmpeg template explainer, built) | `Motion:` |

Wave 1: A, B, C, D, E, F. Wave 2: G, H, I, J, K.
