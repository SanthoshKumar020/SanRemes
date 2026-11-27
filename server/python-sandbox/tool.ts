// The run_python tool: what the model sees, and the handler the coordinator wires into
// the agents tool dispatch. The code runs in the sandbox in runner.ts, never on the host.
import { DEFAULT_TIMEOUT_SECONDS, MAX_CODE_CHARS, MAX_TIMEOUT_SECONDS, runPython, type PythonRunResult } from "./runner.ts";

export const RUN_PYTHON_TOOL_NAME = "run_python";

export const RUN_PYTHON_TOOL_DEFINITION = {
  name: RUN_PYTHON_TOOL_NAME,
  description:
    "Run Python 3 code in a locked sandbox and get its stdout, stderr and exit code back. Use it to compute, check data, transform a file you already have in your working folder, or test a snippet before putting it in a deliverable. The sandbox has no network and no pip installs, so only the Python standard library is available; it starts in an empty working folder, so code that needs files must create them first, and it cannot read anything outside that folder, including your working folder. A run stops after timeout_seconds (default 30, at most 120) and its output is cut off at 64 KB. Never put secrets in the code.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      code: { type: "string", description: `The Python code to run, at most ${MAX_CODE_CHARS} characters.` },
      timeout_seconds: { type: "number", description: `Seconds before the run is stopped, 1 to ${MAX_TIMEOUT_SECONDS}; default ${DEFAULT_TIMEOUT_SECONDS}.` },
    },
    required: ["code"],
  },
} as const;

/** The tool call's arguments, as the dispatcher hands them over: JSON values, unchecked. */
export interface RunPythonToolInput {
  code?: unknown;
  timeout_seconds?: unknown;
}

function parseInput(input: RunPythonToolInput): { code: string; timeoutSeconds?: number } | { error: string } {
  if (typeof input.code !== "string" || !input.code.trim()) return { error: "code: is required, the Python code to run." };
  if (input.code.length > MAX_CODE_CHARS) return { error: `code: is ${input.code.length} characters, over the ${MAX_CODE_CHARS} limit.` };
  if (input.timeout_seconds === undefined) return { code: input.code };
  if (typeof input.timeout_seconds !== "number" || !Number.isFinite(input.timeout_seconds)) return { error: "timeout_seconds: must be a number of seconds." };
  return { code: input.code, timeoutSeconds: input.timeout_seconds };
}

/** The run as plain text for the model: exit code, output, and what stopped it. */
export function formatPythonResult(result: PythonRunResult): string {
  const lines = [`exit_code: ${result.exitCode === null ? "none" : result.exitCode}`];
  if (result.note) lines.push(result.note);
  if (result.truncated) lines.push("Output was cut off at 64 KB.");
  if (result.stdout) lines.push(`stdout:\n${result.stdout}`);
  if (result.stderr) lines.push(`stderr:\n${result.stderr}`);
  if (result.files.length) lines.push(`files written: ${result.files.map((file) => `${file.name} (${file.bytes} bytes)`).join(", ")}`);
  if (!result.stdout && !result.stderr && !result.note) lines.push("(no output)");
  return lines.join("\n");
}

/** Runs the tool call and returns the text the model gets back. */
export async function executeRunPython(input: RunPythonToolInput): Promise<{ text: string; isError: boolean }> {
  const parsed = parseInput(input);
  if ("error" in parsed) return { text: parsed.error, isError: true };
  const result = await runPython({ code: parsed.code, timeoutSeconds: parsed.timeoutSeconds });
  return { text: formatPythonResult(result), isError: result.note !== null && result.exitCode === null && !result.timedOut };
}
