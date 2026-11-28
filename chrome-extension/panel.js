/* global chrome */

// The side panel: asks the local SanRemes bot about the page in front of you, through the Bot API. It talks only to
// the address below; the page itself is read on demand, when you click, and nothing is sent anywhere else.

const DEFAULT_BASE_URL = "http://localhost:8799";
const MAX_MESSAGE = 20000;
const POLL_EVERY_MS = 2000;
const POLL_TRIES = 30;

const botIdInput = document.getElementById("botId");
const baseUrlInput = document.getElementById("baseUrl");
const keyInput = document.getElementById("key");
const questionInput = document.getElementById("question");
const log = document.getElementById("log");
const status = document.getElementById("status");
const askPageButton = document.getElementById("askPage");
const sendButton = document.getElementById("send");

let thread = null;
let busy = false;

const settings = async () => {
  const stored = await chrome.storage.local.get(["botId", "baseUrl", "key"]);
  return {
    botId: (stored.botId ?? "").trim(),
    baseUrl: (stored.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "") || DEFAULT_BASE_URL,
    key: stored.key ?? "",
  };
};
const saveSettings = () => chrome.storage.local.set({
  botId: botIdInput.value.trim(),
  baseUrl: baseUrlInput.value.trim(),
  key: keyInput.value,
});

const say = (text, kind) => {
  const bubble = document.createElement("div");
  bubble.className = kind;
  bubble.textContent = text;
  log.append(bubble);
  bubble.scrollIntoView({ block: "nearest" });
};
const setStatus = (text) => { status.textContent = text; };
const setBusy = (value) => {
  busy = value;
  askPageButton.disabled = value;
  sendButton.disabled = value;
};

const pageContext = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      title: document.title,
      url: location.href,
      selection: window.getSelection()?.toString().slice(0, 2000) ?? "",
    }),
  });
  return result?.result ?? null;
};

const callBot = async ({ botId, baseUrl, key }, body) => {
  const response = await fetch(`${baseUrl}/hooks/api/bots/${encodeURIComponent(botId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const plain = response.status === 401 ? "Wrong key — paste the key from Bot settings again."
      : response.status === 403 ? "The Bot API is off for this bot, or this key cannot use it."
      : response.status === 429 ? "Too many calls in a minute — wait a little and try again."
      : response.status === 404 ? "No such bot, or the thread is gone."
      : `SanRemes answered ${response.status}. Is it running at ${baseUrl}?`;
    throw new Error(plain);
  }
  return response.json();
};

const readThread = async ({ botId, baseUrl, key }, id) => {
  const response = await fetch(`${baseUrl}/hooks/api/bots/${encodeURIComponent(botId)}/messages?thread=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error(`SanRemes answered ${response.status} while reading the thread.`);
  return response.json();
};

const ask = async (message) => {
  if (busy) return;
  const { botId, baseUrl, key } = await settings();
  if (!botId || !key) {
    setStatus("Fill in the bot ID and key under Connection first.");
    return;
  }
  setBusy(true);
  setStatus("");
  say(message, "you");
  try {
    let answer = await callBot({ botId, baseUrl, key }, { message: message.slice(0, MAX_MESSAGE), thread, wait: 60 });
    thread = answer.thread ?? thread;
    for (let attempt = 0; attempt < POLL_TRIES && answer.status === "working"; attempt += 1) {
      setStatus("The bot is still thinking…");
      await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
      answer = await readThread({ botId, baseUrl, key }, thread);
    }
    if (answer.reply) {
      say(answer.reply, "bot");
      setStatus("");
    } else if (answer.status === "needs_approval") {
      say("The bot asked for an approval — open the thread in SanRemes and answer it there.", "note");
      setStatus("");
    } else if (answer.status === "working") {
      say("The bot is still working — its reply will appear in the thread in SanRemes.", "note");
      setStatus("");
    } else {
      setStatus("SanRemes answered, but with no reply to show.");
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
};

askPageButton.addEventListener("click", async () => {
  const question = questionInput.value.trim();
  const page = await pageContext().catch(() => null);
  if (!page) {
    setStatus("Could not read this page — open a normal web page and try again.");
    return;
  }
  const head = `[Page: ${page.title} (${page.url})]`;
  const selected = page.selection ? `Selected text:\n${page.selection}\n\n` : "";
  await ask(`${head}\n${selected}${question || "What is this page about, and what should I know from it?"}`);
  questionInput.value = "";
});

sendButton.addEventListener("click", async () => {
  const question = questionInput.value.trim();
  if (!question) return;
  await ask(question);
  questionInput.value = "";
});

questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendButton.click();
  }
});

for (const input of [botIdInput, baseUrlInput, keyInput]) input.addEventListener("change", saveSettings);

void settings().then((stored) => {
  botIdInput.value = stored.botId;
  baseUrlInput.value = stored.baseUrl;
  keyInput.value = stored.key;
  if (!stored.botId || !stored.key) setStatus("Fill in the bot ID and key under Connection first.");
});
