import { describe, expect, it } from "vitest";
import { fetchPageText, parseDuckDuckGoHtml, searchWeb, textOf } from "./web-search.ts";

const DDG_HTML = `<html><body>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://example.com/alpha">Alpha &amp; Omega</a>
  <a class="result__snippet" href="https://example.com/alpha">First snippet here.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbeta&amp;rut=abc">Beta</a>
  <a class="result__snippet" href="https://example.com/beta">Second <b>snippet</b> here.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/?q=alpha">Internal link</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://example.com/alpha">Alpha again</a>
</div>
</body></html>`;

function fakeFetch(body: string | Error, status = 200, contentType = "text/html") {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (body instanceof Error) throw body;
    return new Response(body, { status, headers: { "content-type": contentType } });
  };
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

describe("parseDuckDuckGoHtml", () => {
  it("pairs result links with snippets, unwraps redirect links, drops internal and duplicate links", () => {
    expect(parseDuckDuckGoHtml(DDG_HTML)).toEqual([
      { url: "https://example.com/alpha", title: "Alpha & Omega", snippet: "First snippet here." },
      { url: "https://example.com/beta", title: "Beta", snippet: "Second snippet here." },
    ]);
  });

  it("caps the hit count", () => {
    expect(parseDuckDuckGoHtml(DDG_HTML, 1)).toHaveLength(1);
    expect(parseDuckDuckGoHtml("")).toEqual([]);
  });
});

describe("textOf", () => {
  it("strips tags, decodes entities and collapses whitespace", () => {
    expect(textOf("<p>Hello &amp; <b>world</b></p>\n  again")).toBe("Hello & world again");
  });
});

describe("searchWeb", () => {
  it("asks the HTML endpoint and returns its hits", async () => {
    const { fetcher, calls } = fakeFetch(DDG_HTML);
    const outcome = await searchWeb("alpha", { fetcher });
    expect(outcome.hits).toHaveLength(2);
    expect(outcome.note).toBeUndefined();
    const called = calls[0]!;
    expect(called.url).toBe("https://html.duckduckgo.com/html/?q=alpha");
    expect(called.init?.headers).toMatchObject({ accept: "text/html" });
  });

  it("says so in plain words when the search page cannot be reached, never throws", async () => {
    for (const { fetcher } of [fakeFetch(new Error("offline")), fakeFetch("", 503)]) {
      const outcome = await searchWeb("alpha", { fetcher });
      expect(outcome).toEqual({ hits: [], note: expect.stringContaining("could not be reached") });
      expect(outcome.note).toContain('"alpha"');
    }
  });

  it("says so in plain words when the page has no results", async () => {
    const outcome = await searchWeb("zzzqqq", { fetcher: fakeFetch("<html></html>").fetcher });
    expect(outcome).toEqual({ hits: [], note: expect.stringContaining("found nothing") });
  });

  it("refuses a blank query without fetching", async () => {
    const { fetcher, calls } = fakeFetch(DDG_HTML);
    const outcome = await searchWeb("   ", { fetcher });
    expect(outcome.hits).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("fetchPageText", () => {
  const PAGE = `<html><head><title>Alpha page</title><style>.x{}</style><script>var x = 1;</script></head>
<body><h1>Alpha</h1><p>First sentence here. Second sentence here. Third sentence here.</p></body></html>`;

  it("returns the title and readable text, scripts and styles out", async () => {
    const page = await fetchPageText("https://example.com/alpha", { fetcher: fakeFetch(PAGE).fetcher, now: () => 1000 });
    expect(page).toEqual({
      url: "https://example.com/alpha",
      title: "Alpha page",
      text: "Alpha First sentence here. Second sentence here. Third sentence here.",
      fetchedAt: 1000,
    });
  });

  it("returns null for unreachable, non-page and near-empty pages, never throws", async () => {
    for (const { fetcher } of [
      fakeFetch(new Error("offline")),
      fakeFetch("", 404),
      fakeFetch("{}", 200, "application/json"),
      fakeFetch("<html><body><p>tiny</p></body></html>"),
    ]) {
      await expect(fetchPageText("https://example.com/alpha", { fetcher })).resolves.toBeNull();
    }
    await expect(fetchPageText("not a url")).resolves.toBeNull();
    await expect(fetchPageText("file:///etc/passwd")).resolves.toBeNull();
  });
});
