import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MEMORY_JOURNAL_RETENTION_DAYS,
  JOURNAL_DIR,
  journalFile,
  listJournalBotIds,
  memoryJournalRetentionDays,
  pruneAllMemoryJournals,
  pruneMemoryJournal,
  resolveMemoryJournalRetention,
  type MemoryJournalEntry,
} from "./memory-journal.ts";

let counter = 0;
const bot = () => `retention-bot-${process.pid}-${counter++}`;
const files: string[] = [];

const entry = (overrides: Partial<MemoryJournalEntry> = {}): MemoryJournalEntry => ({
  id: `entry-${Math.random()}`,
  at: Date.now(),
  botId: "retention-bot",
  path: "MEMORY.md",
  actor: "bot",
  via: "turn",
  kind: "edited",
  beforeHash: null,
  afterHash: null,
  before: null,
  diff: "",
  added: 1,
  removed: 0,
  canRevert: true,
  ...overrides,
});

const writeJournal = (botId: string, entries: MemoryJournalEntry[]): void => {
  mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(journalFile(botId), entries.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  files.push(journalFile(botId));
};

afterEach(() => {
  for (const file of files.splice(0)) rmSync(file, { force: true });
});

describe("resolveMemoryJournalRetention", () => {
  it("takes the environment over config, then config over the 180-day default", () => {
    expect(resolveMemoryJournalRetention(90, {})).toEqual({ days: 90, source: "config" });
    expect(resolveMemoryJournalRetention(90, { SANREMES_MEMORY_JOURNAL_RETENTION_DAYS: "30" })).toEqual({ days: 30, source: "env" });
    expect(resolveMemoryJournalRetention(undefined, {})).toEqual({ days: DEFAULT_MEMORY_JOURNAL_RETENTION_DAYS, source: "default" });
    expect(memoryJournalRetentionDays(7, {})).toBe(7);
  });

  it("ignores invalid values", () => {
    expect(resolveMemoryJournalRetention(0, {})).toEqual({ days: DEFAULT_MEMORY_JOURNAL_RETENTION_DAYS, source: "default" });
    expect(resolveMemoryJournalRetention(90, { SANREMES_MEMORY_JOURNAL_RETENTION_DAYS: "4000" })).toEqual({ days: 90, source: "config" });
  });
});

describe("pruneMemoryJournal", () => {
  it("drops entries older than the window and keeps the rest byte-for-byte", () => {
    const botId = bot();
    const now = new Date("2026-11-27T12:00:00Z");
    const oldAt = now.getTime() - 10 * 24 * 60 * 60_000;
    const newAt = now.getTime() - 2 * 24 * 60 * 60_000;
    const oldEntry = entry({ id: "old", at: oldAt, botId });
    const newEntry = entry({ id: "new", at: newAt, botId });
    writeJournal(botId, [oldEntry, newEntry]);
    expect(pruneMemoryJournal(botId, 7, now)).toBe(1);
    expect(readFileSync(journalFile(botId), "utf8")).toBe(`${JSON.stringify(newEntry)}\n`);
  });

  it("changing the day count changes what is pruned", () => {
    const botId = bot();
    const now = new Date("2026-11-27T12:00:00Z");
    const at = now.getTime() - 10 * 24 * 60 * 60_000;
    writeJournal(botId, [entry({ id: "old", at, botId })]);
    expect(pruneMemoryJournal(botId, 30, now)).toBe(0);
    expect(pruneMemoryJournal(botId, 7, now)).toBe(1);
    expect(readFileSync(journalFile(botId), "utf8")).toBe("");
  });

  it("returns 0 for a missing journal and keeps unparseable lines", () => {
    expect(pruneMemoryJournal(bot(), 7)).toBe(0);
    const botId = bot();
    mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(journalFile(botId), "not json\n", { mode: 0o600 });
    files.push(journalFile(botId));
    expect(pruneMemoryJournal(botId, 7)).toBe(0);
    expect(readFileSync(journalFile(botId), "utf8")).toBe("not json\n");
  });

  it("prunes every bot's journal and lists journal bot ids", () => {
    const first = bot();
    const second = bot();
    const now = new Date("2026-11-27T12:00:00Z");
    const oldAt = now.getTime() - 40 * 24 * 60 * 60_000;
    writeJournal(first, [entry({ id: "a", at: oldAt, botId: first })]);
    writeJournal(second, [entry({ id: "b", at: oldAt, botId: second })]);
    expect(listJournalBotIds()).toContain(first);
    const pruned = pruneAllMemoryJournals(30, now).filter((row) => row.botId === first || row.botId === second);
    expect(pruned).toEqual([
      { botId: first, removed: 1 },
      { botId: second, removed: 1 },
    ]);
  });
});
