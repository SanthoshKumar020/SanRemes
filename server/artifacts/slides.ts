// Deck template: notes become slides, shown one at a time with next/previous,
// arrow keys, a counter and a Present mode that fills the frame.
import { artifactShell, escapeHtml } from "./html.ts";

export const DECK_LIMITS = {
  maxSlides: 60,
  maxTitleChars: 200,
  maxSlideTitleChars: 160,
  maxBullets: 12,
  maxBulletChars: 300,
  maxTextChars: 2000,
  maxNotesChars: 2000,
  maxHtmlBytes: 200_000,
} as const;

export type SlideLayout = "title" | "bullets" | "quote";

export interface Slide {
  title?: string;
  bullets?: string[];
  text?: string;
  notes?: string;
  layout?: SlideLayout;
}

export interface DeckInput {
  title: string;
  slides: Slide[];
}

export function validateDeckInput(input: unknown): { deck: DeckInput } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "A deck needs { title, slides }." };
  const { title, slides } = input as { title?: unknown; slides?: unknown };
  if (typeof title !== "string" || !title.trim()) return { error: "A deck needs a title." };
  if (title.length > DECK_LIMITS.maxTitleChars) return { error: `The deck title is over ${DECK_LIMITS.maxTitleChars} characters.` };
  if (!Array.isArray(slides) || slides.length === 0) return { error: "A deck needs at least one slide." };
  if (slides.length > DECK_LIMITS.maxSlides) return { error: `A deck holds at most ${DECK_LIMITS.maxSlides} slides.` };
  const layouts: ReadonlySet<string> = new Set(["title", "bullets", "quote"]);
  const deckSlides: Slide[] = [];
  for (let i = 0; i < slides.length; i += 1) {
    const slide = slides[i] as Record<string, unknown> | null;
    if (!slide || typeof slide !== "object") return { error: `Slide ${i + 1} needs an object.` };
    const n = i + 1;
    const check = (value: unknown, max: number, what: string): string | null =>
      typeof value === "string" && value.length > max ? `${what} on slide ${n} is over ${max} characters.` : null;
    const bad =
      check(slide.title, DECK_LIMITS.maxSlideTitleChars, "The title") ??
      check(slide.text, DECK_LIMITS.maxTextChars, "The text") ??
      check(slide.notes, DECK_LIMITS.maxNotesChars, "The notes");
    if (bad) return { error: bad };
    if (slide.title !== undefined && typeof slide.title !== "string") return { error: `Slide ${n} needs a text title.` };
    if (slide.text !== undefined && typeof slide.text !== "string") return { error: `Slide ${n} needs text.` };
    if (slide.notes !== undefined && typeof slide.notes !== "string") return { error: `Slide ${n} needs text notes.` };
    if (slide.layout !== undefined && (typeof slide.layout !== "string" || !layouts.has(slide.layout))) {
      return { error: `Slide ${n} has an unknown layout. Use title, bullets or quote.` };
    }
    if (slide.bullets !== undefined) {
      if (!Array.isArray(slide.bullets)) return { error: `Slide ${n} needs its bullets as a list.` };
      if (slide.bullets.length > DECK_LIMITS.maxBullets) return { error: `Slide ${n} holds at most ${DECK_LIMITS.maxBullets} bullets.` };
      for (const bullet of slide.bullets) {
        if (typeof bullet !== "string") return { error: `Slide ${n} needs text bullets.` };
        if (bullet.length > DECK_LIMITS.maxBulletChars) return { error: `A bullet on slide ${n} is over ${DECK_LIMITS.maxBulletChars} characters.` };
      }
    }
    const hasContent = slide.title || slide.text || (Array.isArray(slide.bullets) && slide.bullets.length > 0);
    if (!hasContent) return { error: `Slide ${n} is empty. Give it a title, text or bullets.` };
    deckSlides.push({
      ...(typeof slide.title === "string" ? { title: slide.title } : {}),
      ...(Array.isArray(slide.bullets) ? { bullets: slide.bullets as string[] } : {}),
      ...(typeof slide.text === "string" ? { text: slide.text } : {}),
      ...(typeof slide.notes === "string" ? { notes: slide.notes } : {}),
      ...(typeof slide.layout === "string" ? { layout: slide.layout as SlideLayout } : {}),
    });
  }
  return { deck: { title: title.trim(), slides: deckSlides } };
}

/** Notes into a deck: a `# ` line starts a slide, `- ` lines are its bullets, other lines its text. */
export function deckFromNotes(title: string, notes: string): DeckInput {
  const slides: Slide[] = [];
  let current: Slide | null = null;
  const flush = () => {
    if (current && (current.title || current.text || (current.bullets?.length ?? 0) > 0)) slides.push(current);
    current = null;
  };
  for (const raw of notes.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# ")) {
      flush();
      current = { title: line.slice(2).trim() };
    } else if (line.startsWith("- ")) {
      if (!current) current = {};
      current.bullets = [...(current.bullets ?? []), line.slice(2).trim()];
    } else {
      if (!current) current = {};
      current.text = current.text ? `${current.text}\n${line}` : line;
    }
  }
  flush();
  return { title, slides: slides.length ? slides : [{ title }] };
}

