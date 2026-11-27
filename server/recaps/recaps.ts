import { listJournalBotIds, readMemoryJournal, type MemoryJournalEntry } from "../memory-journal.ts";
import { readUsage, summarizeUsage, type UsageRow } from "../usage-ledger.ts";

export type RecapPeriod = "weekly" | "monthly";
export const RECAP_PERIODS: readonly RecapPeriod[] = ["weekly", "monthly"];

const DAY_MS = 24 * 60 * 60_000;
const TOP_BOTS = 5;
const TOP_MODELS = 5;
const TOP_MEMORY_BOTS = 5;
const NOTABLE_MEMORY = 10;
const JOURNAL_ROWS = 500;

const dayLabel = (date: Date): string => date.toISOString().slice(0, 10);
const count = (value: number): string => value.toLocaleString("en-US");
const money = (value: number | null): string => (value === null ? "unpriced" : `$${value.toFixed(2)}`);

/** Weekly covers the 7 days ending now; monthly covers the calendar month to date. */
export function recapRange(period: RecapPeriod, now = new Date()): { from: Date; to: Date; label: string } {
  const to = now;
  if (period === "weekly") {
    const from = new Date(now.getTime() - 7 * DAY_MS);
    return { from, to, label: `Week of ${dayLabel(from)} to ${dayLabel(to)}` };
  }
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    from,
    to,
    label: `${now.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${now.getUTCFullYear()}`,
  };
}

/** A routine runs a recap on this schedule; the routine's prompt names the period. */
export function recapCron(period: RecapPeriod): string {
  return period === "weekly" ? "0 9 * * 1" : "0 9 1 * *";
}

export interface RecapInput {
  period: RecapPeriod;
  from: Date;
  to: Date;
  usageRows: readonly UsageRow[];
  journalEntries: readonly MemoryJournalEntry[];
  /** Threads whose rows stay out of the recap. A no-history thread's id goes here once it exists. */
  excludedThreadIds?: ReadonlySet<string>;
  now?: Date;
}

