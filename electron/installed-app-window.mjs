// Installed apps (row 10): a show_html page wrapped as a standalone Electron
// window with its own icon. Installing needs the person's explicit allow in a
// prompt that defaults to Cancel; the window runs the artifact page only —
// same origin, no navigation away, no new windows, and only the permissions
// the page's own origin may use. Follows the desktop viewer (main.mjs) and
// the lending activity window's factory shape: every Electron object is
// injected, so the permission and state logic is testable without Electron.
import { randomUUID } from "node:crypto";

/** A web origin (scheme and host, port included), or null for anything else. Opaque origins serialise as "null". */
function webOrigin(value) {
  if (Object.prototype.toString.call(value) !== "[object String]") return null;
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** Graduated permission levels, least to most. Full computer access is a level record here; the programs-and-files
 * operations it gates live behind main-process handlers, never in the page's own session. */
export const PERMISSION_LEVELS = Object.freeze(["basic", "intermediate", "full"]);

/** The Electron session permissions each level allows, for the app's own origin only. Full adds no session
 * permission: running programs and touching files is not something a web permission grants. */
const PERMISSIONS_BY_LEVEL = Object.freeze({
  basic: Object.freeze(["fullscreen", "clipboard-sanitized-write", "notifications"]),
  intermediate: Object.freeze(["fullscreen", "clipboard-sanitized-write", "notifications", "window-placement"]),
  full: Object.freeze(["fullscreen", "clipboard-sanitized-write", "notifications", "window-placement"]),
});

/** What each level may do outside the page's session. Menu-bar items and floating windows are main-process
 * capabilities, not session permissions, so they are flags the main process checks, not grants to the page. */
const CAPABILITIES_BY_LEVEL = Object.freeze({
  basic: Object.freeze({ floatingWindows: false, menuBarItems: false, computerAccess: false }),
  intermediate: Object.freeze({ floatingWindows: true, menuBarItems: true, computerAccess: false }),
  full: Object.freeze({ floatingWindows: true, menuBarItems: true, computerAccess: true }),
});

/** A stored or requested level, or "basic" for anything unknown: an unrecognised level never grants more. */
export function normalizePermissionLevel(value) {
  return PERMISSION_LEVELS.includes(value) ? value : "basic";
}

/** The session permissions a level allows. */
export function permissionsForLevel(level) {
  return [...PERMISSIONS_BY_LEVEL[normalizePermissionLevel(level)]];
}

/** The out-of-session capabilities a level allows. */
export function capabilitiesForLevel(level) {
  return { ...CAPABILITIES_BY_LEVEL[normalizePermissionLevel(level)] };
}

/** Whether `permission` from `requestingOrigin` is allowed inside an installed app whose page lives at `appOrigin`.
 * `level` defaults to basic; a level the page never asked for grants nothing extra. */
export function installedAppPermissionAllowed(permission, requestingOrigin, appOrigin, level = "basic") {
  if (!PERMISSIONS_BY_LEVEL[normalizePermissionLevel(level)].includes(permission)) return false;
  const requesting = webOrigin(requestingOrigin);
  return requesting !== null && requesting === webOrigin(appOrigin);
}

/** Whether the window may navigate to `url`: the artifact's own origin only. */
export function installedAppNavigationAllowed(url, appOrigin) {
  const target = webOrigin(url);
  return target !== null && target === webOrigin(appOrigin);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ICON_DATA_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const ICON_PATH = /\.(png|jpe?g|ico)$/i;

/**
 * An install request from the renderer: the artifact page's link, its title, and optionally its own icon as a data:
 * URL or a file path. A URL with credentials is never an artifact link.
 * @returns {{ ok: true, value: { url: string, origin: string, title: string, iconDataUrl?: string, iconPath?: string } } | { ok: false, error: string }}
 */
export function validateInstallRequest(request) {
  if (!request || typeof request !== "object") return { ok: false, error: "Install needs a page link and a title." };
  if (typeof request.url !== "string") return { ok: false, error: "Install needs a page link." };
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return { ok: false, error: "That page link is not a web address." };
  }
  const loopback = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !loopback) return { ok: false, error: "Install needs a secure (https) page link, or a page on this computer." };
  if (url.username || url.password) return { ok: false, error: "Install needs a page link without a username or password in it." };
  if (typeof request.title !== "string" || !request.title.trim() || request.title.length > 80) {
    return { ok: false, error: "Install needs a title of 1 to 80 characters." };
  }
  const value = { url: url.href, origin: url.origin, title: request.title.trim() };
  if (request.permissionLevel !== undefined && request.permissionLevel !== "basic") {
    return { ok: false, error: "Install starts at basic permissions; ask to raise them after installing." };
  }
  if (request.iconDataUrl !== undefined) {
    if (typeof request.iconDataUrl !== "string" || !ICON_DATA_URL.test(request.iconDataUrl)) {
      return { ok: false, error: "The icon must be a PNG or JPEG data: URL." };
    }
    value.iconDataUrl = request.iconDataUrl;
  }
  if (request.iconPath !== undefined) {
    if (typeof request.iconPath !== "string" || !request.iconPath.startsWith("/") && !/^[A-Za-z]:\\/.test(request.iconPath) || !ICON_PATH.test(request.iconPath)) {
      return { ok: false, error: "The icon must be a .png, .jpg or .ico file." };
    }
    value.iconPath = request.iconPath;
  }
  return { ok: true, value };
}

