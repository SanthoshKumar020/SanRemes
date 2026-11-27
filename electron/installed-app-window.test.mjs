import { describe, expect, it, vi } from "vitest";

import { createInstalledApps, iconFor, installedAppNavigationAllowed, installedAppPermissionAllowed, validateInstallRequest } from "./installed-app-window.mjs";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

class FakeSession {
  constructor() {
    this.checkHandler = null;
    this.requestHandler = null;
  }

  setPermissionCheckHandler(handler) { this.checkHandler = handler; }

  setPermissionRequestHandler(handler) { this.requestHandler = handler; }
}

class FakeContents {
  constructor() {
    this.session = new FakeSession();
    this.handlers = {};
    this.loadedUrl = null;
    this.focused = false;
  }

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }

  on(event, handler) {
    this.handlers[event] = handler;
  }

  once(event, handler) {
    this.handlers[`once:${event}`] = handler;
  }

  getURL() { return this.loadedUrl ?? ""; }

  focus() { this.focused = true; }

  async loadURL(url) { this.loadedUrl = url; }
}

class FakeWindow {
  static created = [];

  constructor(options) {
    this.options = options;
    this.webContents = new FakeContents();
    this.handlers = {};
    this.destroyed = false;
    this.shown = false;
    this.title = options.title;
    FakeWindow.created.push(this);
  }

  static reset() { FakeWindow.created = []; }

  on(event, handler) { this.handlers[event] = handler; }

  once(event, handler) { this.handlers[`once:${event}`] = handler; }

  show() { this.shown = true; }

  focus() {}

  loadURL(url) { return this.webContents.loadURL(url); }

  close() {
    this.destroyed = true;
    this.handlers.closed?.();
  }

  isDestroyed() { return this.destroyed; }

  setTitle(title) { this.title = title; }
}

function setup({ dialogResponse = 0 } = {}) {
  FakeWindow.reset();
  let stored = null;
  const store = { read: () => stored, write: (value) => { stored = value; } };
  const dialog = { showMessageBox: vi.fn(async () => ({ response: dialogResponse })) };
  const nativeImage = {
    createFromDataURL: vi.fn(() => ({ isEmpty: () => false })),
    createFromPath: vi.fn(() => ({ isEmpty: () => false })),
  };
  let counter = 0;
  const apps = createInstalledApps({
    BrowserWindow: FakeWindow,
    dialog,
    nativeImage,
    icon: "app-icon",
    background: () => "#ffffff",
    store,
    makeId: () => `app-${++counter}`,
  });
  return { apps, dialog, nativeImage, store: { get value() { return stored; } } };
}

describe("validateInstallRequest", () => {
  it("accepts an https link and a loopback page", () => {
    expect(validateInstallRequest({ url: "https://example.com/board", title: "Board" }).ok).toBe(true);
    expect(validateInstallRequest({ url: "http://127.0.0.1:8799/app", title: "Local" }).ok).toBe(true);
  });

  it("refuses plain http, credentials in the link, and a bad title", () => {
    expect(validateInstallRequest({ url: "http://example.com/board", title: "Board" })).toEqual({ ok: false, error: expect.stringContaining("secure") });
    expect(validateInstallRequest({ url: "https://user:pass@example.com/", title: "Board" }).ok).toBe(false);
    expect(validateInstallRequest({ url: "https://example.com/", title: "" }).ok).toBe(false);
    expect(validateInstallRequest({ url: "https://example.com/", title: "x".repeat(81) }).ok).toBe(false);
    expect(validateInstallRequest({ url: "not a url", title: "Board" }).ok).toBe(false);
  });

  it("accepts a PNG data: icon and a .ico file, and refuses anything else", () => {
    expect(validateInstallRequest({ url: "https://example.com/", title: "B", iconDataUrl: PNG_DATA_URL }).ok).toBe(true);
    expect(validateInstallRequest({ url: "https://example.com/", title: "B", iconPath: "/icons/board.ico" }).ok).toBe(true);
    expect(validateInstallRequest({ url: "https://example.com/", title: "B", iconDataUrl: "data:image/svg+xml;base64,xxx" }).ok).toBe(false);
    expect(validateInstallRequest({ url: "https://example.com/", title: "B", iconPath: "relative/board.png" }).ok).toBe(false);
    expect(validateInstallRequest({ url: "https://example.com/", title: "B", iconPath: "/icons/board.txt" }).ok).toBe(false);
  });
});

describe("installedAppPermissionAllowed", () => {
  it("allows fullscreen, clipboard write and notifications for the app's own origin only", () => {
    for (const permission of ["fullscreen", "clipboard-sanitized-write", "notifications"]) {
      expect(installedAppPermissionAllowed(permission, "https://example.com/", "https://example.com")).toBe(true);
      expect(installedAppPermissionAllowed(permission, "https://other.com/", "https://example.com")).toBe(false);
    }
  });

  it("keeps media, camera, geolocation and keyboard lock off, even for the app's origin", () => {
    for (const permission of ["media", "camera", "microphone", "geolocation", "keyboardLock", "pointerLock", "usb"]) {
      expect(installedAppPermissionAllowed(permission, "https://example.com/", "https://example.com")).toBe(false);
    }
  });
});

