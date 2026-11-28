import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BatchRunner } from "../batch-runner/batch-runner.ts";
import type { RequestAuth } from "../request-auth.ts";
import { TasksStore } from "../tasks-store.ts";
import { createBatchRoutes } from "./batches.ts";
import { type RouteContext } from "./table.ts";

let dir: string;
let runner: BatchRunner;
let noted: Array<{ botId: string; threadId: string; text: string }>;
let release: (() => void) | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sanremes-batches-"));
  runner = new BatchRunner(new TasksStore({ dataDir: dir }), { dataDir: dir });
  noted = [];
  release = null;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(useRunner: BatchRunner = runner) {
  const route = createBatchRoutes({
    requireActive: () => {},
    readBody: async () => body,
    botId: () => "scout",
    threadId: () => "t1",
    runner: useRunner,
    runPrompt: async (botId, prompt) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return `answer to ${prompt} from ${botId}`;
    },
    noteDone: (botId, threadId, text) => { noted.push({ botId, threadId, text }); },
  });
  let body: unknown;
  const call = async (method: string, payload: unknown, path = "/api/internal/batches") => {
    body = payload;
    const sent: { status?: number; body?: unknown } = {};
    const url = new URL(path, "http://127.0.0.1");
    const out = await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url, path: url.pathname, method,
      auth: { kind: "loopback", scopes: ["admin"] } as RequestAuth, readBody: (async () => body) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, value: unknown) => { sent.status = status; sent.body = value; }) as RouteContext["json"],
    });
    return { out, ...sent };
  };
  return { call };
}

describe("POST /api/internal/batches", () => {
  it("queues the prompts and reports the summary to the asking thread when done", async () => {
    const { call } = setup();
    const { status, body } = await call("POST", { botId: "scout", threadId: "t1", prompts: ["one", "two"] });
    expect(status).toBe(201);
    expect(body).toMatchObject({ queued: 2 });
    expect(runner.getBatch((body as { batchId: string }).batchId)?.taskIds).toHaveLength(2);
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toMatchObject({ botId: "scout", threadId: "t1" });
    expect(noted[0]!.text).toContain("2 done, 0 failed, 0 not run yet.");
  });

  it("refuses a second batch while one runs, and a batch for another bot or thread", async () => {
    const { call } = setup();
    expect((await call("POST", { botId: "scout", threadId: "t1", prompts: ["one"] })).status).toBe(201);
    const busy = await call("POST", { botId: "scout", threadId: "t1", prompts: ["two"] });
    expect(busy.status).toBe(409);
    expect((await call("POST", { botId: "other", threadId: "t1", prompts: ["two"] })).status).toBe(403);
    expect((await call("POST", { botId: "scout", threadId: "t2", prompts: ["two"] })).status).toBe(403);
    release!();
  });

  it("refuses an empty prompt list and passes any other path on", async () => {
    const { call } = setup();
    expect((await call("POST", { botId: "scout", threadId: "t1", prompts: [] })).status).toBe(400);
    expect((await call("GET", { botId: "scout", threadId: "t1", prompts: ["one"] })).status).toBe(405);
  });
});

describe("GET /api/internal/batches/:id and POST /api/internal/batches/:id/resume", () => {
  it("reports a batch's progress and refuses a resume while it runs or after it finishes", async () => {
    const { call } = setup();
    const created = await call("POST", { botId: "scout", threadId: "t1", prompts: ["one", "two"] });
    const batchId = (created.body as { batchId: string }).batchId;
    const status = await call("GET", {}, `/api/internal/batches/${batchId}`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ status: { queued: 1, claimed: 0, running: 1, done: 0, failed: 0 }, running: true });
    expect((await call("GET", {}, "/api/internal/batches/nope")).status).toBe(404);
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const mid = await call("GET", {}, `/api/internal/batches/${batchId}`);
    expect(mid.body).toMatchObject({ status: { queued: 0, claimed: 0, running: 1, done: 1, failed: 0 } });
    const resumed = await call("POST", {}, `/api/internal/batches/${batchId}/resume`);
    expect(resumed.status).toBe(409);
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(noted).toHaveLength(1);
    expect((await call("POST", {}, `/api/internal/batches/${batchId}/resume`)).status).toBe(409);
  });

  it("resumes a batch a restart cut off, running only what is left", async () => {
    const { call } = setup();
    const created = await call("POST", { botId: "scout", threadId: "t1", prompts: ["one", "two"] });
    const batchId = (created.body as { batchId: string }).batchId;
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const restarted = new BatchRunner(new TasksStore({ dataDir: dir }), { dataDir: dir });
    const afterRestart = setup(restarted);
    const resumed = await afterRestart.call("POST", {}, `/api/internal/batches/${batchId}/resume`);
    expect(resumed.status).toBe(202);
    expect(resumed.body).toMatchObject({ batchId, remaining: 1 });
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const done = await afterRestart.call("GET", {}, `/api/internal/batches/${batchId}`);
    expect(done.body).toMatchObject({ status: { queued: 0, claimed: 0, running: 0, done: 2, failed: 0 }, running: false });
    expect(noted).toHaveLength(1);
    expect(noted[0]!.text).toContain("2 done, 0 failed, 0 not run yet.");
  });
});
