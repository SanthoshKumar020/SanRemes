import { describe, expect, it } from "vitest";

import type { MemoryJournalEntry } from "../memory-journal.ts";
import type { UsageRow } from "../usage-ledger.ts";
import { buildRecap, formatRecap, recapCron, recapRange } from "./recaps.ts";

const usageRow = (overrides: Partial<UsageRow> = {}): UsageRow => ({
  at: "2026-11-25T10:00:00Z",
  botId: "scout",
  botName: "Scout",
  threadId: "t1",
  instanceId: "i1",
  driverKind: "groq",
  model: "gpt-oss-120b",
  input: 100,
  output: 50,
  costUsd: 0.02,
  trigger: { kind: "user", label: "Santhoshkumar" },
  ...overrides,
});

const journalEntry = (overrides: Partial<MemoryJournalEntry> = {}): MemoryJournalEntry => ({
  id: "e1",
  at: Date.parse("2026-11-25T10:00:00Z"),
  botId: "scout",
  path: "MEMORY.md",
  actor: "bot",
  via: "turn",
  threadId: "t1",
  kind: "edited",
  beforeHash: null,
  afterHash: null,
  before: null,
  diff: "",
  added: 10,
  removed: 2,
  canRevert: true,
  ...overrides,
});

const from = new Date("2026-11-20T00:00:00Z");
const to = new Date("2026-11-27T00:00:00Z");

describe("buildRecap", () => {
  it("totals come exactly from the ledger rows", () => {
    const recap = buildRecap({
      period: "weekly",
      from,
      to,
      usageRows: [
        usageRow(),
        usageRow({ botId: "helper", botName: "Helper", input: 200, output: 100, costUsd: 0.05, cachedInput: 40 }),
        usageRow({ at: "2026-11-01T10:00:00Z", input: 9999, output: 9999, costUsd: 9 }),
        usageRow({ costUsd: null }),
      ],
      journalEntries: [],
    });
    expect(recap.turns).toBe(3);
    expect(recap.inputTokens).toBe(400);
    expect(recap.outputTokens).toBe(200);
    expect(recap.cachedInputTokens).toBe(40);
    expect(recap.costUsd).toBeCloseTo(0.07);
    expect(recap.unpricedTurns).toBe(1);
    expect(recap.topBots).toEqual([
      { botId: "helper", botName: "Helper", turns: 1, inputTokens: 200, outputTokens: 100, costUsd: 0.05 },
      { botId: "scout", botName: "Scout", turns: 2, inputTokens: 200, outputTokens: 100, costUsd: 0.02 },
    ]);
    expect(recap.topModels[0]).toMatchObject({ model: "gpt-oss-120b", turns: 3 });
  });

  it("counts memory changes from the journal and ranks the largest first", () => {
    const recap = buildRecap({
      period: "monthly",
      from,
      to,
      usageRows: [],
      journalEntries: [
        journalEntry({ id: "small", kind: "created", added: 1, removed: 0, path: "notes.md" }),
        journalEntry({ id: "big", kind: "deleted", added: 0, removed: 40, path: "old.md", botId: "helper" }),
        journalEntry({ id: "out", at: Date.parse("2026-11-01T10:00:00Z"), kind: "edited" }),
      ],
    });
    expect(recap.memoryChanges).toBe(2);
    expect(recap.memoryCreated).toBe(1);
    expect(recap.memoryEdited).toBe(0);
    expect(recap.memoryDeleted).toBe(1);
    expect(recap.memoryByBot).toEqual([
      { botId: "scout", changes: 1 },
      { botId: "helper", changes: 1 },
    ]);
    expect(recap.notableMemory[0]).toMatchObject({ path: "old.md", kind: "deleted", added: 0, removed: 40 });
    expect(recap.notableMemory[1]).toMatchObject({ path: "notes.md", kind: "created" });
  });

  it("leaves excluded threads out of both the usage totals and the memory counts", () => {
    const recap = buildRecap({
      period: "weekly",
      from,
      to,
      usageRows: [usageRow(), usageRow({ threadId: "hidden", input: 500, output: 500, costUsd: 1 })],
      journalEntries: [
        journalEntry(),
        journalEntry({ id: "hidden-entry", threadId: "hidden", added: 99, removed: 99 }),
      ],
      excludedThreadIds: new Set(["hidden"]),
    });
    expect(recap.turns).toBe(1);
    expect(recap.inputTokens).toBe(100);
    expect(recap.memoryChanges).toBe(1);
    expect(recap.notableMemory).toHaveLength(1);
  });

  it("formats the recap as a readable document carrying the same figures", () => {
    const recap = buildRecap({
      period: "weekly",
      from,
      to,
      usageRows: [usageRow()],
      journalEntries: [journalEntry()],
      now: new Date("2026-11-27T12:00:00Z"),
    });
    const text = formatRecap(recap);
    expect(text).toContain("Weekly recap — Week of 2026-11-20 to 2026-11-27");
    expect(text).toContain("Turns: 1");
    expect(text).toContain("Input tokens: 100");
    expect(text).toContain("Cost: $0.02");
    expect(text).toContain("- Scout: 1 turns, 150 tokens, $0.02");
    expect(text).toContain("Changes: 1 (0 created, 1 edited, 0 deleted)");
    expect(text).toContain("- MEMORY.md (edited, +10/-2 lines, 2026-11-25)");
  });

  it("reports an empty period without inventing figures", () => {
    const recap = buildRecap({ period: "weekly", from, to, usageRows: [], journalEntries: [] });
    expect(recap.turns).toBe(0);
    expect(recap.costUsd).toBeNull();
    expect(formatRecap(recap)).toContain("No turns in this period.");
  });
});

describe("recapRange / recapCron", () => {
  it("covers the 7 days ending now for a week and the calendar month for a month", () => {
    const now = new Date("2026-11-27T12:00:00Z");
    expect(recapRange("weekly", now)).toEqual({
      from: new Date("2026-11-20T12:00:00Z"),
      to: now,
      label: "Week of 2026-11-20 to 2026-11-27",
    });
    expect(recapRange("monthly", now).from).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(recapRange("monthly", now).label).toBe("November 2026");
  });

  it("schedules weekly on Monday morning and monthly on the 1st", () => {
    expect(recapCron("weekly")).toBe("0 9 * * 1");
    expect(recapCron("monthly")).toBe("0 9 1 * *");
  });
});
