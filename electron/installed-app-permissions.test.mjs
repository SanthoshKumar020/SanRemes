import { describe, expect, it, vi } from "vitest";

import {
  capabilitiesForLevel,
  createInstalledApps,
  installedAppPermissionAllowed,
  normalizePermissionLevel,
  permissionsForLevel,
  validateInstallRequest,
} from "./installed-app-window.mjs";

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
  }

  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }

  on(event, handler) { this.handlers[event] = handler; }

  once(event, handler) { this.handlers[`once:${event}`] = handler; }

  getURL() { return this.loadedUrl ?? ""; }

  focus() {}

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

function setup({ dialogResponse = 0, stored = null } = {}) {
  FakeWindow.reset();
  let saved = stored;
  const store = { read: () => saved, write: (value) => { saved = value; } };
  const dialog = { showMessageBox: vi.fn(async () => ({ response: dialogResponse })) };
  let counter = 0;
  const apps = createInstalledApps({
    BrowserWindow: FakeWindow,
    dialog,
    nativeImage: {},
    icon: "app-icon",
    background: () => "#ffffff",
    store,
    makeId: () => `app-${++counter}`,
  });
  return { apps, dialog, store: { get value() { return saved; } } };
}

async function installed(setupResult) {
  await setupResult.apps.install({ url: "https://example.com/board", title: "Board" });
  setupResult.dialog.showMessageBox.mockClear();
  return setupResult;
}

describe("normalizePermissionLevel", () => {
  it("keeps the three levels and drops anything unknown to basic", () => {
    expect(normalizePermissionLevel("basic")).toBe("basic");
    expect(normalizePermissionLevel("intermediate")).toBe("intermediate");
    expect(normalizePermissionLevel("full")).toBe("full");
    expect(normalizePermissionLevel("admin")).toBe("basic");
    expect(normalizePermissionLevel(undefined)).toBe("basic");
    expect(normalizePermissionLevel(null)).toBe("basic");
  });
});

describe("permissionsForLevel and capabilitiesForLevel", () => {
  it("basic is browser-like, intermediate adds window placement, full adds no session permission", () => {
    expect(permissionsForLevel("basic")).toEqual(["fullscreen", "clipboard-sanitized-write", "notifications"]);
    expect(permissionsForLevel("intermediate")).toContain("window-placement");
    expect(permissionsForLevel("full")).toEqual(permissionsForLevel("intermediate"));
    expect(permissionsForLevel("admin")).toEqual(permissionsForLevel("basic"));
  });

  it("intermediate gains floating windows and menu-bar items, full alone gains computer access", () => {
    expect(capabilitiesForLevel("basic")).toEqual({ floatingWindows: false, menuBarItems: false, computerAccess: false });
    expect(capabilitiesForLevel("intermediate")).toEqual({ floatingWindows: true, menuBarItems: true, computerAccess: false });
    expect(capabilitiesForLevel("full")).toEqual({ floatingWindows: true, menuBarItems: true, computerAccess: true });
    expect(capabilitiesForLevel("admin")).toEqual(capabilitiesForLevel("basic"));
  });
});

describe("installedAppPermissionAllowed with a level", () => {
  it("allows window-placement only at intermediate and above, for the app's own origin", () => {
    expect(installedAppPermissionAllowed("window-placement", "https://example.com/", "https://example.com", "basic")).toBe(false);
    expect(installedAppPermissionAllowed("window-placement", "https://example.com/", "https://example.com", "intermediate")).toBe(true);
    expect(installedAppPermissionAllowed("window-placement", "https://example.com/", "https://example.com", "full")).toBe(true);
    expect(installedAppPermissionAllowed("window-placement", "https://other.com/", "https://example.com", "full")).toBe(false);
  });

  it("defaults to basic and never grants media, camera or geolocation at any level", () => {
    expect(installedAppPermissionAllowed("window-placement", "https://example.com/", "https://example.com")).toBe(false);
    for (const level of ["basic", "intermediate", "full"]) {
      for (const permission of ["media", "camera", "microphone", "geolocation", "usb"]) {
        expect(installedAppPermissionAllowed(permission, "https://example.com/", "https://example.com", level)).toBe(false);
      }
    }
  });
});

describe("validateInstallRequest with a permission level", () => {
  it("installs start at basic; asking for more up front is refused", () => {
    expect(validateInstallRequest({ url: "https://example.com/", title: "B", permissionLevel: "basic" }).ok).toBe(true);
    expect(validateInstallRequest({ url: "https://example.com/", title: "B", permissionLevel: "intermediate" }).ok).toBe(false);
    expect(validateInstallRequest({ url: "https://example.com/", title: "B", permissionLevel: "full" }).ok).toBe(false);
    expect(validateInstallRequest({ url: "https://example.com/", title: "B", permissionLevel: "admin" }).ok).toBe(false);
  });
});

