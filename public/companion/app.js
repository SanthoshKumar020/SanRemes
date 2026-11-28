// SanRemes companion: a thin phone client over the Bot API (docs/bot-api.md). It holds no account of its own: each
// bot is added here with the address and key from that bot's Bot API card, and the key stays in this browser's
// storage, going only to the address it was saved for. The Bot API has no list of bots or threads, so the bots and
// threads shown here are the ones saved on this device. Approvals are never answered from here: a bot that stops at
// an approval waits for the person in the SanRemes app.
"use strict";

var STORE_KEY = "sanremes-companion-v1";
var POLL_MS = 2000;

function load() {
  try {
    var parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (parsed && Array.isArray(parsed.bots)) return { bots: parsed.bots, threads: parsed.threads || {} };
  } catch { /* a bad store starts empty */ }
  return { bots: [], threads: {} };
}

function save(state) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

var state = load();
var openThread = null;
var pollTimer = null;

function el(tag, text, className) {
  var node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function statusLine(text) {
  document.getElementById("status").textContent = text || "";
}

function botPath(bot, suffix) {
  var origin = (bot.origin || "").replace(/\/$/, "");
  return origin + "/hooks/api/bots/" + encodeURIComponent(bot.id) + suffix;
}

async function callBot(bot, method, suffix, body) {
  var response = await fetch(botPath(bot, suffix), {
    method: method,
    headers: {
      "Authorization": "Bearer " + bot.key,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  var data = null;
  try { data = await response.json(); } catch { /* a non-JSON answer carries no detail */ }
  if (!response.ok) throw new Error((data && data.error) || ("The server answered " + response.status + "."));
  return data;
}

function threadState(bot, threadId) {
  var list = state.threads[bot.id] || [];
  var found = list.find(function (item) { return item.thread === threadId; });
  if (!found) {
    found = { thread: threadId, title: "", status: "working", reply: "", updatedAt: Date.now() };
    list.unshift(found);
    state.threads[bot.id] = list.slice(0, 20);
    save(state);
  }
  return found;
}

function rememberThread(bot, threadId, title) {
  var item = threadState(bot, threadId);
  if (title && !item.title) item.title = title.slice(0, 80);
  item.updatedAt = Date.now();
  save(state);
  return item;
}

function statusPill(status) {
  var pill = el("span", status === "working" ? "Working" : status === "needs_approval" ? "Needs approval" : "Replied");
  pill.className = "pill" + (status === "working" ? " working" : status === "needs_approval" ? " needs" : "");
  return pill;
}

function approvalNote() {
  var note = el("p", "Needs approval — answer it in the SanRemes app. Approvals can't be given from outside.");
  note.className = "muted";
  return note;
}

function show(target) {
  openThread = null;
  stopPolling();
  document.querySelectorAll("nav button").forEach(function (button) {
    button.setAttribute("aria-pressed", String(button.dataset.view === target));
  });
  ["bots", "running", "settings", "thread"].forEach(function (name) {
    document.getElementById("view-" + name).hidden = name !== target;
  });
  if (target === "bots") renderBots();
  if (target === "running") renderRunning();
  if (target === "settings") renderSettings();
  statusLine("");
}

function stopPolling() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}

function renderBots() {
  var root = document.getElementById("view-bots");
  root.replaceChildren();
  if (!state.bots.length) {
    var empty = el("div", undefined, "card");
    empty.append(el("h2", "No bots yet"));
    empty.append(el("p", "Add a bot in Settings with the address and key from its Bot API card.", "muted"));
    var go = el("button", "Open Settings", "primary");
    go.addEventListener("click", function () { show("settings"); });
    empty.append(go);
    root.append(empty);
    return;
  }
  state.bots.forEach(function (bot) {
    var card = el("div", undefined, "card");
    card.append(el("h2", bot.label || bot.id));
    card.append(el("p", bot.origin, "muted"));
    var threads = state.threads[bot.id] || [];
    if (!threads.length) {
      card.append(el("p", "No conversations on this phone yet. Start one below.", "muted"));
    }
    threads.forEach(function (item) {
      var row = el("div", undefined, "row");
      var open = el("button", item.title || item.thread.slice(0, 12));
      open.addEventListener("click", function () { openConversation(bot, item.thread); });
      row.append(open, statusPill(item.status));
      card.append(row);
    });
    var composer = el("textarea");
    composer.setAttribute("dir", "auto");
    composer.setAttribute("aria-label", "Message " + (bot.label || bot.id));
    composer.placeholder = "Message " + (bot.label || bot.id) + "…";
    var send = el("button", "Send", "primary");
    send.addEventListener("click", async function () {
      var text = composer.value.trim();
      if (!text) return;
      composer.value = "";
      send.disabled = true;
      try {
        var answer = await callBot(bot, "POST", "/messages", { message: text, wait: 0 });
        var item = rememberThread(bot, answer.thread, text);
        item.status = answer.status || "working";
        if (answer.reply) item.reply = answer.reply;
        save(state);
        openConversation(bot, answer.thread);
      } catch (error) {
        statusLine(error.message);
      } finally {
        send.disabled = false;
      }
    });
    card.append(composer, send);
    root.append(card);
  });
}

function openConversation(bot, threadId) {
  openThread = { bot: bot, thread: threadId };
  stopPolling();
  document.querySelectorAll("nav button").forEach(function (button) { button.setAttribute("aria-pressed", "false"); });
  ["bots", "running", "settings"].forEach(function (name) { document.getElementById("view-" + name).hidden = true; });
  var root = document.getElementById("view-thread");
  root.hidden = false;
  renderConversation();
  pollTimer = setInterval(renderConversation, POLL_MS);
}

async function renderConversation() {
  if (!openThread) return;
  var bot = openThread.bot;
  var threadId = openThread.thread;
  var item = threadState(bot, threadId);
  var root = document.getElementById("view-thread");
  root.replaceChildren();
  var card = el("div", undefined, "card");
  card.append(el("h2", item.title || (bot.label || bot.id)));
  card.append(el("p", "Thread " + threadId, "muted"));
  var row = el("div", undefined, "row");
  row.append(statusPill(item.status));
  var back = el("button", "Back to bots");
  back.addEventListener("click", function () { show("bots"); });
  row.append(back);
  card.append(row);
  try {
    var answer = await callBot(bot, "GET", "/messages?thread=" + encodeURIComponent(threadId));
    if (answer.status) {
      item.status = answer.status;
    } else if (answer.reply) {
      item.status = "replied";
      item.reply = answer.reply;
    }
    item.updatedAt = Date.now();
    save(state);
  } catch (error) {
    statusLine(error.message);
  }
  if (item.reply) card.append(el("p", item.reply, "message bot"));
  if (item.status === "needs_approval") card.append(approvalNote());
  var composer = el("textarea");
  composer.setAttribute("dir", "auto");
  composer.setAttribute("aria-label", "Continue this conversation");
  composer.placeholder = "Continue…";
  var send = el("button", "Send", "primary");
  send.addEventListener("click", async function () {
    var text = composer.value.trim();
    if (!text) return;
    composer.value = "";
    send.disabled = true;
    try {
      var answer = await callBot(bot, "POST", "/messages", { message: text, thread: threadId, wait: 0 });
      item.status = answer.status || "working";
      if (answer.reply) item.reply = answer.reply;
      item.updatedAt = Date.now();
      save(state);
      renderConversation();
    } catch (error) {
      statusLine(error.message);
    } finally {
      send.disabled = false;
    }
  });
  card.append(composer, send);
  root.append(card);
}

async function renderRunning() {
  var root = document.getElementById("view-running");
  root.replaceChildren();
  if (!state.bots.length) {
    root.append(el("p", "No bots yet. Add one in Settings.", "muted"));
    return;
  }
  var busy = [];
  for (var index = 0; index < state.bots.length; index += 1) {
    var bot = state.bots[index];
    var threads = state.threads[bot.id] || [];
    for (var j = 0; j < threads.length; j += 1) {
      var item = threads[j];
      try {
        var answer = await callBot(bot, "GET", "/messages?thread=" + encodeURIComponent(item.thread));
        item.status = answer.status || (answer.reply ? "replied" : item.status);
        if (answer.reply) item.reply = answer.reply;
        item.updatedAt = Date.now();
      } catch {
        item.status = "unknown";
      }
      if (item.status === "working" || item.status === "needs_approval") busy.push({ bot: bot, item: item });
    }
  }
  save(state);
  if (!busy.length) {
    root.append(el("p", "Nothing running right now.", "muted"));
    return;
  }
  busy.forEach(function (entry) {
    var card = el("div", undefined, "card");
    card.append(el("h2", entry.item.title || (entry.bot.label || entry.bot.id)));
    var row = el("div", undefined, "row");
    row.append(statusPill(entry.item.status));
    var open = el("button", "Open");
    open.addEventListener("click", function () { openConversation(entry.bot, entry.item.thread); });
    row.append(open);
    card.append(row);
    if (entry.item.status === "needs_approval") card.append(approvalNote());
    root.append(card);
  });
}

function renderSettings() {
  var root = document.getElementById("view-settings");
  root.replaceChildren();
  var note = el("p", "Keys stay in this browser and go only to the address saved with them. Nothing here is sent anywhere else.", "muted");
  root.append(note);
  state.bots.forEach(function (bot, index) {
    var card = el("div", undefined, "card");
    card.append(el("h2", bot.label || bot.id));
    card.append(el("p", bot.origin + " · " + bot.id, "muted"));
    var remove = el("button", "Remove bot");
    remove.addEventListener("click", function () {
      state.bots.splice(index, 1);
      delete state.threads[bot.id];
      save(state);
      renderSettings();
    });
    card.append(remove);
    root.append(card);
  });
  var form = el("div", undefined, "card");
  form.append(el("h2", "Add a bot"));
  var labelInput = el("input");
  labelInput.id = "new-label";
  labelInput.autocomplete = "off";
  var originInput = el("input");
  originInput.id = "new-origin";
  originInput.inputMode = "url";
  originInput.autocomplete = "off";
  originInput.value = window.location.origin;
  var idInput = el("input");
  idInput.id = "new-id";
  idInput.autocomplete = "off";
  var keyInput = el("input");
  keyInput.id = "new-key";
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  var labels = [["Name", labelInput, "e.g. Scout"], ["Server address", originInput, ""], ["Bot id", idInput, "From the Bot API card"], ["Key", keyInput, "Paste the key from the Bot API card"]];
  labels.forEach(function (entry) {
    var label = el("label", entry[0]);
    label.htmlFor = entry[1].id;
    if (entry[2]) entry[1].placeholder = entry[2];
    form.append(label, entry[1]);
  });
  var add = el("button", "Add bot", "primary");
  add.addEventListener("click", function () {
    var origin = originInput.value.trim().replace(/\/$/, "");
    var id = idInput.value.trim();
    var key = keyInput.value.trim();
    if (!origin || !id || !key) { statusLine("Fill in the server address, bot id and key."); return; }
    if (!/^https?:\/\//.test(origin)) { statusLine("The server address must start with http:// or https://."); return; }
    state.bots.push({ label: labelInput.value.trim() || id, origin: origin, id: id, key: key });
    save(state);
    statusLine("Bot added.");
    show("bots");
  });
  form.append(add);
  root.append(form);
}

document.querySelectorAll("nav button").forEach(function (button) {
  button.addEventListener("click", function () { show(button.dataset.view); });
});
show("bots");
