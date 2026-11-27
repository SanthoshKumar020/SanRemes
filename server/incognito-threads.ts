import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

export const INCOGNITO_THREADS_FILE = "incognito-threads.json";

export interface IncognitoThreadEntry {
  threadId: string;
  botId?: string;
  createdAt: number;
}

function isEntry(value: unknown): value is IncognitoThreadEntry {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.threadId === "string" && typeof row.createdAt === "number";
}

export class IncognitoThreads {
  private readonly file: string;
  private cache: Map<string, IncognitoThreadEntry> | null = null;
  private cacheMtimeMs = 0;

  constructor(dataDir: string = DATA_DIR) {
    this.file = join(dataDir, INCOGNITO_THREADS_FILE);
  }

  private load(): Map<string, IncognitoThreadEntry> {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch {
      return new Map();
    }
    if (this.cache && mtimeMs === this.cacheMtimeMs) return this.cache;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return new Map();
    }
    const entries = new Map<string, IncognitoThreadEntry>();
    if (Array.isArray(parsed)) for (const row of parsed) if (isEntry(row)) entries.set(row.threadId, row);
    this.cache = entries;
    this.cacheMtimeMs = mtimeMs;
    return entries;
  }

  private save(entries: Map<string, IncognitoThreadEntry>): void {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify([...entries.values()], null, 2)}\n`, { mode: 0o600 });
    this.cache = entries;
    try {
      this.cacheMtimeMs = statSync(this.file).mtimeMs;
    } catch {
      this.cacheMtimeMs = 0;
    }
  }

  has(threadId: string): boolean {
    return this.load().has(threadId);
  }

  mark(threadId: string, botId?: string): void {
    const entries = this.load();
    if (!entries.has(threadId)) {
      entries.set(threadId, { threadId, ...(botId ? { botId } : {}), createdAt: Date.now() });
      this.save(entries);
    }
  }

  clear(threadId: string): void {
    const entries = this.load();
    if (entries.delete(threadId)) this.save(entries);
  }

  ids(): string[] {
    return [...this.load().keys()];
  }

  idsForBot(botId: string): string[] {
    return [...this.load().values()].filter((entry) => entry.botId === botId).map((entry) => entry.threadId);
  }

  __resetForTests(): void {
    this.cache = null;
    this.cacheMtimeMs = 0;
  }
}

export const incognitoThreads = new IncognitoThreads();

export function isIncognitoThread(threadId: string): boolean {
  return incognitoThreads.has(threadId);
}

export function markThreadIncognito(threadId: string, botId?: string): void {
  incognitoThreads.mark(threadId, botId);
}

export function clearIncognitoThread(threadId: string): void {
  incognitoThreads.clear(threadId);
}

export function incognitoThreadIds(): string[] {
  return incognitoThreads.ids();
}

export function incognitoThreadIdsForBot(botId: string): string[] {
  return incognitoThreads.idsForBot(botId);
}

/** A turn writes no memory and no journal entry for one of these threads. */
export function skipMemoryForThread(threadId: string): boolean {
  return isIncognitoThread(threadId);
}

export function withoutIncognitoThreads<T extends { threadId: string }>(items: readonly T[], registry: IncognitoThreads = incognitoThreads): T[] {
  return items.filter((item) => !registry.has(item.threadId));
}

export function __resetIncognitoThreadsForTests(): void {
  incognitoThreads.__resetForTests();
}
