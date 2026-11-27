// The agents catalog's X and research tools (through treg) and the internal route behind each. Every treg call is paid, from
// the person's own treg balance or their Cloud plan's allowance, so a bot is shown x_search only when a treg key or a
// plan credential is held and its research switch is on, and the research tools only when research also works for that
// credential (a plan's relay can have X without research); each route checks again before it spends. web_search and
// deep_research are the free exception: keyless web search, no treg, no key.
import { agentsCallMember } from "../../shared/agents-tool-names.ts";
import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";
import { runDeepResearch } from "../research/deep-research.ts";
import { appendSourcesBlock, sourcesFromValue, type ResearchSource } from "../research/sources.ts";
import { fetchPageText, searchWeb } from "../research/web-search.ts";

/** Each call's route, by the member name it goes by (x_search's actions are its members). */
const RESEARCH_ROUTES: Readonly<Record<string, string>> = {
  x_search: "x/search", x_user_posts: "x/user-posts", x_post: "x/post", x_profile: "x/profile",
  research_search: "research/search", research_endpoint: "research/endpoint", research_call: "research/call",
};
export const RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(["x_search", "research_search", "research_endpoint", "research_call", "web_search", "deep_research"]);
/** The ones that need only X: shown without research. */
export const X_TOOL_NAMES: ReadonlySet<string> = new Set(["x_search"]);
/** The ones that need no key at all: free web search, shown to every bot. */
export const FREE_RESEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(["web_search", "deep_research"]);

/** What each X read cannot go without, said before anything is spent. */
const X_NEEDS: Readonly<Record<string, string>> = { x_search: "query", x_user_posts: "handle", x_post: "post", x_profile: "handle" };
const X_ACTIONS = new Set(["search", "user_posts", "post", "profile"]);

