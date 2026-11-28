import { describe, expect, it } from "vitest";

import type { ToolContext } from "../browser/dispatch.ts";
import type { ToolResult } from "../browser/shape.ts";
import type { Tab } from "../browser/tabs.ts";
import type { ToolCall } from "../browser/tools.ts";
import { actionForCall, guardedExecuteTool, type TargetDescription, type TargetDescriber } from "./driver.ts";
import { ComputerUseGate } from "./gate.ts";
import { ComputerUsePermissions } from "./permissions.ts";

const page = "https://example.com/page";

function fakeTab(id: string, url: string): Tab {
  return { id, page: { url: () => url } } as unknown as Tab;
}

function fakeContext(tabs: Record<string, Tab>, active: Tab | null): ToolContext {
  return {
    tabs: { get: (id: string) => tabs[id] },
    active: () => active,
  } as unknown as ToolContext;
}

function stubRun() {
  const calls: ToolCall[] = [];
  const run = async (_context: ToolContext, call: ToolCall): Promise<ToolResult> => {
    calls.push(call);
    return { content: [{ type: "text", text: "ran" }] };
  };
  return { run, calls };
}

function fixedDescription(description: TargetDescription | null): TargetDescriber {
  return async () => description;
}

function recordingDescription(description: TargetDescription | null) {
  const seen: Array<{ ref?: string; selector?: string } | null> = [];
  const describe: TargetDescriber = async (_tab, target) => {
    seen.push(target);
    return description;
  };
  return { describe, seen };
}

describe("mapping a tool call to its Computer Use action", () => {
  it("opens and reads at a named address as a navigation, otherwise as a view", async () => {
    const context = fakeContext({}, fakeTab("t1", page));
    expect(await actionForCall(context, { name: "agent_browser_open", input: { url: "example.com/other" } })).toEqual({
      kind: "navigate",
      url: "https://example.com/other",
    });
    expect(await actionForCall(context, { name: "agent_browser_open", input: {} })).toEqual({ kind: "view", url: page });
    expect(await actionForCall(context, { name: "agent_browser_read", input: { url: "https://other.example/x" } })).toEqual({
      kind: "navigate",
      url: "https://other.example/x",
    });
    expect(await actionForCall(context, { name: "agent_browser_read", input: {} })).toEqual({ kind: "view", url: page });
    expect(await actionForCall(context, { name: "agent_browser_navigate", input: { action: "back" } })).toEqual({ kind: "navigate", url: page });
  });

  it("reads the page as view, and a picture as screenshot", async () => {
    const context = fakeContext({}, fakeTab("t1", page));
    expect(await actionForCall(context, { name: "agent_browser_snapshot", input: {} })).toEqual({ kind: "view", url: page });
    expect(await actionForCall(context, { name: "agent_browser_snapshot", input: { includeImage: true } })).toEqual({ kind: "screenshot", url: page });
    expect(await actionForCall(context, { name: "agent_browser_screenshot", input: {} })).toEqual({ kind: "screenshot", url: page });
    expect(await actionForCall(context, { name: "agent_browser_status", input: {} })).toEqual({ kind: "view", url: page });
    expect(await actionForCall(context, { name: "agent_browser_wait", input: { ms: 500 } })).toEqual({ kind: "view", url: page });
  });

  it("carries a click target's label, and nothing for a point click", async () => {
    const context = fakeContext({}, fakeTab("t1", page));
    expect(await actionForCall(context, { name: "agent_browser_click", input: { ref: "e12" } }, fixedDescription({ label: "Buy now" }))).toEqual({
      kind: "click",
      url: page,
      label: "Buy now",
    });
    expect(await actionForCall(context, { name: "agent_browser_click", input: { x: 10, y: 20 } }, fixedDescription({ label: "Buy now" }))).toEqual({
      kind: "click",
      url: page,
    });
  });

  it("carries a field's type and hints for fill and type, and reads the focused field when type names none", async () => {
    const context = fakeContext({}, fakeTab("t1", page));
    const described = recordingDescription({ fieldType: "password", fieldHints: ["password"] });
    expect(
      await actionForCall(context, { name: "agent_browser_fill", input: { ref: "e3", text: "secret", submit: true } }, described.describe),
    ).toEqual({ kind: "fill", url: page, submit: true, fieldType: "password", fieldHints: ["password"] });
    expect(described.seen).toEqual([{ ref: "e3" }]);
    const focused = recordingDescription({ fieldType: "password", fieldHints: [] });
    expect(await actionForCall(context, { name: "agent_browser_type", input: { text: "secret" } }, focused.describe)).toEqual({
      kind: "type",
      url: page,
      fieldType: "password",
      fieldHints: [],
    });
    expect(focused.seen).toEqual([null]);
  });

  it("marks evaluation, upload and accepting a dialog as their own actions", async () => {
    const context = fakeContext({}, fakeTab("t1", page));
    expect(await actionForCall(context, { name: "agent_browser_eval", input: { expression: "1+1" } })).toEqual({ kind: "eval", url: page });
    expect(await actionForCall(context, { name: "agent_browser_upload", input: { files: ["/tmp/a.png"] } })).toEqual({ kind: "upload", url: page });
    expect(await actionForCall(context, { name: "agent_browser_dialog", input: { accept: true } })).toEqual({ kind: "dialog", url: page, dialogAccept: true });
    expect(await actionForCall(context, { name: "agent_browser_dialog", input: { accept: false } })).toEqual({ kind: "dialog", url: page, dialogAccept: false });
  });

  it("leaves tab and browser lifecycle outside the gate", async () => {
    const context = fakeContext({ t1: fakeTab("t1", page) }, fakeTab("t1", page));
    expect(await actionForCall(context, { name: "agent_browser_tabs", input: { action: "close", tab: "t1" } })).toBeNull();
    expect(await actionForCall(context, { name: "agent_browser_close", input: {} })).toBeNull();
    expect(await actionForCall(context, { name: "restart_browser", input: {} })).toBeNull();
    expect(await actionForCall(context, { name: "agent_browser_tabs", input: { action: "new", url: "https://other.example/" } })).toEqual({
      kind: "navigate",
      url: "https://other.example/",
    });
    expect(await actionForCall(context, { name: "agent_browser_tabs", input: { action: "switch", tab: "t1" } })).toEqual({ kind: "view", url: page });
    expect(await actionForCall(context, { name: "agent_browser_tabs", input: { action: "list" } })).toEqual({ kind: "view", url: page });
  });

  it("throws when an action needs a tab and none is open", async () => {
    const context = fakeContext({}, null);
    await expect(actionForCall(context, { name: "agent_browser_click", input: { ref: "e12" } })).rejects.toThrow("No tab is open");
  });
});

