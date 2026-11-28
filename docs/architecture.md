# SanRemes internal architecture

As of v0.1.6 (commit `cb861783`). SanRemes is a fork of OpenMausBot
(open-source edition), renamed and extended in place. This document
describes the code as it stands; every component named here was verified
in the tree. Where something could not be verified, that is stated
instead of guessed.

## 1. Harness — the local server

The harness is a single Node process, `server/index.ts` (15,258 lines).
It is the whole backend: it owns the HTTP server, the bot store, agent
turns, approvals, computers, and the event fan-out. The desktop client
(`src/`, Electron shell in `electron/`) is a front end to it, not a
second backend.

- **Listen address.** Port `SANREMES_PORT` (default `8799`); the webhook
  receiver is `PORT + 1` (default `8800`). The harness binds loopback
  only and rejects requests whose `Host` is not loopback (see §9).
- **Routes layer.** HTTP handling is split into small route factories
  under `server/routes/` (one file per area: `bots-create.ts`,
  `bot-messages.ts`, `computers.ts`, `jobs.ts`, `job-bot.ts`,
  `task-queue.ts`, `phone-gate.ts`, …). `server/routes/table.ts`
  defines the dispatch contract: each route is a `RouteHandler`
  returning `PASS` or void, and `dispatchRoutes` runs them in order.
  `server/index.ts` wires the factories together with the shared hosts
  (`server/host/`), the store, and the turn engine.
- **Agent processes.** The server owns agent processes: it spawns the
  engine CLIs / ACP subprocesses for a bot's turn (drivers, §2),
  tracks live turns (`server/live-turns.ts`), enforces per-bot thread
  limits (`server/bot-thread-limits.ts`), and releases turn resources
  (including the computer claim) when a turn settles. On a Cloud home,
  turns run inside the bot box (`server/bot-box/`), started at boot.
- **State.** Bots, threads, messages and tasks live in the data dir
  (default `~/.sanremes`) as JSON files, written atomically
  (`server/atomic.ts`). `server/store.ts` is the `Store` the route
  factories and hosts share.
- **Turns.** `server/coordinator.ts` composes turns across bots
  (handoff / `coordinate_bots`); `server/turn-route.ts` routes a direct
  message to a turn. Bot-to-bot turns that hit a usage limit are resent
  once to a backup engine (`server/host/peer-limit-resend.ts`).

## 2. Drivers — how a bot's brain is selected

`server/drivers/` holds one driver per engine family, registered in
`server/drivers/builtIn.ts` as `BUILT_IN_DRIVERS`.

- **Interface.** `ProviderDriver<Config>` in `server/contracts.ts`:
  a `driverKind`, metadata (display name, access kind
  `subscription | custom | api`, optional CLI version check),
  `decodeConfig` / `defaultConfig`, a `models` catalog, and `create`
  returning a `ProviderInstance`. The instance carries the adapter
  (capabilities), `snapshot()`, optional one-shot `generateText` /
  `generateMemoryText` / `reviewPermission`, and `dispose()`.
  A bot stores a `ModelSelection` (instance + model); the provider
  registry (`server/harness/registry.ts`) holds the live instances.
- **Families.** Native CLI drivers: Claude (`drivers/claude.ts`),
  Codex (`drivers/codex.ts`), Antigravity (`drivers/antigravity.ts`).
  ACP subprocess drivers live in `server/drivers/acp/` (Grok, Gemini,
  Kimi, Droid, Cursor, OpenCode, Qwen, Hermes, Cline, Copilot,
  Command Code, Kiro, Devin, Omp, Mistral Vibe, custom). API-key
  chat-completions drivers share `drivers/openai-chat.ts`:
  Groq, Cerebras, Mistral, Greenference, Modelgo, Meta, Minimax,
  DeepSeek, OpenRouter-compatible (`drivers/openai-compat.ts`).
  Local engines: Ollama (`drivers/ollama.ts`), Pi (`drivers/pi.ts`),
  Muse Code (`drivers/muse-code.ts`).
- **SanRemes additions (v0.1.5).** Cerebras (`drivers/cerebras.ts`,
  default `gpt-oss-120b`) and Mistral (`drivers/mistral.ts`, default
  `mistral-large-latest`) are opt-in providers: they appear only when
  the operator supplies their own key (held in the Vault), and they
  serve as *decider* providers — see below — as well as full drivers.
- **Decider + cross-provider failover.** `server/decider/` is the
  small-model router used for seams such as room routing and helper
  picks. `server/decider/index.ts` tries configured providers in
  order; a result is retryable when it is a 429 or a 5xx
  (`retryable()`), and the next configured provider gets the turn.
  Cerebras and Mistral join that candidate list only when their keys
  exist (`server/decider/accounts.ts`, `server/decider/chat.ts`).
  The same transient classification lives in `server/drivers/retry.ts`
  (429 / 5xx / overloaded / reset are retried; auth or request-shape
  errors are not). For full bot turns, quota/limit failover is handled
  separately by `server/quota-switch.ts` and the limit-takeover host
  (`server/host/…`, `limit-notices.json`): a bot whose engine hits its
  limit can move to a configured backup engine. No single
  cross-provider failover path for bot turns was verified beyond these
  two mechanisms.

