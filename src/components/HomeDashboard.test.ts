// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Action, AppState, Bot, InstanceInfo, Message } from "@/state/store";
import type { TeamPeople } from "@/state/team-people";
import type { InboxView } from "../../shared/inbox";
import type { NeedsYouItem } from "../../shared/today";

let state: AppState;
let dispatched: Action[] = [];
const openBotMock = vi.fn();
const openThreadMock = vi.fn();
const openInboxMock = vi.fn();
const apiMock = vi.fn(async (..._args: unknown[]) => ({}));
let teamPeople: TeamPeople | null = null;
let inboxView: InboxView | null = null;
let inboxSupport: "unknown" | "yes" | "no" = "unknown";

vi.mock("@/state/store", async (original) => {
  const actual = await original<typeof import("@/state/store")>();
  return {
    ...actual,
    useStore: () => ({ state, dispatch: (action: Action) => { dispatched.push(action); } }),
    openBot: (...args: Parameters<typeof actual.openBot>) => openBotMock(...args),
    openThread: (...args: Parameters<typeof actual.openThread>) => openThreadMock(...args),
    api: (...args: Parameters<typeof actual.api>) => apiMock(...args),
  };
});
vi.mock("@/state/team-people", () => ({ useTeamPeople: () => teamPeople, refreshNeedsYou: () => {} }));
vi.mock("@/state/inbox", async (original) => {
  const actual = await original<typeof import("@/state/inbox")>();
  return { ...actual, useInboxView: () => inboxView, useInboxSupport: () => inboxSupport, openInbox: (...args: Parameters<typeof actual.openInbox>) => openInboxMock(...args) };
});

const { HomeDashboard, recentConversations, guideSteps, homeGuideDismissed } = await import("./HomeDashboard");
const { initialState } = await import("@/state/store");

const makeMessage = (over: Record<string, unknown> = {}): Message => ({
  id: "m1", role: "user", kind: "text", text: "Hello", at: 1000, ...over,
}) as unknown as Message;

const makeBot = (over: Record<string, unknown> = {}): Bot => ({
  id: "bot-1", threadId: "thread-1", name: "Ada", title: "", description: "",
  hidden: false, messages: [], tasks: [], activity: undefined, yourAccess: "edit",
  modelSelection: { instanceId: "i1", model: "model" }, unread: false, notifications: true,
  ...over,
}) as unknown as Bot;

const makeInstance = (status: string): InstanceInfo =>
  ({ snapshot: { state: status } }) as unknown as InstanceInfo;

let host: HTMLDivElement;
let root: Root;
const text = () => host.textContent ?? "";
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((one) => one.textContent?.trim() === label) ?? null;
const click = (el: Element | null) => {
  if (!el) throw new Error("missing element");
  flushSync(() => (el as HTMLElement).click());
};

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
  dispatched = [];
  openBotMock.mockClear();
  openThreadMock.mockClear();
  openInboxMock.mockClear();
  apiMock.mockClear();
  teamPeople = null;
  inboxView = null;
  inboxSupport = "unknown";
  state = { ...initialState, connected: true, hydrated: true };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

function render() {
  flushSync(() => root.render(createElement(HomeDashboard)));
}

describe("recentConversations", () => {
  it("orders newest first and caps at five", () => {
    const bots = [makeBot({
      id: "bot-1", messages: [makeMessage({ at: 3000, text: "Third" })],
      tasks: [
        { threadId: "task-1", title: "First", createdAt: 1000 },
        { threadId: "task-2", title: "Second", createdAt: 2000 },
        { threadId: "task-3", title: "Fourth", createdAt: 4000 },
        { threadId: "task-4", title: "Fifth", createdAt: 5000 },
        { threadId: "task-5", title: "Sixth", createdAt: 6000 },
      ],
    })];
    const rows = recentConversations(bots);
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.title)).toEqual(["Sixth", "Fifth", "Fourth", "Ada", "Second"]);
  });

  it("skips hidden bots, archived threads and a main thread with no messages", () => {
    const bots = [
      makeBot({ id: "hidden", hidden: true, messages: [makeMessage()] }),
      makeBot({
        id: "bot-1", messages: [],
        tasks: [{ threadId: "task-1", title: "Archived", createdAt: 1000, archivedAt: 2000 }],
      }),
    ];
    expect(recentConversations(bots)).toEqual([]);
  });

  it("shows the main thread from its last message", () => {
    const rows = recentConversations([makeBot({ messages: [makeMessage({ text: "Hi\nthere", at: 7000 })] })]);
    expect(rows).toEqual([{ botId: "bot-1", threadId: "thread-1", title: "Ada", detail: "Hi", at: 7000 }]);
  });
});

describe("guideSteps", () => {
  it("reads bot, model and first message from existing state", () => {
    expect(guideSteps([], [])).toEqual({ bot: false, model: false, message: false });
    expect(guideSteps(
      [makeBot({ messages: [makeMessage()] })],
      [makeInstance("available")],
    )).toEqual({ bot: true, model: true, message: true });
    expect(guideSteps([makeBot()], [makeInstance("offline")])).toEqual({ bot: true, model: false, message: false });
  });
});

