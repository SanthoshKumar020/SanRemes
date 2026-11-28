import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentExecutor } from "../executors.ts";
import { ManagedAgentStore } from "../managed-agents.ts";
import { duetAgentInput, DUET_AGENT_NAME, runDuetAgent } from "./schedule.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sanremes-duet-schedule-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("duetAgentInput", () => {
  it("is a daily local agent with no tools and a morning time", () => {
    const input = duetAgentInput("bot1");
    expect(input.name).toBe(DUET_AGENT_NAME);
    expect(input.schedule).toEqual({ type: "daily", time: "07:30" });
    expect(input.executorPreference).toBe("local");
    expect(input.allowedTools).toEqual([]);
    expect(input.instructions).toContain("Never send");
    expect(duetAgentInput("bot1", "08:00").schedule).toEqual({ type: "daily", time: "08:00" });
  });
});

describe("runDuetAgent", () => {
  it("runs once through the managed-agent runner and records the run", async () => {
    const agentStore = new ManagedAgentStore({ dataDir: dir });
    const agent = agentStore.create(duetAgentInput("bot1"));
    const executor = {
      kind: "local",
      label: "fake",
      attached: () => true,
      runPrompt: async () => ({ text: "attention list", durationMs: 1 }),
    } as unknown as AgentExecutor;
    const run = await runDuetAgent({ agentStore, dataDir: dir, executor }, agent);
    expect(run.status).toBe("completed");
    expect(run.result).toBe("attention list");
    expect(agentStore.runsFor(agent.id)).toHaveLength(1);
  });
});
