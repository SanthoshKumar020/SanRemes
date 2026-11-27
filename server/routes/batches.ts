import { z } from "zod";

import { batchSummary, type BatchExecutor, type BatchRunner } from "../batch-runner/batch-runner.ts";
import { PASS, type RouteHandler } from "./table.ts";

const bodySchema = z.object({
  botId: z.string().min(1),
  threadId: z.string().min(1),
  prompts: z.array(z.string()).min(1).max(50),
}).strict();

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
  return async ({ res, path, method, json }) => {
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
