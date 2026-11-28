# SanRemes Chrome extension

A minimal side-panel extension: ask the SanRemes bot running on your own machine about the page you are on.

## What it does

- The toolbar button opens a side panel.
- **Ask about this page** sends the current tab's title and URL, any text you selected on the page, and your question to one of your bots, through the Bot API. **Send** asks a plain question, without the page.
- The reply comes back in the panel, and the conversation continues in the same thread, which also shows in the SanRemes app.

## Side-loading (no Web Store listing, by design)

1. Open `chrome://extensions`.
2. Switch on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `chrome-extension` folder.
4. Click the SanRemes toolbar button to open the panel.

There is no Web Store listing for this extension in this phase: it is side-loaded on purpose, so there is no review queue, no store assets and no privacy-policy page to maintain. The extension talks only to your own machine (see below).

## Connecting it

1. In SanRemes, open the bot you want to ask: Bot settings (the gear in the bot's panel) → Advanced: Access → **Bot API** → switch on **Let apps talk to this bot**. Copy the key it shows — it is shown once.
2. In the panel, open **Connection** and paste the bot ID and the key. The address defaults to `http://localhost:8799`, where the local SanRemes server listens; if you run it on another port, set `SANREMES_PORT` there and put that address here instead.
3. Ask away. The bot ID and key are kept only in this browser (`chrome.storage.local`).

## What a call may and may not do

A Bot API call runs fenced: the bot answers from its instructions and memory, in Ask, with no tools — it cannot open apps, browse, change anything or approve anything on your behalf. If it asks for an approval, answer it in the SanRemes app, not here. If the bot is off, the key is wrong, or SanRemes isn't running, the panel says so in plain words instead of failing quietly.

## Permissions, and why each one

- `sidePanel` — the panel itself.
- `activeTab` and `scripting` — read the current tab's title, URL and selected text, only when you click **Ask about this page**. The extension has no always-on access to your pages and no content script.
- `storage` — keeps the bot ID, address and key on this machine.
- Host access is limited to `http://localhost:8799/*`: your own SanRemes server, and nothing else on the web.
