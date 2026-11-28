import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";

const SHARES_FILE = "data-shares.json";
const MAX_SOURCES = 20;

/** Who certified a shared view, and when. A certified view was reviewed by its owner: its query and sources are what the owner stands behind. */
export interface DataShareCertification {
  by: string;
  at: number;
  note?: string;
}

/** A live shared view of a bot's data: anyone with the id re-runs the stored query and sees the current rows, plus the sources behind them. */
export interface DataShare {
  id: string;
  botId: string;
  title: string;
  sql: string;
  sources: string[];
  certified: DataShareCertification | null;
  createdAt: number;
  revokedAt: number | null;
}

const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|attach|pragma|vacuum|copy)\b/i;
const SOURCE_PATTERN = /(?:from|join)\s+("[^"]+"|`[^`]+`|[\w]+)(?:\.("[^"]+"|`[^`]+`|[\w]+))?/gi;

/** Table names a query reads, best effort, schema prefix stripped. */
export function sourcesFor(sql: string): string[] {
  const found: string[] = [];
  for (const match of sql.matchAll(SOURCE_PATTERN)) {
    const name = (match[2] ?? match[1]!).replace(/^["`]|["`]$/g, "");
    if (!found.includes(name)) found.push(name);
    if (found.length >= MAX_SOURCES) break;
  }
  return found;
}

/** Null when the SQL is a single read-only statement a share may re-run. */
export function validateShareSql(sql: string): string | null {
  const trimmed = sql.trim();
  if (!trimmed) return "Give a query to share.";
  if (!/^(select|with)\b/i.test(trimmed)) return "Only a SELECT query can be shared.";
  if (trimmed.includes(";")) return "Share one statement, without a semicolon.";
  if (FORBIDDEN.test(trimmed)) return "Only a read-only SELECT query can be shared.";
  return null;
}

export class DataShareStore {
  private readonly file: string;
  private readonly now: () => number;
  private shares: DataShare[] = [];

  constructor(options: { dataDir: string; now?: () => number }) {
    this.file = join(options.dataDir, SHARES_FILE);
    this.now = options.now ?? Date.now;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as { shares?: unknown[] };
      for (const raw of saved.shares ?? []) {
        const share = raw as DataShare;
        if (typeof share?.id === "string" && typeof share?.botId === "string" && typeof share?.sql === "string") {
          this.shares.push({ ...share, sources: Array.isArray(share.sources) ? share.sources : sourcesFor(share.sql), certified: share.certified ?? null, revokedAt: share.revokedAt ?? null });
        }
      }
    } catch {
      this.shares = [];
    }
  }

  private save(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ shares: this.shares }));
  }

  create(input: { botId: string; title: string; sql: string }): DataShare {
    const share: DataShare = {
      id: `ds_${randomUUID().slice(0, 8)}`,
      botId: input.botId,
      title: input.title,
      sql: input.sql,
      sources: sourcesFor(input.sql),
      certified: null,
      createdAt: this.now(),
      revokedAt: null,
    };
    this.shares.push(share);
    this.save();
    return share;
  }

  list(botId: string): DataShare[] {
    return this.shares.filter((share) => share.botId === botId && share.revokedAt === null);
  }

  get(id: string): DataShare | undefined {
    return this.shares.find((share) => share.id === id);
  }

  certify(id: string, by: string, note?: string): DataShare | undefined {
    const share = this.get(id);
    if (!share || share.revokedAt !== null) return undefined;
    share.certified = { by, at: this.now(), ...(note ? { note } : {}) };
    this.save();
    return share;
  }

  revoke(id: string): DataShare | undefined {
    const share = this.get(id);
    if (!share || share.revokedAt !== null) return undefined;
    share.revokedAt = this.now();
    this.save();
    return share;
  }
}
