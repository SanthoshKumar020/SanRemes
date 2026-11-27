// @vitest-environment happy-dom
// The Devices page over a fake desktop bridge and a fake server: what the map draws, what its buttons call, and Add a
// device's pairing code, with nothing reaching a real server.
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { forgetSharedSession } from "@/lib/session-reuse";
import { initialState, StoreContext } from "@/state/store";
import { fullContext } from "../settings-index";
import { SettingsShellContext, type SettingsShell } from "../settings-shell";
import { setDevicesSignal, useDevicesSignal } from "../devices-signal";
import { DevicesPage } from "./DevicesPage";
import { overrideDeviceMap, SHOW_DEVICE_MAP } from "../../devices/DeviceMap";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.now();

let host: HTMLDivElement;
let root: Root;
let session: unknown;
let sessions: Array<{ id: string; label: string; scopes: string[]; lastSeenAt: number }>;
let openCodes: string[];
let requests: string[];
let botRows: unknown[] | "forbidden";
let config: Record<string, unknown>;
let environments: Record<string, ReturnType<typeof vi.fn>>;
let go: ReturnType<typeof vi.fn<SettingsShell["go"]>>;
let setSub: ReturnType<typeof vi.fn<NonNullable<SettingsShell["setSub"]>>>;
let workspaces: Record<string, ReturnType<typeof vi.fn>>;
let lendWish: ReturnType<typeof vi.fn>;
let saved: Array<{ id: string; kind: string; name: string; origin?: string; home?: boolean }>;
let vpsState: string;
let alwaysOn: Record<string, unknown> | null;

function install() {
  saved = [
    { id: "local", kind: "local", name: "This computer" },
    { id: "home", kind: "remote", name: "Ada’s Cloud", origin: "https://ada.sanremes.invalid", home: true },
    { id: "vps", kind: "remote", name: "Hetzner box", origin: "https://sanremes.example.com" },
  ];
  environments = {
    state: vi.fn(async () => ({ localOrigin: "http://127.0.0.1:8799", remote: false, packaged: true, activeId: "local", environments: [...saved] })),
    status: vi.fn(async () => [{ id: "vps", state: vpsState, since: NOW, version: "0.1.180", behind: false, install: "docker" }]),
    switch: vi.fn(async () => {}), forget: vi.fn(async () => {}), retry: vi.fn(async () => {}),
  };
  workspaces = {
    probe: vi.fn(async (address: string) => (address.trim() ? { outcome: "found", label: "Garage NUC", version: "0.1.180", transport: "https" } : { outcome: "problem", problem: "empty" })),
    add: vi.fn(async (how: string, address?: string) => {
      if (how !== "link") return;
      saved = [...saved, { id: "nuc", kind: "remote", name: "Garage NUC", origin: address }];
      return { outcome: "connected" };
    }),
  };
  lendWish = vi.fn(async () => true);
  vi.stubGlobal("ogb", undefined);
  (window as unknown as { ogb: unknown }).ogb = {
    platform: "darwin", app: { version: "0.1.180" }, environments, workspaces, lendComputer: { wish: lendWish, state: async () => null, set: async () => null },
    ...(alwaysOn ? { alwaysOnHome: { state: async () => alwaysOn, set: vi.fn(async () => alwaysOn) } } : {}),
  };
}

beforeEach(() => {
  setLocale("en");
  forgetSharedSession();
  requests = [];
  session = { kind: "loopback", trust: "owner" };
  sessions = [];
  openCodes = ["p1"];
  botRows = [];
  config = { profile: { email: "ada@example.com" }, managedPolicy: null };
  vpsState = "cantReach";
  alwaysOn = null;
  install();
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://127.0.0.1").pathname;
    requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/api/auth/session") return Response.json(session);
    if (path === "/api/auth/sessions") return Response.json({ sessions, current: null });
    if (path === "/api/auth/pairing" && init?.method === "POST") return Response.json({ id: "p1", code: "7KQ2-M9XD-H4TP", expiresAt: NOW + 600_000, url: null, hint: null });
    if (path === "/api/auth/pairing") return Response.json({ pairings: openCodes.map((id) => ({ id })) });
    if (path === "/api/computers/bots") return botRows === "forbidden" ? Response.json({ error: "admin only" }, { status: 403 }) : Response.json({ now: NOW, rows: botRows });
    if (path === "/api/config" && init?.method === "PUT") return Response.json({ notice: "GPU box is no longer used. Its desktops stay on it.", vps: { configured: false, sshAlias: "", servers: [] } });
    if (path === "/api/config") return Response.json({ membership: { authority: "local", pairingCodes: true } });
    return Response.json({ error: "no route" }, { status: 404 });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  go = vi.fn<SettingsShell["go"]>();
  setSub = vi.fn<NonNullable<SettingsShell["setSub"]>>();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  delete (window as unknown as { ogb?: unknown }).ogb;
  vi.unstubAllGlobals();
});

