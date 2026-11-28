import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { TasksStore } from "../tasks-store.ts";
import { writeFileAtomic } from "../atomic.ts";

export const MAX_BATCH_PROMPTS = 50;
export const MAX_BATCH_PROMPT_CHARS = 5_000;
const MAX_RESULT_CHARS = 500;
const BATCHES_FILE = "batches.json";

export type BatchItemStatus = "done" | "failed";

export interface BatchItemResult {
  index: number;
  prompt: string;
  taskId: string;
  status: BatchItemStatus;
  result?: string;
  error?: string;
}

export interface BatchRun {
  id: string;
  botId: string;
  createdAt: number;
  prompts: string[];
  taskIds: string[];
  results: BatchItemResult[];
}

const batchItemResultSchema = z.object({
  index: z.number().int().min(0),
  prompt: z.string().max(MAX_BATCH_PROMPT_CHARS),
  taskId: z.string(),
  status: z.enum(["done", "failed"]),
  result: z.string().max(MAX_RESULT_CHARS).optional(),
  error: z.string().max(MAX_RESULT_CHARS).optional(),
}).strict();
const batchRunSchema = z.object({
  id: z.string(),
  botId: z.string(),
  createdAt: z.number(),
  prompts: z.array(z.string().max(MAX_BATCH_PROMPT_CHARS)).min(1).max(MAX_BATCH_PROMPTS),
  taskIds: z.array(z.string()),
  results: z.array(batchItemResultSchema),
}).strict();
const batchesFileSchema = z.object({ version: z.literal(1), batches: z.array(batchRunSchema) }).strict();

export type BatchExecutor = (prompt: string, item: { index: number; taskId: string }) => Promise<string>;

/** A batch is a list of prompts, one queued task each, run in order through the task queue. */
export class BatchRunner {
  private readonly store: TasksStore;
  private readonly file: string | null;
  private readonly batches = new Map<string, BatchRun>();