## 3. Event bus / messaging

There is no separate message broker; the server is the bus.

- **SSE (server → clients).** `server/sse-fanout.ts` fans frames out
  to connected clients with backpressure handling (screen frames are
  dropped first; durable events are never dropped — an over-buffered
  client is disconnected so its `EventSource` reconnects and replays
  via `Last-Event-ID`, backed by `server/host/sse-replay.ts`
  `ReplayBuffer`). `server/host/bot-frames.ts` shapes per-bot frames.
- **WebSocket upgrades.** `server/routes/upgrades.ts`
  (`createUpgrades`) attaches upgrade handling to the HTTP server
  (`upgrades.attach(server, handleRequest)` in `server/index.ts`);
  it is used for live surfaces such as the live call
  paths. The exact set of upgrade routes was not enumerated here.
- **Wire types.** All client-visible shapes live in `shared/` and in
  `packages/phone-protocol/src/` (§6). `shared/wire.ts` re-exports
  the protocol's `wire.ts` (bots, messages, rooms, tasks, frames).
  Server code imports those same types, so the server and desktop
  agree on the shape by construction.
- **Inbound from outside.** External messages arrive only through
  fenced doors: the Bot API (§7) — never by talking to the harness socket directly.

## 4. Computer claim / computer use

A bot does work on a computer only through a claim; every claim passes
one gate in the server (`server/index.ts`, "Every computer claim
passes here").

- **Kinds of computer.** *This computer* — the host machine, via a
  local computer connection (`server/local-computer.ts`, incl. Linux
  CUA descriptors and a Windows path); *Local VM* — an isolated
  containerised Linux desktop (`server/container-computer.ts`,
  Cua sandbox, durable only under `/home/cua/workspace`);
  *VPS desktop* (`server/vps-computer.ts`); *cloud computer* —
  a managed Boat (`server/boat.ts`: provision, wake, health, delete,
  auto-sleep; `server/boat-command.ts` runs commands in it).
  `server/computer-selection.ts` picks among the options a bot may
  use; `server/shared-computers.ts` / `server/lent-computers.ts`
  cover computers shared with, or lent by, another home.
- **Browser engine.** `server/browser-engine.ts` is agent-browser:
  it downloads/pins the agent-browser release, keeps one Chrome
  profile per saved browser session under
  `agent-browser-profiles/` in the data dir, and fails closed with an
  actionable reason rather than leaving a bot silently browserless.
  Browser automation is also exposed as bot tools (page watches,
  errands) via `server/browser-*.ts` and `server/routes/browser-*.ts`.

## 5. Approvals

Approval modes are `ask | edits | auto | full | custom`
(`packages/phone-protocol/src/approval-mode.ts`). They are *passed
through* to the engine's own permission mode — the harness never
decides a permission itself, except Full access, which answers the
residual prompts the person granted. `edits` exists only on engines
with such a mode (Claude, Grok, Antigravity, Qwen, Gemini, Hermes);
`custom` only on Codex. Switching engines drops the level to Ask when
the new engine cannot honour it (`modelSwitchNeedsAsk`).

Server-side, the gate is spread across:

- `server/auto-approve.ts` — the verdict for a pending tool call
  (`autoVerdict`, held notes, undelivered-approval handling);
- `server/safety-floor-gate.ts` — a floor that denies regardless of
  mode;
- `server/drivers/chat-tool-approval.ts` and the ACP approval
  handling in `server/drivers/acp/` — per-engine permission
  round-trips;
- `server/host/ask-cards.ts` / `server/waiting-on-person.ts` — the
  question/approval cards the person answers in chat, and the
  "waiting on person" state that blocks the turn meanwhile.

**Job Bot approval/submit gate.** Job applications are gated twice.
First, a found job enters an approval queue in `jobs.json` and must
be approved by the person (or by the auto-apply setting) — see §8.
Second, `JobsStore.submitGate(jobId)` (`server/jobs-store.ts`)
refuses submission unless the job exists, has a queue item in state
`approved`, was decided by `user` (or by `auto` while auto-apply is
on), the day's application cap is not reached, and the queue is not
paused. Reasons: `no-such-job | no-queue-item | not-approved |
daily-cap | paused`.

## 6. Wire protocol — `packages/phone-protocol`

`packages/phone-protocol/` (`@sanremes/phone-protocol`) is the shared
wire contract: frame and response types, cards, widgets, mascot,
pairing modules. Its `package.json` describes it as "the wire contract
the desktop and server share". Key modules:

- `src/wire.ts` — the client-visible model for tasks, bots, messages
  and rooms (what the server emits in every response and SSE frame);
- `src/app-rpc.ts` — JSON-RPC between an MCP app frame and its host
  (only `tools/call`, `tools/list`, `resources/read`,
  `resources/list`);
- `src/approval-mode.ts`, `src/live-approval.ts`,
  `src/computer-ask.ts` — approval and computer-use cards;
- `src/bot-avatar.ts`, `src/mascot-bodies.ts`,
  `src/bot-body.ts` — mascot / avatar / body shapes;
- `src/pairing-code.ts` — pairing codes and links, and the sentences
  for a wrong kind of code;
- `src/responses.ts` — response shapes, including
  `PairedDevice`.

It is **shared by the desktop and the server**:
`shared/wire.ts` re-exports it for server and desktop code. That is why it is KEPT in Phase 1 —
it is not phone-only code, and deleting it would break the desktop
and server wire contract.

## 7. Bot API — the hooks API

`server/bot-api-host.ts` (with `server/bot-api.ts` for the key store)
is the outward hooks API used by the WhatsApp and Telegram bridges.

- **Outside call:** `POST /hooks/api/bots/<id>/messages` on the
  webhook receiver, bearer key in the `Authorization` header, body
  `{ message, thread?, wait? }`. Default wait 50 s, max 5 min; the
  call answers "working" with the thread id rather than dropping.
  The turn it starts is an "api" (outside) trigger: it never acts
  for the person, is told the message came from outside, and anything
  needing an approval waits for the person in the thread.
- **Inside management:** `POST /api/bots/<id>/bot-api[/new-key |
  /acts-as-owner]` — switch on/off, mint a key, toggle acts-as-owner —
  open only to whoever may edit the bot.
- **Acts-as-owner.** Off by default, owner-only. A key marked
  `acts-as-owner` runs its threads at the bot's own level with its
  saved allowances, as the owner's work; the never-list, the safety
  floor and the level's own holds still apply. It is never allowed on
  a team's Cloud or a hosted workspace without the operator's policy.
  Without it, API threads are fenced like any other outside thread.

## 8. SanRemes additions

These are changes made after the OpenMausBot fork (downstream of
commit `d5bdd06f`); the rest of the tree is upstream-derived.

- **Job Bot.** `server/jobs-store.ts` (`jobs.json`: profile, resume
  versions, found jobs, approval queue, settings; credentials never
  live here — a platform login is only a Vault login id),
  `server/routes/job-bot.ts` (`GET /api/jobs`, `PATCH` profile/
  settings, `POST` approve/reject, `POST /api/jobs/search` starts a
  Job Apply Bot turn), `server/routes/jobs.ts`, `server/jobs-run.ts`
  (`JobRunDriver`), `server/jobs-resume.ts` (search-prompt parsing,
  resume tailoring). Daily cap, pause, per-platform settings and
  two-factor flags are in the settings; the submit gate is §5.
- **Task queue.** `server/tasks-store.ts` (`tasks.json`): a ticketed
  queue with atomic checkout — one process writes it, a claim only
  lands while the task is still queued, one bot ever holds the lock,
  30-minute lease (`TASK_LOCK_LEASE_MS`), run history.
  `server/routes/task-queue.ts` (`/api/tasks`). Design doc:
  `docs/plans/task-queue-v016.md` (v0.1.6).
- **Optional Ollama install.** `server/ollama-setup.ts` keeps
  `LOCAL_QWEN_MODEL = "qwen3:4b"` and `LOCAL_QWEN_URL =
  http://127.0.0.1:11434` for the optional path only: the Keys page
  Ollama panel probes a running Ollama and downloads `qwen3:4b`
  through `pullOllamaModel` (`server/routes/instances.ts`
  `/api/instances/ollama/pull`). Nothing installs Ollama or Qwen at
  first run, and the Windows installer ships no Ollama bundle.
  `server/drivers/ollama.ts` is the driver; local models get a long
  first-token wait (30 min at the time of writing, per commit history).
- **Terminal-window fix — not verified as a SanRemes change.** No
  commit or file in the tree could be tied to a distinct SanRemes
  "terminal-window fix". The one terminal-window behaviour verified
  in code is in `server/mcp-bridge.ts`: console children (docker,
  podman, ssh) are started hidden on Windows, "or Windows opens a
  terminal window for it". Whether that predates the fork was not
  established; do not cite it as a SanRemes addition without checking
  upstream history.
- **Nod merge (Phases 1–4, upstream of this doc's scope but
  SanRemes-side).** Structured memory notes, trust layer, browser
  sandbox, self-improvement loop — commits `801f9a8a`,
  `a1c767aa`, `06bf41c9`, `7867a801`.

## 9. Companion sidecar — REMOVED in Phase 1

`companion/` was a separate process that sat in front of the
loopback-only harness so a paired phone could reach it. It was
removed with the phone system: there is no companion process, no
`:8810`/`:8811` listener, and no per-device credential relay. The
harness's loopback-only bind stands.

## Unverified / open questions

- The exact set of WebSocket upgrade routes behind
  `server/routes/upgrades.ts` was not enumerated.
- The per-engine approval round-trip details for ACP drivers beyond
  the mode table in `approval-mode.ts` were not traced.
- The "terminal-window fix" named in the roadmap could not be tied
  to a specific SanRemes commit (see §8).
- `server/index.ts` is 15,124 lines and still growing; the route
  list above is representative, not exhaustive (there are ~150 files
  under `server/routes/`).
