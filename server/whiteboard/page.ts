// The whiteboard as a self-contained show_html page: one HTML document with the
// board's state embedded as JSON, a canvas renderer, and editing in the page.
// No dependency and no network: the page runs inside the show_html sandbox,
// which allows no storage, so the state leaves the page only through
// sanremes.setContext (the bot's model context) and the Save button's
// sanremes.send; the bot persists it by calling show_whiteboard again.
import { APP_LIMITS } from "../../packages/phone-protocol/src/app.ts";
import { createBoard, NOTE_COLORS, NOTE_FILL, parseBoardJson, serializeBoard, type WhiteboardState } from "./board.ts";

const STATE_SCRIPT_ID = "whiteboard-state";

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

/** The state as JSON safe to embed in a script tag: `<` never appears literally, so a note's text cannot close the tag. */
function embeddedState(state: WhiteboardState): string {
  return serializeBoard(state).replace(/</g, "\\u003c");
}

/** The board's state back out of a page built by buildWhiteboardHtml, or the reason it cannot be read. */
export function extractBoardState(html: string): { ok: true; value: WhiteboardState } | { ok: false; error: string } {
  const match = html.match(new RegExp(`<script type="application/json" id="${STATE_SCRIPT_ID}">([\\s\\S]*?)</script>`));
  if (!match) return { ok: false, error: "page: no embedded whiteboard state." };
  return parseBoardJson(match[1]);
}