function slideHtml(slide: Slide, index: number): string {
  const layout = slide.layout ?? (slide.bullets?.length ? "bullets" : slide.text && !slide.title ? "quote" : "title");
  const inner: string[] = [];
  if (slide.title) inner.push(`<h2>${escapeHtml(slide.title)}</h2>`);
  if (slide.bullets?.length) {
    inner.push(`<ul>${slide.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`);
  }
  if (slide.text) inner.push(`<p class="slide-text">${escapeHtml(slide.text).replaceAll("\n", "<br>")}</p>`);
  const notes = slide.notes ? `<details class="notes"><summary>Speaker notes</summary><p>${escapeHtml(slide.notes)}</p></details>` : "";
  return `<section class="slide layout-${layout}" data-slide="${index}" hidden>${inner.join("")}${notes}</section>`;
}

/** The deck as show_html `html`. Present mode fills the frame; the host's Full screen fills the window. */
export function renderDeck(input: unknown): { html: string; title: string; height: number } | { error: string } {
  const checked = validateDeckInput(input);
  if ("error" in checked) return checked;
  const { deck } = checked;
  const count = deck.slides.length;
  const body = `<div class="deck" id="deck">
<div class="deck-head"><span class="deck-title">${escapeHtml(deck.title)}</span>
<button type="button" id="present">Present</button></div>
<div class="stage">${deck.slides.map((slide, i) => slideHtml(slide, i)).join("\n")}</div>
<div class="deck-foot">
<button type="button" id="prev" aria-label="Previous slide">‹ Prev</button>
<span id="counter" role="status" aria-live="polite"></span>
<div class="progress"><div id="bar"></div></div>
<button type="button" id="next" aria-label="Next slide">Next ›</button>
</div></div>`;
  const script = `(function () {
  "use strict";
  var total = ${count};
  var current = 0;
  var deck = document.getElementById("deck");
  var counter = document.getElementById("counter");
  var bar = document.getElementById("bar");
  var prev = document.getElementById("prev");
  var next = document.getElementById("next");
  var presentBtn = document.getElementById("present");
  var show = function (index) {
    current = Math.max(0, Math.min(total - 1, index));
    document.querySelectorAll(".slide").forEach(function (slide, i) { slide.hidden = i !== current; });
    counter.textContent = (current + 1) + " / " + total;
    bar.style.width = ((current + 1) / total * 100) + "%";
    prev.disabled = current === 0;
    next.disabled = current === total - 1;
    if (window.sanremes) sanremes.setContext("Showing slide " + (current + 1) + " of " + total + ".");
  };
  prev.addEventListener("click", function () { show(current - 1); });
  next.addEventListener("click", function () { show(current + 1); });
  presentBtn.addEventListener("click", function () {
    var on = deck.classList.toggle("presenting");
    presentBtn.textContent = on ? "Exit present" : "Present";
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "ArrowRight" || event.key === "PageDown") show(current + 1);
    else if (event.key === "ArrowLeft" || event.key === "PageUp") show(current - 1);
    else if (event.key === "Home") show(0);
    else if (event.key === "End") show(total - 1);
    else if (event.key === "Escape" && deck.classList.contains("presenting")) {
      deck.classList.remove("presenting");
      presentBtn.textContent = "Present";
    }
  });
  show(0);
})();`;
  const html = artifactShell({
    title: deck.title,
    css: `.deck{display:flex;flex-direction:column;height:100%;min-height:420px;padding:16px 20px;box-sizing:border-box}
.deck-head{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.deck-title{font-size:13px;color:var(--color-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.deck button{font:inherit;font-size:14px;padding:6px 14px;border-radius:999px;border:1px solid var(--color-border-primary);background:var(--color-background-secondary);color:inherit;cursor:pointer}
.deck button:hover:not(:disabled){background:var(--color-border-primary)}
.deck button:disabled{opacity:.4;cursor:default}
.stage{flex:1;display:flex;min-height:0}
.slide{flex:1;display:flex;flex-direction:column;justify-content:center;max-width:640px;margin:0 auto;width:100%}
.slide[hidden]{display:none}
.slide h2{font-size:30px;line-height:1.2;margin:0 0 16px}
.slide ul{margin:0;padding-left:22px;font-size:18px;line-height:1.55}
.slide li{margin-bottom:10px}
.slide-text{font-size:18px;line-height:1.6;margin:0;white-space:pre-line}
.layout-quote .slide-text{font-size:24px;font-style:italic;border-left:3px solid var(--color-border-primary);padding-left:16px}
.layout-title h2{font-size:40px}
.notes{margin-top:24px;font-size:13px;color:var(--color-text-secondary)}
.notes summary{cursor:pointer}
.deck-foot{display:flex;align-items:center;gap:12px;margin-top:12px}
#counter{font-size:13px;color:var(--color-text-secondary);min-width:44px;text-align:center;font-variant-numeric:tabular-nums}
.progress{flex:1;height:4px;border-radius:2px;background:var(--color-background-secondary);overflow:hidden}
#bar{height:100%;background:var(--color-text-secondary);transition:width 160ms ease-out}
.deck.presenting{position:fixed;inset:0;z-index:10;background:var(--color-background-primary);padding:32px 48px}
.deck.presenting .slide h2{font-size:44px}
.deck.presenting .slide ul,.deck.presenting .slide-text{font-size:24px}
.deck.presenting .layout-quote .slide-text{font-size:32px}
.deck.presenting .notes{display:none}`,
    body,
    script,
  });
  if (new TextEncoder().encode(html).length > DECK_LIMITS.maxHtmlBytes) {
    return { error: `The deck renders over ${Math.round(DECK_LIMITS.maxHtmlBytes / 1000)} KB. Shorten it.` };
  }
  return { html, title: deck.title, height: 560 };
}