export async function callResearchTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  if (name === "web_search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { text: "web_search needs query: words to search the web for.", isError: true };
    const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 10) : 8;
    const outcome = await searchWeb(query, { limit });
    if (outcome.note) return { text: outcome.note };
    const sources: ResearchSource[] = outcome.hits.map((hit) => ({ url: hit.url, title: hit.title, fetchedAt: Date.now() }));
    const lines = outcome.hits.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ""}`);
    return { text: appendSourcesBlock(`Web results for ${JSON.stringify(query)}:\n${lines.join("\n")}`, sources) };
  }
  if (name === "deep_research") {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question) return { text: "deep_research needs question: the question to research.", isError: true };
    if (question.length > 500) return { text: "deep_research question is too long: keep it under 500 characters.", isError: true };
    const maxPages = typeof args.max_pages === "number" && Number.isInteger(args.max_pages) ? Math.min(Math.max(args.max_pages, 1), 8) : 6;
    const result = await runDeepResearch(question, {
      search: (subQuestion) => searchWeb(subQuestion, { limit: 5 }),
      fetchPage: (url) => fetchPageText(url),
      maxPages,
    });
    return { text: result.answer };
  }
  const member = agentsCallMember(name, args);
  const { action, ...rest } = args;
  const input = name === "x_search" ? rest : args;
  if (name === "x_search") {
    if (action !== undefined && action !== null && !X_ACTIONS.has(String(action))) return { text: "x_search action is search (the default), user_posts, post or profile.", isError: true };
    const needed = X_NEEDS[member]!;
    const value = input[needed];
    if (typeof value !== "string" || !value.trim()) return { text: `x_search ${member === "x_search" ? "search" : String(action)} needs ${needed}.`, isError: true };
  }
  const { ok, body } = await context.client.apiResponse(`/api/internal/${RESEARCH_ROUTES[member]}`, { method: "POST", body: JSON.stringify(input) });
  if (ok) return { text: appendSourcesBlock(JSON.stringify(body), sourcesFromValue(body, Date.now())) };
  return { text: String(body.error ?? "Research failed. Try again shortly."), isError: true };
}

export const RESEARCH_TOOL_DEFINITIONS = [
  {
    name: "x_search",
    description:
      "Read X (Twitter) without an X account (was also x_user_posts / x_post / x_profile). Every call is paid (the user's treg balance or Cloud plan) and read-only: you cannot post, like or reply. search (the default) finds posts; write one well-filtered query instead of many broad ones. The query takes X operators: from:handle, to:handle, \"exact phrase\", since:YYYY-MM-DD, until:YYYY-MM-DD, min_faves:N, -filter:replies, lang:en, OR. Bare words are all required, so use a short phrase or OR between alternatives. user_posts reads an account's recent posts, newest first. Both return compact posts (link, author, time, text, likes, reposts, replies, quotes, views) and newestId: to monitor X, for example in a routine, keep newestId and pass it back as sinceId next time to get only newer posts. post reads one post, and with replies the first page of up to 20 replies to it. profile looks up an account: name, bio, followers, following, post count and verified status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["search", "user_posts", "post", "profile"], description: "search (default), user_posts, post or profile." },
        query: { type: "string", minLength: 1, maxLength: 512, description: "search: the X search query; operators allowed." },
        sort: { type: "string", enum: ["latest", "top"], description: "search: latest (default) or top." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "search and user_posts: how many posts, 1-50. Default 20." },
        sinceId: { type: "string", pattern: "^\\d{1,25}$", description: "search and user_posts: only posts newer than this post id, a newestId from an earlier call." },
        handle: { type: "string", minLength: 1, description: "user_posts and profile: the account: @handle, handle, or an x.com profile link." },
        includeReplies: { type: "boolean", description: "user_posts: include the account's replies to others. Default false." },
        post: { type: "string", minLength: 1, description: "post: an x.com or twitter.com post link, or the post id." },
        replies: { type: "boolean", description: "post: also return replies to the post. Default false." },
      },
    },
  },
  {
    name: "research_search",
    description:
      "Find a research endpoint for a job in treg's catalog: companies, people and work emails, funding, news, social and trend data, SEO, search results, scraping, generation and more. Describe the job, not a vendor. Returns endpoints with their params, an example and the estimated cost; then call one with research_call. Searching is free.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        job: { type: "string", minLength: 1, maxLength: 300, description: "What the research is for, such as \"work email of a person at a company\"." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "How many endpoints, 1-10. Default 5." },
      },
      required: ["job"],
    },
  },
  {
    name: "research_endpoint",
    description: "Read one research endpoint in full: its params, an example, its cost and how to check on an async task.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", minLength: 1, maxLength: 200, description: "An endpoint id from research_search." } },
      required: ["id"],
    },
  },
  {
    name: "research_call",
    description:
      "Call a research endpoint by id and get the provider's answer and what it cost (a paid call). params are its query parameters for a GET endpoint, otherwise its JSON body; query adds a query string to a body endpoint. Follow the endpoint's params and example. An async task answers with how to check on it: call that with research_call.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1, maxLength: 200, description: "The endpoint id." },
        params: { type: "object", additionalProperties: true, description: "The endpoint's parameters." },
        query: { type: "object", additionalProperties: true, description: "Query string for an endpoint that takes a JSON body." },
      },
      required: ["id"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the web for free, with no key: DuckDuckGo results (title, link, snippet). Use it for a quick fact check, or when research_search is not available. Returns numbered results with their sources; when the search page cannot be reached it says so plainly instead of failing.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 512, description: "Words to search the web for." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "How many results, 1-10. Default 8." },
      },
      required: ["query"],
    },
  },
  {
    name: "deep_research",
    description:
      "Research a question in depth, free and with no key: plans sub-questions, searches the web for each, reads the best pages, and returns findings with numbered citations ([1], [2]) and a Sources list. Cite those numbers in your reply and keep the Sources list under it. Reads at most 6 pages, so ask a focused question.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: { type: "string", minLength: 1, maxLength: 500, description: "The question to research." },
        max_pages: { type: "integer", minimum: 1, maximum: 8, description: "How many pages to read, 1-8. Default 6." },
      },
      required: ["question"],
    },
  },
];
