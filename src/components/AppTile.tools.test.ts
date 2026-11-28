// @vitest-environment happy-dom
// A tile with a tool count opens its tool list on demand, and only where its own project key can answer one.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  calls: [] as string[],
  tools: [{ name: "GMAIL_SEND_EMAIL", description: "Send an email" }, { name: "GMAIL_READ_EMAIL", description: "Read an email" }] as Array<{ name: string; description?: string }>,
}));

vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string) => {
    fixture.calls.push(path);
    return { tools: fixture.tools };
  }),
}));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("./bot-panel/rows", () => ({ BotSwitch: () => null }));

const { AppTileView } = await import("./AppTile");
const { StoreSourceContext } = await import("@/state/store-context");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = { getState: () => ({}), subscribe: () => () => {}, dispatch: () => {} } as never;
let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const card = (overrides: Record<string, unknown> = {}) => ({
  slug: "gmail", label: "Gmail", blurb: "Read and send email", logo: null, domain: null, toolCount: 3, triggerCount: 1, ...overrides,
});
const actions = {
  connect: () => {}, openUrl: () => {}, toggleAlias: () => {}, setAliasDraft: () => {}, aliasRequired: () => {},
  changeBots: () => {}, grantSelection: () => {}, disconnect: () => {}, openBotApps: () => {},
};
const renderTile = async (mode: "managed" | "self-hosted" | "unavailable", extra: Record<string, unknown> = {}) => {
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(StoreSourceContext, { value: source }, createElement(AppTileView, {
      card: card(extra), serviceStatus: undefined, pendingUrl: undefined, aliasDraft: null, busy: false,
      configured: true, inventoryPhase: "ready", mode, policy: undefined, usedBy: [], limited: [],
      canChangeBots: false, grantBots: [], grantSelection: null, actions,
    })));
  });
  await flush();
};
const disclosure = () => host.querySelector<HTMLButtonElement>('button[aria-expanded]');

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  fixture.calls = [];
  fixture.tools = [
    { name: "GMAIL_SEND_EMAIL", description: "Send an email" },
    { name: "GMAIL_READ_EMAIL", description: "Read an email" },
  ];
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

describe("a tile's tool preview", () => {
  it("shows the counts, and opens the tool names on demand for a self-hosted install", async () => {
    await renderTile("self-hosted");
    expect(host.textContent).toContain("3 tools");
    expect(host.textContent).toContain("1 trigger");
    expect(disclosure()).not.toBeNull();
    expect(host.textContent).not.toContain("GMAIL_SEND_EMAIL");
    await act(async () => { disclosure()!.click(); });
    await flush();
    expect(fixture.calls).toEqual(["/api/connectors/gmail/tools"]);
    expect(host.textContent).toContain("GMAIL_SEND_EMAIL");
    expect(host.textContent).toContain("Send an email");
    expect(host.textContent).toContain("GMAIL_READ_EMAIL");
    expect(disclosure()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("fetches the list once, however often the disclosure opens and closes", async () => {
    await renderTile("self-hosted");
    await act(async () => { disclosure()!.click(); });
    await flush();
    await act(async () => { disclosure()!.click(); });
    await act(async () => { disclosure()!.click(); });
    await flush();
    expect(fixture.calls).toEqual(["/api/connectors/gmail/tools"]);
  });

  it("offers no disclosure where the managed broker cannot name the tools", async () => {
    await renderTile("managed");
    expect(host.textContent).toContain("3 tools");
    expect(disclosure()).toBeNull();
    expect(fixture.calls).toEqual([]);
  });

  it("shows no count line at all for a card the catalog left uncounted", async () => {
    await renderTile("self-hosted", { toolCount: undefined, triggerCount: undefined });
    expect(host.textContent).not.toContain("tools");
    expect(disclosure()).toBeNull();
  });
});
