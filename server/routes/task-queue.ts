// Ticketed-task queue over HTTP. GET /api/tasks lists; POST creates; POST /api/tasks/:id/claim checks a task out
// to one bot; POST /api/tasks/:id/complete and /fail release it and record the outcome.
// This is the queue, not the conversation tasks in routes/tasks.ts.
import { z } from "zod";

import { taskStateSchema } from "../../shared/tasks.ts";
import type { TasksStore } from "../tasks-store.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const TASKS_PATH = "/api/tasks";

export interface TaskQueueRouteDeps {
  store: TasksStore;
  /** Absent, a bot id is taken as given; present, an unknown id is refused. */
  botExists?(id: string): boolean;
}

const isJson = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
  String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";

const createBody = z.object({
  title: z.string().min(1).max(300),
  goal: z.string().max(5000).optional(),
  assigneeBotId: z.string().max(128).nullable().optional(),
}).strict();
const claimBody = z.object({ botId: z.string().max(128) }).strict();
const finishBody = z.object({ botId: z.string().max(128), result: z.string().max(500).optional() }).strict();
const ACTION = /^([\w-]{1,128})\/(claim|complete|fail)$/u;

export function createTaskQueueRoutes(deps: TaskQueueRouteDeps): RouteHandler {
  const { store } = deps;
  const state = () => ({ version: store.version, tasks: store.list() });
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path === TASKS_PATH) {
      if (method === "GET") {
        const wanted = url.searchParams.get("state");
        if (wanted !== null && !taskStateSchema.safeParse(wanted).success) {
          return json(res, 400, { error: "state must be queued, claimed, running, done or failed" });
        }
        return json(res, 200, { version: store.version, tasks: store.list(wanted === null ? undefined : taskStateSchema.parse(wanted)) });
      }
      if (method !== "POST") return json(res, 405, { error: "Use GET or POST." });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const body = createBody.safeParse(await readBody(req, 64_000));
      if (!body.success) return json(res, 400, { error: "Send a title for the task." });
      if (body.data.assigneeBotId && deps.botExists && !deps.botExists(body.data.assigneeBotId)) {
        return json(res, 400, { error: "No such bot." });
      }
      return json(res, 201, { task: store.create(body.data) });
    }
    if (!path.startsWith(`${TASKS_PATH}/`)) return PASS;
    const action = ACTION.exec(path.slice(TASKS_PATH.length + 1));
    if (!action) return json(res, 404, { error: "no such task" });
    const [id, verb] = [action[1]!, action[2]! as "claim" | "complete" | "fail"];
    if (method !== "POST") return json(res, 405, { error: "Use POST." });
    if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
    const task = store.get(id);
    if (!task) return json(res, 404, { error: "no such task" });
    if (verb === "claim") {
      const body = claimBody.safeParse(await readBody(req, 4096));
      if (!body.success) return json(res, 400, { error: "Send the bot id claiming the task." });
      if (deps.botExists && !deps.botExists(body.data.botId)) return json(res, 404, { error: "No such bot." });
      const claimed = store.claim(id, body.data.botId);
      if (claimed === null) return json(res, 404, { error: "no such task" });
      return claimed === "not-queued"
        ? json(res, 409, { error: "That task is not queued.", state: task.state })
        : json(res, 200, { task: claimed });
    }
    const body = finishBody.safeParse(await readBody(req, 4096));
    if (!body.success) return json(res, 400, { error: "Send the bot id finishing the task." });
    if (deps.botExists && !deps.botExists(body.data.botId)) return json(res, 404, { error: "No such bot." });
    const finished = verb === "complete"
      ? store.complete(id, body.data.botId, body.data.result)
      : store.fail(id, body.data.botId, body.data.result);
    if (finished === null) return json(res, 404, { error: "no such task" });
    if (finished === "not-claimed") return json(res, 409, { error: "That task is not claimed.", state: task.state });
    if (finished === "not-locked-by") return json(res, 409, { error: "That task is locked by another bot.", lockedBy: task.lockedBy });
    return json(res, 200, { task: finished, ...state() });
  };
}