const BOTS = [{ id: "b1", name: "Scout", color: "green" }, { id: "b2", name: "Writer", color: "purple" }, { id: "b3", name: "Builder", color: "orange" }];
const gpu = { configured: true, sshAlias: "", servers: [{ name: "GPU box", sshAlias: "gpu" }] };
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T & HTMLElement>(selector);
const click = async (selector: string) => { await act(async () => $(selector)!.click()); await settle(); };
/** A key pressed on an element; true when it reached the window unhandled, where Settings would close. */
const press = async (selector: string | HTMLElement, key: string) => {
  let unhandled = false;
  const onWindow = (event: KeyboardEvent) => { unhandled = !event.defaultPrevented; };
  window.addEventListener("keydown", onWindow);
  const target = typeof selector === "string" ? $(selector)! : selector;
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  await settle();
  window.removeEventListener("keydown", onWindow);
  return unhandled;
};
const type = async (selector: string, value: string) => {
  const input = $<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
};
const wait = async (ms: number) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); await settle(); };
/** Layers this page opened: Settings itself is not in this render, so every role=dialog here sits over it. */
const layers = () => document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length;

let dispatch: ReturnType<typeof vi.fn>;
/** The page under a stand-in for the window's header, which holds the page's one action as Settings does. */
function WithHeader({ shell }: { shell: SettingsShell }) {
  const [action, setAction] = useState<ReactNode | null>(null);
  return createElement(SettingsShellContext.Provider, { value: { ...shell, setHeaderAction: setAction } },
    createElement("header", { "data-settings-header": "" }, action), createElement(DevicesPage));
}
async function render(over: Partial<SettingsShell["ctx"]> = {}, shellOver: Partial<SettingsShell> = {}, header = true) {
  const shell: SettingsShell = { ctx: fullContext({ advanced: false, ...over }), place: { name: "This computer", kind: "computer", color: null, named: false }, page: "devices", anchor: null, go, ...shellOver };
  const state = { ...initialState, config: config as never, bots: BOTS as never };
  dispatch = vi.fn();
  act(() => root.render(createElement(StoreContext.Provider, { value: { state, dispatch } as never },
    header ? createElement(WithHeader, { shell }) : createElement(SettingsShellContext.Provider, { value: shell }, createElement(DevicesPage)))));
  await settle();
}

