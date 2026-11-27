// @vitest-environment happy-dom
// The section against a fake preload bridge: the switch on the spare computer, and adding one from the main computer.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const sessions = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} } }), api: async () => ({ sessions: sessions.list }) }));

const { AlwaysOnHomeSection, alwaysOnLines, homeStatusLine, recentSessions, RECENT_SESSION_MS, systemSettingLines } = await import("./AlwaysOnHomeSection");

const home = (over: Partial<AlwaysOnHomeState> = {}): AlwaysOnHomeState =>
  ({ available: true, on: false, platform: "darwin", openAtLogin: false, awake: "off", updates: "by-itself", ...over });

let host: HTMLDivElement;
let root: Root;
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const text = () => host.textContent ?? "";

beforeEach(() => {
  setLocale("en");
  sessions.list = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  delete (globalThis as { ogb?: unknown }).ogb;
});

function render({ onAddComputer = vi.fn(), onConnect = vi.fn(), blocked = null as string | null } = {}) {
  flushSync(() => root.render(createElement(AlwaysOnHomeSection, { blocked, onAddComputer, onConnect })));
  return { onAddComputer, onConnect };
}

describe("what the switch says it did", () => {
  it("one line for each part, from main's own state", () => {
    expect(alwaysOnLines(home({ on: true, openAtLogin: true, awake: "holding" })).map((line) => [line.key, line.good])).toEqual([
      ["alwaysOn.login.on", true], ["alwaysOn.awake.on", true], ["alwaysOn.updates.byItself", true], ["alwaysOn.windowClosed", true], ["alwaysOn.restarts", true],
    ]);
    expect(alwaysOnLines(home({ on: true, awake: "battery", updates: "package", available: false })).map((line) => line.key)).toEqual([
      "alwaysOn.login.unavailable", "alwaysOn.awake.battery", "alwaysOn.updates.package", "alwaysOn.windowClosed", "alwaysOn.restarts",
    ]);
  });

  it("names the Mac's own settings on a Mac only", () => {
    expect(systemSettingLines("darwin")).toHaveLength(4);
    expect(systemSettingLines("win32")).toEqual([]);
    expect(systemSettingLines("linux")).toEqual([]);
  });

  it("on Linux, the window line says how to get the window back and how to quit", () => {
    expect(alwaysOnLines(home({ on: true, platform: "linux" })).map((line) => line.key)).toContain("alwaysOn.windowClosedLinux");
    expect(alwaysOnLines(home({ on: true, platform: "win32" })).map((line) => line.key)).toContain("alwaysOn.windowClosed");
  });

  it("only sessions seen lately count as reaching it", () => {
    const now = 100 * RECENT_SESSION_MS;
    expect(recentSessions([{ lastSeenAt: now - 1000 }, { lastSeenAt: now - RECENT_SESSION_MS - 1 }, { id: "no time" }, null], now)).toBe(1);
    expect(recentSessions(undefined, now)).toBe(0);
  });

  it("the status line counts what reaches it", () => {
    expect(homeStatusLine(0)).toBe("Home is on · nothing paired yet");
    expect(homeStatusLine(1)).toBe("Home is on · reachable from 1 device");
    expect(homeStatusLine(2)).toBe("Home is on · reachable from 2 devices");
  });
});

