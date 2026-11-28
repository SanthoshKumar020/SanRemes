// Hosted batches over HTTP: the Phase 0 local batch runner offered as a cloud job.
// A job names its prompts, its bot, and its target executor. The executor is decided
// before anything is queued: a cloud target with no cloud executor attached is refused
// in plain words and nothing is created. A local job runs in the background through
// the local runner, one prompt per queued task, and reports per item.
import { z } from "zod";

import type { ExecutorRegistry } from "../executors.ts";
import { BatchRunner, type BatchExecutor, type BatchRun } from "../batch-runner/batch-runner.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface HostedBatchRouteDeps {
  runner: BatchRunner;
  registry: ExecutorRegistry;
  botExists?(id: string): boolean;
  /** Runs one prompt as its own turn of the bot and resolves with the reply. */
  runPrompt(botId: string, prompt: string): Promise<string>;
}

const isJson = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
  String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";

const submitBody = z.object({
  botId: z.string().min(1).max(128),
  prompts: z.array(z.string().min(1).max(5000)).min(1).max(50),
  executor: z.enum(["auto", "local", "cloud"]).optional(),
  label: z.string().max(200).optional(),
}).strict();
const BATCH_PATH = /^\/api\/hosted-batches\/([\w-]{1,128})$/u;

export function createHostedBatchRoutes(deps: HostedBatchRouteDeps): RouteHandler {
  const running = new Set<string>();
  const start = (batch: BatchRun) => {
    if (running.has(batch.id)) return;
    running.add(batch.id);
    const executor: BatchExecutor = (prompt) => deps.runPrompt(batch.botId, prompt);
    void deps.runner.runBatch(batch, executor).catch(() => {}).finally(() => {
      running.delete(batch.id);
    });
  };
  return async ({ req, res, path, method, json, readBody }) => {
    if (path === "/api/hosted-batches") {
      if (method === "GET") {
        return json(res, 200, {
          batches: deps.runner.list(),
          cloudAttached: deps.registry.cloudAttached(),
        });
      }
      if (method !== "POST") return json(res, 405, { error: "Use GET or POST." });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = submitBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send a bot and at least one prompt." });
      if (deps.botExists && !deps.botExists(parsed.data.botId)) return json(res, 404, { error: "No such bot." });
      const { executor, note } = deps.registry.resolve(parsed.data.executor ?? "auto");
      try {
        const batch = deps.runner.createBatch(parsed.data.botId, parsed.data.prompts);
        start(batch);
        return json(res, 202, { batch, executor: executor.kind, ...(note ? { note } : {}) });
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Could not start that batch." });
      }
    }
    const single = BATCH_PATH.exec(path);
    if (!single) return PASS;
    if (method !== "GET") return json(res, 405, { error: "Use GET." });
    const batch = deps.runner.getBatch(single[1]!);
    if (!batch) return json(res, 404, { error: "No such batch." });
    return json(res, 200, { batch, status: deps.runner.status(batch), running: running.has(batch.id) });
  };
}
