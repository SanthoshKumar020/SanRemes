import { describe, expect, it } from "vitest";

import { qwenSetupDue } from "./QwenSetupGate";

describe("qwenSetupDue", () => {
  it("waits while the install runs", () => {
    expect(qwenSetupDue({ state: "starting" })).toBe(true);
    expect(qwenSetupDue({ state: "pulling", percent: 25 })).toBe(true);
  });

  it("stays out of the way otherwise", () => {
    expect(qwenSetupDue(undefined)).toBe(false);
    expect(qwenSetupDue({ state: "idle" })).toBe(false);
    expect(qwenSetupDue({ state: "ready", instanceId: "ollama" })).toBe(false);
    expect(qwenSetupDue({ state: "failed", error: "no Ollama binary" })).toBe(false);
  });
});
