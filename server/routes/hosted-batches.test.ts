import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BatchRunner } from "../batch-runner/batch-runner.ts";
import { createExecutorRegistry, createLocalExecutor } from "../executors.ts";
import { json, readBody } from "../harness/http.ts";
import { ParallelSessionStore, type GhRunner, type GitRunner } from "../parallel-sessions.ts";
import type { RequestAuth } from "../request-auth.ts";
import { TasksStore } from "../tasks-store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { dispatchRoutes } from "./table.ts";
import { createHostedBatchRoutes } from "./hosted-batches.ts";

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
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function fakeGh(): GhRunner {
  return { find: () => "/usr/bin/gh", run: async () => ({ code: 0, stdout: "", stderr: "" }) };
}

async function serve() {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-hosted-batches-"));
  scratch.push(dataDir);
  const tasks = new TasksStore({ dataDir });
  const sessions = new ParallelSessionStore({ dataDir });
  const runner = new BatchRunner(tasks, { dataDir });
  const local = createLocalExecutor({
    sessions, tasks, git: fakeGit(), gh: fakeGh(),
    runPrompt: async (_botId, prompt) => `answer: ${prompt}`,
    botExists: (id) => id === "scout",
  });
  const registry = createExecutorRegistry({ local });
  const routes = [createHostedBatchRoutes({
    runner, registry, botExists: (id) => id === "scout", runPrompt: async (_botId, prompt) => `answer: ${prompt}`,
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
  return { call };
}

describe("hosted batch routes", () => {
  it("submits a job to the local runner and collects its results", async () => {
    const { call } = await serve();
    const submitted = await call("/api/hosted-batches", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "scout", prompts: ["first prompt", "second prompt"] }),
    });
    expect(submitted.status).toBe(202);
    expect((submitted.body as { executor: string }).executor).toBe("local");
    const id = (submitted.body.batch as { id: string }).id;
    let results: unknown[] = [];
    for (let attempt = 0; attempt < 20 && results.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const got = await call(`/api/hosted-batches/${id}`);
      results = ((got.body.batch as { results: unknown[] } | undefined)?.results) ?? [];
    }
    expect(results).toHaveLength(2);
    expect((results[0] as { status: string }).status).toBe("done");
    expect((results[0] as { result: string }).result).toBe("answer: first prompt");
    const listed = await call("/api/hosted-batches");
    expect((listed.body.batches as unknown[])).toHaveLength(1);
  });

  it("falls back to local with a note when cloud is asked for but not attached", async () => {
    const { call } = await serve();
    const submitted = await call("/api/hosted-batches", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "scout", prompts: ["one prompt"], executor: "cloud" }),
    });
    expect(submitted.status).toBe(202);
    expect((submitted.body as { executor: string }).executor).toBe("local");
    expect((submitted.body as { note: string }).note).toContain("No cloud executor is attached");
  });

  it("refuses an unknown bot, empty prompts and unknown batches", async () => {
    const { call } = await serve();
    const ghost = await call("/api/hosted-batches", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "ghost", prompts: ["one"] }),
    });
    expect(ghost.status).toBe(404);
    const empty = await call("/api/hosted-batches", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "scout", prompts: [] }),
    });
    expect(empty.status).toBe(400);
    expect(await call("/api/hosted-batches/nope")).toMatchObject({ status: 404 });
  });
});
