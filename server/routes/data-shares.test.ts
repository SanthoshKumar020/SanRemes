import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DataEngine } from "../data/types.ts";
import { json, readBody } from "../harness/http.ts";
import type { DataSheetRegistry } from "../data/sheet.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createDataSharesRoutes, type DataShareRouteDeps } from "./data-shares.ts";
import { DataShareStore } from "../data/shares.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

async function serve(owner: boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-data-shares-routes-"));
  scratch.push(dataDir);
  const fakeDb = {
    run: async () => ({ columns: [{ name: "total", type: "number" }], rows: [[42]], rowCount: 1, truncated: false, elapsedMs: 1 }),
  };
  const deps = {
    bot: (id: string) => (id === "scout" ? { id: "scout" } : null),
    engine: { unavailable: () => null, forBot: async () => fakeDb } as unknown as Pick<DataEngine, "unavailable" | "forBot">,
    sheets: { for: () => ({ card: (id: string) => (id === "c_1" ? { id: "c_1", sql: "SELECT * FROM orders" } : undefined) }) } as unknown as Pick<DataSheetRegistry, "for">,
    store: new DataShareStore({ dataDir }),
    isOwner: () => owner,
  } satisfies DataShareRouteDeps;
  const routes = [createDataSharesRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const post = (path: string, body?: unknown) => call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { call, post };
}

describe("data share routes", () => {
  it("shares a query live, certifies it, then revokes it", async () => {
    const { call, post } = await serve(true);

    const refused = await post("/api/bots/scout/data/shares", { title: "Bad", sql: "DELETE FROM orders" });
    expect(refused.status).toBe(400);

    const created = await post("/api/bots/scout/data/shares", { title: "Weekly orders", sql: "SELECT total FROM orders" });
    expect(created.status).toBe(201);
    const id = created.body.share.id as string;
    expect(created.body.share.sources).toEqual(["orders"]);
    expect(created.body.share.certified).toBeNull();

    const listed = await call("/api/bots/scout/data/shares");
    expect(listed.status).toBe(200);
    expect(listed.body.shares).toHaveLength(1);

    const read = await call(`/api/data-shares/${id}`);
    expect(read.status).toBe(200);
    expect(read.body.rows).toEqual([[42]]);
    expect(read.body.share.sources).toEqual(["orders"]);

    const certified = await post(`/api/data-shares/${id}/certify`, { by: "owner", note: "Checked." });
    expect(certified.status).toBe(200);
    expect(certified.body.share.certified.by).toBe("owner");

    const readCertified = await call(`/api/data-shares/${id}`);
    expect(readCertified.body.share.certified.note).toBe("Checked.");

    const revoked = await post(`/api/data-shares/${id}/revoke`);
    expect(revoked.status).toBe(200);
    const gone = await call(`/api/data-shares/${id}`);
    expect(gone.status).toBe(410);
    const empty = await call("/api/bots/scout/data/shares");
    expect(empty.body.shares).toEqual([]);
  });

  it("shares from a card and refuses non-owners", async () => {
    const { call, post } = await serve(false);
    const fromCard = await post("/api/bots/scout/data/shares", { title: "From card", cardId: "c_1" });
    expect(fromCard.status).toBe(403);
    const listed = await call("/api/bots/scout/data/shares");
    expect(listed.status).toBe(403);
  });

  it("creates a share from a card for the owner", async () => {
    const { post } = await serve(true);
    const created = await post("/api/bots/scout/data/shares", { title: "From card", cardId: "c_1" });
    expect(created.status).toBe(201);
    expect(created.body.share.sources).toEqual(["orders"]);
    const missing = await post("/api/bots/scout/data/shares", { title: "Missing", cardId: "c_9" });
    expect(missing.status).toBe(404);
  });
});