describe("the Devices page", () => {
  it("lists this computer first, then each group by what a person calls it, every row with its state in a mark and words", async () => {
    sessions = [{ id: "s1", label: "Safari on iPhone", scopes: ["admin", "client"], lastSeenAt: NOW }];
    await render();
    expect($("[data-device-node=here]")?.textContent).toContain("This computer");
    expect([...document.querySelectorAll("section:is([data-settings-block=phones], [data-settings-block^=group-]) > div h3")].map((heading) => heading.textContent))
      .toEqual(["Phones and tablets", "Computers", "Clouds and your own servers"]);
    const iphone = $("[data-device-row='session:s1']")!;
    expect(iphone.getAttribute("data-device-status")).toBe("online");
    expect(iphone.querySelector("[data-device-state]")?.getAttribute("data-device-state")).toBe("online");
    expect(iphone.querySelector("[data-device-state]")?.textContent).toContain("Online");
    const vps = $("[data-device-row='place:vps'] [data-device-state]")!;
    expect(vps.textContent).toContain("Can’t reach it");
    expect(vps.getAttribute("data-device-state")).toBe("attention");
    expect($("[data-devices-empty=computers]")?.textContent).toBe("No other computers yet");
  });
  it("puts the one thing a device needs on its row, and leads its details with it once they are open", async () => {
    await render();
    await click("[data-device-row='place:vps'] [data-row-action=retry]");
    expect(environments.retry).toHaveBeenCalledWith("vps");
    expect($("[data-device-row='place:home'] [data-row-action]")).toBeNull();
    await click("[data-device-node='place:vps']");
    expect($("[data-device-row='place:vps'] [data-row-action]")).toBeNull();
    expect($("[data-device-details='place:vps'] [data-device-action]")?.getAttribute("data-device-action")).toBe("retry");
  });
  it("opens a device's details under its own row, whose buttons call the actions that already exist, with one Remove last", async () => {
    await render();
    await click("[data-device-node='place:vps']");
    expect($("[data-device-node='place:vps']")?.getAttribute("aria-expanded")).toBe("true");
    expect($("[data-device-row='place:vps'] [data-device-details='place:vps']")).not.toBeNull();
    expect(layers()).toBe(0);
    const actions = [...document.querySelectorAll("[data-device-details='place:vps'] [data-device-action]")].map((one) => one.getAttribute("data-device-action"));
    expect(actions.at(-1)).toBe("remove");
    expect(actions.filter((one) => one === "remove")).toHaveLength(1);
    await click("[data-device-details='place:vps'] [data-device-action=remove]");
    expect(environments.forget).toHaveBeenCalledWith("vps");
    expect($("[data-devices-notice]")?.textContent).toBe("Hetzner box was removed.");
    expect(go).not.toHaveBeenCalled();
  });
  it("closes the open details on Escape, gives focus back to its row, and never lets that Escape close Settings", async () => {
    await render();
    await click("[data-device-node='place:vps']");
    expect(await press("[data-device-details='place:vps'] button", "Escape")).toBe(false);
    expect($("[data-device-details]")).toBeNull();
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement?.getAttribute("data-device-node")).toBe("place:vps");
    // Nothing open: Escape is Settings' own.
    expect(await press("[data-device-node='place:vps']", "Escape")).toBe(true);
  });
  it("removes a saved server whole, and keeps its sign-in its own action", async () => {
    sessions = [{ id: "s-vps", label: "Hetzner box", scopes: ["admin", "client"], lastSeenAt: NOW }];
    await render();
    await click("[data-device-node='place:vps']");
    const details = $("[data-device-details='place:vps']")!;
    // One red Remove, last in the one action row, with nothing written under any button.
    const row = details.querySelector("[data-device-actions]")!;
    expect([...row.querySelectorAll("button")].map((one) => one.textContent).sort()).toEqual(["Copy address", "Go to its bots", "Remove", "Try again"]);
    expect(row.querySelectorAll("[data-device-action=remove]")).toHaveLength(1);
    expect(row.lastElementChild?.getAttribute("data-device-action")).toBe("remove");
    expect(row.lastElementChild?.className).toContain("ms-auto");
    expect(row.querySelectorAll(":scope > :not(button)")).toHaveLength(0);
    // Its sign-in here is said where it connects, with the quiet way to end it and what that does.
    const signedIn = details.querySelector("[data-device-signed-in]")!;
    expect(signedIn.closest("dd")?.previousElementSibling?.textContent).toBe("Connected by");
    const signOut = signedIn.querySelector<HTMLButtonElement>("[data-device-sign-out]")!;
    expect(signedIn.firstChild?.textContent).toBe("Also signed in to this computer");
    expect(signOut.textContent).toBe("Sign it out");
    expect(signOut.className).toContain("settings-quiet");
    expect(document.getElementById(signOut.getAttribute("aria-describedby")!)?.textContent).toBe("It ends that computer’s sign-in here; it will need a new code.");
    await click("[data-device-details='place:vps'] [data-device-action=remove]");
    expect(environments.forget).toHaveBeenCalledWith("vps");
    expect(requests).not.toContain("DELETE /api/auth/sessions/s-vps");
  });
  it("ends a saved server's sign-in here from its Connected by line, and keeps the saved server", async () => {
    sessions = [{ id: "s-vps", label: "Hetzner box", scopes: ["admin", "client"], lastSeenAt: NOW }];
    await render();
    await click("[data-device-node='place:vps']");
    await click("[data-device-details='place:vps'] [data-device-sign-out]");
    expect(requests).toContain("DELETE /api/auth/sessions/s-vps");
    expect(environments.forget).not.toHaveBeenCalled();
  });

  it("closes the open details on an Escape pressed with focus nowhere, as after Pair again's Cancel", async () => {
    vpsState = "signedOut";
    await render();
    await click("[data-device-node='place:vps']");
    await click("[data-device-details='place:vps'] [data-device-action=pair-again]");
    await click("[data-pair-again-cancel]");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(await press(document.body, "Escape")).toBe(false);
    expect($("[data-device-details]")).toBeNull();
  });

  it("pairs a saved server again inside its details, with nothing over the page", async () => {
    vpsState = "signedOut";
    await render();
    await click("[data-device-node='place:vps']");
    await click("[data-device-details='place:vps'] [data-device-action=pair-again]");
    expect($("[data-device-details='place:vps'] [data-device-pair-again] [data-own-server-link]")).not.toBeNull();
    expect($<HTMLInputElement>("[data-own-server-link]")?.readOnly).toBe(true);
    await wait(450);
    expect($("[data-connect-other-server]")?.textContent).toBe("This link reaches Garage NUC, not Hetzner box.");
    expect(layers()).toBe(0);
    await click("[data-pair-again-cancel]");
    expect($("[data-device-pair-again]")).toBeNull();
    expect($("[data-device-details='place:vps'] [data-device-action=pair-again]")).not.toBeNull();
  });

  it("is reachable from the keyboard: every row is a button with a full label, in page order", async () => {
    await render();
    const nodes = [...document.querySelectorAll<HTMLElement>("[data-device-node]")];
    expect(nodes.map((node) => node.tagName)).toEqual(nodes.map(() => "BUTTON"));
    expect(nodes.every((node) => node.tabIndex === 0 && node.getAttribute("aria-label") && node.hasAttribute("aria-expanded"))).toBe(true);
    expect(nodes.map((node) => node.getAttribute("data-device-node"))).toEqual(["here", "place:vps", "place:home"]);
  });
  it("shows which bots use each device, and their names in its details", async () => {
    config = { ...config, vps: gpu };
    botRows = [
      { botId: "b1", kind: "local", computerId: "local", name: null, state: "ready", stateAt: NOW },
      { botId: "b2", kind: "cloud", computerId: "cloud:b2", name: null, state: "asleep", stateAt: NOW },
      { botId: "b3", kind: "vps", computerId: "vps:gpu/sanremes-b3", name: "GPU box", state: "ready", stateAt: NOW, vps: { serverId: "vps:gpu", alias: "gpu", container: "sanremes-b3" } },
    ];
    await render();
    expect(requests).toContain("GET /api/computers/bots");
    expect($("[data-device-node=here]")?.getAttribute("aria-label")).toContain("Bots here: Scout");
    const desktop = $("[data-device-row='cloud:b2']")!;
    expect(desktop.textContent).toContain("Writer’s cloud desktop");
    expect(desktop.querySelector("[data-device-state]")?.textContent).toContain("Asleep");
    await click("[data-device-node='vps:gpu']");
    expect($("[data-device-details='vps:gpu'] [data-device-bot-names]")?.textContent).toContain("Builder");
  });

  it("draws no bots when the list is refused", async () => {
    botRows = "forbidden";
    await render();
    expect(document.querySelector("[data-device-bots]")).toBeNull();
    expect($("[data-device-node=here]")).not.toBeNull();
  });
  it("marks a device nothing here checks with a grey dot and says when it is checked, so every row's words start at one edge", async () => {
    config = { ...config, vps: gpu };
    await render();
    const state = $("[data-device-row='vps:gpu'] [data-device-state]")!;
    expect(state.getAttribute("data-device-state")).toBe("unknown");
    expect(state.querySelector("[data-device-unchecked]")?.className).toContain("rounded-full");
    expect(state.textContent).toBe("Checked when a bot uses it · Secure login (SSH)");
    const edges = [...document.querySelectorAll("[data-device-state]")].map((one) => one.firstElementChild?.className);
    expect(new Set(edges).size).toBe(1);
  });

  it("offers each empty group's own Add once, in its card, in the same quiet look as a section's Add", async () => {
    saved = [{ id: "local", kind: "local", name: "This computer" }];
    await render();
    expect([...document.querySelectorAll("[data-add-empty]")].map((one) => [one.getAttribute("data-add-empty"), one.textContent]))
      .toEqual([["computers", "Add a computer"], ["servers", "Add a Cloud or own server"]]);
    expect($("[data-add-empty=computers]")?.closest("[data-settings-empty]")?.querySelector("[data-devices-empty=computers]")).not.toBeNull();
    expect(document.querySelectorAll("[data-add-group=computers]")).toHaveLength(1);
    expect($("[data-add-empty=computers]")?.className).toContain("settings-quiet");
    expect($("[data-add-empty=computers]")?.className).not.toContain("ui-button");
    expect($("[data-settings-actions] [data-add-group]")).toBeNull();
    await click("[data-add-empty=computers]");
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("computer");
  });
  it("puts a group's quiet Add beside its title while it has devices, on the title's line however long the title", async () => {
    await render();
    expect($("[data-add-group=servers]")?.className).toContain("settings-quiet");
    expect($("[data-add-group=servers]")?.closest("[data-settings-actions]")?.parentElement?.className).not.toContain("flex-wrap");
  });
  it("opens a named SSH server's row from its link on AI, once, and names its kind as AI does", async () => {
    config = { ...config, vps: gpu };
    await render({}, { anchor: "ssh:gpu" });
    await wait(20);
    const details = $("[data-device-details='vps:gpu']")!;
    expect(details).not.toBeNull();
    expect(details.textContent).toContain("Your own server (SSH)");
    expect(document.activeElement).toBe($("[data-device-node='vps:gpu']"));
    await click("[data-device-node='vps:gpu']");
    expect($("[data-device-details]"), "closes like any row").toBeNull();
  });

  it("opens a server bots reach over SSH in its editor, in place, and closes with the server's notice once it is removed", async () => {
    config = { ...config, vps: gpu };
    await render();
    await click("[data-device-node='vps:gpu']");
    expect($<HTMLInputElement>("[data-device-details='vps:gpu'] [data-vps-server=gpu] input")?.value).toBe("GPU box");
    expect(layers()).toBe(0);
    await click("[data-device-details='vps:gpu'] [data-vps-server=gpu] button[aria-label^='Remove']");
    expect(requests).toContain("PUT /api/config");
    expect($("[data-device-details]")).toBeNull();
    expect($("[role=status]")?.textContent).toContain("GPU box is no longer used");
  });
});

