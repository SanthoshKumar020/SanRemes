import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decideExecutor, HandoffStore } from "./cloud-handoff.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sanremes-handoff-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("decideExecutor", () => {
  it("always honours local", () => {
    expect(decideExecutor("local", true)).toEqual({ executor: "local", note: null });
    expect(decideExecutor("local", false)).toEqual({ executor: "local", note: null });
  });

  it("defaults to local until a cloud executor is attached", () => {
    expect(decideExecutor("auto", false)).toEqual({ executor: "local", note: null });
    expect(decideExecutor("auto", true)).toEqual({ executor: "cloud", note: null });
  });

  it("falls back to local with a plain-words note when cloud is asked for but not attached", () => {
    const decided = decideExecutor("cloud", false);
    expect(decided.executor).toBe("local");
    expect(decided.note).toContain("No cloud executor is attached");
    expect(decideExecutor("cloud", true)).toEqual({ executor: "cloud", note: null });
  });
});

describe("HandoffStore", () => {
  it("defaults to auto and persists a changed preference", () => {
    const store = new HandoffStore({ dataDir: dir });
    expect(store.preference()).toBe("auto");
    expect(store.decide(false)).toEqual({ executor: "local", note: null });
    store.setPreference("cloud");
    expect(new HandoffStore({ dataDir: dir }).preference()).toBe("cloud");
    expect(store.decide(false).executor).toBe("local");
    expect(store.decide(false).note).toContain("No cloud executor is attached");
  });

  it("treats an unreadable file as auto rather than failing", () => {
    writeFileSync(join(dir, "cloud-handoff.json"), "not json");
    expect(new HandoffStore({ dataDir: dir }).preference()).toBe("auto");
  });
});
