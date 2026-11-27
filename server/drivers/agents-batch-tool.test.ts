import { describe, expect, it, vi } from "vitest";
import { callBatchTool } from "./agents-batch-tool.ts";
import type { ToolCallContext } from "./agents-call.ts";

const context = { botId: "scout", threadId: "t1" } as ToolCallContext;

describe("callBatchTool", () => {
  it("starts the batch and tells the turn to end without waiting", async () => {
    const api = vi.fn(async () => ({ batchId: "b1", queued: 2 }));
    const result = await callBatchTool({ prompts: ["one", "two"] }, context, api);
    expect(api).toHaveBeenCalledWith("/api/internal/batches", { method: "POST",
      body: JSON.stringify({ botId: "scout", threadId: "t1", prompts: ["one", "two"] }) });
    expect(result.text).toContain("Batch b1: 2 prompt(s) queued");
    expect(result.text).toContain("do not wait for it here");
    expect(result.isError).toBeUndefined();
  });

  it("refuses an empty prompt list and a failed start", async () => {
    const api = vi.fn(async () => ({ batchId: "b1", queued: 1 }));
    expect((await callBatchTool({ prompts: [] }, context, api)).isError).toBe(true);
    expect((await callBatchTool({ prompts: ["  "] }, context, api)).isError).toBe(true);
    expect(api).not.toHaveBeenCalled();
    const failing = vi.fn(async () => ({ error: "a batch is already running" }));
    const failed = await callBatchTool({ prompts: ["one"] }, context, failing);
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("a batch is already running");
  });
});