describe("Add a device, in the page", () => {
  it("opens from Add a device, from each group and from search's anchor, and never puts a layer over Settings", async () => {
    await render();
    expect($("[data-settings-block=add] [data-add-device]")).not.toBeNull();
    expect($("[data-settings-block=here] [data-add-device]"), "You're here has no Add of its own").toBeNull();
    for (const [opener, step] of [["[data-add-device]", "choose"], ["[data-add-group=computers]", "computer"], ["[data-add-group=servers]", "choose"]] as const) {
      await click(opener);
      expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe(step);
      expect(layers()).toBe(0);
      await click("[data-add-back]");
      expect($("[data-add-panel]")).toBeNull();
    }
    for (const kind of ["computer", "server", "cloud"]) {
      await click("[data-add-device]");
      await click(`[data-add-kind=${kind}]`);
      expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe(kind);
      expect(layers()).toBe(0);
      await click("[data-add-back]");
      await click("[data-add-back]");
    }
  });
  it("steps back one level on Escape, to the choice just left and then to the list, never closing Settings", async () => {
    await render();
    await click("[data-add-device]");
    await click("[data-add-kind=server]");
    expect(await press("[data-add-panel]", "Escape")).toBe(false);
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("choose");
    expect(document.activeElement?.getAttribute("data-add-kind")).toBe("server");
    expect(await press("[data-add-panel]", "Escape")).toBe(false);
    expect($("[data-add-panel]")).toBeNull();
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement?.hasAttribute("data-add-device")).toBe(true);
  });

  it("steps back on an Escape pressed with focus nowhere or on the header's Back, as after a step swaps its controls", async () => {
    await render({}, { setSub });
    await click("[data-add-device]");
    await click("[data-add-kind=computer]");
    (document.activeElement as HTMLElement | null)?.blur();
    expect(await press(document.body, "Escape")).toBe(false);
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("choose");
    const header = document.createElement("header");
    header.setAttribute("data-settings-header", "");
    const back = document.createElement("button");
    header.append(back);
    document.body.append(header);
    back.focus();
    expect(await press(back, "Escape")).toBe(false);
    expect($("[data-add-panel]")).toBeNull();
    // A field elsewhere in Settings (its search) keeps its own Escape.
    await click("[data-add-device]");
    const search = document.createElement("input");
    document.body.append(search);
    search.focus();
    expect(await press(search, "Escape")).toBe(true);
    expect($("[data-add-panel]")).not.toBeNull();
  });

  it("shows no device as just joined that was already there when Add opened before the lists answered", async () => {
    const shell: SettingsShell = { ctx: fullContext({ advanced: false }), place: { name: "This computer", kind: "computer", color: null, named: false }, page: "devices", anchor: null, go };
    act(() => root.render(createElement(StoreContext.Provider, { value: { state: { ...initialState, config: config as never, bots: BOTS as never }, dispatch: vi.fn() } as never },
      createElement(SettingsShellContext.Provider, { value: shell }, createElement(DevicesPage)))));
    act(() => $("[data-add-device]")!.click());
    act(() => $("[data-add-kind=computer]")!.click());
    await settle();
    expect($("[data-add-connected]")).toBeNull();
  });
  it("names each step in a narrow window's own header, with its way back, and leaves out the page's copy of it", async () => {
    await render({}, { narrow: true, setSub });
    await click("[data-add-device]");
    expect(setSub).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Add a device", back: "Devices" }));
    await click("[data-add-kind=server]");
    expect(setSub).toHaveBeenLastCalledWith({ title: "Add your own server", back: "Add a device", onBack: expect.any(Function) });
    expect($("[data-add-back]")).toBeNull();
    act(() => setSub.mock.lastCall![0]!.onBack());
    await settle();
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("choose");
    await click("[data-add-kind=computer]");
    act(() => setSub.mock.lastCall![0]!.onBack());
    await settle();
    act(() => setSub.mock.lastCall![0]!.onBack());
    await settle();
    expect($("[data-add-panel]")).toBeNull();
    expect(setSub).toHaveBeenLastCalledWith(null);
  });
  it("gives another computer a code, says when it connected, and confirms it in the page", async () => {
    await render();
    await click("[data-add-group=computers]");
    expect(requests).toContain("POST /api/auth/pairing");
    expect($("[data-pairing-code]")?.textContent).toBe("7KQ2-M9XD-H4TP");
    expect($("[data-pair-state]")?.getAttribute("data-pair-state")).toBe("waiting");
    sessions = [{ id: "s-other", label: "Chrome on Windows", scopes: ["admin", "client"], lastSeenAt: NOW }];
    await wait(2_300);
    expect($("[data-pair-state]")?.getAttribute("data-pair-state")).toBe("waiting");
    sessions = [...sessions, { id: "s-new", label: "Studio Mac mini", scopes: ["admin", "client"], lastSeenAt: NOW }];
    openCodes = [];
    await wait(2_300);
    await wait(5_200);
    expect($("[data-add-connected]")?.textContent).toContain("is connected");
    expect(requests).not.toContain("DELETE /api/auth/pairing/p1");
    await click("[data-add-done]");
    expect($("[data-add-panel]")).toBeNull();
    expect($("[data-device-details]")).not.toBeNull();
  }, 20_000);
  it("cancels a code nobody used when the person goes back", async () => {
    await render();
    await click("[data-add-group=computers]");
    await click("[data-add-back]");
    expect(requests).toContain("DELETE /api/auth/pairing/p1");
  });
  it("adds your own server in two steps: the line to run, then Connect to another computer's own form with its lend switch, and confirms it", async () => {
    await render();
    await click("[data-add-device]");
    await click("[data-add-kind=server]");
    expect([...document.querySelectorAll("[data-server-command]")].map((line) => line.textContent)).toEqual([
      "npx sanremes account login && npx sanremes serve --tunnel",
    ]);
    const why = $("[data-add-server-why]")!;
    expect(why.textContent).toBe("These start SanRemes on that machine. They need Node.js 24 or later; a terminal is the window where you type commands.");
    expect(why.compareDocumentPosition($("[data-server-command]")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect($("[data-add-panel] [data-place-add=own-server]")).not.toBeNull();
    expect(layers()).toBe(0);
    await type("[data-own-server-link]", "https://sanremes.example.org/pair#code=7KQ2-M9XD-H4TP");
    await wait(500);
    expect($("[data-connect-found]")?.textContent).toContain("Garage NUC");
    expect($("[data-lend-add]")?.getAttribute("data-lend-add")).toBe("off");
    await click("[data-lend-add] [role=switch]");
    expect(lendWish).toHaveBeenLastCalledWith("https://sanremes.example.org/pair#code=7KQ2-M9XD-H4TP", true);
    await click("[data-own-server-connect]");
    expect(workspaces.add).toHaveBeenCalledWith("link", "https://sanremes.example.org/pair#code=7KQ2-M9XD-H4TP", "");
    expect($("[data-add-connected='place:nuc']")?.textContent).toContain("Garage NUC is connected");
  });
  it("gets a Cloud by closing Settings for the plans, the one place this page hands over to something else", async () => {
    await render();
    await click("[data-add-device]");
    await click("[data-add-kind=cloud]");
    expect(workspaces.add).not.toHaveBeenCalled();
    await click("[data-get-cloud]");
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: false });
    expect(workspaces.add).toHaveBeenCalledWith("cloud");
  });

  it("offers a chat-only session no code at all", async () => {
    session = { kind: "session", id: "s1", label: "Chrome on Mac", scopes: ["client"], expiresAt: 0 };
    await render();
    await click("[data-add-device]");
    expect($("[data-add-kind=cloud]")).not.toBeNull();
    await click("[data-add-kind=computer]");
    expect($("[data-pair-blocked]")).not.toBeNull();
    expect($("[data-pair-blocked]")?.textContent).toBe("This device has chat and approvals only, so it can't pair others.");
    expect($("[data-pairing-code]")).toBeNull();
    expect(requests.filter((request) => request.startsWith("POST"))).toEqual([]);
    expect(requests).not.toContain("POST /api/auth/pairing");
  });
});

