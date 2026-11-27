import { describe, expect, it } from "vitest";

import { executeRunPython, formatPythonResult, RUN_PYTHON_TOOL_DEFINITION } from "./tool.ts";
import { MAX_CODE_CHARS } from "./runner.ts";

describe("run_python tool", () => {
  it("advertises code with a timeout and nothing else", () => {
    expect(RUN_PYTHON_TOOL_DEFINITION.name).toBe("run_python");
    expect(RUN_PYTHON_TOOL_DEFINITION.inputSchema.required).toEqual(["code"]);
    expect(Object.keys(RUN_PYTHON_TOOL_DEFINITION.inputSchema.properties).sort()).toEqual(["code", "timeout_seconds"]);
  });

  it("rejects a missing or empty code argument", async () => {
    for (const input of [{}, { code: "" }, { code: "  " }, { code: 42 }]) {
      const result = await executeRunPython(input);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("code:");
    }
  });

  it("rejects code over the limit and a non-numeric timeout", async () => {
    const over = await executeRunPython({ code: "x".repeat(MAX_CODE_CHARS + 1) });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("over the");
    const badTimeout = await executeRunPython({ code: "print(1)", timeout_seconds: "soon" });
    expect(badTimeout.isError).toBe(true);
    expect(badTimeout.text).toContain("timeout_seconds:");
  });

  it("formats a finished run as exit code plus output", () => {
    const text = formatPythonResult({
      stdout: "42\n", stderr: "", exitCode: 0, timedOut: false, truncated: false,
      seccomp: true, durationMs: 12, files: [{ name: "out.txt", bytes: 3 }], note: null,
    });
    expect(text).toContain("exit_code: 0");
    expect(text).toContain("stdout:\n42");
    expect(text).toContain("files written: out.txt (3 bytes)");
    expect(text).not.toContain("stderr:");
  });

  it("formats a timeout and truncation in plain words", () => {
    const text = formatPythonResult({
      stdout: "x", stderr: "", exitCode: null, timedOut: true, truncated: true,
      seccomp: true, durationMs: 3000, files: [], note: "Stopped after 3 seconds: the code was still running.",
    });
    expect(text).toContain("exit_code: none");
    expect(text).toContain("Stopped after 3 seconds");
    expect(text).toContain("Output was cut off at 64 KB.");
  });

  it("says so when a run produced no output at all", () => {
    const text = formatPythonResult({
      stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false,
      seccomp: true, durationMs: 5, files: [], note: null,
    });
    expect(text).toContain("(no output)");
  });
});
