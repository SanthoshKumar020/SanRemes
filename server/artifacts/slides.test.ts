import { describe, expect, it } from "vitest";
import { deckFromNotes, renderDeck, validateDeckInput } from "./slides.ts";

const DECK = {
  title: "Quarter review",
  slides: [
    { title: "Quarter review", layout: "title" },
    { title: "What went well", bullets: ["Shipped search", "Support replies under an hour"], notes: "Pause here for questions." },
    { title: "Next", text: "Double down on search quality." },
  ],
};

describe("validateDeckInput", () => {
  it("accepts a well-formed deck", () => {
    expect(validateDeckInput(DECK)).toEqual({ deck: DECK });
  });

  it("rejects an empty deck, an empty slide and an unknown layout", () => {
    expect(validateDeckInput({ title: "T", slides: [] })).toMatchObject({ error: expect.stringContaining("at least one") });
    expect(validateDeckInput({ title: "T", slides: [{}] })).toMatchObject({ error: expect.stringContaining("empty") });
    expect(validateDeckInput({ title: "T", slides: [{ title: "x", layout: "grid" }] })).toMatchObject({ error: expect.stringContaining("unknown layout") });
  });

  it("rejects more than 60 slides", () => {
    const slides = Array.from({ length: 61 }, () => ({ title: "x" }));
    expect(validateDeckInput({ title: "T", slides })).toMatchObject({ error: expect.stringContaining("60") });
  });
});

describe("renderDeck", () => {
  it("renders one section per slide with navigation, counter and Present", () => {
    const rendered = renderDeck(DECK);
    expect(rendered).not.toHaveProperty("error");
    if ("error" in rendered) return;
    expect(rendered.html).toContain('data-slide="0"');
    expect(rendered.html).toContain('data-slide="2"');
    expect(rendered.html).toContain('id="prev"');
    expect(rendered.html).toContain('id="next"');
    expect(rendered.html).toContain('id="present"');
    expect(rendered.html).toContain('id="counter"');
    expect(rendered.html).toContain("ArrowRight");
    expect(rendered.html).toContain("Present");
    expect(rendered.html).toContain("Speaker notes");
    expect(rendered.html).toContain("sanremes.setContext");
    expect(rendered.height).toBe(560);
  });

  it("hides every slide but the first at load", () => {
    const rendered = renderDeck(DECK);
    if ("error" in rendered) return;
    expect(rendered.html).toContain("slide.hidden = i !== current");
  });

  it("escapes slide content", () => {
    const rendered = renderDeck({ title: "T", slides: [{ title: "<b>bold</b>" }] });
    if ("error" in rendered) return;
    expect(rendered.html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(rendered.html).not.toContain("<b>bold</b>");
  });

  it("keeps the whole page under the show_html size limit", () => {
    const rendered = renderDeck(DECK);
    if ("error" in rendered) return;
    expect(new TextEncoder().encode(rendered.html).length).toBeLessThan(256 * 1024);
  });
});

describe("deckFromNotes", () => {
  it("splits headings into slides and gathers bullets and text", () => {
    expect(deckFromNotes("Review", "# Intro\nHello\n- one\n- two\n# Next\nDone")).toEqual({
      title: "Review",
      slides: [
        { title: "Intro", text: "Hello", bullets: ["one", "two"] },
        { title: "Next", text: "Done" },
      ],
    });
  });

  it("never returns an empty deck", () => {
    expect(deckFromNotes("T", "").slides).toEqual([{ title: "T" }]);
  });
});
