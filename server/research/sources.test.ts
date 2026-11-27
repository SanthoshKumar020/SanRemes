import { describe, expect, it } from "vitest";
import { appendSourcesBlock, dedupeSources, formatSources, parseSourcesBlock, sourcesFromValue, type ResearchSource } from "./sources.ts";

const NOW = Date.parse("2026-11-27T10:00:00Z");
const source = (url: string, title = "Title", fetchedAt = NOW): ResearchSource => ({ url, title, fetchedAt });

describe("formatSources / appendSourcesBlock / parseSourcesBlock", () => {
  it("round-trips a sources block through text", () => {
    const sources = [source("https://example.com/a", "Alpha"), source("https://example.com/b", "Beta")];
    const text = appendSourcesBlock("Findings here.", sources);
    expect(text).toBe("Findings here.\n\nSources\n1. Alpha — https://example.com/a (fetched 2026-11-27)\n2. Beta — https://example.com/b (fetched 2026-11-27)");
    expect(parseSourcesBlock(text)).toEqual({
      text: "Findings here.",
      sources: sources.map((item) => ({ ...item, fetchedAt: Date.parse("2026-11-27T00:00:00Z") })),
    });
  });

  it("leaves text alone with no sources and ignores a block that is not trailing", () => {
    expect(appendSourcesBlock("Nothing.", [])).toBe("Nothing.");
    expect(formatSources([])).toBe("");
    expect(parseSourcesBlock("Sources\n1. Alpha — https://example.com/a\n\nMore text.")).toEqual({
      text: "Sources\n1. Alpha — https://example.com/a\n\nMore text.",
      sources: [],
    });
  });

  it("ignores a malformed trailing block instead of inventing sources", () => {
    expect(parseSourcesBlock("Done.\n\nSources\n1. Alpha — not-a-url")).toEqual({
      text: "Done.\n\nSources\n1. Alpha — not-a-url",
      sources: [],
    });
  });

  it("falls back to the host when a title is blank and omits an unknown fetch date", () => {
    expect(formatSources([source("https://example.com/a", "  ", 0)])).toBe("Sources\n1. example.com — https://example.com/a");
  });

  it("dedupes by URL, first seen first", () => {
    expect(dedupeSources([source("https://a.test"), source("https://a.test", "Other"), source("https://b.test")]).map((item) => item.url))
      .toEqual(["https://a.test", "https://b.test"]);
  });
});

describe("sourcesFromValue", () => {
  it("collects url fields with their titles and bare links in text", () => {
    const found = sourcesFromValue({
      results: [
        { url: "https://example.com/a", title: "Alpha" },
        { link: "https://example.com/b", name: "Beta" },
        { text: "see https://example.com/c for more." },
        { url: "https://example.com/a", title: "Alpha again" },
      ],
    }, NOW);
    expect(found).toEqual([
      { url: "https://example.com/a", title: "Alpha", fetchedAt: NOW },
      { url: "https://example.com/b", title: "Beta", fetchedAt: NOW },
      { url: "https://example.com/c", title: "example.com", fetchedAt: NOW },
    ]);
  });

  it("ignores non-web values and caps the list", () => {
    const value = { items: Array.from({ length: 15 }, (_, i) => ({ url: `https://example.com/${i}` })) };
    expect(sourcesFromValue(value, NOW)).toHaveLength(10);
    expect(sourcesFromValue({ count: 3, ok: true, nested: null }, NOW)).toEqual([]);
  });
});
