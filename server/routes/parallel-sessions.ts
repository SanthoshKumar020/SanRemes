// Parallel sessions over HTTP: start one per queued task, read its live state, open its pull request,
// close its record. Conflicts surface in plain words; nothing here resolves them.
import { z } from "zod";

import {
  closeParallelSession, createParallelSession, defaultGhRunner, defaultGitRunner, openParallelPr,
  ParallelSessionError, refreshParallelSession,
  type GhRunner, type GitRunner, type ParallelSessionStore,
} from "../parallel-sessions.ts";
import type { TasksStore } from "../tasks-store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ParallelSessionRouteDeps {
  store: ParallelSessionStore;
  tasks: TasksStore;
  git?: GitRunner;
  gh?: GhRunner;
  /** Absent, a bot id is taken as given; present, an unknown id is refused. */
  botExists?(id: string): boolean;
}

const isJson = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
  String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";

const createBody = z.object({
  repoDir: z.string().min(1).max(1000),
  taskId: z.string().regex(/^[\w-]{1,128}$/u),
  botId: z.string().max(128),
  baseBranch: z.string().min(1).max(128).optional(),
}).strict();
const prBody = z.object({ title: z.string().min(1).max(300), body: z.string().max(5000).optional() }).strict();
const SESSION_PATH = /^\/api\/parallel-sessions\/([\w-]{1,128})(\/pr|\/close)?$/u;

export function createParallelSessionRoutes(deps: ParallelSessionRouteDeps): RouteHandler {
  const git = deps.git ?? defaultGitRunner;
  const gh = deps.gh ?? defaultGhRunner;
  const fail = (res: Parameters<RouteHandler>[0]["res"], json: Parameters<RouteHandler>[0]["json"], error: unknown) => {
    if (error instanceof ParallelSessionError) return json(res, error.status, { error: error.message });
    return json(res, 500, { error: error instanceof Error ? error.message : "Could not run that session step." });
  };
  return async ({ req, res, path, method, json, readBody }) => {
    if (path === "/api/parallel-sessions") {
      if (method === "GET") return json(res, 200, { sessions: deps.store.list() });
      if (method !== "POST") return json(res, 405, { error: "Use GET or POST." });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = createBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send a repo folder, a task id, and a bot id." });
      if (deps.botExists && !deps.botExists(parsed.data.botId)) return json(res, 404, { error: "No such bot." });
      try {
        const session = await createParallelSession(deps.store, deps.tasks, git, parsed.data);
        return json(res, 201, { session });
      } catch (error) {
        return fail(res, json, error);
      }
    }
    const single = SESSION_PATH.exec(path);
    if (!single) return PASS;
    const id = single[1]!;
    if (method === "GET" && single[2] === undefined) {
      try {
        const session = await refreshParallelSession(deps.store, git, id);
        return json(res, 200, { session });
      } catch (error) {
        return fail(res, json, error);
      }
    }
    if (method === "POST" && single[2] === "/close") {
      try {
        return json(res, 200, { session: closeParallelSession(deps.store, id) });
      } catch (error) {
        return fail(res, json, error);
      }
    }
    if (method === "POST" && single[2] === "/pr") {
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = prBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Give the pull request a title." });
      try {
        const session = await openParallelPr(deps.store, gh, id, parsed.data);
        return json(res, 200, { session });
      } catch (error) {
        return fail(res, json, error);
      }
    }
    return json(res, 405, { error: "method not allowed" });
  };
}
