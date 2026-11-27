# Phase 2 notes — free / BYOK paths after the phone removal (v0.1.7)

Verified 2026-11-27 against HEAD `3d92efef`. Gates ran on `52c93ce6`; the only
delta to `3d92efef` is the one-line bundle fix below, which touches no verified
path (all 28 `bundle-server.mjs` entries exist; no `phone-proxy` reference
remains anywhere).

## What's in v0.1.7

Phase 1, shipped:

- `8083318c` — rebrand + license hygiene (upstream strings cleaned, team
  library repointed, CLA replaced, dead CLA workflow deleted).
- `2f1fcd81` — phone removal (606 files, +2,628/−84,714): `companion/`,
  `relay/`, server phone code, Electron companion management, desktop phone
  UI, Cloudflare phone surfaces. `server/index.ts` 15,258 → 15,124 lines.
  Tunnel account service ported, not deleted.
- `f6b7a763` — ownership hygiene: NOTICE topped with SanRemes copyright,
  README fork notice → Origin paragraph, Boat/ModelGo sponsor badges removed.
- `52c93ce6` — version bump to 0.1.7.
- `3d92efef` — build fix: the v0.1.7 CI build failed on a dangling bundle
  entry (`scripts/bundle-server.mjs` still listed deleted
  `server/drivers/phone-proxy.ts`); one line removed, nothing else.

## What the fixture verification covered

Code-read (not grep-only), then gates on the final tree:

- **Qwen default bot creation** — intact. `startLocalQwenOnBoot` /
  `botsOnBootPick` in `server/ollama-setup.ts`, wired at
  `server/index.ts:15012`. Win32-gated (`platform !== "win32"` returns
  early), so it never runs on this Linux VM and the setup state stays
  `idle`. When Qwen is ready and no default was saved at boot, bots still
  on the boot pick move to Qwen (`qwen3:4b`); a bot pointed elsewhere keeps
  its model, and a saved default is never overridden.
- **Ollama pull endpoint** — intact. `GET`/`POST /api/instances/ollama/pull`
  in `server/routes/instances.ts`: owner-only, `202` on start, state
  machine `idle → pulling → ready/failed`, pulls `qwen3:4b` via
  `pullOllamaModel`.
- **Groq / Gemini provider options** — present. `GroqDriver` and
  `GeminiAgentDriver` are registered in `BUILT_IN_DRIVERS`
  (`server/drivers/builtIn.ts`); both files untouched since the fork
  commit. The fixture doctor lists the `groq` instance (Groq (API),
  `openai/gpt-oss-120b` / `openai/gpt-oss-20b`, `unavailable` with no key
  configured — expected). `geminiAgent` does not appear in the fixture's
  known-instances list because the Gemini CLI is not installed on this VM;
  the same holds for the other ACP drivers (Grok, Kimi, Droid), so that is
  detection, not a regression.
- **Job Bot v2** — intact. `server/routes/job-bot.ts` (`GET /api/jobs`,
  `PATCH` profile/settings, approve/reject, `POST /api/jobs/search`),
  `server/jobs-store.ts` defaults `autoApply: true` with the submit gate
  (`jobs-store.ts:311`), `src/components/jobs/JobBotPage.tsx` and
  `src/lib/jobs.ts` mirror the defaults.
- **Task queue** — intact. `shared/tasks.ts` schema
  (`queued/claimed/running/done/failed`, attempt history),
  `server/tasks-store.ts`, `server/routes/task-queue.ts`
  (create/claim/start/complete/fail/requeue).
- **Bridges** — untouched. `server/bot-api-host.ts`, `server/jobs-store.ts`,
  `server/routes/jobs*.ts`, `server/tasks-store.ts`,
  `server/routes/task-queue.ts` were last touched at `cb861783` (v0.1.6
  bump); zero phone references in any of them. The removal commit's only
  touch to `server/routes/tasks.ts` was dropping the phone-secret
  credential-saving 409 guards. The two `phone` hits in
  `server/routes/instances.ts` are comments about phone sign-in/OAuth, not
  connector code.

Gates (all green, no regressions found):

- Focused tests: **166 passed, 0 failed** across 10 files
  (`ollama-setup`, `routes/instances`, `routes/jobs`, `routes/job-bot`,
  `routes/task-queue`, `tasks-store`, `jobs-store`, `jobs-run`,
  `bot-api-host`, `drivers/groq`). Full `pnpm test` never finishes on this
  VM; focused runs are the accepted standard.
- Typecheck: pass (`tsc -b && tsc -p tsconfig.server.json && tsc -p
  packages/phone-protocol/tsconfig.json`).
- Lint: **0 warnings, 0 errors** (`oxlint --deny-warnings`, 7,678 files).
- i18n: valid, **16 languages**, 12,122 English strings
  (`node scripts/generate-locale.mjs --check`).
- Isolated fixture doctor: `"ok": true`, `"problems": []` at
  `http://127.0.0.1:22003`. Fixture server log:
  `/tmp/sanremes-verification-evidence/server-1795752713354-5834.log`.
  Known fixture artifacts, not failures: the fixture injects a fake
  authenticated Claude CLI, so the default bot shows
  `claude/claude-sonnet-5`; the Qwen setup stays `idle` (win32-gated).

## Still pending on him

- Install v0.1.7 on his laptop.
- Telegram: `TELEGRAM_BOT_TOKEN` + allowlist in Vercel, laptop Bot API +
  tunnel.
- WhatsApp bridge setup (Meta app + number migration, permanent token,
  webhook subscribe, Vercel env vars — see
  `~/workspace/sanremes-web/WHATSAPP_BRIDGE.md`).
- Fresh Groq key for `sanremes-web` + `rag-search-agent` (the old key is
  dead).
- Org-name pick for the GitHub org move (Santo-Square-Automation vs
  santosquare).