/** The page for `state`, as one HTML document under show_html's 256 KB cap. */
export function buildWhiteboardHtml(state: WhiteboardState): { ok: true; html: string } | { ok: false; error: string } {
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(state.title)}</title>
<style>
:root { color-scheme: light dark; --ink: #1d1d1f; --quiet: #6e6e73; --line: #d6d6da; --page: #f5f5f7; --card: #ffffff; --accent: #0b5fff; }
@media (prefers-color-scheme: dark) { :root { --ink: #f5f5f7; --quiet: #a1a1a6; --line: #38383a; --page: #1c1c1e; --card: #2c2c2e; --accent: #6ea8ff; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body { background: var(--page); color: var(--ink); font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; display: flex; flex-direction: column; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; background: var(--card); border-bottom: 1px solid var(--line); }
header h1 { margin: 0 8px 0 0; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
header button { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; cursor: pointer; }
header button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
header button:disabled { opacity: 0.4; cursor: default; }
header .spacer { flex: 1; }
header .zoom { min-width: 52px; text-align: center; color: var(--quiet); font-variant-numeric: tabular-nums; }
#status { color: var(--quiet); font-size: 12px; min-height: 16px; padding: 0 10px; }
#wrap { position: relative; flex: 1; min-height: 0; }
#board { display: block; width: 100%; height: 100%; touch-action: none; cursor: default; }
#board.pan { cursor: grab; }
#board.pan:active { cursor: grabbing; }
#editor { position: absolute; display: none; margin: 0; padding: 8px; border: 2px solid var(--accent); border-radius: 4px; background: #fff8d6; color: #1d1d1f; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; resize: none; overflow: hidden; }
#swatches { display: none; gap: 4px; align-items: center; }
#swatches button { width: 20px; height: 20px; padding: 0; border-radius: 999px; border: 1px solid var(--line); }
</style>
</head>
<body>
<header>
<h1>${escapeHtml(state.title)}</h1>
<button type="button" data-tool="select" aria-pressed="true">Select</button>
<button type="button" data-tool="note" aria-pressed="false">Note</button>
<button type="button" data-tool="rect" aria-pressed="false">Rect</button>
<button type="button" data-tool="ellipse" aria-pressed="false">Ellipse</button>
<button type="button" data-tool="line" aria-pressed="false">Line</button>
<button type="button" data-tool="connect" aria-pressed="false">Connect</button>
<span id="swatches" aria-label="Note colour"></span>
<span class="spacer"></span>
<button type="button" id="zoomOut" aria-label="Zoom out">−</button>
<span class="zoom" id="zoomLabel">100%</span>
<button type="button" id="zoomIn" aria-label="Zoom in">+</button>
<button type="button" id="fit">Fit</button>
<button type="button" id="save">Save board</button>
</header>
<p id="status" role="status"></p>
<div id="wrap">
<canvas id="board"></canvas>
<textarea id="editor" aria-label="Note text"></textarea>
</div>
<script type="application/json" id="${STATE_SCRIPT_ID}">${embeddedState(state)}</script>
<script>
(function () {
  var state = JSON.parse(document.getElementById("${STATE_SCRIPT_ID}").textContent);
  var canvas = document.getElementById("board");
  var ctx = canvas.getContext("2d");
  var status = document.getElementById("status");
  var editor = document.getElementById("editor");
  var swatches = document.getElementById("swatches");
  var zoomLabel = document.getElementById("zoomLabel");
  var view = { x: state.viewport.x, y: state.viewport.y, scale: state.viewport.scale };
  var tool = "select";
  var selected = null;
  var drag = null;
  var connectFrom = null;
  var counter = state.items.length + state.connectors.length + 1;
  var saveTimer = null;
  var NOTE_FILL = ${JSON.stringify(NOTE_FILL)};
  var NOTE_COLORS = ${JSON.stringify(NOTE_COLORS)};
  var SHAPE_STROKE = "#334155";
  var CONNECTOR_STROKE = "#64748b";

  function noteId() { return "item-" + (counter++) + "-" + Date.now().toString(36); }
  function toBoard(px, py) { var r = canvas.getBoundingClientRect(); return { x: (px - r.left) / view.scale + view.x, y: (py - r.top) / view.scale + view.y }; }
  function toScreen(bx, by) { return { x: (bx - view.x) * view.scale, y: (by - view.y) * view.scale }; }
  function itemById(id) { for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i]; return null; }
  function center(item) { return { x: item.x + item.w / 2, y: item.y + item.h / 2 }; }
  function edgeAnchor(item, toward) {
    var c = center(item); var dx = toward.x - c.x; var dy = toward.y - c.y;
    if (dx === 0 && dy === 0) return { x: item.x + item.w, y: c.y };
    var sx = dx === 0 ? Infinity : (item.w / 2) / Math.abs(dx);
    var sy = dy === 0 ? Infinity : (item.h / 2) / Math.abs(dy);
    var s = Math.min(sx, sy);
    return { x: c.x + dx * s, y: c.y + dy * s };
  }
  function distanceToSegment(bx, by, item) {
    var x1 = item.x, y1 = item.y, x2 = item.x + item.w, y2 = item.y + item.h;
    var dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
    var along = len === 0 ? 0 : Math.min(1, Math.max(0, ((bx - x1) * dx + (by - y1) * dy) / len));
    return Math.hypot(bx - (x1 + along * dx), by - (y1 + along * dy));
  }
  function hitAt(bx, by) {
    for (var i = state.items.length - 1; i >= 0; i--) {
      var item = state.items[i];
      if (item.kind === "ellipse") {
        var ex = (bx - (item.x + item.w / 2)) / (item.w / 2), ey = (by - (item.y + item.h / 2)) / (item.h / 2);
        if (ex * ex + ey * ey <= 1) return item.id;
      } else if (item.kind === "line") {
        if (distanceToSegment(bx, by, item) <= 6 / view.scale) return item.id;
      } else if (bx >= item.x && bx <= item.x + item.w && by >= item.y && by <= item.y + item.h) return item.id;
    }
    return null;
  }
  function wrapText(text, maxWidth) {
    var lines = [], words = String(text || "").split(/\\s+/), line = "";
    words.forEach(function (word) {
      var trial = line ? line + " " + word : word;
      if (ctx.measureText(trial).width > maxWidth && line) { lines.push(line); line = word; }
      else line = trial;
    });
    if (line) lines.push(line);
    return lines;
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function draw() {
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--page") || "#f5f5f7";
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.save();
    ctx.scale(view.scale, view.scale);
    ctx.translate(-view.x, -view.y);
    state.connectors.forEach(function (link) {
      var from = itemById(link.from), to = itemById(link.to);
      if (!from || !to) return;
      var a = edgeAnchor(from, center(to)), b = edgeAnchor(to, center(from));
      ctx.strokeStyle = CONNECTOR_STROKE;
      ctx.lineWidth = 2 / view.scale;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      var angle = Math.atan2(b.y - a.y, b.x - a.x), size = 10 / view.scale;
      ctx.fillStyle = CONNECTOR_STROKE;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - size * Math.cos(angle - 0.4), b.y - size * Math.sin(angle - 0.4));
      ctx.lineTo(b.x - size * Math.cos(angle + 0.4), b.y - size * Math.sin(angle + 0.4));
      ctx.closePath(); ctx.fill();
    });
    state.items.forEach(function (item) {
      ctx.lineWidth = 2 / view.scale;
      if (item.kind === "note") {
        ctx.fillStyle = NOTE_FILL[item.color] || NOTE_FILL.yellow;
        ctx.strokeStyle = "rgba(0,0,0,0.12)";
        roundRect(item.x, item.y, item.w, item.h, 6);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#1d1d1f";
        ctx.font = "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
        wrapText(item.text || "", item.w - 20).forEach(function (line, i) { ctx.fillText(line, item.x + 10, item.y + 24 + i * 18); });
      } else if (item.kind === "rect") {
        ctx.fillStyle = "rgba(51,65,85,0.08)";
        ctx.strokeStyle = item.color || SHAPE_STROKE;
        ctx.fillRect(item.x, item.y, item.w, item.h);
        ctx.strokeRect(item.x, item.y, item.w, item.h);
      } else if (item.kind === "ellipse") {
        ctx.fillStyle = "rgba(51,65,85,0.08)";
        ctx.strokeStyle = item.color || SHAPE_STROKE;
        ctx.beginPath();
        ctx.ellipse(item.x + item.w / 2, item.y + item.h / 2, item.w / 2, item.h / 2, 0, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      } else if (item.kind === "line") {
        ctx.strokeStyle = item.color || SHAPE_STROKE;
        ctx.beginPath(); ctx.moveTo(item.x, item.y); ctx.lineTo(item.x + item.w, item.y + item.h); ctx.stroke();
      }
      if (item.id === selected) {
        ctx.strokeStyle = "#0b5fff";
        ctx.setLineDash([6 / view.scale, 4 / view.scale]);
        ctx.strokeRect(item.x - 4 / view.scale, item.y - 4 / view.scale, item.w + 8 / view.scale, item.h + 8 / view.scale);
        ctx.setLineDash([]);
      }
    });
    if (connectFrom) {
      var anchor = itemById(connectFrom);
      if (anchor) {
        var c = center(anchor);
        ctx.strokeStyle = "#0b5fff";
        ctx.setLineDash([6 / view.scale, 4 / view.scale]);
        ctx.strokeRect(anchor.x - 4 / view.scale, anchor.y - 4 / view.scale, anchor.w + 8 / view.scale, anchor.h + 8 / view.scale);
        ctx.setLineDash([]);
        ctx.fillStyle = "#0b5fff";
        ctx.font = (13 / view.scale) + "px sans-serif";
        ctx.fillText("Click another item to connect", c.x + 10, c.y - 10);
      }
    }
    ctx.restore();
    zoomLabel.textContent = Math.round(view.scale * 100) + "%";
  }
  function fit() {
    if (!state.items.length) { view = { x: 0, y: 0, scale: 1 }; draw(); return; }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    state.items.forEach(function (item) {
      minX = Math.min(minX, item.x); minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.w); maxY = Math.max(maxY, item.y + item.h);
    });
    var rect = canvas.getBoundingClientRect(), margin = 40;
    var scale = Math.min(4, Math.max(0.1, Math.min(rect.width / (maxX - minX + margin * 2), rect.height / (maxY - minY + margin * 2))));
    view = { x: minX - margin, y: minY - margin, scale: scale };
    draw();
  }
  function zoom(factor, cx, cy) {
    var rect = canvas.getBoundingClientRect();
    var px = cx === undefined ? rect.width / 2 : cx, py = cy === undefined ? rect.height / 2 : cy;
    var before = toBoard(px, py);
    view.scale = Math.min(4, Math.max(0.1, view.scale * factor));
    view.x = before.x - px / view.scale;
    view.y = before.y - py / view.scale;
    draw();
  }
  function setTool(next) {
    tool = next; connectFrom = null; closeEditor();
    document.querySelectorAll("[data-tool]").forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.tool === next)); });
    canvas.classList.toggle("pan", next === "select");
    status.textContent = next === "connect" ? "Click one item, then another, to connect them." : "";
  }
  function closeEditor() {
    if (editor.style.display === "none") return;
    var item = itemById(editor.dataset.itemId || "");
    if (item) item.text = editor.value;
    editor.style.display = "none";
    pushContext();
    draw();
  }
  function openEditor(item) {
    var topLeft = toScreen(item.x, item.y);
    editor.dataset.itemId = item.id;
    editor.value = item.text || "";
    editor.style.display = "block";
    editor.style.left = topLeft.x + "px";
    editor.style.top = topLeft.y + "px";
    editor.style.width = Math.max(60, item.w * view.scale) + "px";
    editor.style.height = Math.max(40, item.h * view.scale) + "px";
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }
  function showSwatches(item) {
    swatches.innerHTML = "";
    if (!item || item.kind !== "note") { swatches.style.display = "none"; return; }
    swatches.style.display = "flex";
    NOTE_COLORS.forEach(function (color) {
      var button = document.createElement("button");
      button.type = "button";
      button.style.background = NOTE_FILL[color];
      button.setAttribute("aria-label", "Note colour " + color);
      button.addEventListener("click", function () { item.color = color; pushContext(); draw(); });
      swatches.appendChild(button);
    });
  }
  function select(id) {
    selected = id;
    showSwatches(id ? itemById(id) : null);
    draw();
  }
  function removeSelected() {
    if (!selected) return;
    var id = selected;
    state.items = state.items.filter(function (item) { return item.id !== id; });
    state.connectors = state.connectors.filter(function (link) { return link.from !== id && link.to !== id; });
    select(null);
    pushContext();
  }
  function pushContext() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        if (window.sanremes && window.sanremes.setContext) window.sanremes.setContext({ structuredContent: { whiteboard: state } });
      } catch (e) { /* the page keeps working without the host */ }
    }, 500);
  }
  function save() {
    state.viewport = { x: view.x, y: view.y, scale: view.scale };
    var payload = "Whiteboard state: " + JSON.stringify(state);
    try {
      if (window.sanremes && window.sanremes.send) {
        window.sanremes.send(payload);
        status.textContent = "Board sent to the chat — send it and the bot will keep this version.";
        return;
      }
    } catch (e) { /* fall through to the download */ }
    var copy = document.documentElement.outerHTML.replace(
      /(<script type="application\\/json" id="${STATE_SCRIPT_ID}">)[\\s\\S]*?(<\\/script>)/,
      "$1" + JSON.stringify(state).replace(/</g, "\\\\u003c") + "$2");
    var url = URL.createObjectURL(new Blob([copy], { type: "text/html" }));
    var link = document.createElement("a");
    link.href = url; link.download = (state.title || "whiteboard") + ".html";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    status.textContent = "Saved a copy of this board as a file.";
  }

  document.querySelectorAll("[data-tool]").forEach(function (button) {
    button.addEventListener("click", function () { setTool(button.dataset.tool); });
  });
  document.getElementById("zoomIn").addEventListener("click", function () { zoom(1.25); });
  document.getElementById("zoomOut").addEventListener("click", function () { zoom(0.8); });
  document.getElementById("fit").addEventListener("click", fit);
  document.getElementById("save").addEventListener("click", save);
  editor.addEventListener("blur", closeEditor);
  editor.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { event.preventDefault(); closeEditor(); }
    event.stopPropagation();
  });
  canvas.addEventListener("pointerdown", function (event) {
    canvas.setPointerCapture(event.pointerId);
    var point = toBoard(event.clientX, event.clientY);
    var hit = hitAt(point.x, point.y);
    if (tool === "note" || tool === "rect" || tool === "ellipse") {
      var size = tool === "note" ? { w: 200, h: 140 } : { w: 160, h: 100 };
      var created = { id: noteId(), kind: tool, x: Math.round(point.x - size.w / 2), y: Math.round(point.y - size.h / 2), w: size.w, h: size.h };
      if (tool === "note") { created.text = ""; created.color = "yellow"; }
      state.items.push(created);
      select(created.id);
      pushContext();
      if (tool === "note") openEditor(created);
      setTool("select");
      return;
    }
    if (tool === "line") {
      drag = { kind: "line", start: point, item: null };
      return;
    }
    if (tool === "connect") {
      if (!hit) { connectFrom = null; draw(); return; }
      if (!connectFrom) { connectFrom = hit; draw(); return; }
      if (connectFrom !== hit && !state.connectors.some(function (link) { return (link.from === connectFrom && link.to === hit) || (link.from === hit && link.to === connectFrom); })) {
        state.connectors.push({ id: noteId(), from: connectFrom, to: hit });
        pushContext();
      }
      connectFrom = null;
      draw();
      return;
    }
    if (hit) {
      var item = itemById(hit);
      select(hit);
      drag = { kind: "move", item: item, start: point, origin: { x: item.x, y: item.y } };
    } else {
      select(null);
      drag = { kind: "pan", start: { x: event.clientX, y: event.clientY }, origin: { x: view.x, y: view.y } };
    }
  });
  canvas.addEventListener("pointermove", function (event) {
    if (!drag) return;
    if (drag.kind === "pan") {
      view.x = drag.origin.x - (event.clientX - drag.start.x) / view.scale;
      view.y = drag.origin.y - (event.clientY - drag.start.y) / view.scale;
      draw();
    } else if (drag.kind === "move") {
      var point = toBoard(event.clientX, event.clientY);
      drag.item.x = Math.round(drag.origin.x + (point.x - drag.start.x));
      drag.item.y = Math.round(drag.origin.y + (point.y - drag.start.y));
      draw();
    } else if (drag.kind === "line") {
      var end = toBoard(event.clientX, event.clientY);
      if (!drag.item) {
        drag.item = { id: noteId(), kind: "line", x: 0, y: 0, w: 8, h: 8 };
        state.items.push(drag.item);
      }
      drag.item.x = Math.round(Math.min(drag.start.x, end.x));
      drag.item.y = Math.round(Math.min(drag.start.y, end.y));
      drag.item.w = Math.max(8, Math.round(Math.abs(end.x - drag.start.x)));
      drag.item.h = Math.max(8, Math.round(Math.abs(end.y - drag.start.y)));
      draw();
    }
  });
  canvas.addEventListener("pointerup", function () {
    if (drag && drag.kind === "line" && drag.item) select(drag.item.id);
    if (drag && drag.kind !== "pan") pushContext();
    drag = null;
  });
  canvas.addEventListener("wheel", function (event) {
    event.preventDefault();
    var rect = canvas.getBoundingClientRect();
    zoom(event.deltaY < 0 ? 1.1 : 0.9, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  canvas.addEventListener("dblclick", function (event) {
    var point = toBoard(event.clientX, event.clientY);
    var hit = hitAt(point.x, point.y);
    var item = hit ? itemById(hit) : null;
    if (item && item.kind === "note") { select(item.id); openEditor(item); }
  });
  document.addEventListener("keydown", function (event) {
    if ((event.key === "Delete" || event.key === "Backspace") && editor.style.display === "none" && selected) {
      event.preventDefault();
      removeSelected();
    } else if (event.key === "Escape") {
      connectFrom = null;
      select(null);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
    }
  });
  window.addEventListener("resize", draw);
  if (window.sanremes && window.sanremes.setContext) pushContext();
  draw();
})();
</script>
</body>
</html>`;
  const bytes = new TextEncoder().encode(page).length;
  if (bytes > APP_LIMITS.htmlBytes) return { ok: false, error: `whiteboard: page is ${bytes} bytes, over the ${APP_LIMITS.htmlBytes}-byte show_html limit.` };
  return { ok: true, html: page };
}

/** A board from nothing, for the tool's empty call. */
export function emptyWhiteboardPage(title: string): { ok: true; html: string } | { ok: false; error: string } {
  return buildWhiteboardHtml(createBoard(title));
}
