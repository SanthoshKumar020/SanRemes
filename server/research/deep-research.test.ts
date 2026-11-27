import { describe, expect, it } from "vitest";
import { excerptOf, planSubQuestions, runDeepResearch, type DeepResearchDeps } from "./deep-research.ts";
import type { FetchedPage } from "./web-search.ts";

const NOW = Date.parse("2026-11-27T10:00:00Z");

function page(url: string, text: string, title = "Page"): FetchedPage {
  return { url, title, text, fetchedAt: NOW };
}

function deps(overrides: Partial<DeepResearchDeps> = {}): DeepResearchDeps {
  return {
    search: async (query) => ({
      hits: [
        { url: "https://example.com/a", title: "Alpha", snippet: "" },
        { url: "https://example.com/b", title: "Beta", snippet: "" },
      ],
      ...(query === "nothing" ? { hits: [] } : {}),
    }),
    fetchPage: async (url) => page(url, "First sentence here. Second sentence here. Third sentence here."),
    now: () => NOW,
    ...overrides,
  };
}

describe("planSubQuestions", () => {
  it("keeps a single question whole", () => {
    expect(planSubQuestions("How does photosynthesis work?")).toEqual(["How does photosynthesis work?"]);
    expect(planSubQuestions("   ")).toEqual([]);
  });

  it("splits semicolon-separated questions", () => {
    expect(planSubQuestions("What is Databricks?; How is it priced?")).toEqual(["What is Databricks?", "How is it priced?"]);
  });

  it("asks both sides of a versus question as well as the whole", () => {
    expect(planSubQuestions("Databricks vs Snowflake")).toEqual(["Databricks vs Snowflake", "Databricks", "Snowflake"]);
  });

  it("caps the plan", () => {
    expect(planSubQuestions("One?; Two questions here?; Three questions here?; Four questions here?; Five questions here?", 2)).toHaveLength(2);
  });
});

describe("excerptOf", () => {
  it("takes the first two sentences and caps the length", () => {
    expect(excerptOf("One. Two. Three.")).toBe("One. Two.");
    expect(excerptOf("word ".repeat(200))).toMatch(/…$/);
  });
});

describe("runDeepResearch", () => {
  it("searches, reads pages and synthesises with numbered citations and a Sources list", async () => {
    const result = await runDeepResearch("How does photosynthesis work?", deps());
    expect(result.pagesRead).toBe(2);
    expect(result.searches).toBe(1);
    expect(result.sources).toEqual([
      { url: "https://example.com/a", title: "Page", fetchedAt: NOW },
      { url: "https://example.com/b", title: "Page", fetchedAt: NOW },
    ]);
    expect(result.answer).toContain("[1] First sentence here. Second sentence here.");
    expect(result.answer).toContain("Sources\n1. Page — https://example.com/a (fetched 2026-11-27)");
    expect(result.answer).toContain("2. Page — https://example.com/b (fetched 2026-11-27)");
  });

  it("reads each URL once across sub-questions and stops at the page cap", async () => {
    const read: string[] = [];
    const result = await runDeepResearch("What is A here?; What is B here?", deps({
      fetchPage: async (url) => {
        read.push(url);
        return page(url, "First sentence here. Second sentence here.");
      },
    }));
    expect(result.subQuestions).toHaveLength(2);
    expect(result.pagesRead).toBe(2);
    expect(read).toEqual(["https://example.com/a", "https://example.com/b"]);
    const capped = await runDeepResearch("What is A here?; What is B here?", deps({ maxPages: 1 }));
    expect(capped.pagesRead).toBe(1);
  });

  it("says so in plain words when nothing can be read, never throws", async () => {
    const result = await runDeepResearch("nothing", deps({
      search: async () => { throw new Error("offline"); },
      fetchPage: async () => { throw new Error("offline"); },
    }));
    expect(result.pagesRead).toBe(0);
    expect(result.sources).toEqual([]);
    expect(result.answer).toContain("No pages could be read");
    expect(result.answer).not.toContain("Sources");
  });

  it("skips pages that fail to read and keeps the rest", async () => {
    const result = await runDeepResearch("How does photosynthesis work?", deps({
      fetchPage: async (url) => (url.endsWith("/a") ? null : page(url, "Kept sentence here. Second sentence here.")),
    }));
    expect(result.pagesRead).toBe(1);
    expect(result.sources.map((source) => source.url)).toEqual(["https://example.com/b"]);
    expect(result.answer).toContain("[1] Kept sentence here.");
  });
});