describe("running a tool call through the gate", () => {
  it("runs a read on an unlisted site, and an ordinary change once the site is granted", async () => {
    const permissions = new ComputerUsePermissions();
    const gate = new ComputerUseGate(permissions);
    const context = fakeContext({}, fakeTab("t1", page));
    const { run, calls } = stubRun();
    expect((await guardedExecuteTool(context, { name: "agent_browser_snapshot", input: {} }, gate, run)).isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    await expect(guardedExecuteTool(context, { name: "agent_browser_click", input: { ref: "e12" } }, gate, run, fixedDescription(null))).resolves.toMatchObject({
      isError: true,
    });
    expect(calls).toHaveLength(1);
    permissions.grant(page);
    expect((await guardedExecuteTool(context, { name: "agent_browser_click", input: { ref: "e12" } }, gate, run, fixedDescription(null))).isError).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("never runs a blocked destination, even when the confirmer would approve", async () => {
    const permissions = new ComputerUsePermissions();
    permissions.grant("https://chase.com/");
    const gate = new ComputerUseGate(permissions, async () => true);
    const context = fakeContext({}, fakeTab("t1", "https://chase.com/accounts"));
    const { run, calls } = stubRun();
    const outcome = await guardedExecuteTool(context, { name: "agent_browser_snapshot", input: {} }, gate, run);
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]?.type).toBe("text");
    if (outcome.content[0]?.type === "text") expect(outcome.content[0].text).toContain("chase.com");
    expect(calls).toHaveLength(0);
  });

  it("runs a sensitive action only when the person confirms that exact action", async () => {
    const permissions = new ComputerUsePermissions();
    permissions.grant(page);
    const gate = new ComputerUseGate(permissions, async (request) => request.action.kind === "eval");
    const context = fakeContext({}, fakeTab("t1", page));
    const { run, calls } = stubRun();
    expect((await guardedExecuteTool(context, { name: "agent_browser_eval", input: { expression: "1" } }, gate, run)).isError).toBeUndefined();
    await expect(guardedExecuteTool(context, { name: "agent_browser_upload", input: { files: ["/tmp/a.png"] } }, gate, run)).resolves.toMatchObject({ isError: true });
    expect(calls).toHaveLength(1);
  });

  it("runs lifecycle calls without asking the gate", async () => {
    const gate = new ComputerUseGate(new ComputerUsePermissions());
    const context = fakeContext({ t1: fakeTab("t1", page) }, fakeTab("t1", page));
    const { run, calls } = stubRun();
    expect((await guardedExecuteTool(context, { name: "agent_browser_close", input: {} }, gate, run)).isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(gate.history()).toHaveLength(0);
  });

  it("answers a target the page no longer has with its error, and never runs the action", async () => {
    const gate = new ComputerUseGate(new ComputerUsePermissions());
    const context = fakeContext({}, fakeTab("t1", page));
    const { run, calls } = stubRun();
    const failing: TargetDescriber = async () => {
      throw new Error("That ref is stale. Take a snapshot for current refs.");
    };
    const outcome = await guardedExecuteTool(context, { name: "agent_browser_click", input: { ref: "e99" } }, gate, run, failing);
    expect(outcome.isError).toBe(true);
    if (outcome.content[0]?.type === "text") expect(outcome.content[0].text).toContain("stale");
    expect(calls).toHaveLength(0);
  });
});
