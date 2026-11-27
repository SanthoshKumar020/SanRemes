// Installed apps (row 10): a show_html page wrapped as a standalone Electron
// window with its own icon. Installing needs the person's explicit allow in a
// prompt that defaults to Cancel; the window runs the artifact page only —
// same origin, no navigation away, no new windows, and only the permissions
// the page's own origin may use. Follows the desktop viewer (main.mjs) and
// the lending activity window's factory shape: every Electron object is
// injected, so the permission and state logic is testable without Electron.
import { randomUUID } from "node:crypto";

const INSTALLED_APP_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write", "notifications"]);

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

/** Whether `permission` from `requestingOrigin` is allowed inside an installed app whose page lives at `appOrigin`. */
export function installedAppPermissionAllowed(permission, requestingOrigin, appOrigin) {
  if (!INSTALLED_APP_PERMISSIONS.has(permission)) return false;
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
    return stored.filter((record) => record && typeof record === "object" && typeof record.id === "string" && typeof record.url === "string");
  }

  function writeRecords(records) {
    store.write(records);
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
      installedAppPermissionAllowed(permission, requestingOrigin, record.origin));
    win.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(installedAppPermissionAllowed(permission, details?.requestingUrl || contents.getURL(), record.origin)));
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
      const record = { ...validated.value, id: makeId(), installedAt: Date.now() };
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
