import { FILEGEN_TOOLS, filegenToolCallProblem, runFilegenTool, type FilegenContext, type FilegenToolResult } from "./tools.ts";

export const FILEGEN_INTERNAL_MCP_PATH = "/api/internal/filegen/mcp";

export interface FilegenRpcDeps extends FilegenContext {
  assertActive(): void;
}

export type FilegenToolsList = { tools: typeof FILEGEN_TOOLS };

export async function filegenRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: FilegenRpcDeps,
): Promise<FilegenToolsList | FilegenToolResult> {
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: FILEGEN_TOOLS };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported filegen method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  const args = params.arguments ?? {};
  const problem = filegenToolCallProblem(params.name, args);
  if (problem) {
    return { isError: true, content: [{ type: "text", text: `invalid_input: ${problem}` }], structuredContent: { code: "invalid_input", message: problem } };
  }
  deps.assertActive();
  const { assertActive, ...context } = deps;
  const result = await runFilegenTool(context, params.name as string, args as Record<string, unknown>);
  assertActive();
  return result;
}
