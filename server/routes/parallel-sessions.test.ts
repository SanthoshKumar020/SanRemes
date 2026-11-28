import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { TasksStore } from "../tasks-store.ts";
import { ParallelSessionStore, type CommandResult, type GhRunner, type GitRunner } from "../parallel-sessions.ts";
import { dispatchRoutes } from "./table.ts";
import { createParallelSessionRoutes } from "./parallel-sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";

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
      if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "diff") return { code: 0, stdout: "src/app.ts\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function fakeGh(): GhRunner {
  return {
    find: () => "/usr/bin/gh",
    run: async () => ({ code: 0, stdout: "https://github.com/person/demo/pull/12\n", stderr: "" }) as CommandResult,
  };
}

async function serve() {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-parallel-routes-"));
  scratch.push(dataDir);
  const tasks = new TasksStore({ dataDir });
  const store = new ParallelSessionStore({ dataDir });
  const routes = [createParallelSessionRoutes({
    store, tasks, git: fakeGit(), gh: fakeGh(), botExists: (id) => id === "scout",
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { api, tasks, store };
}

it("starts a session, reports its conflict, refuses its pull request, and closes it", async () => {
  const { api, tasks } = await serve();
  const task = tasks.create({ title: "Fix the flaky test" });
  const created = await api("/api/parallel-sessions", {
    method: "POST", body: JSON.stringify({ repoDir: REPO, taskId: task.id, botId: "scout" }),
  });
  expect(created.status).toBe(201);
  const id = created.body.session.id as string;
  expect(created.body.session).toMatchObject({ branch: `sanremes/${task.id}`, state: "active" });
  const listed = await api("/api/parallel-sessions");
  expect(listed.body.sessions).toHaveLength(1);
  const read = await api(`/api/parallel-sessions/${id}`);
  expect(read.status).toBe(200);
  expect(read.body.session).toMatchObject({ state: "conflict", conflictFiles: ["src/app.ts"] });
  const pr = await api(`/api/parallel-sessions/${id}/pr`, { method: "POST", body: JSON.stringify({ title: "Fix it" }) });
  expect(pr.status).toBe(409);
  expect(pr.body.error).toContain("Resolve the conflicts");
  const closed = await api(`/api/parallel-sessions/${id}/close`, { method: "POST", body: "{}" });
  expect(closed.status).toBe(200);
  expect(closed.body.session).toMatchObject({ state: "closed" });
  expect((await api("/api/parallel-sessions/nope")).status).toBe(404);
});

it("refuses unknown bots and tasks, and a session for a task that is not queued", async () => {
  const { api, tasks } = await serve();
  const ghost = await api("/api/parallel-sessions", {
    method: "POST", body: JSON.stringify({ repoDir: REPO, taskId: "missing", botId: "ghost" }),
  });
  expect(ghost.status).toBe(404);
  const task = tasks.create({ title: "Fix the flaky test" });
  tasks.claim(task.id, "scout");
  const claimed = await api("/api/parallel-sessions", {
    method: "POST", body: JSON.stringify({ repoDir: REPO, taskId: task.id, botId: "scout" }),
  });
  expect(claimed.status).toBe(409);
  expect(claimed.body.error).toContain("not queued");
});
