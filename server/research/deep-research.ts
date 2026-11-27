// An orchestrated research agent: plan sub-questions, search each, read the best pages, synthesise with citations.
// No model call inside, so it runs on any driver: the search and page-read steps are injected, and the bot tool
// wires them to the keyless web search.
import { appendSourcesBlock, type ResearchSource } from "./sources.ts";
import { sourceOf, type FetchedPage, type WebSearchOutcome } from "./web-search.ts";

export interface DeepResearchDeps {
  search: (query: string) => Promise<WebSearchOutcome>;
  fetchPage: (url: string) => Promise<FetchedPage | null>;
  now?: () => number;
  maxSubQuestions?: number;
  maxPagesPerQuestion?: number;
  maxPages?: number;
}

export interface DeepResearchResult {
  question: string;
  subQuestions: string[];
  answer: string;
  sources: ResearchSource[];
  pagesRead: number;
  searches: number;
}

const MAX_SUB_QUESTIONS = 4;
const MAX_PAGES_PER_QUESTION = 3;
const MAX_PAGES = 6;
const MAX_EXCERPT_CHARS = 400;

/** A multi-part question's parts: `;` separates questions, and an `X vs Y` question also asks about X and Y alone. */
export function planSubQuestions(question: string, max = MAX_SUB_QUESTIONS): string[] {
  const clean = question.trim().replace(/\s+/g, " ");
  if (!clean) return [];
  const parts = clean
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length >= 10);
  const questions = parts.length > 1 ? parts : [clean];
  const versus = /\s+vs\.?\s+|\s+versus\s+/i.exec(clean);
  if (versus && questions.length === 1) {
    const sides = clean.split(versus[0]).map((side) => side.trim().replace(/[?.,]+$/, ""));
    if (sides.length === 2 && sides.every((side) => side.length >= 3)) questions.push(...sides);
  }
  return [...new Set(questions)].slice(0, Math.max(max, 1));
}

/** A page's opening, cut to its first two sentences. */
export function excerptOf(text: string, maxChars = MAX_EXCERPT_CHARS): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim());
  const excerpt = sentences.slice(0, 2).join(" ").trim();
  return excerpt.length > maxChars ? `${excerpt.slice(0, maxChars).trimEnd()}…` : excerpt;
}

export async function runDeepResearch(question: string, deps: DeepResearchDeps): Promise<DeepResearchResult> {
  const clean = question.trim().replace(/\s+/g, " ");
  const subQuestions = planSubQuestions(clean, deps.maxSubQuestions ?? MAX_SUB_QUESTIONS);
  const maxPages = deps.maxPages ?? MAX_PAGES;
  const maxPerQuestion = deps.maxPagesPerQuestion ?? MAX_PAGES_PER_QUESTION;
  const sources: ResearchSource[] = [];
  const seen = new Set<string>();
  const findings: Array<{ subQuestion: string; index: number; excerpt: string }> = [];
  let pagesRead = 0;
  let searches = 0;
  for (const subQuestion of subQuestions) {
    if (pagesRead >= maxPages) break;
    let hits: WebSearchOutcome["hits"] = [];
    try {
      const outcome = await deps.search(subQuestion);
      searches += 1;
      hits = outcome.hits ?? [];
    } catch {
      hits = [];
    }
    for (const hit of hits.slice(0, maxPerQuestion)) {
      if (pagesRead >= maxPages) break;
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      let page: FetchedPage | null = null;
      try {
        page = await deps.fetchPage(hit.url);
      } catch {
        page = null;
      }
      if (!page) continue;
      pagesRead += 1;
      sources.push(sourceOf(page, hit.title));
      findings.push({ subQuestion, index: sources.length, excerpt: excerptOf(page.text) });
    }
  }
  if (!findings.length) {
    return {
      question: clean,
      subQuestions,
      answer: `No pages could be read for ${JSON.stringify(clean)}, so there is nothing to report. Try different words, or open the browser.`,
      sources: [],
      pagesRead: 0,
      searches,
    };
  }
  const lines = [`Research: ${clean}`, ""];
  for (const subQuestion of subQuestions) {
    const mine = findings.filter((finding) => finding.subQuestion === subQuestion);
    if (!mine.length) continue;
    if (subQuestions.length > 1) lines.push(`On ${JSON.stringify(subQuestion)}:`);
    for (const finding of mine) lines.push(`- [${finding.index}] ${finding.excerpt}`);
    lines.push("");
  }
  return {
    question: clean,
    subQuestions,
    answer: appendSourcesBlock(lines.join("\n").trimEnd(), sources),
    sources,
    pagesRead,
    searches,
  };
}
