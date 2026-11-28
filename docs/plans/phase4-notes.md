# Phase 4 notes — Integrations depth (Microsoft 365 connectors first-class, connectors marketplace polish, minimal side-loaded Chrome extension)

Built 2026-11-28 on base `3d63c48d` (Phase 3). No version bump, no release, no push.

## What was built

### 1. Microsoft 365 connectors, first-class

- **Curated list** (`shared/connector-curated.ts`, `server/composio.ts`): Outlook (`outlook`), OneDrive (`one_drive`), SharePoint (`share_point`) and Microsoft Teams (`microsoft_teams`) join Gmail and Drive in the curated list, with labels, domains, categories and plain-words blurbs. Each carries the "Microsoft 365" category; the Teams and SharePoint blurbs say they need a work or school Microsoft account, and the Outlook and OneDrive blurbs say nothing of the kind, because personal accounts work there. `MICROSOFT_365_CONNECTOR_SLUGS` names the four.
- **Copy** (`src/lib/app-catalog.ts`): `connectorDescription` names the four in plain words, including the work-or-school limit for Teams and SharePoint. Documented in `docs/composio.md` ("Microsoft 365 apps").
- **Auth and grants**: unchanged from any other connector — managed OAuth through the Composio broker, or the person's own project key, and the same per-bot grants. No sign-ups, credentials, or payments were involved; no live Composio call needing a real account was made.

### 2. Connectors marketplace polish (`src/components/PluginsPanel.tsx`, `src/components/AppTile.tsx`, `src/components/AppGrantPrompt.tsx`)

The seven scoping gaps, closed:

- **(a) Promotion/grouping**: the four apps appear in a featured "Microsoft 365" section after Connected (connected ones stay out of it), and `pickCategory("Microsoft 365")` works because the cards carry the category. The server walk injects the category too (`server/composio-catalog.ts`, `withMicrosoft365Category`, capped at four categories), so live-catalog cards group the same way.
- **(b) Catalog-walk stall**: the walk used to run up to 100 pages at 15 s a page — up to 25 minutes on first read. It now stops at a 60,000 ms wall-clock budget (`CATALOG_WALK_MS`), serves the partial catalog with `stalled: true` and stop reason `"timeout"`, and never leaves the panel hung.
- **(c) Install-time grants**: opening an app's account-name form now shows "Which bots can use {app}?" with a switch per grantable bot, on for every bot the old auto-grant would have given it to. The choice is applied by `appConnected` when the connection lands, exactly as the later prompt does; unchecking every bot grants none and says so. No picker appears when adding a second account, or for someone who cannot change bots.
- **(d) Browse cap**: paginated, not raised. The "all apps" section shows one page of 48 (`APPS_PREVIEW_COUNT`) with a "Show {remaining} more" button and a "Showing {shown} of {total}" line. The page resets when the list itself changes (search, category, connected tab) — deliberately not when the surface flips to MCP servers and back, so that round-trip keeps the page.
- **(e) Tool-level preview**: every tile shows its tool and trigger counts from the catalog ("3 tools · 1 trigger"). Where the install has its own Composio project key, the count opens to the tool names (`GET /api/connectors/:slug/tools`, `server/routes/connectors-listing.ts`, `server/composio.ts` `listToolkitTools`, de-duplicated, descriptions sliced to 140 characters, fetched once). On a managed install the broker has no per-toolkit tool route, so the tile shows the counts and no names — a display limit only, stated in `docs/composio.md`. The preview lives in a child component (`AppTileTools`) so the tile itself stays a plain render with no hooks.
- **(f) Wording**: the app never promised a "one-click install" for connectors — the subtitle already reads "Connect an app or your own MCP server once…". The phrase lived only in the plan document. Verified, not reworded; recorded here instead.
- **Locales**: `apps.showAll` removed from every pack; `apps.showMore`, `apps.showingCount`, `apps.toolsCount` / `apps.toolsCountOne`, `apps.triggersCount` / `apps.triggersCountOne`, `apps.tools.loading` / `apps.tools.empty` / `apps.tools.more`, `apps.section.microsoft365` and the four catalog blurbs added.

### 3. Chrome extension, minimal and side-loaded (`chrome-extension/`)

