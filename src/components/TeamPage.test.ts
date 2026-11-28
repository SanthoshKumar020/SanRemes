// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { en } from "@/locales";
import type { Action, AppState, Bot, InstanceInfo, Message } from "@/state/store";

let state: AppState;
let dispatched: Action[] = [];

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({ state, dispatch: (action: Action) => { dispatched.push(action); } }),
  };
});

const { TeamPage, botLastActiveAt, filterTeamBots, isBotActive } = await import("./TeamPage");
const { initialState } = await import("@/state/store");

const TEAM_KEYS: Record<string, string> = {
  "team.title": "Team",
  "team.filter.status": "Status",
  "team.filter.statusActive": "Active",
  "team.filter.statusAll": "All",
  "team.filter.workspace": "Workspace",
  "team.filter.allWorkspaces": "All workspaces",
  "team.filter.noWorkspace": "No workspace",
  "team.lastActive": "Last active {time}",
  "team.emptyFiltered": "No bots match these filters.",
  "team.clearFilters": "Clear filters",
};

function seedTeamKeys(): void {
  Object.assign(en as Record<string, string>, TEAM_KEYS);
}

const makeMessage = (over: Record<string, unknown> = {}): Message => ({
  id: "m1", role: "user", kind: "text", text: "Hello", at: 1000, ...over,
}) as unknown as Message;

const makeBot = (over: Record<string, unknown> = {}): Bot => ({
  id: "bot-1", threadId: "thread-1", name: "Ada", title: "", description: "",
  hidden: false, messages: [], tasks: [], activity: undefined, yourAccess: "edit",
  modelSelection: { instanceId: "i1", model: "model" }, unread: false, notifications: true,
  color: "green",
  ...over,
}) as unknown as Bot;

const makeInstance = (): InstanceInfo => ({
  instanceId: "i1", driverKind: "test", displayName: "Test engine",
  snapshot: { state: "available" },
  models: { default: "model", options: [{ id: "model", label: "Test model" }] },
}) as unknown as InstanceInfo;

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? "";
const render = () => {
  flushSync(() => {
    root.render(createElement(TeamPage));
  });
};
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((one) => one.textContent?.trim() === label) ?? null;
const rowButton = (name: string) =>
  [...host.querySelectorAll("button")].find((one) => one.textContent?.includes(name)) ?? null;
const click = (el: Element | null) => {
  if (!el) throw new Error("missing element");
  flushSync(() => (el as HTMLElement).click());
};
const selectByLabel = (label: string) =>
  host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