describe("Always-on home, on Devices", () => {
  const home = { available: true, platform: "darwin", openAtLogin: true, awake: "holding", updates: "by-itself" };
  it("adds an always-on computer with Add your own server's steps in the page", async () => {
    alwaysOn = { ...home, on: false };
    install();
    await render();
    await click("[data-settings-disclosure=add-always-on] button");
    await click("[data-always-on-connect]");
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("server");
    expect(layers()).toBe(0);
  });

  it("adds another computer to this home with the page's own steps", async () => {
    alwaysOn = { ...home, on: true };
    install();
    await render();
    await click("[data-always-on-add-computer]");
    expect($("[data-add-panel]")?.getAttribute("data-add-step")).toBe("computer");
    expect(layers()).toBe(0);
  });
});

describe("what a Cloud's or server's page says about pairing", () => {
  it("says pairing codes are off where an organization's Admin signs people in", async () => {
    delete (window as unknown as { ogb?: unknown }).ogb;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = new URL(String(input), "http://127.0.0.1").pathname;
      if (path === "/api/auth/session") return Response.json(session);
      if (path === "/api/config") return Response.json({ membership: { authority: "portal", pairingCodes: false } });
      return Response.json({ sessions: [], current: null });
    });
    await render();
    await click("[data-add-group=computers]");
    expect($("[data-pair-blocked]")).not.toBeNull();
    expect($("[data-pair-blocked]")?.textContent).toBe("People sign in through your organization's Admin, so pairing codes are off.");
  });
});

