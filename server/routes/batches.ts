import { z } from "zod";

import { batchSummary, type BatchExecutor, type BatchRunner } from "../batch-runner/batch-runner.ts";
import { PASS, type RouteHandler } from "./table.ts";

const bodySchema = z.object({
  botId: z.string().min(1),
  threadId: z.string().min(1),
  prompts: z.array(z.string()).min(1).max(50),
}).strict();
const BATCH_PATH = /^\/api\/internal\/batches\/([\w-]{1,128})(\/resume)?$/u;

export interface BatchRouteDeps {
  requireActive(): void;
  readBody(): Promise<unknown>;
  botId(): string;
  threadId(): string;
  runner: BatchRunner;
  /** Runs one prompt as its own turn of the bot and resolves with the reply. */
  runPrompt(botId: string, prompt: string): Promise<string>;
  /** The batch's summary, delivered to the thread that asked for it. */
  noteDone(botId: string, threadId: string, text: string): void;
}

/** The run_batch tool: queue the prompts, run them one turn each in the background, collect the results. */
export function createBatchRoutes(deps: BatchRouteDeps): RouteHandler {
  const running = new Map<string, string>();
  const resume = (batchId: string) => {
    const batch = deps.runner.getBatch(batchId);
    if (!batch || batch.botId !== deps.botId()) return null;
    if (batch.results.length >= batch.prompts.length) return "done";
    const active = running.get(batch.botId);
    if (active) return "busy";
    running.set(batch.botId, batch.id);
    const executor: BatchExecutor = (prompt) => deps.runPrompt(batch.botId, prompt);
    void deps.runner.resumeBatch(batch, executor).then((finished) => {
      deps.noteDone(batch.botId, deps.threadId(), batchSummary(finished));
    }).catch((error) => {
      deps.noteDone(batch.botId, deps.threadId(), `Batch ${batch.id} stopped early: ${error instanceof Error ? error.message : "unknown error"}`);
    }).finally(() => {
      running.delete(batch.botId);
    });
    return batch;
  };
  return async ({ res, path, method, json }) => {
    const single = BATCH_PATH.exec(path);
    if (single) {
      const batchId = single[1]!;
      if (method === "GET" && single[2] === undefined) {
        deps.requireActive();
        const batch = deps.runner.getBatch(batchId);
        if (!batch || batch.botId !== deps.botId()) return json(res, 404, { error: "No such batch." });
        return json(res, 200, { batch, status: deps.runner.status(batch), running: running.get(batch.botId) === batch.id });
      }
      if (method === "POST" && single[2] === "/resume") {
        deps.requireActive();
        const resumed = resume(batchId);
        if (resumed === null) return json(res, 404, { error: "No such batch." });
        if (resumed === "done") return json(res, 409, { error: `Batch ${batchId} already ran every prompt.` });
        if (resumed === "busy") return json(res, 409, { error: `Batch ${running.get(deps.botId())} is still running for this bot. Wait for its summary before starting another.` });
        return json(res, 202, { batchId: resumed.id, remaining: resumed.prompts.length - resumed.results.length });
      }
      return json(res, 405, { error: "method not allowed" });
    }
    if (path !== "/api/internal/batches") return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    deps.requireActive();
    const parsed = bodySchema.safeParse(await deps.readBody());
    if (!parsed.success) return json(res, 400, { error: "A batch needs a list of prompts." });
    const { botId, threadId, prompts } = parsed.data;
    if (botId !== deps.botId() || threadId !== deps.threadId()) return json(res, 403, { error: "A batch runs only for the bot and thread that asked for it." });
    const active = running.get(botId);
    if (active) return json(res, 409, { error: `Batch ${active} is still running for this bot. Wait for its summary before starting another.` });
    let batch;
    try {
      batch = deps.runner.createBatch(botId, prompts);
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : "Could not queue that batch." });
    }
    running.set(botId, batch.id);
    const executor: BatchExecutor = (prompt) => deps.runPrompt(botId, prompt);
    void deps.runner.runBatch(batch, executor).then((done) => {
      deps.noteDone(botId, threadId, batchSummary(done));
    }).catch((error) => {
      deps.noteDone(botId, threadId, `Batch ${batch.id} stopped early: ${error instanceof Error ? error.message : "unknown error"}`);
    }).finally(() => {
      running.delete(botId);
    });
    return json(res, 201, { batchId: batch.id, queued: batch.prompts.length });
  };
}
