import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createBrowserWatchesRoutes } from "./browser-watches.ts";
import { dispatchRoutes } from "./table.ts";

const BOTS: Record<string, { id: string }> = { "bot-123": { id: "bot-123" } };
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(auth: RequestAuth = { kind: "loopback", scopes: ["admin"] }): Promise<string> {
  const routes = [createBrowserWatchesRoutes({ bot: (id) => BOTS[id] })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, {
        req, res, url, path: url.pathname, method: req.method ?? "GET",
        auth, json, readBody,
      });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/bots/bot-123/browser-watches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("the browser-watches routes", () => {
  it("creates a watch, lists it, and deletes it", async () => {
    const base = await serve();
    const empty = await fetch(`${base}/api/bots/bot-123/browser-watches`);
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { watches: unknown[] }).watches).toEqual([]);
    const created = await post(base, { name: "Price", url: "https://example.test/item", routineId: "routine-1" });
    expect(created.status).toBe(200);
    const { watch } = (await created.json()) as { watch: { id: string; name: string; url: string; routineId: string; digest: string } };
    expect(watch).toMatchObject({ name: "Price", url: "https://example.test/item", routineId: "routine-1", digest: "" });
    expect(watch.id).toMatch(/^[0-9a-f-]{36}$/);
    const listed = await fetch(`${base}/api/bots/bot-123/browser-watches`);
    expect((((await listed.json()) as { watches: { id: string }[] }).watches)).toHaveLength(1);
    const removed = await fetch(`${base}/api/bots/bot-123/browser-watches/${watch.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    const again = await fetch(`${base}/api/bots/bot-123/browser-watches`);
    expect((((await again.json()) as { watches: unknown[] }).watches)).toEqual([]);
  });

  it("refuses a bad URL, an unknown bot, and an unknown watch", async () => {
    const base = await serve();
    const bad = await post(base, { name: "Price", url: "not-a-url", routineId: "routine-1" });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/api/bots/nope/browser-watches`);
    expect(missing.status).toBe(404);
    const gone = await fetch(`${base}/api/bots/bot-123/browser-watches/00000000-0000-0000-0000-000000000000`, { method: "DELETE" });
    expect(gone.status).toBe(404);
  });

  it("lets anyone list but only the owner change watches", async () => {
    const base = await serve({ kind: "loopback", trust: "service", scopes: [] });
    const listed = await fetch(`${base}/api/bots/bot-123/browser-watches`);
    expect(listed.status).toBe(200);
    const created = await post(base, { name: "Price", url: "https://example.test/item", routineId: "routine-1" });
    expect(created.status).toBe(403);
  });

  it("passes other paths through", async () => {
    const base = await serve();
    const other = await fetch(`${base}/api/bots/bot-123/browser-watches/extra/deep`);
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ from: "inline routes" });
  });
});
