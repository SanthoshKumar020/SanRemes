// Living document template: a page whose lines the person edits in place.
// An edit is reported by the page as one message the bot parses with
// parseDocEditMessage and applies with applyDocLineEdits, then re-shows with
// the same app_id; the show_html engine keeps the earlier version.
import { artifactShell, escapeHtml, jsonForScript } from "./html.ts";

export const DOC_LIMITS = {
  maxLines: 200,
  maxLineChars: 2000,
  maxTitleChars: 200,
  maxHtmlBytes: 200_000,
} as const;

export type DocLineKind = "title" | "heading" | "paragraph" | "bullet" | "quote";

export interface DocLine {
  kind: DocLineKind;
  text: string;
}

export interface DocInput {
  title: string;
  lines: DocLine[];
}

export interface DocLineEdit {
  line: number;
  text: string;
}

/** The first line of every edit message the document page sends. */
export const DOC_EDIT_MARKER = "[doc-edit]";

export function validateDocInput(input: unknown): { doc: DocInput } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "A document needs { title, lines }." };
  const { title, lines } = input as { title?: unknown; lines?: unknown };
  if (typeof title !== "string" || !title.trim()) return { error: "A document needs a title." };
  if (title.length > DOC_LIMITS.maxTitleChars) return { error: `The title is over ${DOC_LIMITS.maxTitleChars} characters.` };
  if (!Array.isArray(lines) || lines.length === 0) return { error: "A document needs at least one line." };
  if (lines.length > DOC_LIMITS.maxLines) return { error: `A document holds at most ${DOC_LIMITS.maxLines} lines.` };
  const kinds: ReadonlySet<string> = new Set(["title", "heading", "paragraph", "bullet", "quote"]);
  const docLines: DocLine[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as { kind?: unknown; text?: unknown } | null;
    if (!line || typeof line !== "object") return { error: `Line ${i + 1} needs { kind, text }.` };
    if (typeof line.kind !== "string" || !kinds.has(line.kind)) {
      return { error: `Line ${i + 1} has an unknown kind. Use title, heading, paragraph, bullet or quote.` };
    }
    if (typeof line.text !== "string") return { error: `Line ${i + 1} needs text.` };
    if (line.text.length > DOC_LIMITS.maxLineChars) return { error: `Line ${i + 1} is over ${DOC_LIMITS.maxLineChars} characters.` };
    docLines.push({ kind: line.kind as DocLineKind, text: line.text });
  }
  return { doc: { title: title.trim(), lines: docLines } };
}

/** Plain text into lines: `# ` a heading, `- ` a bullet, `> ` a quote, blank lines ignored. */
export function docFromText(title: string, text: string): DocInput {
  const lines: DocLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# ")) lines.push({ kind: "heading", text: line.slice(2).trim() });
    else if (line.startsWith("- ")) lines.push({ kind: "bullet", text: line.slice(2).trim() });
    else if (line.startsWith("> ")) lines.push({ kind: "quote", text: line.slice(2).trim() });
    else lines.push({ kind: "paragraph", text: line });
  }
  return { title, lines: lines.length ? lines : [{ kind: "paragraph", text: "" }] };
}

const LINE_TAG: Record<DocLineKind, string> = {
  title: "h1",
  heading: "h2",
  paragraph: "p",
  bullet: "p",
  quote: "blockquote",
};

function lineHtml(line: DocLine, index: number): string {
  const tag = LINE_TAG[line.kind];
  const cls = line.kind === "bullet" ? ` class="bullet"` : "";
  const text = escapeHtml(line.text) || "&nbsp;";
  return `<${tag}${cls} data-line="${index}" contenteditable="true" spellcheck="false">${text}</${tag}>`;
}

