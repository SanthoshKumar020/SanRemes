import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createExecutorRegistry, createLocalExecutor } from "../executors.ts";
import { json, readBody } from "../harness/http.ts";
import { ParallelSessionStore, type GhRunner, type GitRunner } from "../parallel-sessions.ts";
import type { RequestAuth } from "../request-auth.ts";
import { TasksStore } from "../tasks-store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { dispatchRoutes } from "./table.ts";
import { createCloudSessionRoutes } from "./cloud-sessions.ts";

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
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "diff") return { code: 0, stdout: "src/app.ts\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function fakeGh(): GhRunner {
  return { find: () => "/usr/bin/gh", run: async () => ({ code: 0, stdout: "https://github.com/person/demo/pull/12\n", stderr: "" }) };
}

async function serve() {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-cloud-sessions-"));
  scratch.push(dataDir);
  const tasks = new TasksStore({ dataDir });
  const store = new ParallelSessionStore({ dataDir });
  const local = createLocalExecutor({
    sessions: store, tasks, git: fakeGit(), gh: fakeGh(),
    runPrompt: async () => "ok",
    botExists: (id) => id === "scout",
  });
  const registry = createExecutorRegistry({ local });
  const routes = [createCloudSessionRoutes({ store, registry, botExists: (id) => id === "scout" })];
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
  return { call, tasks };
}

describe("cloud session routes", () => {
  it("starts a session locally, reports its conflict, opens its PR and closes it", async () => {
    const { call, tasks } = await serve();
    const task = tasks.create({ title: "fix it", goal: "fix it", assigneeBotId: "scout" });
    const created = await call("/api/cloud-sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoDir: REPO, taskId: task.id, botId: "scout" }),
    });
    expect(created.status).toBe(201);
    expect((created.body as { executor: string }).executor).toBe("local");
    const id = (created.body.session as { id: string }).id;
    const read = await call(`/api/cloud-sessions/${id}`);
    expect(read.status).toBe(200);
    expect((read.body.session as { state: string }).state).toBe("conflict");
    expect((read.body.session as { conflictFiles: string[] }).conflictFiles).toEqual(["src/app.ts"]);
    const pr = await call(`/api/cloud-sessions/${id}/pr`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Fix it" }),
    });
    expect(pr.status).toBe(409);
    expect((pr.body as { error: string }).error).toContain("Resolve the conflicts");
    const listed = await call("/api/cloud-sessions");
    expect((listed.body.sessions as unknown[])).toHaveLength(1);
    expect((listed.body as { cloudAttached: boolean }).cloudAttached).toBe(false);
    const closed = await call(`/api/cloud-sessions/${id}/close`, { method: "POST" });
    expect((closed.body.session as { state: string }).state).toBe("closed");
  });

  it("falls back to local with a note when cloud is asked for but not attached", async () => {
    const { call, tasks } = await serve();
    const task = tasks.create({ title: "fix it", goal: "fix it", assigneeBotId: "scout" });
    const created = await call("/api/cloud-sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoDir: REPO, taskId: task.id, botId: "scout", executor: "cloud" }),
    });
    expect(created.status).toBe(201);
    expect((created.body as { executor: string }).executor).toBe("local");
    expect((created.body as { note: string }).note).toContain("No cloud executor is attached");
  });

  it("refuses unknown tasks and sessions", async () => {
    const { call } = await serve();
    const created = await call("/api/cloud-sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoDir: REPO, taskId: "nope", botId: "scout" }),
    });
    expect(created.status).toBe(409);
    expect(await call("/api/cloud-sessions/nope")).toMatchObject({ status: 404 });
  });
});
