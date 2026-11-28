import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RequestAuth } from "../request-auth.ts";
import { composeAttention } from "../duet/attention.ts";
import { DuetStore } from "../duet/store.ts";
import { createDuetRoutes } from "./duet.ts";
import { PASS, type RouteContext } from "./table.ts";

const now = 1_800_000_000_000;
const owner = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
const outsider = { kind: "loopback", trust: "service", scopes: ["client"] } as RequestAuth;
let dir: string;
let store: DuetStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sanremes-duet-routes-"));
  store = new DuetStore({ dataDir: dir, now: () => now });
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

const call = async (method: string, path: string, auth: RequestAuth = owner) => {
  const route = createDuetRoutes({ attention: () => list, store });
  const sent: { status?: number; body?: unknown } = {};
  const url = new URL(path, "http://127.0.0.1");
  const out = await route({
    req: {} as IncomingMessage, res: {} as ServerResponse, url, path: url.pathname, method, auth,
    readBody: (async () => undefined) as RouteContext["readBody"],
    json: ((_res: ServerResponse, status: number, value: unknown) => { sent.status = status; sent.body = value; }) as RouteContext["json"],
  });
  return { out, ...sent };
};

describe("GET /api/duet/attention", () => {
  it("returns the list and its pending offers to the owner", async () => {
    const { status, body } = await call("GET", "/api/duet/attention");
    expect(status).toBe(200);
    const value = body as { items: unknown[]; offers: unknown[] };
    expect(value.items).toHaveLength(1);
    expect(value.offers).toHaveLength(1);
  });

  it("refuses a non-owner", async () => {
    const { status } = await call("GET", "/api/duet/attention", outsider);
    expect(status).toBe(403);
  });

  it("passes on an unrelated path", async () => {
    const { out } = await call("GET", "/api/duet/other");
    expect(out).toBe(PASS);
  });
});

describe("POST /api/duet/offers/:id/approve", () => {
  it("approves once with the exact action, then refuses a second decision", async () => {
    await call("GET", "/api/duet/attention");
    const first = await call("POST", "/api/duet/offers/offer:email:m1/approve");
    expect(first.status).toBe(200);
    const body = first.body as { approvedAction: string };
    expect(body.approvedAction).toContain("Draft a Gmail reply in thread t1");
    const second = await call("POST", "/api/duet/offers/offer:email:m1/approve");
    expect(second.status).toBe(409);
  });

  it("reports an unknown offer as not found", async () => {
    const { status } = await call("POST", "/api/duet/offers/offer:nope/approve");
    expect(status).toBe(404);
  });

  it("declines without an approved action", async () => {
    await call("GET", "/api/duet/attention");
    const { status, body } = await call("POST", "/api/duet/offers/offer:email:m1/decline");
    expect(status).toBe(200);
    expect(body as object).not.toHaveProperty("approvedAction");
  });
});
