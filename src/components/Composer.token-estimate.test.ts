// @vitest-environment happy-dom
// The composer's token estimate: Advanced mode shows the draft plus the
// thread context as an estimated count before send, and Simple mode does not.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Message } from "@/state/store";
import { restoreComposerDraft } from "@/lib/drafts";
import { setCallMode } from "@/lib/call-mode";

const fixture = vi.hoisted(() => ({
  advanced: true,
  agentsMcp: true,
  dispatch: vi.fn(),
  call: null as Record<string, unknown> | null,
  groupCall: null as Record<string, unknown> | null,
  model: null as Record<string, unknown> | null,
  config: undefined as unknown,
}));
const ENGINE = "claude-3f0c2b1e-9d1a-4c55-8a51-0a3a6f1e2b7c";
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, config: fixture.config ?? original.initialState.config, bots: [bot, peer], instances: [{
      instanceId: ENGINE, driverKind: "claudeAgent", displayName: "Claude", capabilities: { agentsMcp: fixture.agentsMcp },
    }] },
    dispatch: fixture.dispatch,
  }) };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-guest")>(), useReactor: () => "user" }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: vi.fn() }));
vi.mock("./CallView", () => ({ CallButton: (props: Record<string, unknown>) => {
  fixture.call = props;
  return null;
} }));
vi.mock("./GroupCallView", () => ({ GroupCallButton: (props: Record<string, unknown>) => {
  fixture.groupCall = props;
  return null;
} }));
vi.mock("./ModelPicker", () => ({ ModelPicker: (props: Record<string, unknown>) => {
  fixture.model = props;
  return createElement("span", { "data-test-model": true });
} }));

import { Composer } from "./Composer";

const bot: Bot = {
  id: "atlas", threadId: "atlas-thread", name: "Atlas", title: "", description: "",
  color: "purple", notifications: false, unread: false, busy: false, messages: [], approvalMode: "ask",
  modelSelection: { instanceId: ENGINE, model: "fake" },
};
const peer: Bot = { ...bot, id: "juniper", threadId: "juniper-thread", name: "Juniper", color: "teal" };
const contextMessage: Message = {
  id: "m1", role: "user", kind: "text", text: "The quick brown fox jumps over the lazy dog", at: 1,
};

let root: Root;
let container: HTMLDivElement;
const render = (props: Parameters<typeof Composer>[0]) => flushSync(() => root.render(createElement(Composer, props)));
const estimate = () => container.querySelector<HTMLElement>("[data-token-estimate]");
const draft = (text: string) => restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text, attachments: [] });

beforeEach(() => {
  fixture.advanced = true;
  fixture.agentsMcp = true;
  fixture.config = undefined;
  fixture.call = null;
  fixture.groupCall = null;
  fixture.model = null;
  setCallMode("turns");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  restoreComposerDraft(`bot:${bot.id}:${bot.threadId}`, { text: "", attachments: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the composer's token estimate", () => {
  it("shows the draft as an estimated count in Advanced mode", () => {
    draft("Hello world");
    render({ bot });
    expect(estimate()?.textContent).toBe("~2 tokens");
    expect(estimate()?.getAttribute("title")).toMatch(/Estimated, not exact/);
  });

  it("adds the thread context to the draft", () => {
    draft("Hello world");
    render({ bot: { ...bot, messages: [contextMessage] } });
    expect(estimate()?.textContent).toBe("~11 tokens");
  });

  it("shows the thread context even with an empty draft", () => {
    render({ bot: { ...bot, messages: [contextMessage] } });
    expect(estimate()?.textContent).toBe("~9 tokens");
  });

  it("shows nothing with an empty draft and an empty thread", () => {
    render({ bot });
    expect(estimate()).toBeNull();
  });

  it("shows nothing in Simple mode", () => {
    fixture.advanced = false;
    draft("Hello world");
    render({ bot: { ...bot, messages: [contextMessage] } });
    expect(estimate()).toBeNull();
  });
});