export interface RecapTopBot {
  botId: string;
  botName: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface RecapTopModel {
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface RecapNotableMemory {
  botId: string;
  path: string;
  kind: MemoryJournalEntry["kind"];
  added: number;
  removed: number;
  at: string;
}

export interface Recap {
  period: RecapPeriod;
  label: string;
  from: string;
  to: string;
  generatedAt: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
  unpricedTurns: number;
  topBots: RecapTopBot[];
  topModels: RecapTopModel[];
  memoryChanges: number;
  memoryCreated: number;
  memoryEdited: number;
  memoryDeleted: number;
  memoryByBot: Array<{ botId: string; changes: number }>;
  notableMemory: RecapNotableMemory[];
}

/** Every figure comes from the ledger and journal rows handed in; nothing is estimated or invented. */
export function buildRecap(input: RecapInput): Recap {
  const from = input.from.getTime();
  const to = input.to.getTime();
  const excluded = input.excludedThreadIds;
  const rows = input.usageRows.filter(
    (row) => {
      const at = Date.parse(row.at);
      return at >= from && at <= to && !(excluded?.has(row.threadId));
    },
  );
  const entries = input.journalEntries.filter(
    (entry) => entry.at >= from && entry.at <= to && !(entry.threadId && excluded?.has(entry.threadId)),
  );
  const byBot = summarizeUsage(rows, "bot");
  const byModel = summarizeUsage(rows, "model");
  const total = byBot.total;
  const byBotChanges = new Map<string, number>();
  let created = 0;
  let edited = 0;
  let deleted = 0;
  for (const entry of entries) {
    if (entry.kind === "created") created += 1;
    else if (entry.kind === "edited") edited += 1;
    else deleted += 1;
    byBotChanges.set(entry.botId, (byBotChanges.get(entry.botId) ?? 0) + 1);
  }
  const notable = [...entries]
    .sort((a, b) => b.added + b.removed - (a.added + a.removed) || b.at - a.at)
    .slice(0, NOTABLE_MEMORY)
    .map((entry) => ({
      botId: entry.botId,
      path: entry.path,
      kind: entry.kind,
      added: entry.added,
      removed: entry.removed,
      at: new Date(entry.at).toISOString(),
    }));
  return {
    period: input.period,
    label: input.period === "weekly"
      ? `Week of ${dayLabel(input.from)} to ${dayLabel(input.to)}`
      : `${input.to.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${input.to.getUTCFullYear()}`,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    generatedAt: (input.now ?? new Date()).toISOString(),
    turns: total.turns,
    inputTokens: total.input,
    outputTokens: total.output,
    cachedInputTokens: total.cachedInput,
    costUsd: total.costUsd,
    unpricedTurns: total.unpriced,
    topBots: byBot.groups.slice(0, TOP_BOTS).map((group) => ({
      botId: group.key.slice("bot:".length),
      botName: group.label,
      turns: group.turns,
      inputTokens: group.input,
      outputTokens: group.output,
      costUsd: group.costUsd,
    })),
    topModels: byModel.groups.slice(0, TOP_MODELS).map((group) => ({
      model: group.label,
      turns: group.turns,
      inputTokens: group.input,
      outputTokens: group.output,
      costUsd: group.costUsd,
    })),
    memoryChanges: entries.length,
    memoryCreated: created,
    memoryEdited: edited,
    memoryDeleted: deleted,
    memoryByBot: [...byBotChanges.entries()]
      .map(([botId, changes]) => ({ botId, changes }))
      .sort((a, b) => b.changes - a.changes)
      .slice(0, TOP_MEMORY_BOTS),
    notableMemory: notable,
  };
}

/** Reads the ledger and every bot's journal for the period; pass the bot ids, or omit them to cover all journals on disk. */
export function collectRecapInput(
  dataDir: string,
  period: RecapPeriod,
  now = new Date(),
  botIds: readonly string[] = listJournalBotIds(),
  excludedThreadIds?: ReadonlySet<string>,
): RecapInput {
  const { from, to } = recapRange(period, now);
  return {
    period,
    from,
    to,
    usageRows: readUsage(dataDir, { from, to }),
    journalEntries: botIds.flatMap((botId) => readMemoryJournal(botId, JOURNAL_ROWS)),
    excludedThreadIds,
    now,
  };
}

/** The recap as a plain-text document: headings, totals, top bots and models, memory changes. */
export function formatRecap(recap: Recap): string {
  const lines: string[] = [
    `${recap.period === "weekly" ? "Weekly" : "Monthly"} recap — ${recap.label}`,
    `Generated ${recap.generatedAt.slice(0, 10)}`,
    "",
    "Usage",
    `Turns: ${count(recap.turns)}`,
    `Input tokens: ${count(recap.inputTokens)}`,
    `Output tokens: ${count(recap.outputTokens)}`,
    `Cached input tokens: ${count(recap.cachedInputTokens)}`,
    `Cost: ${money(recap.costUsd)}${recap.unpricedTurns ? ` (${count(recap.unpricedTurns)} turns unpriced)` : ""}`,
    "",
    "Top bots",
  ];
  if (!recap.topBots.length) lines.push("No turns in this period.");
  for (const bot of recap.topBots) {
    lines.push(`- ${bot.botName}: ${count(bot.turns)} turns, ${count(bot.inputTokens + bot.outputTokens)} tokens, ${money(bot.costUsd)}`);
  }
  lines.push("", "Top models");
  if (!recap.topModels.length) lines.push("No turns in this period.");
  for (const model of recap.topModels) {
    lines.push(`- ${model.model}: ${count(model.turns)} turns, ${count(model.inputTokens + model.outputTokens)} tokens, ${money(model.costUsd)}`);
  }
  lines.push(
    "",
    "Memory",
    `Changes: ${count(recap.memoryChanges)} (${count(recap.memoryCreated)} created, ${count(recap.memoryEdited)} edited, ${count(recap.memoryDeleted)} deleted)`,
  );
  for (const bot of recap.memoryByBot) lines.push(`- ${bot.botId}: ${count(bot.changes)} changes`);
  if (recap.notableMemory.length) {
    lines.push("", "Largest memory changes");
    for (const entry of recap.notableMemory) {
      lines.push(`- ${entry.path} (${entry.kind}, +${count(entry.added)}/-${count(entry.removed)} lines, ${entry.at.slice(0, 10)})`);
    }
  }
  return `${lines.join("\n")}\n`;
}
