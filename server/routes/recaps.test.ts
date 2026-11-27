import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { __resetIncognitoThreadsForTests, markThreadIncognito } from "../incognito-threads.ts";
import { JOURNAL_DIR, type MemoryJournalEntry } from "../memory-journal.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createRecapRoutes } from "./recaps.ts";
import { PASS, type RouteContext } from "./table.ts";

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  __resetIncognitoThreadsForTests();
});

const NOW = new Date("2026-11-27T12:00:00Z");
const entry = (overrides: Partial<MemoryJournalEntry> = {}): MemoryJournalEntry => ({
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

function setup() {
  mkdirSync(JOURNAL_DIR, { recursive: true });
  writeFileSync(join(JOURNAL_DIR, "scout.ndjson"), [
    JSON.stringify(entry()),
    JSON.stringify(entry({ id: "e2", threadId: "hidden", added: 99, removed: 99 })),
    "",
  ].join("\n"));
  markThreadIncognito("hidden", "scout");
  const route = createRecapRoutes({ dataDir: DATA_DIR, now: () => NOW });
  const call = async (method: string, target: string, scopes: RequestAuth["scopes"] = ["admin", "client"], kind: RequestAuth["kind"] = "loopback") => {
    const sent: { status?: number; body?: unknown; text?: string } = {};
    const url = new URL(target, "http://127.0.0.1");
    const res = {
      setHeader: () => {},
      end: (text: string) => { sent.text = text; },
    } as unknown as ServerResponse;
    const out = await route({
      req: {} as IncomingMessage, res, url, path: url.pathname, method,
      auth: { kind, scopes } as RequestAuth, readBody: (async () => ({})) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as RouteContext["json"],
    });
    return { out, ...sent };
  };
  return { call };
}

describe("GET /api/recaps/:period", () => {
  it("totals the period and leaves incognito threads out of the memory counts", async () => {
    const { call } = setup();
    const { status, body } = await call("GET", "/api/recaps/weekly");
    expect(status).toBe(200);
    expect(body).toMatchObject({ period: "weekly", memoryChanges: 1, memoryEdited: 1 });
    expect((body as { notableMemory: unknown[] }).notableMemory).toHaveLength(1);
  });

  it("renders the same recap as text when asked", async () => {
    const { call } = setup();
    const { text } = await call("GET", "/api/recaps/weekly?format=text");
    expect(text).toContain("Weekly recap — Week of 2026-11-20 to 2026-11-27");
    expect(text).toContain("Changes: 1 (0 created, 1 edited, 0 deleted)");
  });

  it("refuses a non-owner session and passes any other path on", async () => {
    const { call } = setup();
    const denied = await call("GET", "/api/recaps/weekly", ["client"], "session");
    expect(denied.status).toBe(403);
    expect((await call("GET", "/api/recaps/daily")).out).toBe(PASS);
    expect((await call("POST", "/api/recaps/weekly")).out).toBe(PASS);
  });
});
