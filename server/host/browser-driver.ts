import type { BrowserDriver } from "../browser-errands.ts";
import type { BrowserRuntime, BrowserSpawnSpec } from "../browser-runtime.ts";

export interface WatchBrowserDriverDeps {
  /** The server's browser runtime: the driver calls its agentRpc the way the internal browser MCP route does. */
  runtime: Pick<BrowserRuntime, "agentRpc">;
  /** The bot's current browser session and spawn spec; null while its browser engine is not installed. */
  spec: () => Promise<{ session: string; spec: BrowserSpawnSpec } | null>;
}

/** A live-browser driver for scheduled page watches, over the bot's own browser.
 *
 * Reads only: navigate and read are both "read" steps in the trust table, so a scheduled check never stages or
 * mutates — and this adapter can call nothing else. A failed call throws, so the watch check records it as an
 * error, not a change. */
export async function createWatchBrowserDriver(deps: WatchBrowserDriverDeps): Promise<BrowserDriver | null> {
  const target = await deps.spec();
  if (!target) return null;
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await deps.runtime.agentRpc(target.session, target.spec, "tools/call", { name, arguments: args });
    const content = (result as { content?: unknown; isError?: boolean } | null)?.content;
    const part = Array.isArray(content) ? content.find((item) => typeof (item as { text?: unknown } | null)?.text === "string") : undefined;
    const text = part ? (part as { text: string }).text : "";
    if ((result as { isError?: boolean } | null)?.isError) throw new Error(text || "the browser call failed");
    return text;
  };
  return {
    navigate: async (url) => {
      await call("agent_browser_navigate", { url, readiness: "load" });
    },
    readText: () => call("agent_browser_read", { maxChars: 40_000 }),
    snapshot: () => call("agent_browser_snapshot", {}),
  };
}
