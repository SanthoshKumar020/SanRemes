import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { ParallelSessionStore, type GhRunner } from "../parallel-sessions.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ShipPolicyStore } from "../ship/policy.ts";
import { createShipRoutes } from "./ship.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

function fakeGh(): GhRunner {
  return {
    find: () => "/usr/bin/gh",
    run: async (args) => {
      if (args[0] === "pr" && args[1] === "review") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: "\"APPROVED\"\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "no such pull request" };
    },
  };
}

async function serve() {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-ship-routes-"));
  scratch.push(dataDir);
  const worktree = join(dataDir, "worktree");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, "src.ts"), "const a = 1;\n", "utf8");
  const policy = new ShipPolicyStore({ dataDir });
  const sessions = new ParallelSessionStore({ dataDir });
  const sessionId = sessions.insert({
    id: "session-1", repoDir: dataDir, worktreeDir: worktree, baseBranch: "main", branch: "sanremes/task-1",
    taskId: "task-1", botId: "bot-1", state: "active", prUrl: null, conflictFiles: [], createdAt: 1, updatedAt: 1,
  }).id;
  const routes = [createShipRoutes({ policy, sessions, gh: fakeGh() })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, sessionId, worktree };
}

async function call(base: string, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

it("reads and saves the policy, and refuses auto-merge without auto-approve", async () => {
  const { base } = await serve();
  const read = await call(base, "/api/ship/policy");
  expect(read.status).toBe(200);
  expect((read.body.policy as { autoApprove: boolean }).autoApprove).toBe(false);
  const bad = await call(base, "/api/ship/policy", "PUT", { version: 1, autoApprove: false, autoMerge: true, requiredChecks: [], forbiddenPatterns: [], styleRules: [] });
  expect(bad.status).toBe(400);
  expect(String(bad.body.error)).toContain("Auto-merge needs auto-approve");
  const good = await call(base, "/api/ship/policy", "PUT", { version: 1, autoApprove: true, autoMerge: false, requiredChecks: ["tests"], forbiddenPatterns: [], styleRules: [] });
  expect(good.status).toBe(200);
  expect((good.body.policy as { requiredChecks: string[] }).requiredChecks).toEqual(["tests"]);
});

it("reviews files against the saved policy", async () => {
  const { base } = await serve();
  await call(base, "/api/ship/policy", "PUT", {
    version: 1, autoApprove: false, autoMerge: false, requiredChecks: ["tests"],
    forbiddenPatterns: [{ pattern: "password\\s*=", message: "Do not hard-code passwords." }], styleRules: [],
  });
  const reviewed = await call(base, "/api/ship/review", "POST", {
    files: [{ path: "src/a.ts", patch: "@@ -1,1 +1,2 @@\n x\n+const password = \"hunter2\";" }],
    checks: [{ name: "tests", status: "pass" }],
  });
  expect(reviewed.status).toBe(200);
  const review = reviewed.body.review as { verdict: string; findings: { file: string; line: number }[] };
  expect(review.verdict).toBe("fail");
  expect(review.findings).toEqual([{ file: "src/a.ts", line: 2, severity: "block", message: "Do not hard-code passwords." }]);
});

it("parses a /ship command and applies fixes in the session worktree", async () => {
  const { base, sessionId, worktree } = await serve();
  const parsed = await call(base, "/api/ship/command", "POST", { text: "/ship review octocat/hello-world#12" });
  expect(parsed.status).toBe(200);
  expect(parsed.body.command).toEqual({ action: "review", repo: "octocat/hello-world", number: 12, sessionId: null });
  expect(String(parsed.body.reply)).toContain("Reviewing pull request 12");
  const fixed = await call(base, `/api/ship/sessions/${sessionId}/fixes`, "POST", {
    edits: [{ path: "src.ts", find: "const a = 1;", replace: "const a = 10;" }],
  });
  expect(fixed.status).toBe(200);
  expect(fixed.body.applied).toEqual([{ path: "src.ts" }]);
  expect(readFileSync(join(worktree, "src.ts"), "utf8")).toBe("const a = 10;\n");
});

it("refuses to approve when auto-approve is off, without calling gh", async () => {
  const { base } = await serve();
  const approved = await call(base, "/api/ship/pr/approve", "POST", {
    repo: "octocat/hello-world", number: 12, files: [], checks: [],
  });
  expect(approved.status).toBe(200);
  expect(approved.body.approved).toBe(false);
  expect(String(approved.body.reason)).toContain("Auto-approve is off");
});

it("passes unknown ship paths through", async () => {
  const { base } = await serve();
  const res = await fetch(`${base}/api/ship/nope`);
  expect(res.status).toBe(404);
});
