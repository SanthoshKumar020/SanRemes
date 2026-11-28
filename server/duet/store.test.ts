import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeAttention } from "./attention.ts";
import { DuetStore, OFFER_TTL_MS } from "./store.ts";

const now = 1_800_000_000_000;
let dir: string;
let at: number;
let store: DuetStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sanremes-duet-"));
  at = now;
  store = new DuetStore({ dataDir: dir, now: () => at });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const list = composeAttention({
  now,
  emails: [{ header: { id: "m1", threadId: "t1", at: now - 1000, from: "Ada <ada@example.com>", subject: "Q3 numbers", preview: "x" }, needsReply: true }],
  routines: [],
  needsYou: [],
});

describe("DuetStore", () => {
  it("saves a list's offers as pending and keeps them across a reopen", () => {
    const saved = store.saveList(list);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe("pending");
    const reopened = new DuetStore({ dataDir: dir, now: () => at });
    expect(reopened.offers()).toHaveLength(1);
  });

  it("does not duplicate an offer saved twice, and keeps its decision", () => {
    store.saveList(list);
    store.approve("offer:email:m1", "owner");
    store.saveList(list);
    expect(store.offers()).toHaveLength(1);
    expect(store.get("offer:email:m1")?.status).toBe("approved");
  });

  it("approves once, then refuses a second decision", () => {
    store.saveList(list);
    const first = store.approve("offer:email:m1", "owner");
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.offer.decidedBy).toBe("owner");
    expect(store.approve("offer:email:m1", "owner")).toEqual({ ok: false, reason: "already-decided" });
    expect(store.decline("offer:email:m1", "owner")).toEqual({ ok: false, reason: "already-decided" });
  });

  it("declines, and reports an unknown offer as not found", () => {
    store.saveList(list);
    expect(store.decline("offer:email:m1", "owner").ok).toBe(true);
    expect(store.get("offer:email:m1")?.status).toBe("declined");
    expect(store.approve("offer:nope", "owner")).toEqual({ ok: false, reason: "not-found" });
  });

  it("expires an offer past its time to live", () => {
    store.saveList(list);
    at += OFFER_TTL_MS + 1;
    expect(store.approve("offer:email:m1", "owner")).toEqual({ ok: false, reason: "expired" });
    expect(store.get("offer:email:m1")?.status).toBe("expired");
    expect(store.pending()).toHaveLength(0);
  });
});
