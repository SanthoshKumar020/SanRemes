import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { TasksStore } from "../tasks-store.ts";
import { dispatchRoutes } from "./table.ts";
import { createTaskQueueRoutes, type TaskQueueRouteDeps } from "./task-queue.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const servers: Server[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

async function serve(extra: Partial<TaskQueueRouteDeps> = {}, authOverride?: RequestAuth) {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-task-queue-routes-"));
  scratch.push(dataDir);
  const store = new TasksStore({ dataDir, now: () => 1_000 });
  const routes = [createTaskQueueRoutes({
    store,
    botExists: (id) => id === "job-bot" || id === "qa-bot",
    ...extra,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = authOverride ?? { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { api, store };
}

async function seed(api: Awaited<ReturnType<typeof serve>>["api"], title = "Triage the inbox") {
  const created = await api("/api/tasks", { method: "POST", body: JSON.stringify({ title, goal: "Clear every unread message." }) });
  return created.body.task.id as string;
}

it("reads the empty queue", async () => {
  const { api } = await serve();
  const { status, body } = await api("/api/tasks");
  expect(status).toBe(200);
  expect(body).toMatchObject({ tasks: [] });
  expect(typeof body.version).toBe("number");
});

it("creates a task and lists it", async () => {
  const { api } = await serve();
  const created = await api("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Triage the inbox", goal: "Clear every unread message." }) });
  expect(created.status).toBe(201);
  expect(created.body.task).toMatchObject({ title: "Triage the inbox", state: "queued", lockedBy: null, history: [] });
  const listed = await api("/api/tasks");
  expect(listed.body.tasks).toHaveLength(1);
  expect(listed.body.tasks[0].id).toBe(created.body.task.id);
});

it("refuses a task without a title, or for an unknown bot", async () => {
  const { api } = await serve();
  expect((await api("/api/tasks", { method: "POST", body: JSON.stringify({ goal: "No title." }) })).status).toBe(400);
  expect((await api("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Triage", assigneeBotId: "ghost" }) })).status).toBe(400);
  expect((await api("/api/tasks", { method: "POST", body: JSON.stringify({ title: "Triage", unknown: true }) })).status).toBe(400);
});

it("claims once, then refuses a second claim", async () => {
  const { api } = await serve();
  const id = await seed(api);
  const claimed = await api(`/api/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) });
  expect(claimed.status).toBe(200);
  expect(claimed.body.task).toMatchObject({ state: "claimed", lockedBy: "job-bot", assigneeBotId: "job-bot" });
  const again = await api(`/api/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({ botId: "qa-bot" }) });
  expect(again.status).toBe(409);
  expect(again.body).toMatchObject({ state: "claimed" });
  expect((await api(`/api/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({ botId: "ghost" }) })).status).toBe(404);
  expect((await api(`/api/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
});

it("completing releases the lock and records the result", async () => {
  const { api } = await serve();
  const id = await seed(api);
  await api(`/api/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) });
  const done = await api(`/api/tasks/${id}/complete`, { method: "POST", body: JSON.stringify({ botId: "job-bot", result: "Inbox cleared." }) });
  expect(done.status).toBe(200);
  expect(done.body.task).toMatchObject({ state: "done", lockedBy: null });
  expect(done.body.task.history).toHaveLength(2);
  expect(done.body.tasks).toHaveLength(1);
  expect((await api(`/api/tasks/${id}/complete`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) })).status).toBe(409);
});

it("failing releases the lock, and only the holder may finish a task", async () => {
  const { api } = await serve();
  const id = await seed(api);
  expect((await api(`/api/tasks/${id}/complete`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) })).status).toBe(409);
  await api(`/api/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) });
  expect((await api(`/api/tasks/${id}/complete`, { method: "POST", body: JSON.stringify({ botId: "qa-bot" }) })).status).toBe(409);
  const failed = await api(`/api/tasks/${id}/fail`, { method: "POST", body: JSON.stringify({ botId: "job-bot", result: "Inbox API refused the sign-in." }) });
  expect(failed.status).toBe(200);
  expect(failed.body.task).toMatchObject({ state: "failed", lockedBy: null });
  expect(failed.body.task.history[1]).toMatchObject({ result: "Inbox API refused the sign-in.", botId: "job-bot" });
});

