import { afterEach, describe, expect, it, vi } from "vitest";
import { callResearchTool, FREE_RESEARCH_TOOL_NAMES, RESEARCH_TOOL_DEFINITIONS, RESEARCH_TOOL_NAMES } from "./agents-research-tools.ts";
import type { ToolCallContext } from "./agents-call.ts";

const DDG_HTML = `<html><body>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://example.com/alpha">Alpha page</a>
  <a class="result__snippet" href="https://example.com/alpha">First snippet here.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://example.com/beta">Beta page</a>
  <a class="result__snippet" href="https://example.com/beta">Second snippet here.</a>
</div>
</body></html>`;

const PAGE = (title: string, body: string) =>
  `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

function context(): ToolCallContext {
  return {
    botId: "bot-research",
    threadId: "thread-research",
    externalRuntime: false,
    sharedComputers: false,
    client: {
      api: async () => ({}),
      apiResponse: async () => ({ ok: true, status: 200, body: {} }),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string) => Response | Error) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const answer = handler(String(input));
    if (answer instanceof Error) throw answer;
    return answer;
  }));
}

describe("free research tools", () => {
  it("lists web_search and deep_research as free tools in the research set", () => {
    expect(RESEARCH_TOOL_NAMES.has("web_search")).toBe(true);
    expect(RESEARCH_TOOL_NAMES.has("deep_research")).toBe(true);
    expect([...FREE_RESEARCH_TOOL_NAMES].sort()).toEqual(["deep_research", "web_search"]);
    const names = RESEARCH_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toContain("web_search");
    expect(names).toContain("deep_research");
    for (const tool of RESEARCH_TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe("object");
      for (const required of tool.inputSchema.required ?? []) expect(tool.inputSchema.properties).toHaveProperty(required);
    }
  });

  it("web_search returns numbered results with a Sources list", async () => {
    stubFetch(() => new Response(DDG_HTML, { status: 200, headers: { "content-type": "text/html" } }));
    const result = await callResearchTool("web_search", { query: "alpha" }, context());
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain('Web results for "alpha":');
    expect(result.text).toContain("1. Alpha page\n   https://example.com/alpha\n   First snippet here.");
    expect(result.text).toContain("Sources\n1. Alpha page — https://example.com/alpha (fetched ");
    expect(result.text).toContain("2. Beta page — https://example.com/beta (fetched ");
  });

  it("web_search says so in plain words when offline, never throws or errors the turn", async () => {
    stubFetch(() => new Error("offline"));
    const result = await callResearchTool("web_search", { query: "alpha" }, context());
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("could not be reached");
    expect(result.text).not.toContain("Sources");
  });

  it("web_search refuses a blank query", async () => {
    const result = await callResearchTool("web_search", { query: "   " }, context());
    expect(result).toEqual({ text: "web_search needs query: words to search the web for.", isError: true });
  });

  it("deep_research searches, reads pages and returns cited findings", async () => {
    stubFetch((url) => {
      if (url.startsWith("https://html.duckduckgo.com")) return new Response(DDG_HTML, { status: 200, headers: { "content-type": "text/html" } });
      if (url.endsWith("/alpha")) return new Response(PAGE("Alpha", "Alpha opens with this sentence. And a second sentence follows here. And a third."), { status: 200, headers: { "content-type": "text/html" } });
      return new Response(PAGE("Beta", "Beta opens with this sentence. And a second sentence follows here. And a third."), { status: 200, headers: { "content-type": "text/html" } });
    });
    const result = await callResearchTool("deep_research", { question: "What is Alpha?" }, context());
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("[1] Alpha opens with this sentence. And a second sentence follows here.");
    expect(result.text).toContain("Sources\n1. Alpha — https://example.com/alpha (fetched ");
    expect(result.text).toContain("2. Beta — https://example.com/beta (fetched ");
  });

  it("deep_research refuses a blank or over-long question", async () => {
    expect(await callResearchTool("deep_research", { question: " " }, context())).toEqual({
      text: "deep_research needs question: the question to research.",
      isError: true,
    });
    expect((await callResearchTool("deep_research", { question: "x".repeat(501) }, context())).isError).toBe(true);
  });
});

describe("treg research tools keep source tracking", () => {
  it("appends a Sources list to a treg answer that names pages, and leaves one without links alone", async () => {
    const withLinks = context();
    withLinks.client = {
      api: async () => ({}),
      apiResponse: async () => ({
        ok: true,
        status: 200,
        body: { answer: "See the docs.", docs: [{ url: "https://example.com/docs", title: "Docs" }] },
      }),
    };
    const linked = await callResearchTool("research_call", { id: "docs.search", params: { q: "x" } }, withLinks);
    expect(linked.text).toContain('"answer":"See the docs."');
    expect(linked.text).toContain("Sources\n1. Docs — https://example.com/docs (fetched ");

    const plain = await callResearchTool("research_search", { job: "work email" }, context());
    expect(plain.text).toBe("{}");
    expect(plain.text).not.toContain("Sources");
  });

  it("still reports a treg refusal as an error", async () => {
    const refused = context();
    refused.client = {
      api: async () => ({}),
      apiResponse: async () => ({ ok: false, status: 402, body: { error: "No credit left." } }),
    };
    expect(await callResearchTool("research_call", { id: "docs.search" }, refused)).toEqual({ text: "No credit left.", isError: true });
  });
});