describe("one way back for each kind of trouble", () => {
  const actionsOf = (id: string) => [...document.querySelectorAll(`[data-device-details='${id}'] [data-device-action]`)].map((one) => one.getAttribute("data-device-action"));
  it("offers only Try again while a server can't be reached, and says to check it is on", async () => {
    await render();
    expect($("[data-device-row='place:vps'] [data-row-action=retry]")?.textContent).toBe("Try again");
    await click("[data-device-node='place:vps']");
    expect(actionsOf("place:vps")).toContain("retry");
    expect(actionsOf("place:vps")).not.toContain("pair-again");
    expect($("[data-device-details='place:vps'] [data-device-unreachable]")?.textContent).toBe("Check that Hetzner box is on and online, then choose Try again.");
  });

  it("offers only Pair again once its sign-in is gone", async () => {
    vpsState = "signedOut";
    await render();
    expect($("[data-device-row='place:vps'] [data-row-action]")?.getAttribute("data-row-action")).toBe("pair-again");
    await click("[data-device-node='place:vps']");
    expect(actionsOf("place:vps")).toContain("pair-again");
    expect(actionsOf("place:vps")).not.toContain("retry");
  });

  it("offers neither while it is online", async () => {
    vpsState = "connected";
    await render();
    expect($("[data-device-row='place:vps'] [data-row-action]")).toBeNull();
    await click("[data-device-node='place:vps']");
    expect(actionsOf("place:vps").filter((type) => type === "retry" || type === "pair-again")).toEqual([]);
  });
});