describe("on the spare computer", () => {
  it("one switch turns it on; then what it did, the status, the next step and the Mac's own settings", async () => {
    let saved = home();
    const set = vi.fn(async (on: boolean) => (saved = home({ on, openAtLogin: on, awake: on ? "holding" : "off" })));
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", alwaysOnHome: { state: vi.fn(async () => saved), set } };
    sessions.list = [{ id: "laptop", lastSeenAt: Date.now() }, { id: "old", lastSeenAt: Date.now() - 2 * RECENT_SESSION_MS }];
    render();
    await vi.waitFor(() => expect($("[data-always-on-switch] [role=switch]")).not.toBeNull());
    expect(text()).toContain("Use this Mac as an always-on home");
    expect($("[data-always-on-details]")).toBeNull();
    flushSync(() => $<HTMLButtonElement>("[data-always-on-switch] [role=switch]")!.click());
    await vi.waitFor(() => expect($("[data-always-on-details]")).not.toBeNull());
    expect(set).toHaveBeenCalledWith(true);
    expect(text()).toContain("Opens at login");
    expect(text()).toContain("Stays awake while plugged in");
    expect(text()).toContain("Installs updates by itself at a quiet moment. While its bots are busy, an update waits.");
    expect(text()).toContain("Starts its server again if it crashes");
    expect(text()).toContain("Keeps running when its window is closed");
    await vi.waitFor(() => expect($("[data-always-on-status]")?.textContent).toBe("Home is on · reachable from 1 device"));
    // The Mac's own settings to check sit folded under one quiet button.
    const toggle = $<HTMLButtonElement>("[data-always-on-system-toggle]")!;
    expect(toggle.textContent).toBe("Mac settings to check");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.hidden).toBe(true);
    flushSync(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect($<HTMLElement>("[data-always-on-system]")?.hidden).toBe(false);
    expect($("[data-always-on-system]")?.textContent).toContain("System Settings → Energy → Start up automatically after a power failure");
    expect($("[data-always-on-system]")?.textContent).not.toContain("power is connected");
    expect($("[data-always-on-system]")?.textContent).toContain("Automatically log in as");
    expect($("[data-always-on-system]")?.textContent).toContain("Accessibility and Screen & System Audio Recording");
    expect($("[data-always-on-steps]"), "a home doesn't offer adding another").toBeNull();
  });

  it("Add your other computer opens the page's own steps for a computer, whether or not the share is on yet", async () => {
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", alwaysOnHome: { state: async () => home({ on: true, openAtLogin: true, awake: "holding" }), set: vi.fn() } };
    const { onAddComputer } = render();
    await vi.waitFor(() => expect($("[data-always-on-add-computer]")).not.toBeNull());
    flushSync(() => $<HTMLButtonElement>("[data-always-on-add-computer]")!.click());
    expect(onAddComputer).toHaveBeenCalledOnce();
  });

  it("with nothing signed in lately, the status says nothing is paired yet", async () => {
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", alwaysOnHome: { state: async () => home({ on: true, openAtLogin: true, awake: "holding" }), set: vi.fn() } };
    render();
    await vi.waitFor(() => expect($("[data-always-on-status]")?.textContent).toBe("Home is on · nothing paired yet"));
  });

  it("an organization that keeps remote access off: the next step stays off, and it says why", async () => {
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", alwaysOnHome: { state: async () => home({ on: true, openAtLogin: true, awake: "holding" }), set: vi.fn() } };
    render({ blocked: "Managed by Acme" });
    await vi.waitFor(() => expect($("[data-always-on-add-computer]")).not.toBeNull());
    expect($<HTMLButtonElement>("[data-always-on-add-computer]")!.disabled).toBe(true);
    expect(text()).toContain("Managed by Acme");
  });

  it("on Windows the Mac's settings are left out, and a Linux package's updates say where they come from", async () => {
    (globalThis as { ogb?: unknown }).ogb = { platform: "linux", alwaysOnHome: { state: async () => home({ on: true, platform: "linux", openAtLogin: true, awake: "holding", updates: "package" }), set: vi.fn() } };
    render();
    await vi.waitFor(() => expect($("[data-always-on-details]")).not.toBeNull());
    expect(text()).toContain("Use this computer as an always-on home");
    expect(text()).toContain("Updates come through your package manager");
    expect(text()).toMatch(/Keeps running when its window is closed\. Open \S+ again to bring the window back; to quit, press Alt and choose File → Quit\./);
    expect($("[data-always-on-system]")).toBeNull();
  });
});