const DEFAULT_WORDS = Object.freeze({
  installMessage: (title) => `Install "${title}" as an app?`,
  installDetail: "It opens in its own window and runs only that page. You can remove it at any time.",
  installButton: "Install",
  cancelButton: "Cancel",
  allowButton: "Allow",
  levelMessage: (title, level) => `Allow "${title}" ${level} permissions?`,
  levelDetail: (level) => ({
    basic: "Browser-like: full screen, clipboard and notifications for this page only.",
    intermediate: "Adds floating windows and menu-bar items for this app.",
    full: "Full computer access: this app may run programs and read, write and delete files on this computer. Allow only an app you trust.",
  })[level] ?? "Browser-like: full screen, clipboard and notifications for this page only.",
  levelReconfirmDetail: (title, level) => `The page behind "${title}" changed. Keep its ${level} permissions, or drop back to basic?`,
});

/** The icon for a record: its own, else the app's. A data: URL or file the platform cannot read falls back too. */
export function iconFor(record, { nativeImage, fallback }) {
  try {
    if (record.iconDataUrl && nativeImage?.createFromDataURL) {
      const image = nativeImage.createFromDataURL(record.iconDataUrl);
      if (image && !image.isEmpty?.()) return image;
    }
    if (record.iconPath && nativeImage?.createFromPath) {
      const image = nativeImage.createFromPath(record.iconPath);
      if (image && !image.isEmpty?.()) return image;
    }
  } catch {
    // A bad icon never blocks the window.
  }
  return fallback;
}

/**
 * @param {{ BrowserWindow: unknown, dialog: { showMessageBox: (...args: unknown[]) => Promise<{ response: number }> },
 *   nativeImage?: unknown, icon: unknown, background: () => string, store: { read: () => unknown, write: (value: unknown) => void },
 *   makeId?: () => string, words?: Partial<typeof DEFAULT_WORDS> }} deps
 */