const choose = (select: HTMLSelectElement | null | undefined, value: string) => {
  if (!select) throw new Error("missing select");
  flushSync(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

beforeEach(() => {
  setLocale("en");
  seedTeamKeys();
  localStorage.clear();
  dispatched = [];
  state = { ...initialState, connected: true, hydrated: true, instances: [makeInstance()] };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => {
    root.unmount();
  });
  host.remove();
});

describe("isBotActive", () => {
  it("treats working, waiting and idle bots as active", () => {
    expect(isBotActive(makeBot({ activity: "working" }))).toBe(true);
    expect(isBotActive(makeBot({ activity: "waiting-on-you" }))).toBe(true);
    expect(isBotActive(makeBot({ activity: "idle" }))).toBe(true);
    expect(isBotActive(makeBot({ activity: undefined }))).toBe(true);
  });

  it("treats dead, parked and no-signal bots as inactive", () => {
    expect(isBotActive(makeBot({ activity: "dead" }))).toBe(false);
    expect(isBotActive(makeBot({ activity: "parked.computer" }))).toBe(false);
    expect(isBotActive(makeBot({ activity: "no-signal" }))).toBe(false);
  });
});

describe("botLastActiveAt", () => {
  it("takes the newest message or task stamp", () => {
    const bot = makeBot({
      messages: [makeMessage({ at: 1000 }), makeMessage({ at: 5000 })],
      tasks: [{ threadId: "t2", updatedAt: 3000 }],
    });
    expect(botLastActiveAt(bot)).toBe(5000);
  });

  it("returns null with nothing to date", () => {
    expect(botLastActiveAt(makeBot())).toBeNull();
  });
});

describe("filterTeamBots", () => {
  const bots = [
    makeBot({ id: "a", name: "Ada", activity: "working", section: "Support" }),
    makeBot({ id: "b", name: "Ben", activity: "dead", section: "Support" }),
    makeBot({ id: "c", name: "Cleo", activity: "idle", section: undefined }),
  ];

  it("keeps only active bots by default", () => {
    expect(filterTeamBots(bots, { status: "active", workspace: "" }).map((bot) => bot.id)).toEqual(["a", "c"]);
  });

  it("shows every bot with the all filter", () => {
    expect(filterTeamBots(bots, { status: "all", workspace: "" }).map((bot) => bot.id)).toEqual(["a", "b", "c"]);
  });

  it("narrows to one workspace", () => {
    expect(filterTeamBots(bots, { status: "all", workspace: "Support" }).map((bot) => bot.id)).toEqual(["a", "b"]);
  });

  it("finds bots with no workspace", () => {
    expect(filterTeamBots(bots, { status: "all", workspace: "__none__" }).map((bot) => bot.id)).toEqual(["c"]);
  });
});

describe("TeamPage", () => {
  it("lists each active bot with its model, status and last active time", () => {
    state = {
      ...state,
      bots: [
        makeBot({ messages: [makeMessage({ at: Date.now() - 5 * 60 * 1000 })] }),
        makeBot({ id: "bot-2", name: "Ben", activity: "dead" }),
      ],
    };
    render();
    expect(text()).toContain("Team");
    expect(text()).toContain("Ada");
    expect(text()).toContain("Test model");
    expect(text()).toContain("Idle");
    expect(text()).toContain("Last active 5 min ago");
    expect(text()).not.toContain("Ben");
  });

  it("shows every bot once the status filter is set to all", () => {
    state = { ...state, bots: [makeBot({ activity: "dead" })] };
    render();
    expect(text()).not.toContain("Ada");
    choose(selectByLabel("Status"), "all");
    expect(text()).toContain("Ada");
    expect(text()).toContain("Off");
  });

  it("narrows the list by workspace", () => {
    state = {
      ...state,
      sections: ["Support"],
      bots: [
        makeBot({ id: "bot-1", name: "Ada", section: "Support" }),
        makeBot({ id: "bot-2", name: "Ben", section: undefined }),
      ],
    };
    render();
    choose(selectByLabel("Workspace"), "Support");
    expect(text()).toContain("Ada");
    expect(text()).not.toContain("Ben");
    choose(selectByLabel("Workspace"), "__none__");
    expect(text()).not.toContain("Ada");
    expect(text()).toContain("Ben");
  });

  it("opens the bot panel for the clicked bot", () => {
    state = { ...state, bots: [makeBot()] };
    render();
    click(rowButton("Ada"));
    expect(dispatched).toContainEqual({ type: "toggleSettings", open: true, section: "overview", botId: "bot-1" });
  });

  it("starts a new bot from the header button", () => {
    state = { ...state, bots: [makeBot()] };
    render();
    click(button("New bot"));
    expect(dispatched).toContainEqual({ type: "newBot" });
  });

  it("shows one line and one action when there are no bots", () => {
    state = { ...state, bots: [] };
    render();
    expect(text()).toContain("No bots yet.");
    click(button("New bot"));
    expect(dispatched).toContainEqual({ type: "newBot" });
  });

  it("offers clearing the filters when they hide every bot", () => {
    state = { ...state, bots: [makeBot({ activity: "dead" })] };
    render();
    expect(text()).toContain("No bots match these filters.");
    click(button("Clear filters"));
    expect(text()).toContain("No bots match these filters.");
    choose(selectByLabel("Status"), "all");
    expect(text()).toContain("Ada");
  });
});
