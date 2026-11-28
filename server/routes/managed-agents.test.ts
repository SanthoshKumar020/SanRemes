import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HandoffStore } from "../cloud-handoff.ts";
import { createExecutorRegistry, createLocalExecutor } from "../executors.ts";
import { json, readBody } from "../harness/http.ts";
import { ManagedAgentStore } from "../managed-agents.ts";
import { ParallelSessionStore, type GhRunner, type GitRunner } from "../parallel-sessions.ts";
import type { RequestAuth } from "../request-auth.ts";
import { TasksStore } from "../tasks-store.ts";
import { appendUsage } from "../usage-ledger.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { dispatchRoutes } from "./table.ts";
import { createManagedAgentRoutes } from "./managed-agents.ts";

const servers: Server[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

const REPO = "/home/person/work/demo";

function fakeGit(): GitRunner {
  return {
    run: async (_cwd, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: `${REPO}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: "abc\n", stderr: "" };
      if (args[0] === "show-ref") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "worktree") return { code: 0, stdout: "Preparing worktree\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function fakeGh(): GhRunner {
  return { find: () => "/usr/bin/gh", run: async () => ({ code: 0, stdout: "https://github.com/person/demo/pull/12\n", stderr: "" }) };
}

async function serve() {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-managed-routes-"));
  scratch.push(dataDir);
  const tasks = new TasksStore({ dataDir });
  const sessions = new ParallelSessionStore({ dataDir });
  const store = new ManagedAgentStore({ dataDir });
  const local = createLocalExecutor({
    sessions, tasks, git: fakeGit(), gh: fakeGh(),
    runPrompt: async () => "brief done",
    botExists: (id) => id === "scout",
  });
  const registry = createExecutorRegistry({ local });
  const routes = [createManagedAgentRoutes({
    store,
    handoff: new HandoffStore({ dataDir }),
    registry,
    dataDir,
    routines: () => [{
      id: "routine-1", name: "Morning brief", prompt: "Summarise the news.", target: "bot",
      botId: "scout", runOn: "sanremes", enabled: true,
      schedule: { type: "daily", time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      durationMinutes: 10, nextRunAt: null, createdAt: 0, updatedAt: 0,
    } as never],
    botExists: (id) => id === "scout",
    visible: () => ({ bot: (id: string) => id === "scout" }),
    bookUsage: (row) => appendUsage(dataDir, row),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { call, store };
}

const createPayload = {
  name: "Briefing bot", botId: "scout", instructions: "Write the morning brief.",
  schedule: { type: "daily", time: "08:00" },
};

describe("managed agent routes", () => {
  it("creates, lists, pauses, resumes, runs and deletes an agent", async () => {
    const { call } = await serve();
    const created = await call("/api/managed-agents", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(createPayload),
    });
    expect(created.status).toBe(201);
    const id = (created.body.agent as { id: string }).id;
    const listed = await call("/api/managed-agents");
    expect(listed.status).toBe(200);
    expect((listed.body.agents as unknown[])).toHaveLength(1);
    expect((listed.body.handoff as { preference: string }).preference).toBe("auto");
    const paused = await call(`/api/managed-agents/${id}/pause`, { method: "POST" });
    expect((paused.body.agent as { enabled: boolean }).enabled).toBe(false);
    const runWhilePaused = await call(`/api/managed-agents/${id}/run`, { method: "POST" });
    expect(runWhilePaused.status).toBe(409);
    await call(`/api/managed-agents/${id}/resume`, { method: "POST" });
    const run = await call(`/api/managed-agents/${id}/run`, { method: "POST" });
    expect(run.status).toBe(202);
    expect(run.body.started).toBe(true);
    let runs: unknown[] = [];
    for (let attempt = 0; attempt < 20 && runs.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const got = await call(`/api/managed-agents/${id}`);
      runs = (got.body.runs as unknown[]) ?? [];
    }
    expect(runs).toHaveLength(1);
    expect((runs[0] as { status: string }).status).toBe("completed");
    const removed = await call(`/api/managed-agents/${id}`, { method: "DELETE" });
    expect(removed.body.removed).toBe(true);
    expect((await call("/api/managed-agents")).body.agents).toEqual([]);
  });

  it("refuses an unknown bot and invalid input", async () => {
    const { call } = await serve();
    const ghost = await call("/api/managed-agents", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...createPayload, botId: "ghost" }),
    });
    expect(ghost.status).toBe(404);
    const invalid = await call("/api/managed-agents", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "No instructions", botId: "scout" }),
    });
    expect(invalid.status).toBe(400);
    expect(await call("/api/managed-agents/nope")).toMatchObject({ status: 404 });
  });

  it("creates an agent from a routine once, and reads and writes the hand-off", async () => {
    const { call } = await serve();
    const created = await call("/api/managed-agents/from-routine", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ routineId: "routine-1" }),
    });
    expect(created.status).toBe(201);
    expect((created.body.agent as { routineId: string }).routineId).toBe("routine-1");
    expect((created.body.agent as { schedule: { type: string } }).schedule.type).toBe("daily");
    const duplicate = await call("/api/managed-agents/from-routine", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ routineId: "routine-1" }),
    });
    expect(duplicate.status).toBe(409);
    const missing = await call("/api/managed-agents/from-routine", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ routineId: "routine-9" }),
    });
    expect(missing.status).toBe(404);
    const handoff = await call("/api/cloud-handoff", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ preference: "cloud" }),
    });
    expect(handoff.status).toBe(200);
    expect((handoff.body as { executor: string }).executor).toBe("local");
    expect((handoff.body as { note: string }).note).toContain("No cloud executor is attached");
  });
});