export function createInstalledApps({ BrowserWindow, dialog, nativeImage, icon, background, store, makeId = randomUUID, words = {} }) {
  const text = { ...DEFAULT_WORDS, ...words };
  const windows = new Map();

  function readRecords() {
    const stored = store.read();
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((record) => record && typeof record === "object" && typeof record.id === "string" && typeof record.url === "string")
      .map((record) => ({
        ...record,
        permissionLevel: normalizePermissionLevel(record.permissionLevel),
        ...(typeof record.contentHash === "string" ? { contentHash: record.contentHash } : {}),
      }));
  }

  function writeRecords(records) {
    store.write(records);
  }

  /** An installed app's current level, read fresh so a change applies to a window that is already open. */
  function levelOf(id) {
    return normalizePermissionLevel(readRecords().find((record) => record.id === id)?.permissionLevel);
  }

  /** Ask the person to allow `level` for `record`; Cancel is the default, and a decline changes nothing. */
  async function askLevel(record, level, parent, detail) {
    const options = {
      type: "question",
      buttons: [text.allowButton, text.cancelButton],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: text.levelMessage(record.title, level),
      detail,
    };
    const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return answer.response === 0;
  }

  function createWindow(record) {
    const win = new BrowserWindow({
      width: 1120,
      height: 800,
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: record.title,
      icon: iconFor(record, { nativeImage, fallback: icon }),
      backgroundColor: background(),
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        partition: `sanremes-installed-${record.id}`,
      },
    });
    win.webContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
      installedAppPermissionAllowed(permission, requestingOrigin, record.origin, levelOf(record.id)));
    win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(installedAppPermissionAllowed(permission, details?.requestingUrl || contents.getURL(), record.origin, levelOf(record.id))));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (!installedAppNavigationAllowed(url, record.origin)) event.preventDefault();
    });
    win.webContents.on("page-title-updated", (event) => {
      event.preventDefault();
      win.setTitle(record.title);
    });
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        win.webContents.focus();
      }
    });
    win.on("closed", () => {
      if (windows.get(record.id) === win) windows.delete(record.id);
    });
    windows.set(record.id, win);
    void win.loadURL(record.url).catch(() => {});
    return win;
  }

  return {
    /** The installed apps, newest first. */
    list() {
      return readRecords().map((record) => ({ ...record }));
    },

    /** Ask the person; on their explicit allow, record the install and open its window. */
    async install(request, parent) {
      const validated = validateInstallRequest(request);
      if (!validated.ok) return { installed: false, reason: validated.error };
      const records = readRecords();
      const existing = records.find((record) => record.url === validated.value.url);
      if (existing) {
        const win = windows.get(existing.id);
        if (win && !win.isDestroyed()) {
          win.show();
          win.focus();
        } else {
          createWindow(existing);
        }
        return { installed: true, id: existing.id, existing: true };
      }
      const options = {
        type: "question",
        buttons: [text.installButton, text.cancelButton],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: text.installMessage(validated.value.title),
        detail: text.installDetail,
      };
      const answer = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (answer.response !== 0) return { installed: false, reason: "declined" };
      const record = { ...validated.value, id: makeId(), installedAt: Date.now(), permissionLevel: "basic" };
      writeRecords([...records, record]);
      createWindow(record);
      return { installed: true, id: record.id };
    },

    /** Open an installed app's window, or null when it is not installed. */
    open(id) {
      const record = readRecords().find((entry) => entry.id === id);
      if (!record) return null;
      const win = windows.get(id);
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
        return win;
      }
      return createWindow(record);
    },

    /** Raise or lower an installed app's permission level, only after the person's explicit allow in a prompt
     * that defaults to Cancel. A decline is not a failure: the level stays where it was. */
    async setPermissionLevel(id, level, parent) {
      if (!PERMISSION_LEVELS.includes(level)) return { changed: false, reason: "unknown level" };
      const records = readRecords();
      const record = records.find((entry) => entry.id === id);
      if (!record) return { changed: false, reason: "not installed" };
      if (record.permissionLevel === level) return { changed: false, level, reason: "unchanged" };
      const allowed = await askLevel(record, level, parent, text.levelDetail(level));
      if (!allowed) return { changed: false, level: record.permissionLevel, reason: "declined" };
      writeRecords(records.map((entry) => (entry.id === id ? { ...entry, permissionLevel: level } : entry)));
      return { changed: true, level };
    },

    /** Re-confirm an installed app's permissions when the artifact behind it changed. The caller passes the
     * artifact's current content hash; a first sighting records it without asking, an unchanged hash asks
     * nothing, and a changed hash prompts to keep the level. A decline drops the app back to basic — the app
     * keeps working, with browser-like permissions only. Basic apps are never prompted: there is nothing
     * elevated to re-confirm. */
    async reconfirmPermissions(id, contentHash, parent) {
      if (typeof contentHash !== "string" || !contentHash) return { confirmed: false, reason: "needs a content hash" };
      const records = readRecords();
      const record = records.find((entry) => entry.id === id);
      if (!record) return { confirmed: false, reason: "not installed" };
      if (record.contentHash === undefined) {
        writeRecords(records.map((entry) => (entry.id === id ? { ...entry, contentHash } : entry)));
        return { confirmed: true, level: record.permissionLevel };
      }
      if (record.contentHash === contentHash || record.permissionLevel === "basic") {
        writeRecords(records.map((entry) => (entry.id === id ? { ...entry, contentHash } : entry)));
        return { confirmed: true, level: record.permissionLevel };
      }
      const kept = await askLevel(record, record.permissionLevel, parent, text.levelReconfirmDetail(record.title, record.permissionLevel));
      const level = kept ? record.permissionLevel : "basic";
      writeRecords(records.map((entry) => (entry.id === id ? { ...entry, contentHash, permissionLevel: level } : entry)));
      return kept ? { confirmed: true, level } : { confirmed: false, level, reason: "declined" };
    },

    /** Close an installed app's window and forget the install. */
    uninstall(id) {
      const win = windows.get(id);
      if (win && !win.isDestroyed()) win.close();
      windows.delete(id);
      const records = readRecords();
      if (!records.some((record) => record.id === id)) return false;
      writeRecords(records.filter((record) => record.id !== id));
      return true;
    },

    closeAll() {
      for (const win of windows.values()) if (!win.isDestroyed()) win.close();
      windows.clear();
    },
  };
}
