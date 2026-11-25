import { describe, expect, it, vi } from "vitest";

import type { BrowserSpawnSpec } from "../browser-runtime.ts";
import { createWatchBrowserDriver, watchBrowserDriverForBot } from "./browser-driver.ts";

const spec: BrowserSpawnSpec = { command: "agent-browser", args: [], env: {} };
const textResult = (text: string) => ({ content: [{ type: "text", text }] });

function harness(result: unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const runtime = {
    agentRpc: vi.fn(async (_session: string, _spec: BrowserSpawnSpec, _method: "tools/list" | "tools/call", params: unknown) => {
      const { name, arguments: args } = params as { name: string; arguments: Record<string, unknown> };
      calls.push({ name, args });
      return result;
    }),
  };
  return { runtime, calls };
}

describe("createWatchBrowserDriver", () => {
  it("returns null when the bot has no browser session", async () => {
    const { runtime } = harness(textResult("x"));
    expect(await createWatchBrowserDriver({ runtime, spec: async () => null })).toBeNull();
    expect(runtime.agentRpc).not.toHaveBeenCalled();
  });

  it("navigates then reads through the bot's browser", async () => {
    const { runtime, calls } = harness(textResult("Price: 109"));
    const driver = await createWatchBrowserDriver({ runtime, spec: async () => ({ session: "s1", spec }) });
    await driver!.navigate("https://example.com/price");
    expect(await driver!.readText()).toBe("Price: 109");
    expect(await driver!.snapshot()).toBe("Price: 109");
    expect(calls).toEqual([
      { name: "agent_browser_navigate", args: { url: "https://example.com/price", readiness: "load" } },
      { name: "agent_browser_read", args: { maxChars: 40_000 } },
      { name: "agent_browser_snapshot", args: {} },
    ]);
  });

  it("a failed browser call throws instead of reading as a change", async () => {
    const { runtime } = harness({ isError: true, content: [{ type: "text", text: "the browser could not start" }] });
    const driver = await createWatchBrowserDriver({ runtime, spec: async () => ({ session: "s1", spec }) });
    await expect(driver!.readText()).rejects.toThrow("the browser could not start");
  });
});

describe("watchBrowserDriverForBot", () => {
  it("returns null when the bot has no browser session", async () => {
    const { runtime } = harness(textResult("x"));
    const driverForBot = watchBrowserDriverForBot({ runtime, resolveTarget: async () => null });
    expect(await driverForBot("bot-1")).toBeNull();
    expect(runtime.agentRpc).not.toHaveBeenCalled();
  });

  it("normalizes the host spawn spec before the driver uses it", async () => {
    const seen: BrowserSpawnSpec[] = [];
    const runtime = {
      agentRpc: vi.fn(async (session: string, spec: BrowserSpawnSpec, _method: "tools/list" | "tools/call", params: unknown) => {
        expect(session).toBe("s1");
        seen.push(spec);
        const { name, arguments: args } = params as { name: string; arguments: Record<string, unknown> };
        expect(name).toBe("agent_browser_navigate");
        expect(args).toEqual({ url: "https://example.com/price", readiness: "load" });
        return textResult("Price: 109");
      }),
    };
    const driverForBot = watchBrowserDriverForBot({
      runtime,
      resolveTarget: async () => ({ session: "s1", spec: { command: "agent-browser", env: { FOO: "bar" } } }),
    });
    const driver = await driverForBot("bot-1");
    await driver!.navigate("https://example.com/price");
    expect(seen).toEqual([{ command: "agent-browser", args: [], env: { FOO: "bar" } }]);
  });
});
