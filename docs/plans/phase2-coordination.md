# Phase 2 coordination — Job Bot wedge hardening

Plan: `~/workspace/your_files/sanremes-claude-features-plan/sanremes-claude-features-phase-plan.md` (Phase 2, row 47 + rows 4, 26-adjacent).
Design docs: `~/workspace/sanremes-jobbot-design.md`, `~/workspace/sanremes-jobbot-v2-design.md`.
Base: v0.1.9 (commit `0195d0db`), master. Phase 0 (`ccb409f7`) + Phase 1 (`2ab078c9`) + spreadsheet fix (`9b14d21f`) already landed.
Scope: ONLY Phase 2. LOCAL ONLY — commit locally on master, do NOT push (push happens after all phases 2–6, per user order 2026-11-28).
Excluded: new job platforms, any CAPTCHA solving (never — hard policy), paid job boards.

## Decisions (coordinator, grounded in the code)

1. **Bridge notify endpoint does NOT exist yet.** `~/workspace/sanremes-web/app/api/` has only `whatsapp/webhook` and `telegram/webhook` (inbound). No `notify` route anywhere. The v2 design already said the notify endpoint is a sanremes-web follow-up, not desktop code — and this phase may not touch sanremes-web code. So item 1 is desktop-side wiring against a documented contract: `server/jobs-report-delivery.ts` POSTs `{ source: "sanremes-job-bot", runId, text }` to the configured notify URL with header `x-sanremes-notify-secret`. Until the endpoint exists, runs stay `pending-bridge` with the plain-words line. The contract is written in the module header and in this note so the sanremes-web follow-up is trivial.
2. **Bridge secret is a Vault saved-secret NAME, never a value in jobs.json.** Settings hold `reportBridge: { whatsappUrl?, telegramUrl?, secretName? }`; the secret is resolved from the Vault at send time. No password/token ever lands in `jobs.json`, logs, or chat.
3. **Company research is best-effort and never blocks applying.** It runs in the tailoring phase for ranked jobs (cached per company within a run), is recorded on the job, and a failure is recorded as a failure with a plain-words reason — the application still goes out.
4. **Layout-change detection is marker + fingerprint, not a new browser stack.** The apply prompt gains a layout section (expected labels when a last-good fingerprint exists). The bot stops with `LAYOUT CHANGED:` (parallel to `HUMAN CHECK:`) when the apply page lacks the expected controls or looks redesigned; on a successful apply it reports the labels it used on a `LAYOUT:` line and the driver stores the fingerprint. The driver stops the run cleanly, records a takeover, and the report says so in plain words.
5. **Manual takeover is run state, not a browser feature.** A stopped run carries `takeover: { jobId, reason, at, status: "waiting" | "resumed" | "abandoned" }`. The Jobs page shows it with "Open the job" + "Resume run" / "Mark done". The person finishes the step in the app's own browser via the existing sign-in/takeover path; the bot never solves a human check.
6. **Schema rule (v2 §4): every new field is optional-with-default.** A required field would fail zod strict parse on v1 files and the store would replace the file with empty defaults — wiping the profile. Same for settings patches.
7. **`server/index.ts` line count may only go DOWN** (ratchet). New driver deps are wired inside the existing `createJobBotRoutes({...})` call object — no net new lines.

## Waves

- **Wave 1 (parallel, new files only, disjoint):**
  - W1 report delivery — `server/jobs-report-delivery.ts` + test (item 1, desktop side + contract).
  - W2 documents — `server/jobs-documents.ts` + test (item 3: cover letters, interview prep, per-platform resume variants; pure builders + filegen writers).
  - W3 layout guard — `server/jobs-layout-guard.ts` + test (item 5: fingerprint, compare, marker, prompt section).
  - W4 company research — `server/jobs-company-research.ts` + test (item 4: wraps Phase 0 `runDeepResearch`, per-company cache, failure never throws).
- **Wave 2 (sequential integration, one worker):** W5 schema + store + routes + driver wiring + prompts. Owns `shared/jobs.ts`, `server/jobs-store.ts`, `server/jobs-run.ts`, `server/jobs-resume.ts`, `server/routes/job-bot.ts`, `server/index.ts` wiring (no net new lines).
- **Wave 3 (UI, after W5):** W6 Jobs page — dashboard, tracker, takeover card, documents buttons, i18n keys. Owns `src/components/jobs/JobBotPage.tsx` (+ dom tests), locale keys via the generator source.
- **Wave 4 (coordinator):** final verification (focused vitest across all touched suites, 3 typechecks, oxlint, `pnpm i18n:check`, fixture doctor `"problems": []`), local commit on master, report.