- **Panel** (`manifest.json`, `panel.html`, `panel.js`, `background.js`): an MV3 side panel. The toolbar button opens it; **Ask about this page** sends the current tab's title, URL, selected text and the question to one of the person's bots through the Bot API on `http://localhost:8799`, and **Send** asks a plain question. Replies continue in the same thread, which also shows in the app. A `202 working` answer is polled; `needs_approval` is reported as something to answer in the app; 401/403/429/404 are plain-words errors, not silent failures.
- **Permissions, kept small**: `sidePanel`, `activeTab`, `scripting`, `storage`; host access only `http://localhost:8799/*`. There is no content script and no always-on access to pages — the page is read on demand, when the button is clicked. The bot ID and key are kept only in this browser.
- **README** (`chrome-extension/README.md`): side-loading steps (`chrome://extensions` → Developer mode → Load unpacked), how to mint a Bot API key, the fenced-call caveat, and that there is **no Web Store listing by design** in this phase.
- **Test** (`chrome-extension/extension.test.ts`, added to the vitest include list in `vite.config.ts`): the manifest parses as MV3 with localhost-only host permissions and no content scripts, the scripts parse, and nothing but the local server is called.

### 4. Microsoft 365 add-ins: skipped, on purpose

No add-in was built, and no web page was dressed up as one. An Office JS add-in needs a hosted web app plus a per-host XML manifest, Partner Center / Microsoft 365 program membership, and up to four weeks of AppSource review; the Composio connectors in section 1 are the standing equivalent, and the only real gap is in-ribbon document editing, which a connector cannot do. That gap stays open; see "Deferred".

## Verification

Gates on the final tree (base `3d63c48d` plus this work, uncommitted):

- Focused tests: **203 passed, 0 failed** across 11 files (`server/composio-catalog` 23, `server/composio` 66, `server/routes/connectors-listing` 7, `src/lib/app-catalog` 7, `src/lib/analytics-allowlist` 7, `PluginsPanel.grants` 26, `PluginsPanel.listing` 5, `PluginsPanel.window` 7, `PluginsPanel.navigation` 48, `AppTile.tools` 4, `chrome-extension/extension` 3). Full `pnpm test` never finishes on this VM; focused runs are the accepted standard.
- Typecheck: pass (`tsc -b && tsc -p tsconfig.server.json && tsc -p packages/phone-protocol/tsconfig.json`), run alone. Two errors found on the way were fixed, not waived: an unused `t` import left in `PluginsPanel.window.test.ts` when the old "Show all" helper went away, and a cast in the new tools route that TypeScript would not narrow.
- Lint: **0 warnings, 0 errors** (`oxlint --deny-warnings`, 7,799 files).
- i18n: valid, **16 languages**, 12,233 English strings (`node scripts/generate-locale.mjs --check`).
- Isolated fixture doctor: `"ok": true`, `"problems": []` at `http://127.0.0.1:21006`. The fixture also exercised the new work live: `GET /api/connectors/catalog` returned the 28 curated cards including all four Microsoft 365 apps under "Microsoft 365", and `GET /api/connectors/outlook/tools` answered 503 with the plain message ("Tool lists need your own Composio project key. Add it in Settings → API keys."). Fixture server log: `/tmp/sanremes-verification-evidence/server-1795849305324-13689.log`. Recipe: `docs/verification/README.md`.
- File-size ratchet: `server/index.ts` is unchanged in line count (15,202); no new file exceeds 1,000 lines (largest is `chrome-extension/panel.js`, 161 lines).

## Deferred (with reasons)

- **In-ribbon Microsoft 365 editing**: the one gap the connectors do not cover. It needs the full add-in route (hosted web app, per-host manifest, Partner Center membership, AppSource review) — out of scope for this phase by the scoping verdict.
- **Tool names on a managed install**: the managed broker has no per-toolkit tool route, so tiles there show counts only. Adding it needs a broker route, not a panel change.
- **Composio free-tier call cap**: the pricing page says 10,000 calls a month and the toolkit FAQ says "Hobby" 100,000. Neither number is promised anywhere in the product; the discrepancy is recorded here rather than resolved.
- **Chrome extension in the browser**: no live browser check covers the panel itself; its manifest, scripts and endpoints are covered by the static suite and the Bot API it calls is covered by the server tests and the fixture above. A packaged-browser run would need the side-loaded extension on a machine with SanRemes running.
