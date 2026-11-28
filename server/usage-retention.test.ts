import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appendUsage, pruneUsage, resolveUsageRetentionDays } from "./usage-ledger.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "sanremes-usage-retention-"));
  scratch.push(d);
  return d;
};

describe("usage retention", () => {
  it("is off unless the owner sets it, and the environment wins over config", () => {
    expect(resolveUsageRetentionDays(undefined, {})).toEqual({ days: null, source: "default" });
    expect(resolveUsageRetentionDays(365, {})).toEqual({ days: 365, source: "config" });
    expect(resolveUsageRetentionDays(365, { SANREMES_USAGE_RETENTION_DAYS: "90" })).toEqual({ days: 90, source: "env" });
    expect(resolveUsageRetentionDays(365, { SANREMES_USAGE_RETENTION_DAYS: "0" })).toEqual({ days: 365, source: "config" });
    expect(resolveUsageRetentionDays(99999, {})).toEqual({ days: null, source: "default" });
  });

  it("drops whole months past the window and keeps the current month", async () => {
    const d = dir();
    const usageDir = join(d, "usage");
    mkdirSync(usageDir, { recursive: true });
    for (const name of ["2025-01.jsonl", "2025-06.jsonl", "2026-11.jsonl"]) {
      writeFileSync(join(usageDir, name), "{\"at\":\"2025-01-01T00:00:00.000Z\",\"botId\":\"b\",\"botName\":\"B\",\"threadId\":\"t\",\"instanceId\":\"i\",\"driverKind\":\"d\",\"model\":\"m\",\"input\":1,\"output\":1,\"costUsd\":null,\"trigger\":{\"kind\":\"owner\"}}\n");
    }
    writeFileSync(join(usageDir, "notes.txt"), "not a month file");
    const removed = await pruneUsage(d, 180, new Date("2026-11-28T00:00:00.000Z"));
    expect(removed).toEqual(["2025-01.jsonl", "2025-06.jsonl"]);
    expect(await pruneUsage(d, 180, new Date("2026-11-28T00:00:00.000Z"))).toEqual([]);
    expect(await pruneUsage(join(d, "missing"), 180)).toEqual([]);
  });

  it("prunes through the append path's cache without serving stale rows", async () => {
    const d = dir();
    const row = {
      botId: "b", botName: "B", threadId: "t", instanceId: "i", driverKind: "d", model: "m",
      input: 1, output: 1, costUsd: null, trigger: { kind: "owner" as const }, at: "2025-01-15T00:00:00.000Z",
    };
    expect(await appendUsage(d, row)).toBe(true);
    expect(await pruneUsage(d, 30, new Date("2026-11-28T00:00:00.000Z"))).toEqual(["2025-01.jsonl"]);
  });
});