## Verification standard (every wave)

Focused vitest only (full `pnpm test` never finishes on this VM). Typecheck `tsc -b && tsc -p tsconfig.server.json && tsc -p packages/phone-protocol/tsconfig.json`. Lint `oxlint --deny-warnings`. UI wave also runs `pnpm i18n:check`. Fixture verification per `docs/verification/README.md` (isolated fixture only, never the live app or live user data). File-size ratchet: `server/index.ts` counts only down; a new file >1000 lines needs a LINES entry + reason in the commit message; HARD_CAP 2000. Never `SANREMES_SKIP_HOOKS=1`. UI follows `DESIGN.md` (Lucide icons only). Strict comment rules (`AGENTS.md`).

## Status

- 2026-11-28 ~03:20 IST: coordination note written; Wave 1 spawned (W1–W4).
- Wave 1 COMPLETE, all verified by the coordinator with focused-test re-runs: W4 company research 12/12, W3 layout guard 17/17, W1 report delivery 8/8, W2 documents 20/20 (incl. 7 pre-existing tailor tests). W2's allowed surgical change to `server/jobs-resume.ts` (`tailorResumeText` gains optional `{ maxLines }`, default 48) is in the tree.
- Cleanup noted for Wave 4: `tsc -b` emitted 99 untracked `.js` build artifacts across `server/` and `packages/phone-protocol/src/` — git tracks ZERO `.js` files in those dirs, so all 99 are safe to delete before commit. Full `tsc -b` was OOM-killed twice when run concurrently — run it once, alone, in Wave 4.
- 2026-11-28 ~03:25 IST: Wave 2 spawned (W5 integration — schema, store, routes, driver, prompts). Wave 3 UI follows W5.

## W2 — documents (done, uncommitted)