  constructor(store: TasksStore, options?: { dataDir?: string }) {
    this.store = store;
    this.file = options?.dataDir ? join(options.dataDir, BATCHES_FILE) : null;
    if (this.file && existsSync(this.file)) {
      try {
        const parsed = batchesFileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
        for (const batch of parsed.batches) this.batches.set(batch.id, batch);
      } catch {
        console.warn("batches: batches.json could not be read; past batches are not listed");
      }
    }
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(batchesFileSchema.parse({ version: 1, batches: [...this.batches.values()] }), null, 2)}\n`);
  }

  /** Every batch this process knows, including ones a restart cut off: the record survives, so a batch
   * started before a restart can be listed and resumed instead of vanishing with the process. */
  list(): BatchRun[] {
    return [...this.batches.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Batches with prompts still to run. */
  listActive(): BatchRun[] {
    return this.list().filter((batch) => batch.results.length < batch.prompts.length);
  }

  createBatch(botId: string, prompts: readonly string[]): BatchRun {
    if (!prompts.length) throw new Error("Send at least one prompt.");
    if (prompts.length > MAX_BATCH_PROMPTS) throw new Error(`Send at most ${MAX_BATCH_PROMPTS} prompts.`);
    const cleaned = prompts.map((prompt) => prompt.trim());
    if (cleaned.some((prompt) => !prompt || prompt.length > MAX_BATCH_PROMPT_CHARS)) {
      throw new Error("Each prompt must be non-empty and at most 5000 characters.");
    }
    const batch: BatchRun = {
      id: randomUUID(),
      botId,
      createdAt: Date.now(),
      prompts: cleaned,
      taskIds: [],
      results: [],
    };
    batch.taskIds = cleaned.map((prompt) =>
      this.store.create({
        title: prompt.length > 80 ? `${prompt.slice(0, 77)}…` : prompt,
        goal: prompt,
        assigneeBotId: botId,
      }).id,
    );
    this.batches.set(batch.id, batch);
    this.save();
    return batch;
  }

  getBatch(id: string): BatchRun | undefined {
    return this.batches.get(id);
  }

  /** Runs the prompts a restart — or a failure — left unrun, in their original order; prompts already done or
   * failed are not run again. */
  async resumeBatch(
    batch: BatchRun,
    executor: BatchExecutor,
    onItem?: (result: BatchItemResult) => void,
  ): Promise<BatchRun> {
    for (let index = batch.results.length; index < batch.prompts.length; index += 1) {
      const prompt = batch.prompts[index]!;
      const taskId = batch.taskIds[index]!;
      const result = await this.runItem(batch.botId, index, prompt, taskId, executor);
      batch.results.push(result);
      this.save();
      onItem?.(result);
    }
    return batch;
  }

  /** Runs each prompt through its task and records the outcome per item; one failure never stops the batch. */
  async runBatch(
    batch: BatchRun,
    executor: BatchExecutor,
    onItem?: (result: BatchItemResult) => void,
  ): Promise<BatchRun> {
    for (let index = 0; index < batch.prompts.length; index += 1) {
      const prompt = batch.prompts[index]!;
      const taskId = batch.taskIds[index]!;
      const result = await this.runItem(batch.botId, index, prompt, taskId, executor);
      batch.results.push(result);
      this.save();
      onItem?.(result);
    }
    return batch;
  }

  private async runItem(
    botId: string,
    index: number,
    prompt: string,
    taskId: string,
    executor: BatchExecutor,
  ): Promise<BatchItemResult> {
    const fail = (error: string, claimed: boolean): BatchItemResult => {
      const message = error.slice(0, MAX_RESULT_CHARS);
      if (claimed) this.store.fail(taskId, botId, message);
      return { index, prompt, taskId, status: "failed", error: message };
    };
    const claimed = this.store.claim(taskId, botId);
    if (claimed === null || claimed === "not-queued") return fail("That task is no longer queued.", false);
    const started = this.store.start(taskId, botId);
    if (started === null || started === "not-claimed" || started === "not-locked-by") {
      return fail("That task could not be started.", true);
    }
    try {
      const result = await executor(prompt, { index, taskId });
      this.store.complete(taskId, botId, result.slice(0, MAX_RESULT_CHARS) || "completed");
      return { index, prompt, taskId, status: "done", result };
    } catch (error) {
      return fail(error instanceof Error ? error.message : "The prompt failed.", true);
    }
  }

  /** Live counts for a batch, read from the queue rather than from remembered results. */
  status(batch: BatchRun): { queued: number; claimed: number; running: number; done: number; failed: number } {
    const counts = { queued: 0, claimed: 0, running: 0, done: 0, failed: 0 };
    for (const taskId of batch.taskIds) {
      const task = this.store.get(taskId);
      if (task) counts[task.state] += 1;
    }
    return counts;
  }
}

/** The batch's outcome in one line per prompt, for the person who queued it. */
export function batchSummary(batch: BatchRun): string {
  const done = batch.results.filter((result) => result.status === "done").length;
  const failed = batch.results.filter((result) => result.status === "failed").length;
  const lines = [`Batch ${batch.id}: ${done} done, ${failed} failed, ${batch.prompts.length - batch.results.length} not run yet.`];
  for (const result of batch.results) {
    lines.push(result.status === "done" ? `- ${result.index + 1}. Done` : `- ${result.index + 1}. Failed: ${result.error ?? "unknown error"}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The tool a bot offers for bulk work; the runner behind it is wired where bot tools are registered. */
export const BATCH_RUNNER_TOOL = {
  name: "run_batch",
  description: "Run a list of prompts as queued tasks and collect one result per prompt.",
  inputSchema: {
    type: "object",
    properties: {
      prompts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_BATCH_PROMPTS },
    },
    required: ["prompts"],
    additionalProperties: false,
  },
} as const;