describe("on the main computer", () => {
  const environments = (servers: Array<{ id: string; name: string; origin?: string; home?: boolean; kind?: "local" | "remote" }>, status: unknown[] = []) => ({
    state: vi.fn(async () => ({ localOrigin: "http://127.0.0.1:8799", remote: false, packaged: true, activeId: "local", environments: servers })),
    status: vi.fn(async () => status),
    switch: vi.fn(async () => {}),
    onStatus: () => () => {},
  });
  const unfold = async () => {
    await vi.waitFor(() => expect($("[data-settings-disclosure=add-always-on] button")).not.toBeNull());
    flushSync(() => $<HTMLButtonElement>("[data-settings-disclosure=add-always-on] button")!.click());
  };

  it("walks through adding one: the steps, then Connect, which is Add your own server's steps", async () => {
    const env = environments([{ id: "local", name: "This computer", kind: "local" }]);
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", environments: env, workspaces: { probe: vi.fn(), makeHome: vi.fn() } };
    render();
    await vi.waitFor(() => expect($("[data-settings-disclosure=add-always-on] button")).not.toBeNull());
    expect(text()).toContain("Add a Mac mini or other always-on computer");
    flushSync(() => $<HTMLButtonElement>("[data-settings-disclosure=add-always-on] button")!.click());
    expect($("[data-always-on-steps]")?.textContent).toContain("Use this Mac as an always-on home");
    expect($("[data-always-on-steps]")?.textContent).toContain("Tailscale");
    const { onConnect } = render();
    flushSync(() => $<HTMLButtonElement>("[data-always-on-connect]")!.click());
    expect(onConnect).toHaveBeenCalledOnce();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("once added: how it is doing, Open its bots, and Make … my home in one tap while main offers it, as on the rail", async () => {
    const env = environments([
      { id: "local", name: "This computer", kind: "local" },
      { id: "cloud", name: "My Cloud", kind: "remote", origin: "https://cloud.example.test", home: true },
      { id: "mini", name: "Mac mini", kind: "remote", origin: "http://mini.tail1234.ts.net:8799" },
    ], [{ id: "mini", state: "connected", since: 1, version: "0.1.166", behind: false, install: null }]);
    const makeHome = vi.fn(async () => ({ started: true }));
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", environments: env, workspaces: { probe: vi.fn(), makeHome, places: vi.fn(async () => ({ places: [], add: {} })), homeOffers: vi.fn(async () => ["mini"]) } };
    render();
    await unfold();
    await vi.waitFor(() => expect($("[data-always-on-move]")).not.toBeNull());
    expect($("[data-always-on-computer=cloud]"), "My Cloud is not a computer added by hand").toBeNull();
    await vi.waitFor(() => expect($("[data-always-on-health]")?.textContent).toBe("Online"));
    expect(text()).toContain("Mac mini has its own circle at the left edge of the window");
    expect(text()).toContain("Bots there use its screen, browser and files");
    flushSync(() => $<HTMLButtonElement>("[data-always-on-open]")!.click());
    expect(env.switch).toHaveBeenCalledWith("mini");
    expect($("[data-always-on-move]")?.textContent).toBe("Make Mac mini my home");
    expect(text()).toContain("Make Mac mini my home moves this computer's bots, chats, memory and routines there");
    flushSync(() => $<HTMLButtonElement>("[data-always-on-move]")!.click());
    await vi.waitFor(() => expect(makeHome).toHaveBeenCalledWith("mini"));
  });

  it("says main's own words when it can't move there", async () => {
    const env = environments([{ id: "mini", name: "Mac mini", kind: "remote", origin: "http://mini.tail1234.ts.net:8799" }]);
    const makeHome = vi.fn(async () => { throw new Error("This server can't be your bots' home."); });
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", environments: env, workspaces: { probe: vi.fn(), makeHome, places: vi.fn(async () => ({ places: [], add: {} })), homeOffers: vi.fn(async () => ["mini"]) } };
    render();
    await unfold();
    await vi.waitFor(() => expect($("[data-always-on-move]")).not.toBeNull());
    flushSync(() => $<HTMLButtonElement>("[data-always-on-move]")!.click());
    await vi.waitFor(() => expect($("[role=alert]")?.textContent).toBe("This server can't be your bots' home."));
  });

  it("a server main doesn't offer it for (or no longer, once the move is done): no Make … my home; the fold stays closed until asked", async () => {
    const env = environments([{ id: "mini", name: "Mac mini", kind: "remote", origin: "http://mini.tail1234.ts.net:8799" }],
      [{ id: "mini", state: "connected", since: 1, version: "0.1.166", behind: false, install: null }]);
    let offers = ["mini"];
    let changed = () => {};
    const homeOffers = vi.fn(async () => offers);
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", environments: env,
      workspaces: { probe: vi.fn(), makeHome: vi.fn(), homeOffers, onChanged: (cb: () => void) => { changed = cb; return () => {}; } } };
    render();
    await vi.waitFor(() => expect(homeOffers).toHaveBeenCalled());
    expect($("[data-always-on-steps]"), "a saved server doesn't open the fold by itself").toBeNull();
    await unfold();
    await vi.waitFor(() => expect($("[data-always-on-move]")).not.toBeNull());
    offers = [];
    changed();
    await vi.waitFor(() => expect($("[data-always-on-move]")).toBeNull());
    expect($("[data-always-on-computer=mini]")).not.toBeNull();
    expect(text()).not.toContain("Make Mac mini my home");
    expect(text()).toContain("Mac mini has its own circle");
  });

  it("an older app with no offers to read shows no Make … my home", async () => {
    const env = environments([{ id: "mini", name: "Mac mini", kind: "remote", origin: "http://mini.tail1234.ts.net:8799" }]);
    (globalThis as { ogb?: unknown }).ogb = { platform: "darwin", environments: env, workspaces: { probe: vi.fn(), makeHome: vi.fn() } };
    render();
    await unfold();
    await vi.waitFor(() => expect($("[data-always-on-computer=mini]")).not.toBeNull());
    expect($("[data-always-on-move]")).toBeNull();
  });

  it("nothing at all where neither part can run (an older app, or a browser)", () => {
    (globalThis as { ogb?: unknown }).ogb = {};
    render();
    expect(host.innerHTML).toBe("");
  });
});
