import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { appendUsage, flushUsageLedger } from "../usage-ledger.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { dispatchRoutes } from "./table.ts";
import { createCloudUsageRoutes } from "./cloud-usage.ts";

const servers: Server[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

async function serve() {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-cloud-usage-"));
  scratch.push(dataDir);
  await appendUsage(dataDir, {
    at: "2026-11-28T10:00:00.000Z", botId: "scout", botName: "Scout", threadId: "", instanceId: "",
    driverKind: "local", model: "sonnet", input: 100, output: 50, costUsd: 0.01,
    trigger: { kind: "managed-agent", agentId: "agent-1", agentName: "Briefing", executor: "local", runId: "run-1" },
  });
  await appendUsage(dataDir, {
    at: "2026-11-28T11:00:00.000Z", botId: "scout", botName: "Scout", threadId: "", instanceId: "",
    driverKind: "cloud", model: "sonnet", input: 10, output: 5, costUsd: null,
    trigger: { kind: "cloud-job", jobId: "batch-1", label: "Hosted batch", executor: "cloud" },
  });
  await flushUsageLedger(dataDir);
  const routes = [createCloudUsageRoutes({
    dataDir,
    agentRuns: (from, to) => [{
      id: "run-1", agentId: "agent-1", status: "completed" as const, executor: "local" as const, manual: true,
      startedAt: new Date("2026-11-28T10:00:00.000Z").getTime(),
      finishedAt: new Date("2026-11-28T10:01:00.000Z").getTime(),
      durationMs: 60_000, usageReported: true,
    }].filter((run) => run.startedAt >= from.getTime() && run.startedAt <= to.getTime()),
    agentNames: () => new Map([["agent-1", "Briefing"]]),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base };
}

describe("cloud usage routes", () => {
  it("returns the report as JSON and as CSV", async () => {
    const { base } = await serve();
    const response = await fetch(`${base}/api/cloud-usage/report?from=2026-11-01&to=2026-11-30`);
    expect(response.status).toBe(200);
    const body = await response.json() as { report: { agents: unknown[]; jobs: unknown[]; totalInputTokens: number; totalCostUsd: number } };
    expect(body.report.agents).toHaveLength(1);
    expect(body.report.jobs).toHaveLength(1);
    expect(body.report.totalInputTokens).toBe(110);
    expect(body.report.totalCostUsd).toBe(0.01);
    const csv = await fetch(`${base}/api/cloud-usage/report?from=2026-11-01&to=2026-11-30&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text).toContain("managed-agent,agent-1,Briefing,,1,100,50,0.01,0");
    expect(text).toContain("cloud-job,batch-1,Hosted batch,cloud,1,10,5,,");
  });

  it("refuses an invalid range", async () => {
    const { base } = await serve();
    const response = await fetch(`${base}/api/cloud-usage/report?from=2026-02-31&to=2026-11-30`);
    expect(response.status).toBe(400);
  });
});
