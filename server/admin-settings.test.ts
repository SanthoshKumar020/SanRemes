import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAdminSettingsStore, DEFAULT_ADMIN_SETTINGS } from "./admin-settings.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "sanremes-admin-settings-"));
  scratch.push(d);
  return d;
};

describe("admin settings store", () => {
  it("starts with both toggles off and saves each independently", () => {
    const store = createAdminSettingsStore(dir());
    expect(store.read()).toEqual(DEFAULT_ADMIN_SETTINGS);
    expect(store.save({ auditStrict: true })).toEqual({ version: 1, auditStrict: true, motionPaid: false });
    expect(store.save({ motionPaid: true })).toEqual({ version: 1, auditStrict: true, motionPaid: true });
    expect(store.read()).toEqual({ version: 1, auditStrict: true, motionPaid: true });
  });

  it("keeps the file private and falls back to defaults on a bad file", () => {
    const d = dir();
    const store = createAdminSettingsStore(d);
    store.save({ motionPaid: true });
    expect(statSync(join(d, "admin-settings.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(d, "admin-settings.json"), "utf8"))).toEqual({ version: 1, auditStrict: false, motionPaid: true });
    writeFileSync(join(d, "admin-settings.json"), "not json");
    expect(store.read()).toEqual(DEFAULT_ADMIN_SETTINGS);
  });
});
