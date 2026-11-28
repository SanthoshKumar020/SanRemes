import { describe, expect, it } from "vitest";

import { buildCloudUsageReport, cloudUsageCsv } from "./cloud-usage-report.ts";
import type { UsageRow } from "./usage-ledger.ts";
import type { ManagedAgentRun } from "../shared/managed-agents.ts";

function row(overrides: Partial<UsageRow>): UsageRow {
  return {
    at: "2026-11-28T10:00:00.000Z",
    botId: "scout",
    botName: "Scout",
    threadId: "",
    instanceId: "",
    driverKind: "local",
    model: "sonnet",
    input: 100,
    output: 50,
    costUsd: 0.01,
    trigger: { kind: "managed-agent", agentId: "agent-1", agentName: "Briefing", executor: "local", runId: "run-1" },
    ...overrides,
  };
}

function run(overrides: Partial<ManagedAgentRun>): ManagedAgentRun {
  return {
    id: "run-1",
    agentId: "agent-1",
    status: "completed",
    executor: "local",
    manual: true,
    startedAt: 1,
    finishedAt: 2,
    durationMs: 1,
    usageReported: true,
    ...overrides,
  };
}

describe("buildCloudUsageReport", () => {
  it("groups ledger rows by agent and job and counts runs from run records", () => {
    const report = buildCloudUsageReport({
      from: new Date("2026-11-01T00:00:00.000Z"),
      to: new Date("2026-11-30T00:00:00.000Z"),
      rows: [
        row({}),
        row({ input: 200, output: 100, costUsd: 0.02, trigger: { kind: "managed-agent", agentId: "agent-1", agentName: "Briefing", executor: "local", runId: "run-2" } }),
        row({ input: 10, output: 5, costUsd: null, trigger: { kind: "cloud-job", jobId: "batch-1", label: "Hosted batch", executor: "cloud" } }),
        row({ input: 1, output: 1, costUsd: null, trigger: { kind: "user", label: "Ada" } }),
      ],
      agentRuns: [run({}), run({ id: "run-2", usageReported: true })],
      agentNames: new Map([["agent-1", "Briefing"]]),
    });
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]).toMatchObject({ agentId: "agent-1", agentName: "Briefing", runs: 2, inputTokens: 300, outputTokens: 150, costUsd: 0.03, unreportedRuns: 0 });
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0]).toMatchObject({ jobId: "batch-1", label: "Hosted batch", executor: "cloud", runs: 1, inputTokens: 10, outputTokens: 5, costUsd: null });
    expect(report.totalInputTokens).toBe(310);
    expect(report.totalOutputTokens).toBe(155);
    expect(report.totalCostUsd).toBe(0.03);
    expect(report.unpricedRows).toBe(1);
  });

  it("groups managed-agent spend by project tag, untagged rows under Untagged", () => {
    const report = buildCloudUsageReport({
      from: new Date("2026-11-01T00:00:00.000Z"),
      to: new Date("2026-11-30T00:00:00.000Z"),
      rows: [
        row({ project: "alpha", trigger: { kind: "managed-agent", agentId: "agent-1", agentName: "Briefing", executor: "local", runId: "run-1" } }),
        row({ project: "alpha", input: 50, output: 25, costUsd: 0.005, trigger: { kind: "managed-agent", agentId: "agent-1", agentName: "Briefing", executor: "local", runId: "run-1" } }),
        row({ input: 10, output: 5, costUsd: null, trigger: { kind: "managed-agent", agentId: "agent-2", agentName: "Other", executor: "local", runId: "run-2" } }),
      ],
      agentRuns: [run({}), run({ id: "run-2", agentId: "agent-2" })],
      agentNames: new Map([["agent-1", "Briefing"]]),
    });
    expect(report.projects).toEqual([
      { project: "alpha", runs: 1, inputTokens: 150, outputTokens: 75, costUsd: 0.015 },
      { project: "Untagged", runs: 1, inputTokens: 10, outputTokens: 5, costUsd: null },
    ]);
    expect(cloudUsageCsv(report)).toContain("project,alpha,,,1,150,75,0.015,");
  });

  it("counts a ledger-only run and marks runs without reported usage", () => {
    const report = buildCloudUsageReport({
      from: new Date("2026-11-01T00:00:00.000Z"),
      to: new Date("2026-11-30T00:00:00.000Z"),
      rows: [row({ trigger: { kind: "managed-agent", agentId: "agent-9", agentName: "Ghost", executor: "cloud", runId: "run-9" } })],
      agentRuns: [run({ id: "run-8", agentId: "agent-9", usageReported: false })],
      agentNames: new Map(),
    });
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0]).toMatchObject({ agentId: "agent-9", agentName: "agent-9", runs: 2, unreportedRuns: 1 });
  });

  it("renders a CSV the Cloud site can open", () => {
    const report = buildCloudUsageReport({
      from: new Date("2026-11-01T00:00:00.000Z"),
      to: new Date("2026-11-30T00:00:00.000Z"),
      rows: [row({})],
      agentRuns: [run({})],
      agentNames: new Map([["agent-1", "Briefing"]]),
    });
    const csv = cloudUsageCsv(report);
    expect(csv.split("\n")[0]).toBe("kind,id,name,executor,runs,input_tokens,output_tokens,cost_usd,runs_without_reported_usage");
    expect(csv).toContain("managed-agent,agent-1,Briefing,,1,100,50,0.01,0");
  });
});
