// Keyless web search (DuckDuckGo's HTML endpoint, no key, no account) and plain page reads, for bots with no
// research credential. Every failure comes back as a plain-words note, never a throw: a turn with no network still
// ends with an answer.
import type { ResearchSource } from "./sources.ts";

export interface WebSearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface WebSearchOutcome {
  hits: WebSearchHit[];
  /** Said instead of results when the search page could not be reached or had nothing to show. */
  note?: string;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  fetchedAt: number;
}

export interface WebSearchDeps {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  limit?: number;
  now?: () => number;
}

export interface FetchPageDeps {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  maxChars?: number;
}

const SEARCH_URL = "https://html.duckduckgo.com/html/?q=";
const USER_AGENT = "SanRemes research (keyless web search)";
const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 512_000;
const MAX_PAGE_CHARS = 6_000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 10;

export const webSearchUnreachableNote = (query: string): string =>
  `Web search could not be reached just now, so there are no results for ${JSON.stringify(query)}. Check the connection and try again, or open the browser.`;
export const webSearchEmptyNote = (query: string): string =>
  `Web search found nothing for ${JSON.stringify(query)}. Try different words, or open the browser.`;

const decodeEntities = (text: string): string =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_match, digits: string) => {
      const code = Number.parseInt(digits, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });

/** Tags out, entities decoded, whitespace collapsed. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return match?.[1];
}

/** DuckDuckGo's redirect wrapper carries the real address in its `uddg` parameter. */
function resolveHref(raw: string): string | undefined {
  const href = raw.trim();
  if (!href) return undefined;
  try {
    if (href.startsWith("//")) return resolveHref(`https:${href}`);
    const url = new URL(href, "https://html.duckduckgo.com");
    const wrapped = url.searchParams.get("uddg");
    if (wrapped) return wrapped;
    if (url.hostname.endsWith("duckduckgo.com")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function anchors(html: string, wantedClass: string): Array<{ href: string; inner: string }> {
  const found: Array<{ href: string; inner: string }> = [];
  const pattern = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = match[0];
    const classes = attribute(tag, "class") ?? "";
    if (!classes.split(/\s+/).includes(wantedClass)) continue;
    const href = attribute(tag, "href");
    if (href === undefined) continue;
    found.push({ href, inner: match[1] ?? "" });
  }
  return found;
}

/** DuckDuckGo's HTML results page, parsed without a DOM: result links paired with their snippets, in order. */
export function parseDuckDuckGoHtml(html: string, limit = DEFAULT_LIMIT): WebSearchHit[] {
  const capped = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const snippets = anchors(html, "result__snippet").map((anchor) => textOf(anchor.inner));
  const hits: WebSearchHit[] = [];
  const seen = new Set<string>();
  for (const [index, anchor] of anchors(html, "result__a").entries()) {
    if (hits.length >= capped) break;
    const url = resolveHref(decodeEntities(anchor.href));
    if (!url || seen.has(url)) continue;
    const title = textOf(anchor.inner);
    if (!title) continue;
    seen.add(url);
    hits.push({ url, title, snippet: snippets[index] ?? "" });
  }
  return hits;
}

export async function searchWeb(query: string, deps: WebSearchDeps = {}): Promise<WebSearchOutcome> {
  const clean = query.trim();
  if (!clean) return { hits: [], note: "Web search needs words to search for." };
  const limit = deps.limit ?? DEFAULT_LIMIT;
  let response: Response;
  try {
    response = await (deps.fetcher ?? fetch)(`${SEARCH_URL}${encodeURIComponent(clean)}`, {
      headers: { accept: "text/html", "user-agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(deps.timeoutMs ?? SEARCH_TIMEOUT_MS),
    });
  } catch {
    return { hits: [], note: webSearchUnreachableNote(clean) };
  }
  if (!response.ok) return { hits: [], note: webSearchUnreachableNote(clean) };
  const html = await response.text().catch(() => "");
  const hits = parseDuckDuckGoHtml(html, limit);
  return hits.length ? { hits } : { hits: [], note: webSearchEmptyNote(clean) };
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return (await response.text().catch(() => "")).slice(0, maxBytes);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    chunks.push(value);
    bytes += value.length;
    if (bytes >= maxBytes) break;
  }
  await reader.cancel().catch(() => {});
  const merged = new Uint8Array(Math.min(bytes, maxBytes));
  let at = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, merged.length - at);
    merged.set(chunk.subarray(0, take), at);
    at += take;
    if (at >= merged.length) break;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/** One page as readable text, or null when it cannot be read: unreachable, not a page, or no usable text. */
export async function fetchPageText(url: string, deps: FetchPageDeps = {}): Promise<FetchedPage | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  let response: Response;
  try {
    response = await (deps.fetcher ?? fetch)(parsed.toString(), {
      headers: { accept: "text/html, text/plain", "user-agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(deps.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const type = response.headers.get("content-type") ?? "";
  if (type && !/text\/html|text\/plain/.test(type)) return null;
  const html = await readCapped(response, MAX_BODY_BYTES).catch(() => "");
  const title = textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").slice(0, 200);
  const stripped = html
    .replace(/<head[\s\S]*?<\/head>/i, " ")
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  const text = textOf(stripped).slice(0, deps.maxChars ?? MAX_PAGE_CHARS);
  if (text.length < 40) return null;
  return { url: parsed.toString(), title, text, fetchedAt: (deps.now ?? Date.now)() };
}

/** The Sources block for a page just read. */
export function sourceOf(page: FetchedPage, fallbackTitle = ""): ResearchSource {
  return { url: page.url, title: page.title || fallbackTitle || page.url, fetchedAt: page.fetchedAt };
}
