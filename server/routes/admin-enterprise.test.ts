import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAdminSettingsStore } from "../admin-settings.ts";
import type { AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { dispatchRoutes } from "./table.ts";
import { createAdminEnterpriseRoutes } from "./admin-enterprise.ts";

const servers: Server[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

const authFor = (teamRole: "owner" | "admin" | "member" | undefined, adminScope = true): RequestAuth => ({
  kind: "session",
  session: {
    id: "s1", label: "Person", email: "owner@example.test", createdAt: 0, expiresAt: 1,
    scopes: adminScope ? ["admin", "client"] : ["client"],
    ...(teamRole ? { teamRole } : {}),
  },
  via: "cookie",
  scopes: adminScope ? ["admin", "client"] : ["client"],
} as unknown as RequestAuth);

async function serve(role: "owner" | "admin" | "member" | undefined, initial: Partial<AppConfig> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-admin-routes-"));
  scratch.push(dataDir);
  let cfg: AppConfig = { ...initial } as AppConfig;
  const saved: unknown[] = [];
  const routes = [createAdminEnterpriseRoutes({
    dataDir,
    config: () => cfg,
    save: (patch) => {
      saved.push(patch);
      cfg = { ...cfg, ...patch } as AppConfig;
    },
    settings: createAdminSettingsStore(dataDir),
    env: {},
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = authFor(role);
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { call, saved, dataDir };
}

const put = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("admin enterprise routes", () => {
  it("reports the caller's role and capabilities", async () => {
    const { call } = await serve("admin");
    const got = await call("/api/admin/capabilities");
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ role: "admin", capabilities: ["audit.read", "audit.export"] });
    const member = await serve("member");
    expect((await member.call("/api/admin/capabilities")).body).toEqual({ role: "member", capabilities: [] });
  });

  it("lets the owner change retention and refuses the admin, with the strict ratchet", async () => {
    const { call, saved } = await serve("owner", { decisions: { retentionDays: 180 }, memoryJournal: { retentionDays: 180 } });
    const state = await call("/api/admin/retention");
    expect(state.status).toBe(200);
    expect((state.body.decisions as { days: number; source: string }).days).toBe(180);
    expect((state.body.usage as { days: number | null }).days).toBe(null);
    const changed = await call("/api/admin/retention", put({ decisionsDays: 365, usageDays: 365 }));
    expect(changed.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect((changed.body.changed as string[]).sort()).toEqual(["decisions", "usage"]);
    expect((changed.body.restartNeededFor as string[])).toEqual(["decisions"]);

    const admin = await serve("admin");
    expect((await admin.call("/api/admin/retention", put({ decisionsDays: 90 }))).status).toBe(403);
    expect((await admin.call("/api/admin/retention")).status).toBe(200);

    const strict = await serve("owner", { decisions: { retentionDays: 365 } });
    expect((await strict.call("/api/admin/compliance", put({ auditStrict: true })))).toMatchObject({ status: 200 });
    const lowered = await strict.call("/api/admin/retention", put({ decisionsDays: 90 }));
    expect(lowered.status).toBe(400);
    const raised = await strict.call("/api/admin/retention", put({ decisionsDays: 730 }));
    expect(raised.status).toBe(200);
  });

  it("refuses a retention change the environment already sets", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sanremes-admin-routes-env-"));
    scratch.push(dataDir);
    const routes = [createAdminEnterpriseRoutes({
      dataDir,
      config: () => ({ decisions: { retentionDays: 180 } }) as AppConfig,
      save: () => { throw new Error("must not save"); },
      settings: createAdminSettingsStore(dataDir),
      env: { SANREMES_DECISION_RETENTION_DAYS: "90" },
    })];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: authFor("owner"), json, readBody })) json(res, 404, {});
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/admin/retention`, put({ decisionsDays: 365 }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("SANREMES_DECISION_RETENTION_DAYS");
  });

  it("toggles compliance mode and Motion, and the Motion generate path always refuses", async () => {
    const { call } = await serve("owner");
    expect((await call("/api/admin/compliance")).body).toEqual({ auditStrict: false });
    expect((await call("/api/admin/motion")).body).toMatchObject({ paidEnabled: false, provider: "none", ready: false });
    expect((await call("/api/admin/motion/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "a harbour" }) })).status).toBe(409);
    const on = await call("/api/admin/motion", put({ paidEnabled: true }));
    expect(on.status).toBe(200);
    expect((on.body as { ready: boolean }).ready).toBe(false);
    const gen = await call("/api/admin/motion/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "a harbour" }) });
    expect(gen.status).toBe(501);
    expect((gen.body as { error: string }).error).toContain("paid video-generation key");
    const member = await serve("member");
    expect((await member.call("/api/admin/motion", put({ paidEnabled: false })))).toMatchObject({ status: 403 });
    expect((await member.call("/api/admin/compliance")).status).toBe(403);
  });
});
