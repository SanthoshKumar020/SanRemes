import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TasksStore } from "../tasks-store.ts";
import { BATCH_RUNNER_TOOL, BatchRunner, batchSummary } from "./batch-runner.ts";

let dir: string;
let store: TasksStore;
let runner: BatchRunner;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sanremes-batch-"));
  store = new TasksStore({ dataDir: dir });
  runner = new BatchRunner(store);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("BatchRunner.createBatch", () => {
  it("queues one task per prompt, attributable to its prompt", () => {
    const batch = runner.createBatch("scout", ["First prompt", "Second prompt"]);
    expect(batch.taskIds).toHaveLength(2);
    expect(store.list("queued")).toHaveLength(2);
    expect(store.get(batch.taskIds[0]!)!.goal).toBe("First prompt");
    expect(store.get(batch.taskIds[1]!)!.goal).toBe("Second prompt");
    expect(store.get(batch.taskIds[0]!)!.assigneeBotId).toBe("scout");
  });

  it("rejects an empty list, too many prompts and an empty prompt", () => {
    expect(() => runner.createBatch("scout", [])).toThrow("at least one prompt");
    expect(() => runner.createBatch("scout", Array.from({ length: 51 }, (_, i) => `prompt ${i}`))).toThrow("at most 50 prompts");
    expect(() => runner.createBatch("scout", ["  "])).toThrow("non-empty");
    expect(() => runner.createBatch("scout", ["x".repeat(5001)])).toThrow("at most 5000 characters");
  });
});

describe("BatchRunner.runBatch", () => {
  it("collects one result per prompt in order", async () => {
    const batch = runner.createBatch("scout", ["one", "two", "three"]);
    await runner.runBatch(batch, async (prompt) => `answer to ${prompt}`);
    expect(batch.results.map((result) => result.status)).toEqual(["done", "done", "done"]);
    expect(batch.results.map((result) => result.result)).toEqual(["answer to one", "answer to two", "answer to three"]);
    expect(batch.results.map((result) => result.prompt)).toEqual(["one", "two", "three"]);
    expect(store.list("done")).toHaveLength(3);
    expect(batchSummary(batch)).toContain("Batch " + batch.id + ": 3 done, 0 failed, 0 not run yet.");
  });

  it("records a per-item failure and keeps running the rest", async () => {
    const batch = runner.createBatch("scout", ["good", "bad", "good again"]);
    await runner.runBatch(batch, async (prompt) => {
      if (prompt === "bad") throw new Error("model timed out");
      return `ok ${prompt}`;
    });
    expect(batch.results).toHaveLength(3);
    expect(batch.results[1]).toMatchObject({ status: "failed", error: "model timed out", prompt: "bad" });
    expect(batch.results[2]).toMatchObject({ status: "done", result: "ok good again" });
    expect(store.list("done")).toHaveLength(2);
    expect(store.list("failed")).toHaveLength(1);
    expect(store.get(batch.taskIds[1]!)!.history.at(-1)?.result).toBe("model timed out");
    expect(batchSummary(batch)).toContain("2 done, 1 failed");
    expect(batchSummary(batch)).toContain("2. Failed: model timed out");
  });

  it("reports live queue counts from the store", async () => {
    const batch = runner.createBatch("scout", ["one", "two"]);
    expect(runner.status(batch)).toEqual({ queued: 2, claimed: 0, running: 0, done: 0, failed: 0 });
    await runner.runBatch(batch, async () => "done");
    expect(runner.status(batch)).toEqual({ queued: 0, claimed: 0, running: 0, done: 2, failed: 0 });
  });

  it("exposes a tool definition for the bot to offer", () => {
    expect(BATCH_RUNNER_TOOL.name).toBe("run_batch");
    expect(BATCH_RUNNER_TOOL.inputSchema.properties.prompts.maxItems).toBe(50);
  });
});