describe("the inline server form's one error", () => {
  const openForm = async () => { await render(); await click("[data-add-device]"); await click("[data-add-kind=server]"); };
  it("puts an address problem under the address, with no code field until the server is found", async () => {
    await openForm();
    workspaces.probe.mockImplementation(async () => ({ outcome: "problem", problem: "unreachable", host: "sanremes.example.org" }));
    await type("[data-own-server-link]", "https://sanremes.example.org");
    await wait(500);
    const problem = $("[data-connect-problem]")!;
    expect(problem.getAttribute("data-connect-problem")).toBe("address");
    expect(document.querySelectorAll("[data-connect-problem]")).toHaveLength(1);
    const field = $<HTMLInputElement>("[data-own-server-link]")!;
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBe(problem.id);
    expect(field.className).not.toContain("shadow-[inset_0_0_0_1px_var(--color-danger)]");
    expect($("[data-own-server-code]")).toBeNull();
    expect($("[data-lend-add]"), "no lend switch for a server not found").toBeNull();
  });

  it("asks for the code once the server is found, and puts a code problem under the code", async () => {
    await openForm();
    workspaces.probe.mockImplementation(async (_address: string, code: string) => (code
      ? { outcome: "problem", problem: "oldCode", host: "sanremes.example.org" }
      : { outcome: "found", label: "Garage NUC", version: "0.1.180", transport: "https" }));
    await type("[data-own-server-link]", "https://sanremes.example.org");
    await wait(500);
    expect($("[data-own-server-code]")).not.toBeNull();
    await type("[data-own-server-code]", "123456");
    await wait(500);
    expect($("[data-connect-problem]")?.getAttribute("data-connect-problem")).toBe("code");
    expect($("[data-own-server-code]")?.getAttribute("aria-invalid")).toBe("true");
    expect($("[data-own-server-link]")?.hasAttribute("aria-invalid")).toBe(false);
  });
});

describe("a server bots reach over SSH, in its details", () => {
  it("labels every field, says its SSH name and what the limits do, and keeps Remove apart in red", async () => {
    config = { ...config, vps: gpu };
    await render();
    await click("[data-device-node='vps:gpu']");
    const editor = $("[data-device-details='vps:gpu'] [data-vps-server=gpu]")!;
    const labels = [...editor.querySelectorAll("label")].map((label) => label.textContent);
    expect(labels).toEqual(["Name", "Memory for each bot (GB)", "Processor cores for each bot"]);
    for (const label of editor.querySelectorAll("label")) expect(document.getElementById(label.htmlFor)?.tagName).toBe("INPUT");
    expect(editor.querySelector("[data-vps-ssh-name]")?.textContent).toBe("Name in your SSH settings: gpu");
    expect(editor.querySelector("[data-vps-limits-line]")?.textContent).toContain("Left empty, it gets 4 GB and 2 cores.");
    expect(editor.querySelector("button[data-danger]")?.textContent).toBe("Remove");
    expect($("[data-device-details='vps:gpu']")?.textContent).not.toContain("Name and limits");
  });
});