describe("installedAppNavigationAllowed", () => {
  it("allows the app's own origin and nothing else", () => {
    expect(installedAppNavigationAllowed("https://example.com/other", "https://example.com")).toBe(true);
    expect(installedAppNavigationAllowed("https://example.com.evil.com/", "https://example.com")).toBe(false);
    expect(installedAppNavigationAllowed("data:text/html,hi", "https://example.com")).toBe(false);
  });
});

describe("iconFor", () => {
  it("prefers the record's data: icon, then its file icon, then the app icon", () => {
    const nativeImage = {
      createFromDataURL: vi.fn(() => "data-icon"),
      createFromPath: vi.fn(() => "file-icon"),
    };
    expect(iconFor({ iconDataUrl: PNG_DATA_URL }, { nativeImage, fallback: "app-icon" })).toBe("data-icon");
    expect(iconFor({ iconPath: "/icons/board.png" }, { nativeImage, fallback: "app-icon" })).toBe("file-icon");
    expect(iconFor({}, { nativeImage, fallback: "app-icon" })).toBe("app-icon");
  });

  it("falls back when the icon cannot be read", () => {
    const nativeImage = { createFromDataURL: () => { throw new Error("bad image"); } };
    expect(iconFor({ iconDataUrl: PNG_DATA_URL }, { nativeImage, fallback: "app-icon" })).toBe("app-icon");
  });
});

describe("createInstalledApps", () => {
  it("asks first and installs nothing when the person declines", async () => {
    const { apps, dialog, store } = setup({ dialogResponse: 1 });
    const result = await apps.install({ url: "https://example.com/board", title: "Board" });
    expect(result).toEqual({ installed: false, reason: "declined" });
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const options = dialog.showMessageBox.mock.calls[0][0];
    expect(options.defaultId).toBe(1);
    expect(options.cancelId).toBe(1);
    expect(options.message).toContain("Board");
    expect(store.value).toBeNull();
    expect(FakeWindow.created).toHaveLength(0);
  });

  it("records the install and opens a sandboxed window on allow", async () => {
    const { apps, dialog, nativeImage, store } = setup();
    const result = await apps.install({ url: "https://example.com/board", title: "Board", iconDataUrl: PNG_DATA_URL });
    expect(result).toEqual({ installed: true, id: "app-1" });
    expect(store.value).toHaveLength(1);
    expect(store.value[0]).toMatchObject({ id: "app-1", title: "Board", url: "https://example.com/board", origin: "https://example.com" });
    expect(nativeImage.createFromDataURL).toHaveBeenCalledWith(PNG_DATA_URL);
    expect(FakeWindow.created).toHaveLength(1);
    const win = FakeWindow.created[0];
    expect(win.options).toMatchObject({
      width: 1120, height: 800, title: "Board", show: false, autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "sanremes-installed-app-1" },
    });
    expect(win.webContents.loadedUrl).toBe("https://example.com/board");
    expect(win.webContents.windowOpenHandler({ url: "https://example.com/" })).toEqual({ action: "deny" });
    expect(win.webContents.session.checkHandler(null, "fullscreen", "https://example.com/")).toBe(true);
    expect(win.webContents.session.checkHandler(null, "media", "https://example.com/")).toBe(false);
    win.handlers["once:ready-to-show"]();
    expect(win.shown).toBe(true);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it("opens the existing window when the same page is installed again, and never asks twice", async () => {
    const { apps, dialog } = setup();
    await apps.install({ url: "https://example.com/board", title: "Board" });
    const again = await apps.install({ url: "https://example.com/board", title: "Board" });
    expect(again).toEqual({ installed: true, id: "app-1", existing: true });
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(FakeWindow.created).toHaveLength(1);
  });

  it("keeps the title and blocks navigation away from the page", async () => {
    const { apps } = setup();
    await apps.install({ url: "https://example.com/board", title: "Board" });
    const win = FakeWindow.created[0];
    const prevented = { prevented: false };
    win.webContents.handlers["page-title-updated"]({ preventDefault: () => { prevented.prevented = true; } });
    expect(prevented.prevented).toBe(true);
    expect(win.title).toBe("Board");
    const away = { prevented: false };
    win.webContents.handlers["will-navigate"]({ preventDefault: () => { away.prevented = true; } }, "https://other.com/");
    expect(away.prevented).toBe(true);
    const home = { prevented: false };
    win.webContents.handlers["will-navigate"]({ preventDefault: () => { home.prevented = true; } }, "https://example.com/next");
    expect(home.prevented).toBe(false);
  });

  it("opens an installed app again and unpins it on uninstall", async () => {
    const { apps, store } = setup();
    await apps.install({ url: "https://example.com/board", title: "Board" });
    const first = apps.open("app-1");
    expect(first).toBe(FakeWindow.created[0]);
    expect(apps.open("missing")).toBeNull();
    expect(apps.uninstall("missing")).toBe(false);
    expect(apps.uninstall("app-1")).toBe(true);
    expect(FakeWindow.created[0].isDestroyed()).toBe(true);
    expect(store.value).toEqual([]);
    expect(apps.list()).toEqual([]);
  });
});
