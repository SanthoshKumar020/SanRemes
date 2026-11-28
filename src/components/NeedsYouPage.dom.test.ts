// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string; body?: unknown }>, view: null as null | { rows: Array<{ id: string; tab: string; kind?: string; unread?: boolean }> } }));
vi.mock("../state/api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const done = /^\/api\/inbox\/([\w-]+)\/done$/.exec(path);
    if (done && server.view) server.view = { ...server.view, rows: server.view.rows.map((row) => (row.id === done[1] ? { ...row, tab: "done", unread: false } : row)) };
    if (path === "/api/inbox/read-all" && server.view) server.view = { ...server.view, rows: server.view.rows.map((row) => ({ ...row, unread: false })) };
    return server.view;
  }),
}));

// The page's own strings live in en.json from integration; until then the test reads them from here.
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  const extra: Record<string, string> = {
    "needsYouPage.activeThreads": "Active threads",
    "needsYouPage.empty": "You're all clear",
    "needsYouPage.emptyAction": "Open chats",
    "needsYouPage.loading": "Loading…",
  };
  return {
    ...actual,
    t: ((key: string, params?: Record<string, string | number>) =>
      extra[key] ?? (actual.t as (key: never, params?: Record<string, string | number>) => string)(key as never, params)) as typeof actual.t,
  };
});

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { currentInboxPanel, setInboxView } from "@/state/inbox";
import { setTeamPeople } from "@/state/team-people";
import { inboxView } from "@/testing/inbox-fixture";
import { NeedsYouPage } from "./NeedsYouPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fix = { kind: "question", id: "fix-1", at: Date.now() - 60_000, botId: "eli", threadId: "eli-wait", text: "Which page?" } as const;
const bot = (tasks: Array<{ threadId: string; title: string }>): Bot => ({
  id: "eli", name: "Eli", threadId: "eli-main",
  tasks: tasks.map((task) => ({ ...task, activity: "waiting-on-you", createdAt: 1 })),
} as Bot);

let root: Root;
const dispatch = vi.fn();
const mount = (child: ReactElement, bots: Bot[] = []) => act(async () => {
  root.render(createElement(StoreContext.Provider,
    { value: { state: { ...initialState, bots } as AppState, dispatch, flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, child));
});
const click = (selector: string) => act(async () => { document.querySelector<HTMLElement>(selector)!.click(); });
const shown = () => {
  setInboxView(inboxView());
  setTeamPeople({ people: [], me: null, admin: true, needsYou: [{ ...fix }] });
};
const waitingBots = [bot([{ threadId: "eli-wait", title: "Pricing work" }, { threadId: "eli-other", title: "Launch work" }])];

beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  server.calls.length = 0;
  dispatch.mockClear();
  shown();
});
afterEach(() => {
  act(() => root.unmount());
  setInboxView(null);
  setTeamPeople(null);
  document.body.innerHTML = "";
});

describe("NeedsYouPage", () => {
  it("lists the asks newest first, the team's fix, and the active threads without repeating a fixed conversation, and no count badge", async () => {
    await mount(createElement(NeedsYouPage), waitingBots);
    expect([...document.querySelectorAll<HTMLElement>("[data-inbox-row]")].map((row) => row.dataset.inboxRow))
      .toEqual(["line-approval", "line-question"]);
    expect(document.body.textContent).toContain("Eli is asking you");
    expect(document.body.textContent).toContain("Which page?");
    expect(document.body.textContent).not.toContain("Pricing work");
    expect(document.querySelector('[aria-label="Launch work · Eli · Waiting"]')).not.toBeNull();
    expect(document.querySelector("[data-inbox-tab-count]")).toBeNull();
    expect(document.querySelector("[data-needs-you-list]")?.getAttribute("aria-live")).toBe("polite");
  });

  it("marks every line read from the one bulk action, answers an ask from its row, and opens a row in the inbox", async () => {
    await mount(createElement(NeedsYouPage), waitingBots);
    await click("[data-needs-you-mark-all]");
    expect(server.calls).toContainEqual({ path: "/api/inbox/read-all", method: "POST" });
    await click('[data-inbox-row="line-approval"] [data-inbox-action="allow"]');
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "inbox", requestId: "req-approval", behavior: "allow" }));
    await click('[data-inbox-row="line-question"] button');
    expect(currentInboxPanel()).toMatchObject({ open: true, reading: "line-question" });
  });

  it("is one line and one action when there is nothing, and the action opens chats", async () => {
    setInboxView(inboxView([]));
    setTeamPeople({ people: [], me: null, admin: true, needsYou: [] });
    await mount(createElement(NeedsYouPage), []);
    expect(document.querySelector("[data-needs-you-mark-all]")).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe("You're all clear");
    await click("[data-needs-you-page] .ui-button");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "showChat" });
  });

  it("says it is loading while the inbox has not arrived", async () => {
    setInboxView(null);
    setTeamPeople(null);
    await mount(createElement(NeedsYouPage), []);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Loading…");
  });
});
