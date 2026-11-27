import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { IncognitoThreads, withoutIncognitoThreads } from "./incognito-threads.ts";

describe("IncognitoThreads", () => {
  it("marks, reports and clears a thread, and keeps the mark across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanremes-incognito-"));
    const first = new IncognitoThreads(dir);
    expect(first.has("thread-1")).toBe(false);
    first.mark("thread-1", "bot-1");
    expect(first.has("thread-1")).toBe(true);
    expect(first.ids()).toEqual(["thread-1"]);
    expect(first.idsForBot("bot-1")).toEqual(["thread-1"]);
    expect(first.idsForBot("bot-2")).toEqual([]);
    const second = new IncognitoThreads(dir);
    expect(second.has("thread-1")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "incognito-threads.json"), "utf8"))).toHaveLength(1);
    second.clear("thread-1");
    expect(new IncognitoThreads(dir).has("thread-1")).toBe(false);
  });

  it("filters incognito threads out of a list", () => {
    const dir = mkdtempSync(join(tmpdir(), "sanremes-incognito-"));
    const registry = new IncognitoThreads(dir);
    registry.mark("thread-2");
    const kept = withoutIncognitoThreads([{ threadId: "thread-1" }, { threadId: "thread-2" }], registry);
    expect(kept).toEqual([{ threadId: "thread-1" }]);
  });
});
