import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ComputerUsePermissions, siteOrigin } from "./permissions.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("the per-site permission store", () => {
  it("derives an origin from an address and rejects anything else", () => {
    expect(siteOrigin("https://example.com:443/a?b=c")).toBe("https://example.com");
    expect(siteOrigin("http://example.com:8080/a")).toBe("http://example.com:8080");
    expect(siteOrigin("chrome://settings")).toBeNull();
    expect(siteOrigin("not a url")).toBeNull();
  });

  it("starts unasked, then remembers a grant or a denial per origin", () => {
    const store = new ComputerUsePermissions();
    expect(store.status("https://example.com/page")).toBe("prompt");
    store.grant("https://example.com/page", { now: 1_000 });
    expect(store.status("https://example.com/other")).toBe("granted");
    expect(store.status("https://other.example/")).toBe("prompt");
    store.deny("https://other.example/", { now: 2_000 });
    expect(store.status("https://other.example/x")).toBe("denied");
    expect(store.grants()).toEqual([
      { origin: "https://example.com", state: "granted", grantedAt: 1_000 },
      { origin: "https://other.example", state: "denied", grantedAt: 2_000 },
    ]);
  });

  it("returns null for a grant on an unusable address", () => {
    expect(new ComputerUsePermissions().grant("chrome://settings")).toBeNull();
  });

  it("revokes a grant and forgets everything on clear", () => {
    const store = new ComputerUsePermissions();
    store.grant("https://example.com/");
    expect(store.revoke("https://example.com/x")).toBe(true);
    expect(store.revoke("https://example.com/x")).toBe(false);
    expect(store.status("https://example.com/")).toBe("prompt");
    store.grant("https://example.com/");
    store.clear();
    expect(store.grants()).toEqual([]);
  });

  it("lets a grant expire, then reads it as never asked", () => {
    const store = new ComputerUsePermissions();
    store.grant("https://example.com/", { ttlMs: 1_000, now: 1_000 });
    expect(store.status("https://example.com/", 1_999)).toBe("granted");
    expect(store.status("https://example.com/", 2_000)).toBe("prompt");
    expect(store.grants(2_000)).toEqual([]);
  });

  it("round-trips through JSON and drops malformed entries", () => {
    const restored = ComputerUsePermissions.fromJSON([
      { origin: "https://example.com", state: "granted", grantedAt: 5 },
      { origin: "https://bad.example", state: "maybe", grantedAt: 5 },
      { origin: "chrome://settings", state: "granted", grantedAt: 5 },
      "nope",
    ]);
    expect(restored.grants()).toEqual([{ origin: "https://example.com", state: "granted", grantedAt: 5 }]);
    expect(ComputerUsePermissions.fromJSON(new ComputerUsePermissions().toJSON()).grants()).toEqual([]);
  });

  it("saves to a file only the owner can read and loads it back; a missing file is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanremes-computer-use-"));
    folders.push(dir);
    const file = join(dir, "nested", "permissions.json");
    const store = new ComputerUsePermissions();
    store.grant("https://example.com/", { app: "Docs", now: 7 });
    store.save(file);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([{ origin: "https://example.com", state: "granted", app: "Docs", grantedAt: 7 }]);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(ComputerUsePermissions.load(file).status("https://example.com/")).toBe("granted");
    expect(ComputerUsePermissions.load(join(dir, "absent.json")).grants()).toEqual([]);
  });

  it("refuses a corrupt permissions file outright", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanremes-computer-use-"));
    folders.push(dir);
    const file = join(dir, "permissions.json");
    writeFileSync(file, "{not json");
    expect(() => ComputerUsePermissions.load(file)).toThrow(/not valid JSON/);
  });
});
