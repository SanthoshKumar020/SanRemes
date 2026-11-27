import type { ToolCallContext } from "./agents-call.ts";

type BatchApi = (path: string, init: { method: string; body: string }) => Promise<Record<string, unknown>>;

export async function callBatchTool(args: Record<string, unknown>, context: ToolCallContext, api: BatchApi): Promise<{ text: string; isError?: boolean }> {
  const prompts = Array.isArray(args.prompts) ? args.prompts.map((prompt) => String(prompt ?? "").trim()).filter(Boolean) : [];
  if (!prompts.length) return { text: "run_batch needs prompts: a list of at least one prompt.", isError: true };
  const r = await api("/api/internal/batches", { method: "POST", body: JSON.stringify({ botId: context.botId, threadId: context.threadId, prompts }) });
  if (r.error) return { text: `Couldn't start that batch: ${String(r.error)}`, isError: true };
  return { text: `Batch ${String(r.batchId)}: ${String(r.queued)} prompt(s) queued and running in the background, one turn each. Results land in the task queue, and a summary arrives in this chat when it finishes. Say so in one short line and end your turn; do not wait for it here.` };
}