describe("createInstalledApps permission levels", () => {
  it("records every install at basic", async () => {
    const { apps, store } = await installed(setup());
    expect(store.value[0]).toMatchObject({ permissionLevel: "basic" });
    expect(apps.list()[0].permissionLevel).toBe("basic");
  });

  it("reads records installed before levels existed as basic", async () => {
    const { apps } = setup({ stored: [{ id: "old-1", url: "https://example.com/old", origin: "https://example.com", title: "Old", installedAt: 1 }] });
    expect(apps.list()[0].permissionLevel).toBe("basic");
    expect(apps.open("old-1")).not.toBeNull();
    expect(FakeWindow.created[0].webContents.session.checkHandler(null, "window-placement", "https://example.com/")).toBe(false);
  });

  it("refuses an unknown level and an app that is not installed, without asking", async () => {
    const { apps, dialog } = await installed(setup());
    expect(await apps.setPermissionLevel("app-1", "admin")).toEqual({ changed: false, reason: "unknown level" });
    expect(await apps.setPermissionLevel("missing", "full")).toEqual({ changed: false, reason: "not installed" });
    expect(await apps.setPermissionLevel("app-1", "basic")).toEqual({ changed: false, level: "basic", reason: "unchanged" });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("asks first and changes nothing when the person declines a raise", async () => {
    const { apps, dialog, store } = await installed(setup());
    dialog.showMessageBox.mockResolvedValue({ response: 1 });
    const result = await apps.setPermissionLevel("app-1", "full");
    expect(result).toEqual({ changed: false, level: "basic", reason: "declined" });
    expect(store.value[0].permissionLevel).toBe("basic");
    const options = dialog.showMessageBox.mock.calls[0][0];
    expect(options.defaultId).toBe(1);
    expect(options.cancelId).toBe(1);
    expect(options.buttons).toEqual(["Allow", "Cancel"]);
    expect(options.message).toContain("full");
    expect(options.detail).toContain("run programs");
  });

  it("raises the level on allow, and the open window's checks follow at once", async () => {
    const { apps, store } = await installed(setup());
    const win = FakeWindow.created[0];
    expect(win.webContents.session.checkHandler(null, "window-placement", "https://example.com/")).toBe(false);
    expect(await apps.setPermissionLevel("app-1", "intermediate")).toEqual({ changed: true, level: "intermediate" });
    expect(store.value[0].permissionLevel).toBe("intermediate");
    expect(win.webContents.session.checkHandler(null, "window-placement", "https://example.com/")).toBe(true);
    expect(win.webContents.session.checkHandler(null, "media", "https://example.com/")).toBe(false);
    expect(await apps.setPermissionLevel("app-1", "basic")).toEqual({ changed: true, level: "basic" });
    expect(win.webContents.session.checkHandler(null, "window-placement", "https://example.com/")).toBe(false);
  });

  it("spells out full computer access in the prompt", async () => {
    const { apps, dialog } = await installed(setup());
    await apps.setPermissionLevel("app-1", "full");
    const options = dialog.showMessageBox.mock.calls[0][0];
    expect(options.detail).toContain("read, write and delete files");
  });
});

describe("createInstalledApps reconfirmPermissions", () => {
  it("refuses a missing app and a missing hash, without asking", async () => {
    const { apps, dialog } = await installed(setup());
    expect(await apps.reconfirmPermissions("missing", "hash-1")).toEqual({ confirmed: false, reason: "not installed" });
    expect(await apps.reconfirmPermissions("app-1", "")).toEqual({ confirmed: false, reason: "needs a content hash" });
    expect(await apps.reconfirmPermissions("app-1")).toEqual({ confirmed: false, reason: "needs a content hash" });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("records a first hash without asking and asks nothing while it is unchanged", async () => {
    const { apps, dialog, store } = await installed(setup());
    expect(await apps.reconfirmPermissions("app-1", "hash-1")).toEqual({ confirmed: true, level: "basic" });
    expect(store.value[0].contentHash).toBe("hash-1");
    expect(await apps.reconfirmPermissions("app-1", "hash-1")).toEqual({ confirmed: true, level: "basic" });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("never prompts a basic app when the artifact changes, only records the new hash", async () => {
    const { apps, dialog, store } = await installed(setup());
    await apps.reconfirmPermissions("app-1", "hash-1");
    expect(await apps.reconfirmPermissions("app-1", "hash-2")).toEqual({ confirmed: true, level: "basic" });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(store.value[0].contentHash).toBe("hash-2");
    expect(store.value[0].permissionLevel).toBe("basic");
  });

  it("keeps an elevated level when the person confirms the changed artifact", async () => {
    const { apps, dialog, store } = await installed(setup());
    await apps.setPermissionLevel("app-1", "intermediate");
    await apps.reconfirmPermissions("app-1", "hash-1");
    const callsBefore = dialog.showMessageBox.mock.calls.length;
    expect(await apps.reconfirmPermissions("app-1", "hash-2")).toEqual({ confirmed: true, level: "intermediate" });
    expect(dialog.showMessageBox.mock.calls.length).toBe(callsBefore + 1);
    const options = dialog.showMessageBox.mock.calls.at(-1)[0];
    expect(options.message).toContain("intermediate");
    expect(options.detail).toContain("changed");
    expect(store.value[0]).toMatchObject({ contentHash: "hash-2", permissionLevel: "intermediate" });
  });

  it("drops back to basic when the person declines, and the app keeps working", async () => {
    const { apps, dialog, store } = await installed(setup());
    await apps.setPermissionLevel("app-1", "intermediate");
    expect(await apps.reconfirmPermissions("app-1", "hash-1")).toEqual({ confirmed: true, level: "intermediate" });
    dialog.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await apps.reconfirmPermissions("app-1", "hash-2")).toEqual({ confirmed: false, level: "basic", reason: "declined" });
    expect(store.value[0]).toMatchObject({ contentHash: "hash-2", permissionLevel: "basic" });
    expect(FakeWindow.created).toHaveLength(1);
    expect(FakeWindow.created[0].isDestroyed()).toBe(false);
  });
});