describe("HomeDashboard", () => {
  it("greets and asks what to do", () => {
    render();
    expect(text()).toMatch(/Good (morning|afternoon|evening)/);
    expect(text()).toContain("What do you want to do?");
  });

  it("quick actions trigger the existing surfaces", () => {
    state = { ...state, bots: [makeBot()], selectedId: "bot-1" };
    render();
    click(button("New chat"));
    expect(dispatched).toContainEqual({ type: "newTask", botId: "bot-1" });
    click(button("Create bot"));
    expect(dispatched).toContainEqual({ type: "newBot" });
    click(button("Open computer"));
    expect(dispatched).toContainEqual({ type: "toggleComputer", open: true, botId: "bot-1" });
    click(button("Check approvals"));
    expect(openInboxMock).toHaveBeenCalledExactlyOnceWith();
  });

  it("new chat creates a bot when there is none", () => {
    render();
    click(button("New chat"));
    expect(dispatched).toContainEqual({ type: "newBot" });
  });

  it("open computer is disabled with no bot", () => {
    render();
    expect(button("Open computer")?.disabled).toBe(true);
  });

  it("check approvals stays hidden when the server has no inbox", () => {
    inboxSupport = "no";
    render();
    expect(button("Check approvals")).toBeNull();
  });

  it("recent rows open their conversation", () => {
    const bot = makeBot({
      messages: [makeMessage({ text: "Hello" })],
      tasks: [{ threadId: "task-1", title: "Errands", createdAt: 2000 }],
    });
    state = { ...state, bots: [bot], selectedId: "bot-1" };
    render();
    expect(text()).toContain("Recent conversations");
    expect(text()).toContain("Errands");
    click([...host.querySelectorAll("button")].find((one) => one.textContent?.includes("Errands")) ?? null);
    expect(openThreadMock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), { botId: "bot-1", threadId: "task-1" }, state, expect.anything(),
    );
    click([...host.querySelectorAll("button")].find((one) => one.textContent?.includes("Hello")) ?? null);
    expect(openBotMock).toHaveBeenCalledWith(expect.anything(), bot, expect.anything());
  });

  it("empty recent list is one line and one action", () => {
    render();
    expect(text()).toContain("No conversations yet.");
    click(button("New chat"));
    expect(dispatched).toContainEqual({ type: "newBot" });
  });

  it("active bots show their status, never a count", () => {
    state = { ...state, bots: [makeBot({ activity: "working" }), makeBot({ id: "bot-2", threadId: "thread-2", name: "Bo", activity: "waiting-on-you" })] };
    render();
    expect(text()).toContain("Active bots");
    expect(text()).toContain("Working");
    expect(text()).toContain("Waiting on you");
    expect(text()).not.toMatch(/\d+ waiting/);
  });

  it("empty bot list is one line and one action", () => {
    render();
    expect(text()).toContain("No bots yet.");
    click(button("Create bot"));
    expect(dispatched).toContainEqual({ type: "newBot" });
  });

  it("needs-you card stays hidden with nothing to decide", () => {
    render();
    expect(host.querySelector('[data-home-section="attention"]')).toBeNull();
  });

  it("needs-you card shows one item with a status mark and opens its conversation", () => {
    const item = { kind: "question", id: "n1", at: 1, botId: "bot-1", threadId: "thread-1", text: "Which model?" } as unknown as NeedsYouItem;
    teamPeople = { people: [], me: null, admin: false, needsYou: [item] } as unknown as TeamPeople;
    state = { ...state, bots: [makeBot()] };
    render();
    const card = host.querySelector('[data-home-section="attention"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Ada is asking you");
    expect(card?.textContent).toContain("Which model?");
    expect(card?.querySelector(".bg-warning")).not.toBeNull();
    click(button("Open conversation"));
    expect(openThreadMock).toHaveBeenCalledExactlyOnceWith(
      expect.anything(), { botId: "bot-1", threadId: "thread-1" }, state, expect.anything(),
    );
  });

  it("an undecided inbox row opens the inbox on its line", () => {
    inboxView = {
      botId: "bot-1", threadId: "thread-1",
      rows: [{ id: "row-1", kind: "approval", tab: "needs-you", from: {}, text: "Send the email?", at: 1, unread: true }],
    } as unknown as InboxView;
    render();
    expect(host.querySelector('[data-home-section="attention"]')?.textContent).toContain("Send the email?");
    click(button("Open inbox"));
    expect(openInboxMock).toHaveBeenCalledExactlyOnceWith({ reading: "row-1" });
  });

  it("getting-started list dismisses and stays gone", () => {
    render();
    expect(host.querySelector('[data-home-section="guide"]')).not.toBeNull();
    expect(text()).toContain("Create your first bot");
    click(host.querySelector('[data-home-section="guide"] button[aria-label="Dismiss"]'));
    expect(host.querySelector('[data-home-section="guide"]')).toBeNull();
    expect(homeGuideDismissed()).toBe(true);
    render();
    expect(host.querySelector('[data-home-section="guide"]')).toBeNull();
  });

  it("getting-started list stays gone once every step is done", () => {
    state = {
      ...state,
      bots: [makeBot({ messages: [makeMessage()] })],
      instances: [makeInstance("available")],
    };
    render();
    expect(host.querySelector('[data-home-section="guide"]')).toBeNull();
  });

  it("a done step shows a check and no step counts down", () => {
    state = { ...state, bots: [makeBot()] };
    render();
    const guide = host.querySelector('[data-home-section="guide"]');
    expect(guide?.textContent).toContain("Create your first bot");
    expect(guide?.textContent).not.toMatch(/of 3|1 \/ 3/);
  });
});
