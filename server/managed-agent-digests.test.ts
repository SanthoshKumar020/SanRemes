import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ManagedAgentStore } from "./managed-agents.ts";
import { buildAgentDigest, dreamManagedAgents, ManagedAgentDigestStore } from "./managed-agent-digests.ts";
import type { ManagedAgent, ManagedAgentRun } from "../shared/managed-agents.ts";

function agent(overrides: Partial<ManagedAgent> = {}): ManagedAgent {
  return {
    id: "agent-1", name: "Briefing", botId: "scout", instructions: "Brief me.",
    schedule: { type: "manual" }, allowedTools: [], capPeriod: "month",
    enabled: true, executorPreference: "auto", nextRunAt: null,
    createdAt: 1000, updatedAt: 1000, ...overrides,
  };
}

function run(overrides: Partial<ManagedAgentRun> = {}): ManagedAgentRun {
  return {
    id: "run-1", agentId: "agent-1", status: "completed", executor: "local", manual: false,
    startedAt: 2000, finishedAt: 3000, durationMs: 1000, usageReported: true,
    ...overrides,
  };
}

describe("buildAgentDigest", () => {
  it("consolidates a window of runs into plain words", () => {
    const digest = buildAgentDigest(agent(), [
      run({ id: "run-1", startedAt: 2000, durationMs: 1000, inputTokens: 100, outputTokens: 50, costUsd: 0.01, result: "Briefed 3 items." }),
      run({ id: "run-2", startedAt: 3000, status: "failed", durationMs: 2000, error: "Rate limit." }),
      run({ id: "run-3", startedAt: 1000 }),
    ], 9000, 1500);
    expect(digest.runs).toBe(2);
    expect(digest.completed).toBe(1);
    expect(digest.failed).toBe(1);
    expect(digest.totalCostUsd).toBe(0.01);
    expect(digest.avgDurationMs).toBe(1500);
    expect(digest.lastResult).toBe("Rate limit.");
    expect(digest.text).toContain("Briefing ran 2 times since 1970-01-01: 1 completed, 1 failed, 0 stopped.");
    expect(digest.text).toContain("Total cost $0.01.");
  });

  it("handles an empty window without crashing", () => {
    const digest = buildAgentDigest(agent(), [], 9000, 8000);
    expect(digest.runs).toBe(0);
    expect(digest.text).toContain("ran 0 times");
    expect(digest.totalCostUsd).toBeNull();
  });
});

describe("dreamManagedAgents", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "sanremes-agent-dreams-"));

  it("dreams each agent once a day, only when it has new runs", () => {
    const dataDir = dir();
    try {
      const store = new ManagedAgentStore({ dataDir, now: () => 10_000 });
      const digests = new ManagedAgentDigestStore({ dataDir });
      const created = store.create({ name: "Briefing", botId: "scout", instructions: "Brief me." });
      expect(dreamManagedAgents({ store, digests, now: () => 10_000 })).toEqual([]);
      store.recordRun(run({ agentId: created.id, startedAt: 5000, finishedAt: 6000, durationMs: 1000 }));
      expect(dreamManagedAgents({ store, digests, now: () => 10_000 })).toEqual([created.id]);
      expect(digests.latest(created.id)?.runs).toBe(1);
      expect(dreamManagedAgents({ store, digests, now: () => 11_000 })).toEqual([]);
      store.recordRun(run({ id: "run-2", agentId: created.id, startedAt: 20_000, finishedAt: 21_000, durationMs: 1000 }));
      expect(dreamManagedAgents({ store, digests, now: () => 10_000 + 24 * 60 * 60_000 })).toEqual([created.id]);
      expect(digests.latest(created.id)?.runs).toBe(1);
      expect(digests.for(created.id)).toHaveLength(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
