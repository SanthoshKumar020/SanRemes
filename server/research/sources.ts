/** A page a research tool read, kept so an answer can cite it: where it came from, what it is called, when it was read. */
export interface ResearchSource {
  url: string;
  title: string;
  fetchedAt: number;
}

/** The wire shape of a Sources block: one line per source, newest claim last. */
const SOURCE_LINE = /^(\d+)\.\s+(.+?)\s+—\s+(https?:\/\/\S+?)(?:\s+\(fetched\s+(\d{4}-\d{2}-\d{2})\))?$/;

const dayOf = (at: number): string => (Number.isFinite(at) && at > 0 ? new Date(at).toISOString().slice(0, 10) : "");

const shownTitle = (source: ResearchSource): string => {
  const title = source.title.trim();
  if (title) return title;
  try {
    return new URL(source.url).hostname;
  } catch {
    return source.url;
  }
};

/** Sources in first-seen order, one per URL. */
export function dedupeSources(sources: readonly ResearchSource[]): ResearchSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    if (!source.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

/** The Sources block for `sources`, or an empty string when there is nothing to cite. */
export function formatSources(sources: readonly ResearchSource[]): string {
  const unique = dedupeSources(sources);
  if (!unique.length) return "";
  const lines = unique.map((source, index) => {
    const day = dayOf(source.fetchedAt);
    return `${index + 1}. ${shownTitle(source)} — ${source.url}${day ? ` (fetched ${day})` : ""}`;
  });
  return `Sources\n${lines.join("\n")}`;
}

/** `text` with the Sources block for `sources` under it; unchanged when there is nothing to cite. */
export function appendSourcesBlock(text: string, sources: readonly ResearchSource[]): string {
  const block = formatSources(sources);
  return block ? `${text.replace(/\s+$/, "")}\n\n${block}` : text;
}

/** A tool result's trailing Sources block, split back into its text and its sources. */
export function parseSourcesBlock(text: string): { text: string; sources: ResearchSource[] } {
  const lines = text.split("\n");
  const at = lines.lastIndexOf("Sources");
  if (at < 0 || at === lines.length - 1) return { text, sources: [] };
  const sources: ResearchSource[] = [];
  for (const line of lines.slice(at + 1)) {
    const match = SOURCE_LINE.exec(line.trim());
    if (!match) return { text, sources: [] };
    sources.push({
      title: match[2]!,
      url: match[3]!,
      fetchedAt: match[4] ? Date.parse(`${match[4]}T00:00:00Z`) : 0,
    });
  }
  if (!sources.length) return { text, sources: [] };
  return { text: lines.slice(0, at).join("\n").replace(/\s+$/, ""), sources };
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\]+/g;
const MAX_SOURCES = 10;
const MAX_DEPTH = 8;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function cleanUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?"']+$/, "");
  if (url.endsWith(")") && !url.includes("(")) url = url.slice(0, -1);
  return url;
}

function titleOf(row: Record<string, unknown>): string {
  for (const key of ["title", "name"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  return "";
}

/** The pages named anywhere in a provider answer: `url`/`link` fields with a nearby title, else bare links in text. */
export function sourcesFromValue(value: unknown, now: number): ResearchSource[] {
  const found: ResearchSource[] = [];
  const seen = new Set<string>();
  const add = (url: string, title: string) => {
    const clean = cleanUrl(url);
    if (!clean || seen.has(clean) || found.length >= MAX_SOURCES) return;
    seen.add(clean);
    found.push({ url: clean, title: title.trim() || hostnameOf(clean), fetchedAt: now });
  };
  const walk = (node: unknown, depth: number): void => {
    if (found.length >= MAX_SOURCES || depth > MAX_DEPTH) return;
    if (typeof node === "string") {
      for (const match of node.matchAll(URL_IN_TEXT)) add(match[0], "");
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node !== null && typeof node === "object") {
      const row = node as Record<string, unknown>;
      for (const key of ["url", "link"]) {
        const value = row[key];
        if (typeof value === "string" && /^https?:\/\//.test(value)) add(value, titleOf(row));
      }
      for (const [key, item] of Object.entries(row)) {
        if (key === "url" || key === "link") continue;
        walk(item, depth + 1);
      }
    }
  };
  walk(value, 0);
  return found;
}
