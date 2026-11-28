// Parallel sessions over the executor contract: the same branch, worktree and pull
// request flow as the local sessions, run through whichever executor the hand-off
// decision resolves. With no cloud executor attached the cloud side refuses in plain
// words; the local side runs here, on this computer.
import { z } from "zod";

import { CloudExecutorError, type ExecutorRegistry } from "../executors.ts";
import { ParallelSessionError, type ParallelSessionStore } from "../parallel-sessions.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CloudSessionRouteDeps {
  store: ParallelSessionStore;
  registry: ExecutorRegistry;
  botExists?(id: string): boolean;
}

const isJson = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
  String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";

const createBody = z.object({
  repoDir: z.string().min(1).max(1000),
  taskId: z.string().regex(/^[\w-]{1,128}$/u),
  botId: z.string().max(128),
  baseBranch: z.string().min(1).max(128).optional(),
  executor: z.enum(["auto", "local", "cloud"]).optional(),
}).strict();
const prBody = z.object({ title: z.string().min(1).max(300), body: z.string().max(5000).optional() }).strict();
const SESSION_PATH = /^\/api\/cloud-sessions\/([\w-]{1,128})(\/pr|\/close)?$/u;

export function createCloudSessionRoutes(deps: CloudSessionRouteDeps): RouteHandler {
  const fail = (res: Parameters<RouteHandler>[0]["res"], json: Parameters<RouteHandler>[0]["json"], error: unknown) => {
    if (error instanceof CloudExecutorError) return json(res, error.status, { error: error.message });
    if (error instanceof ParallelSessionError) return json(res, error.status, { error: error.message });
    return json(res, 500, { error: error instanceof Error ? error.message : "Could not run that session step." });
  };
  return async ({ req, res, path, method, json, readBody }) => {
    if (path === "/api/cloud-sessions") {
      if (method === "GET") {
        return json(res, 200, {
          sessions: deps.store.list(),
          cloudAttached: deps.registry.cloudAttached(),
        });
      }
      if (method !== "POST") return json(res, 405, { error: "Use GET or POST." });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = createBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send a repo folder, a task id, and a bot id." });
      if (deps.botExists && !deps.botExists(parsed.data.botId)) return json(res, 404, { error: "No such bot." });
      const { executor, note } = deps.registry.resolve(parsed.data.executor ?? "auto");
      try {
        const session = await executor.startSession(parsed.data);
        return json(res, 201, { session, executor: executor.kind, ...(note ? { note } : {}) });
      } catch (error) {
        return fail(res, json, error);
      }
    }
    const single = SESSION_PATH.exec(path);
    if (!single) return PASS;
    const id = single[1]!;
    if (method === "GET" && single[2] === undefined) {
      const session = deps.store.get(id);
      if (!session) return json(res, 404, { error: "No such session." });
      try {
        return json(res, 200, { session: await deps.registry.local.refreshSession(id) });
      } catch (error) {
        return fail(res, json, error);
      }
    }
    if (method === "POST" && single[2] === "/close") {
      try {
        return json(res, 200, { session: await deps.registry.local.closeSession(id) });
      } catch (error) {
        return fail(res, json, error);
      }
    }
    if (method === "POST" && single[2] === "/pr") {
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = prBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Give the pull request a title." });
      try {
        return json(res, 200, { session: await deps.registry.local.openSessionPr(id, parsed.data) });
      } catch (error) {
        return fail(res, json, error);
      }
    }
    return json(res, 405, { error: "method not allowed" });
  };
}
