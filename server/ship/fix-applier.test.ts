import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ParallelSessionStore } from "../parallel-sessions.ts";
import { applyFixes } from "./fix-applier.ts";

let dir: string;
let worktree: string;
let store: ParallelSessionStore;
let sessionId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sanremes-ship-fix-"));
  worktree = join(dir, "worktree");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "src.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
  store = new ParallelSessionStore({ dataDir: dir });
  sessionId = store.insert({
    id: "session-1", repoDir: dir, worktreeDir: worktree, baseBranch: "main", branch: "sanremes/task-1",
    taskId: "task-1", botId: "bot-1", state: "active", prUrl: null, conflictFiles: [], createdAt: 1, updatedAt: 1,
  }).id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("applyFixes", () => {
  it("replaces exact text in the worktree", () => {
    const applied = applyFixes(store, sessionId, [{ path: "src.ts", find: "const a = 1;", replace: "const a = 10;" }]);
    expect(applied).toEqual([{ path: "src.ts" }]);
    expect(readFileSync(join(worktree, "src.ts"), "utf8")).toBe("const a = 10;\nconst b = 2;\n");
  });

  it("refuses text that is not found, and writes nothing", () => {
    expect(() => applyFixes(store, sessionId, [{ path: "src.ts", find: "const z = 9;", replace: "x" }])).toThrow("not found in src.ts");
    expect(readFileSync(join(worktree, "src.ts"), "utf8")).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("refuses text that matches more than once", () => {
    expect(() => applyFixes(store, sessionId, [{ path: "src.ts", find: "const ", replace: "let " }])).toThrow("appears 2 times");
  });

  it("refuses a path that escapes the worktree", () => {
    expect(() => applyFixes(store, sessionId, [{ path: "../outside.ts", find: "x", replace: "y" }])).toThrow("stay inside the worktree");
    expect(() => applyFixes(store, sessionId, [{ path: "/etc/passwd", find: "x", replace: "y" }])).toThrow("stay inside the worktree");
  });

  it("refuses a missing file and an unknown session", () => {
    expect(() => applyFixes(store, sessionId, [{ path: "nope.ts", find: "x", replace: "y" }])).toThrow("does not exist");
    expect(() => applyFixes(store, "missing", [{ path: "src.ts", find: "x", replace: "y" }])).toThrow("No such session");
  });

  it("refuses a session with conflicts, and never resolves them", () => {
    store.update(sessionId, { state: "conflict", conflictFiles: ["src.ts"] });
    expect(() => applyFixes(store, sessionId, [{ path: "src.ts", find: "const a = 1;", replace: "x" }]))
      .toThrow("Resolve the conflicts in sanremes/task-1 first");
    expect(readFileSync(join(worktree, "src.ts"), "utf8")).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("checks every edit before writing any of them", () => {
    expect(() => applyFixes(store, sessionId, [
      { path: "src.ts", find: "const a = 1;", replace: "const a = 10;" },
      { path: "src.ts", find: "missing", replace: "x" },
    ])).toThrow("not found");
    expect(readFileSync(join(worktree, "src.ts"), "utf8")).toBe("const a = 1;\nconst b = 2;\n");
  });
});