/** The document as show_html `html`, with a height that fits a page of lines. */
export function renderDoc(input: unknown): { html: string; title: string; height: number } | { error: string } {
  const checked = validateDocInput(input);
  if ("error" in checked) return checked;
  const { doc } = checked;
  const original = doc.lines.map((line) => line.text);
  const body = `<div class="doc">
<header><h1 class="doc-title" data-line="-1" contenteditable="true" spellcheck="false">${escapeHtml(doc.title)}</h1>
<div class="hint">Click any line to edit it in place, then send your edits.</div></header>
${doc.lines.map((line, i) => lineHtml(line, i)).join("\n")}
<div class="toolbar"><button type="button" id="send-edits">Send edits</button><span id="status" role="status"></span></div>
</div>`;
  const script = `(function () {
  "use strict";
  var original = ${jsonForScript(original)};
  var title = ${jsonForScript(doc.title)};
  var status = document.getElementById("status");
  var say = function (text) { status.textContent = text; };
  var current = function (el) { return el.innerText.replace(/\\n+$/, ""); };
  var collect = function () {
    var edits = [];
    var titleEl = document.querySelector(".doc-title");
    var titleNow = titleEl ? current(titleEl) : title;
    if (titleNow !== title) edits.push({ line: -1, text: titleNow });
    document.querySelectorAll("[data-line]").forEach(function (el) {
      var index = Number(el.getAttribute("data-line"));
      if (index < 0 || original[index] === undefined) return;
      var text = current(el);
      if (text !== original[index]) edits.push({ line: index, text: text });
    });
    return edits;
  };
  document.querySelectorAll("[contenteditable]").forEach(function (el) {
    el.addEventListener("input", function () {
      var edits = collect();
      if (window.sanremes) sanremes.setContext(edits.length ? "The document has unsent edits on " + edits.length + " line(s)." : "The document has no unsent edits.");
    });
  });
  document.getElementById("send-edits").addEventListener("click", function () {
    var edits = collect();
    if (!edits.length) { say("No changes to send yet."); return; }
    var message = ${jsonForScript(DOC_EDIT_MARKER)} + "\\n" + edits.map(function (edit) { return JSON.stringify(edit); }).join("\\n");
    if (!window.sanremes) { say("Edits cannot be sent from here."); return; }
    say("Sending…");
    sanremes.send(message).then(function () {
      edits.forEach(function (edit) {
        if (edit.line === -1) title = edit.text;
        else original[edit.line] = edit.text;
      });
      say("Edits sent.");
    }).catch(function () { say("Could not send the edits. Try again."); });
  });
})();`;
  const html = artifactShell({
    title: doc.title,
    css: `.doc{max-width:680px;margin:0 auto;padding:24px 20px 16px}
.doc-title{font-size:26px;line-height:1.25;margin:0 0 4px;outline:none}
.doc-title:focus,.doc [contenteditable]:focus{background:var(--color-background-secondary);border-radius:6px;outline:none}
.hint{font-size:13px;color:var(--color-text-secondary);margin:0 0 16px}
.doc h2{font-size:18px;margin:20px 0 6px;outline:none}
.doc p{font-size:15px;line-height:1.6;margin:0 0 8px;outline:none}
.doc .bullet{padding-left:20px;position:relative}
.doc .bullet:before{content:"•";position:absolute;left:6px;color:var(--color-text-secondary)}
.doc blockquote{font-size:15px;line-height:1.6;margin:0 0 8px;padding-left:14px;border-left:3px solid var(--color-border-primary);color:var(--color-text-secondary);outline:none}
.toolbar{position:sticky;bottom:0;display:flex;align-items:center;gap:12px;padding:12px 0;background:var(--color-background-primary);border-top:1px solid var(--color-border-primary);margin-top:16px}
.toolbar button{font:inherit;font-size:14px;padding:8px 16px;border-radius:999px;border:1px solid var(--color-border-primary);background:var(--color-background-secondary);color:inherit;cursor:pointer}
.toolbar button:hover{background:var(--color-border-primary)}
#status{font-size:13px;color:var(--color-text-secondary)}`,
    body,
    script,
  });
  if (new TextEncoder().encode(html).length > DOC_LIMITS.maxHtmlBytes) {
    return { error: `The document renders over ${Math.round(DOC_LIMITS.maxHtmlBytes / 1000)} KB. Shorten it.` };
  }
  return { html, title: doc.title, height: Math.min(720, 200 + doc.lines.length * 32) };
}

/** The edits from a message the document page sent, or null when it is not one. */
export function parseDocEditMessage(text: string): { title?: string; edits: DocLineEdit[] } | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== DOC_EDIT_MARKER) return null;
  const edits: DocLineEdit[] = [];
  let title: string | undefined;
  for (const raw of lines.slice(1)) {
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { line, text: next } = parsed as { line?: unknown; text?: unknown };
    if (typeof line !== "number" || !Number.isInteger(line) || typeof next !== "string") return null;
    if (line === -1) title = next;
    else if (line >= 0) edits.push({ line, text: next });
    else return null;
  }
  return { ...(title !== undefined ? { title } : {}), edits };
}

/** A document with the edits applied; out-of-range lines are ignored. */
export function applyDocLineEdits(doc: DocInput, parsed: { title?: string; edits: DocLineEdit[] }): DocInput {
  const lines = doc.lines.map((line) => ({ ...line }));
  for (const edit of parsed.edits) {
    if (edit.line < lines.length) lines[edit.line] = { ...lines[edit.line]!, text: edit.text };
  }
  return { title: parsed.title ?? doc.title, lines };
}
