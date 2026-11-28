// GET /api/running: one list of everything working right now. Rows only for what the caller may see:
// a row needs its bot visible, and a thread row needs its thread visible too.
import type { RequestAuth } from "../request-auth.ts";
import { collectRunningTasks, type RunningTasksDeps } from "../running-tasks.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const RUNNING_TASKS_PATH = "/api/running";

export interface RunningTasksRouteDeps {
  snapshot: () => RunningTasksDeps;
  visible(auth: RequestAuth): { bot(botId: string): boolean; thread(threadId: string): boolean };
}

export function createRunningTasksRoutes(deps: RunningTasksRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (path !== RUNNING_TASKS_PATH || method !== "GET") return PASS;
    const seen = deps.visible(auth);
    const rows = collectRunningTasks(deps.snapshot());
    const shown = rows.filter((row) => seen.bot(row.botId) && (row.threadId === undefined || seen.thread(row.threadId)));
    return json(res, 200, { now: Date.now(), rows: shown });
  };
}