- Files: new `server/jobs-documents.ts` (190 lines) + `server/jobs-documents.test.ts` (188 lines); surgical change to `server/jobs-resume.ts` only — `tailorResumeText` accepts optional `{ maxLines?: number }`, default 48, behaviour unchanged (7-line diff).
- Exports: `buildCoverLetterText`, `coverLetterDocument`, `buildInterviewPrep`, `tailorResumeVariant`, `writeDocumentFiles`, plus `LINKEDIN_RESUME_MAX_LINES` (36) and the other budget constants. No-match cover letters say plainly "My recent work is in …" and never name an unmatched JD keyword; interview prep gives "Be ready to say you have not used X yet." for unmatched keywords and never fabricates answers; company notes are the first ~800 chars of supplied research, cited as "from web research". `writeDocumentFiles` validates baseName (no `/`, `\`, `..`, max 100 chars) and writes via `writeFileAtomic`.
- Verification: focused vitest `server/jobs-documents.test.ts` + `server/jobs-resume.test.ts` — 20/20 pass (13 new + 7 existing). `tsc -p tsconfig.server.json` exit 0; `tsc -p packages/phone-protocol/tsconfig.json` exit 0; `oxlint --deny-warnings` on the three touched files — 0 warnings, 0 errors. Caveat: the full `tsc -b` chain was OOM-killed (exit 137) on this VM while W1 ran the same chain concurrently; the two per-project checks above were run solo afterwards and pass. Nothing pushed, committed, or deployed.

## W3 — layout guard (done, uncommitted)

- Files: `server/jobs-layout-guard.ts` (100 lines) + `server/jobs-layout-guard.test.ts` (120 lines). Exports `LAYOUT_CHANGE_MARKER = "LAYOUT CHANGED:"`, `LAYOUT_REPORT_PREFIX = "LAYOUT:"`, `layoutFingerprint` (SHA-256 over trim/collapse/lowercase/dedupe/sort), `parseLayoutReport` (null when absent, never throws; cap 50 labels, 200 chars each), `checkLayout` (missing = expected absent from seen, normalized; extras fine; empty expected = not changed), `parseLayoutChange` (description after a leading marker, cap 500 chars, null when absent), `layoutPromptSection` (stop-at-once instruction + marker; lists expected labels when given, else asks for a `LAYOUT:` report line; ends with the post-submit `LAYOUT:` report instruction). Follows the `HUMAN_CHECK_MARKER` pattern in `server/jobs-resume.ts`. No integration wiring — W5 owns `applyPrompt` + driver.
- Tests: focused vitest `server/jobs-layout-guard.test.ts` — **17/17 passed**.
- Lint: `oxlint --deny-warnings` on both files — **0 warnings, 0 errors**.
- Typecheck: scoped strict check of both files with the `tsconfig.server.json` flags (`--strict --noUnusedLocals --noUnusedParameters --erasableSyntaxOnly`, NodeNext, `--ignoreConfig`) — **passed**. The full-repo `tsc -b && tsc -p tsconfig.server.json && tsc -p packages/phone-protocol/tsconfig.json` chain was started but its wrapper was OOM-killed by the VM while several Wave 1 workers ran full `tsc -b` builds concurrently; the orphaned `tsc -b` did complete (buildinfo updated, chain advanced to the server config) but its final exit code was not captured. Do NOT re-run the full chain concurrently with other workers — run it once, alone, in Wave 4.
- Needs a decision / cleanup: `tsc -b` emits ~99 untracked `.js` files across `server/` and `packages/phone-protocol/src/` (none for this module — server tsconfig is `noEmit`). They must be removed before the Wave 4 commit (`git clean` the emitted `.js`, or equivalent); the coordinator should confirm none of them is a real source file.
- No decisions needed on the module itself. One judgement call: `checkLayout` returns `missing` in the caller's original label wording (trimmed, whitespace-collapsed) rather than lowercased, so the plain-words note reads naturally; comparison itself is normalized.

## Wave 1 — W1 report delivery (done 2026-11-28 ~22:0x IST, uncommitted)

- Files: `server/jobs-report-delivery.ts` (109 lines) + `server/jobs-report-delivery.test.ts` (221 lines). No other files touched; no new dependencies.
- `deliverRunReport(input)` POSTs `{ source: "sanremes-job-bot", runId, text }` per configured channel with header `x-sanremes-notify-secret`; 2xx = sent, non-2xx / network error / 15s abort = failed with a fixed plain-words note (never the raw body or the secret); unconfigured channel = `not-configured`, never called. Text capped at 4000 chars with `...`. `timeoutMs` is an optional input override (default 15000) so tests use a short timeout, not a real 15s wait.
- `reportDeliveryLine(outcomes)` covers sent / pending / failed per channel, joined plainly (e.g. "Report sent to WhatsApp. Telegram delivery failed (the bridge did not answer) — read the report here.").
- `REPORT_NOTIFY_CONTRACT` constant documents the endpoint contract for the sanremes-web follow-up (method, path shape, header, body, success/failure meanings). The notify endpoint still does not exist in sanremes-web — runs stay `pending-bridge` until that follow-up lands.
- Security invariants in the module header: secret passed in by the caller, resolved from the Vault at send time; never stored in jobs.json, never logged, never in a report/chat/note; module logs nothing (no headers, bodies, or responses).
- Focused vitest: 8/8 passed (`server/jobs-report-delivery.test.ts`), node:http loopback servers only, no external network.
- Lint: `oxlint --deny-warnings` on both files — 0 warnings, 0 errors.
- Typecheck: `tsc -p tsconfig.server.json` (the config covering `server/`, i.e. both new files) passed with exit 0, and `tsc -p packages/phone-protocol/tsconfig.json` passed with exit 0. Full `tsc -b` was OOM-killed (exit 137, no type errors printed) — the VM runs several Wave 1 workers' typechecks concurrently on 6 GB; a scoped check of both new files under the exact server compiler options also passed clean (exit 0). Coordinator: re-run `tsc -b` alone at Wave 4 when the VM is quiet.
- Decision needed by W5 (integration): where settings hold `reportBridge: { whatsappUrl?, telegramUrl?, secretName? }` and how the secret is resolved from the Vault at send time (decision 2 above); W1 only defines the sender + contract.

### W4 company research — done 2026-11-28

- `server/jobs-company-research.ts` (100 lines) + `server/jobs-company-research.test.ts` (135 lines), uncommitted in the working tree.
- Exports `CompanyResearch`, `CompanyResearchOutcome`, `companyResearchQuestion` (500-char cap, empty company throws plain words), `researchCompany` (injected research fn, never throws; summary verbatim, capped 2000 chars; sources capped 10; throw → "The web search did not answer.", empty answer → "The research came back empty."), `createCompanyResearchCache` (memo by trim + lowercase company, per-run, caches failures too).
- Focused vitest: 12/12 pass. Typecheck (`tsc -b` + server + phone-protocol) and `oxlint --deny-warnings` on both files: clean.
- No live check needed: unit tests use an injected fake research fn only, no network, no fixture. Nothing for the integration worker to decide except the wiring already specified (one cache per run, record outcome on the job, failure never blocks applying).

## Phase 2 complete — W5 + W6 + Wave 4 (2026-11-28 ~06:0x IST, Phase 2 completion worker)

### W5 integration (done)
- `server/jobs-run.ts`: `applyAll` returns `"human-check" | "layout-change" | null`; passes the job's last-good labels into `applyPrompt`; a successful apply stores the `LAYOUT:` fingerprint via `setLastGoodLayout`; a `LAYOUT CHANGED:` close records a waiting takeover and stops the run; a human-check close records a waiting takeover too. `finish` is async and calls `deps.deliverReport` when wired: sent / failed / not-configured / pending-bridge, with the plain-words delivery line in the saved report and the posted message. `resume` marks a waiting takeover `resumed`; new `abandonTakeover` marks it `abandoned`. Research runs through the per-run cache in `tailorRanked`; a failed lookup is recorded and never blocks applying.
- `server/routes/job-bot.ts`: new `GET /api/jobs/tracker`, `POST /api/jobs/:id/outcome`, `POST /api/jobs/:id/follow-up`, `POST /api/jobs/runs/:id/takeover/resume|abandon`, `POST /api/jobs/:id/cover-letter`, `POST /api/jobs/:id/interview-prep`, `POST /api/jobs/:id/resume-variant`; `reportBridge` accepted by the settings PATCH; the single-apply route passes last-good labels into the prompt. The driver gets `researchCompany` + a `deliverReport` wrapper: no bridge configured returns `[]`; a configured URL with no saved secret returns `failed` ("the bridge secret is not saved"); otherwise it calls `deliverRunReport` with the Vault-resolved secret. The secret value is never stored or logged.
- `server/index.ts`: wired inside the existing `createJobBotRoutes({...})` call object — `researchCompany` wraps Phase 0 `runDeepResearch` over keyless `searchWeb` + `fetchPageText`; `resolveReportSecret` resolves the named secret from the Vault at send time via the Apply Bot's turn reader (TEAM_READER fallback). Imports appended to the existing import line. Line count unchanged: 15202 (ratchet pin 15258).
- Schema/store already in tree from the W5 start (optional-with-default fields, `trackerSummary`, outcome/follow-up/research/takeover setters, `reportBridge` merge) — untouched except use.

### W6 UI (done)
- `src/components/jobs/JobBotPage.tsx` (712 → 852 lines): tracker dashboard (totals, per-platform applied + interview conversion, follow-ups due), takeover card ("Open the job" + "Resume run" / "Mark done"), per-match document buttons (cover letter, interview prep, resume variant) with ready markers, `whatsapp: "failed"` report line. Client fns in `src/lib/jobs.ts` (`fetchTracker`, `recordOutcome`, `setFollowUp`, `generateCoverLetter`, `generateInterviewPrep`, `generateResumeVariant`) and `src/lib/jobs-run.ts` (`resumeTakeover`, `abandonTakeover`); 34 new `jobs.*` keys in `src/locales/en.json`.

### Wave 4 verification
- Focused vitest, 11 suites, **145/145 pass**: jobs-run 16, jobs-store 25, routes/job-bot 27, jobs-documents 13, jobs-layout-guard 17, jobs-company-research 12, jobs-report-delivery 8, jobs-resume 7, JobBotPage.dom 13, JobSetupWizard.dom 6, ResumeDiff.dom 1.
- Typecheck `tsc -b && tsc -p tsconfig.server.json && tsc -p packages/phone-protocol/tsconfig.json` run once, alone: exit 0 (fixed 2 errors on the way: `t()` literal-key type, unused `LAYOUT_CHANGE_MARKER` import). No `.js` artifacts left in the tree afterwards.
- `oxlint --deny-warnings`: 0 warnings, 0 errors. `pnpm i18n:check`: valid, 16 languages, 12196 English strings.
- Isolated fixture: launched detached, `doctor --url http://127.0.0.1:21899` → `"problems": []` (one warning only: agent-browser not installed on this machine, pre-existing environment state). Live fixture round-trip: `GET /api/jobs` 200, `GET /api/jobs/tracker` 200, `PATCH /api/jobs/settings` saved `reportBridge` with only the secret name. Fixture stopped and its temp data dir removed afterwards.
- One pre-existing failure fixed on the way: `JobSetupWizard.dom.test.ts` expected the stale risk-warning copy ("Automated applying can get an account restricted"); the shipped locale copy is "Automated applying can look like bot activity" (the JobBotPage test already expects the new copy). Test-only one-line fix, no product copy changed.
- Nothing deferred. No new file over 1000 lines (largest new file: `server/jobs-report-delivery.test.ts`, 221 lines), so no LINES entry in the commit message.
- Note: `docs/plans/phase4-scoping.md` appeared untracked in the tree during this work; it is not Phase 2 work and was left uncommitted.