it("answers 404 for an unknown task, and filters the list by state", async () => {
  const { api } = await serve();
  expect((await api("/api/tasks/missing/claim", { method: "POST", body: JSON.stringify({ botId: "job-bot" }) })).status).toBe(404);
  expect((await api("/api/tasks/missing/complete", { method: "POST", body: JSON.stringify({ botId: "job-bot" }) })).status).toBe(404);
  expect((await api("/api/tasks/missing/fail", { method: "POST", body: JSON.stringify({ botId: "job-bot" }) })).status).toBe(404);
  const id = await seed(api);
  await api(`/api/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) });
  await api(`/api/tasks/${id}/complete`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) });
  await seed(api, "Second task");
  expect((await api("/api/tasks?state=done")).body.tasks).toHaveLength(1);
  expect((await api("/api/tasks?state=queued")).body.tasks).toHaveLength(1);
  expect((await api("/api/tasks?state=bogus")).status).toBe(400);
});

it("passes through paths that are not its own", async () => {
  const { api } = await serve();
  expect((await api("/api/other")).status).toBe(404);
  expect((await api("/api/tasks", { method: "DELETE" })).status).toBe(405);
});

it("starts a claimed task, only by the bot holding the lock", async () => {
  const { api } = await serve();
  const id = await seed(api);
  expect((await api(`/api/tasks/${id}/start`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) })).status).toBe(409);
  await api(`/api/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) });
  expect((await api(`/api/tasks/${id}/start`, { method: "POST", body: JSON.stringify({ botId: "qa-bot" }) })).status).toBe(409);
  const started = await api(`/api/tasks/${id}/start`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) });
  expect(started.status).toBe(200);
  expect(started.body.task).toMatchObject({ state: "running", lockedBy: "job-bot" });
  expect(started.body.task.history).toHaveLength(2);
  expect((await api(`/api/tasks/${id}/start`, { method: "POST", body: JSON.stringify({ botId: "ghost" }) })).status).toBe(404);
  expect((await api("/api/tasks/missing/start", { method: "POST", body: JSON.stringify({ botId: "job-bot" }) })).status).toBe(404);
});

it("requeues a failed task, refuses a live one and a third failure, and refuses service callers", async () => {
  const { api, store } = await serve();
  const id = await seed(api);
  expect((await api(`/api/tasks/${id}/requeue`, { method: "POST", body: "{}" })).status).toBe(409);
  await api(`/api/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) });
  await api(`/api/tasks/${id}/fail`, { method: "POST", body: JSON.stringify({ botId: "job-bot", result: "First failure." }) });
  const requeued = await api(`/api/tasks/${id}/requeue`, { method: "POST", body: "{}" });
  expect(requeued.status).toBe(200);
  expect(requeued.body.task).toMatchObject({ state: "queued", assigneeBotId: null, lockedBy: null });
  for (let attempt = 2; attempt <= 3; attempt++) {
    await api(`/api/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) });
    await api(`/api/tasks/${id}/fail`, { method: "POST", body: JSON.stringify({ botId: "job-bot", result: `Failure ${attempt}.` }) });
    if (attempt < 3) expect((await api(`/api/tasks/${id}/requeue`, { method: "POST", body: "{}" })).status).toBe(200);
  }
  const capped = await api(`/api/tasks/${id}/requeue`, { method: "POST", body: "{}" });
  expect(capped.status).toBe(409);
  expect(capped.body).toMatchObject({ attempts: 3 });
  expect((await api("/api/tasks/missing/requeue", { method: "POST", body: "{}" })).status).toBe(404);
  const service = await serve({}, { kind: "loopback", scopes: ["client"], trust: "service" } as unknown as RequestAuth);
  expect((await service.api(`/api/tasks/${id}/requeue`, { method: "POST", body: "{}" })).status).toBe(403);
  expect(store.get(id)?.state).toBe("failed");
});

it("exports a task and imports it on another home as a fresh queued task", async () => {
  const { api, store } = await serve();
  const id = await seed(api);
  await api(`/api/tasks/${id}/claim`, { method: "POST", body: JSON.stringify({ botId: "job-bot" }) });
  await api(`/api/tasks/${id}/fail`, { method: "POST", body: JSON.stringify({ botId: "job-bot", result: "The inbox moved." }) });
  const exported = await api(`/api/tasks/${id}/export`);
  expect(exported.status).toBe(200);
  expect(exported.body).toMatchObject({ version: 1, task: { id, title: "Triage the inbox", state: "failed" } });
  expect(exported.body.task.history).toHaveLength(2);
  expect((await api("/api/tasks/missing/export")).status).toBe(404);

  const other = await serve();
  const imported = await other.api("/api/tasks/import", { method: "POST", body: JSON.stringify(exported.body) });
  expect(imported.status).toBe(201);
  expect(imported.body.task).toMatchObject({ title: "Triage the inbox", state: "queued", lockedBy: null, assigneeBotId: "job-bot" });
  expect(imported.body.task.id).not.toBe(id);
  expect(imported.body.task.history).toHaveLength(3);
  expect(imported.body.task.history.at(-1)).toMatchObject({ result: "handed off from another home" });
  expect(imported.body.task.history[0]).toMatchObject({ result: "claimed", botId: "job-bot" });
  const again = await other.api(`/api/tasks/${imported.body.task.id}/claim`, { method: "POST", body: JSON.stringify({ botId: "qa-bot" }) });
  expect(again.status).toBe(200);
  expect(store.get(id)?.state).toBe("failed");
});

it("refuses a malformed task import", async () => {
  const { api } = await serve();
  expect((await api("/api/tasks/import", { method: "POST", body: JSON.stringify({ version: 2, task: { title: "x" } }) })).status).toBe(400);
  expect((await api("/api/tasks/import", { method: "POST", body: JSON.stringify({ version: 1, task: { title: "" } }) })).status).toBe(400);
  expect((await api("/api/tasks/import", { method: "POST", body: JSON.stringify({ version: 1, task: { title: "x", assigneeBotId: "ghost" } }) })).status).toBe(400);
});
