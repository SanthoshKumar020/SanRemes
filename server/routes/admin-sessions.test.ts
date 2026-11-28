import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createAdminSessionRoutes } from "./admin-sessions.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

async function serve(owner: boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-admin-sessions-"));
  scratch.push(dataDir);
  const live = new Set(["sess-1", "sess-2"]);
  const sessions = {
    revoke: (id: string) => live.delete(id),
    revokeMember: (email: string) => {
      if (email.toLowerCase() !== "ana@example.com") return 0;
      const count = live.size;
      live.clear();
      return count;
    },
  };
  const routes = [createAdminSessionRoutes({ dataDir, sessions, isOwner: () => owner })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string) => {
    const res = await fetch(`${base}${path}`, { method: "POST" });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { post, live };
}

describe("admin session routes", () => {
  it("revokes one session and signs a member out of all of theirs", async () => {
    const { post, live } = await serve(true);
    const revoked = await post("/api/admin/sessions/sess-1/revoke");
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ ok: true, revoked: true });
    expect(live.has("sess-1")).toBe(false);

    const missing = await post("/api/admin/sessions/sess-1/revoke");
    expect(missing.status).toBe(404);

    const signedOut = await post("/api/admin/members/ana%40example.com/sign-out");
    expect(signedOut.status).toBe(200);
    expect(signedOut.body).toEqual({ ok: true, revoked: 1 });
    expect(live.size).toBe(0);

    const nobody = await post("/api/admin/members/nobody%40example.com/sign-out");
    expect(nobody.body).toEqual({ ok: true, revoked: 0 });
  });

  it("refuses non-owners", async () => {
    const { post } = await serve(false);
    expect((await post("/api/admin/sessions/sess-1/revoke")).status).toBe(403);
    expect((await post("/api/admin/members/ana%40example.com/sign-out")).status).toBe(403);
  });
});