describe("the top of the page", () => {
  it("names what needs the person in its own status words, and a name opens that row with focus on it", async () => {
    await render();
    const line = $("[data-devices-attention]")!;
    expect(line.closest("[data-settings-rows]"), "a quiet row in its own card").not.toBeNull();
    expect(line.closest("section")?.compareDocumentPosition($("[data-settings-block=here]")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect([...line.querySelectorAll("[data-attention-device]")].map((item) => item.getAttribute("data-attention-device")))
      .toEqual(["place:vps"]);
    expect(line.querySelector("[data-attention-device='place:vps']")?.textContent).toBe("Hetzner box: Can’t reach it");
    expect([...line.querySelectorAll("li")].map((item) => item.getAttribute("data-attention-device")), "one item a line").toHaveLength(1);
    expect(line.textContent).not.toContain("·");
    await click("[data-attention-device='place:vps'] button");
    await wait(20);
    expect($("[data-device-details='place:vps']")).not.toBeNull();
    expect(document.activeElement).toBe($("[data-device-node='place:vps']"));
    expect(layers()).toBe(0);
  });
  it("puts Add a device in the page's header, as its one primary button, and leaves no band when nothing needs the person", async () => {
    vpsState = "connected";
    await render();
    expect($("[data-devices-attention]")).toBeNull();
    expect($("[data-settings-block=attention]")).toBeNull();
    const add = $("[data-settings-header] [data-settings-block=add] [data-add-device]")!;
    expect(add.textContent).toBe("Add a device");
    expect(add.className).toContain("ui-button-primary");
    expect($("[data-settings-page-body] [data-add-device], [data-devices-page] [data-add-device]")).toBeNull();
    expect(document.querySelectorAll("[data-add-device]")).toHaveLength(1);
    await click("[data-add-device]");
    expect($("[data-add-panel]")).not.toBeNull();
    expect($("[data-settings-header] [data-add-device]"), "gone while adding").toBeNull();
    expect(await press("[data-add-back]", "Escape")).toBe(false);
    expect($("[data-settings-header] [data-add-device]")).not.toBeNull();
  });

  it("keeps Add a device in the page where the window has no header for it", async () => {
    await render({}, {}, false);
    expect($("[data-settings-block=add] [data-add-device]")).not.toBeNull();
  });

  it("tells the nav to mark Devices amber while anything needs the person, and clears it when nothing does", async () => {
    setDevicesSignal(null);
    const key = "computer:This computer";
    let seen: ReturnType<typeof useDevicesSignal> = null;
    function Probe() { seen = useDevicesSignal(key); return null; }
    const probeHost = document.createElement("div");
    const probe = createRoot(probeHost);
    act(() => probe.render(createElement(Probe)));
    await render();
    expect(seen).toEqual({ place: key, needsYou: true });
    vpsState = "connected";
    act(() => root.unmount());
    root = createRoot(host);
    await render();
    expect(seen).toEqual({ place: key, needsYou: false });
    act(() => probe.unmount());
  });
  it("puts the rows that need the person first in each group, the rest in their own order", async () => {
    saved = [...saved, { id: "nas", kind: "remote", name: "Attic box", origin: "https://attic.example.com" }];
    environments.status.mockImplementation(async () => [
      { id: "vps", state: "cantReach", since: NOW, version: "0.1.180", behind: false, install: "docker" },
      { id: "nas", state: "connected", since: NOW, version: "0.1.180", behind: false, install: "docker" },
    ]);
    await render();
    expect([...document.querySelectorAll("[data-settings-block=group-servers] [data-device-node]")].map((node) => node.getAttribute("data-device-node")))
      .toEqual(["place:vps", "place:home", "place:nas"]);
  });
});

describe("the map above the list", () => {
  afterEach(() => overrideDeviceMap(null));

  it("can be turned off", async () => {
    expect(SHOW_DEVICE_MAP).toBe(true);
    overrideDeviceMap(false);
    await render();
    expect($("[data-settings-block=map]")).toBeNull();
    expect($("[data-settings-block=here] h3")?.textContent).toBe("You’re here");
  });

  it("says You're here once, on its hub, explains its lines and keeps its third column short", async () => {
    overrideDeviceMap(true);
    await render();
    expect($("[data-settings-block=here] h3")).toBeNull();
    expect($("[data-map-legend]")?.textContent).toBe("Solid: connected now · Dashed: away");
    expect([...document.querySelectorAll("[data-map-group] > span[id]")].map((label) => label.textContent)).toEqual(["Clouds and servers"]);
    expect($("[data-map-node='place:vps'] .truncate")).toBeNull();
  });
  it("opens a node's row below, with its details open and focus on its row, and nothing over the page", async () => {
    overrideDeviceMap(true);
    await render();
    const map = $("[data-settings-block=map]")!;
    expect(map.getAttribute("role")).toBe("group");
    expect(map.getAttribute("aria-label")).toBe("Your devices and how they connect");
    expect(map.compareDocumentPosition($("[data-settings-block=here]")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect([...map.querySelectorAll("[data-map-node]")].map((node) => node.getAttribute("data-map-node")))
      .toEqual(["here", "place:home", "place:vps"]);
    expect(map.querySelector("[data-map-node='place:vps']")?.getAttribute("aria-label")).toBe("Hetzner box, Your own server, Can’t reach it, Over the internet");
    await click("[data-map-node='place:vps']");
    await wait(20);
    expect($("[data-device-details='place:vps']")).not.toBeNull();
    expect(document.activeElement).toBe($("[data-device-node='place:vps']"));
    expect([...map.querySelectorAll("button, a, input, [role=switch]")].every((control) => control.hasAttribute("data-map-node")), "the map has no actions of its own").toBe(true);
    expect(layers()).toBe(0);
  });
  it("draws an away device's line dashed, and says it all in one line for a narrow window", async () => {
    overrideDeviceMap(true);
    sessions = [{ id: "s1", label: "Pixel 9", scopes: ["admin", "client"], lastSeenAt: NOW - 86_400_000 }];
    await render();
    expect($("[data-map-node='session:s1']")?.getAttribute("data-map-line")).toBe("away");
    expect($("[data-map-node='place:home']")?.getAttribute("data-map-line")).toBe("on");
    expect($("[data-map-summary]")?.textContent).toBe("1 phone · 2 Clouds and your own servers");
  });
  it("with nothing else connected, draws the hub alone and says so", async () => {
    overrideDeviceMap(true);
    saved = [{ id: "local", kind: "local", name: "This computer" }];
    await render();
    expect([...document.querySelectorAll("[data-map-node]")].map((node) => node.getAttribute("data-map-node"))).toEqual(["here"]);
    expect($("[data-map-empty]")?.textContent).toBe("Nothing else is connected yet");
    expect($("[data-map-summary]")?.textContent).toBe("Nothing else is connected yet");
  });
  it("draws nothing while it is turned off", async () => {
    overrideDeviceMap(false);
    await render();
    expect($("[data-settings-block=map]")).toBeNull();
    expect($("[data-map-node]")).toBeNull();
    expect($("[data-device-node='place:vps']")).not.toBeNull();
  });
});
