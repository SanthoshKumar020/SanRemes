// The usage report the Cloud site bills from: per managed agent and per cloud job,
// from the ledger rows those runs booked, plus each agent's own run records for the
// runs whose executor reported no token counts. It carries amounts and counts only:
// no prices are invented here, and no payment is taken.
import { csvCell, type UsageRow } from "./usage-ledger.ts";
import type { ManagedAgentRun } from "../shared/managed-agents.ts";
import type { CloudUsageReport } from "../shared/managed-agents.ts";

export interface CloudUsageReportInput {
  from: Date;
  to: Date;
  rows: UsageRow[];
  agentRuns: ManagedAgentRun[];
  agentNames: Map<string, string>;
}

export function buildCloudUsageReport(input: CloudUsageReportInput): CloudUsageReport {
  const agents = new Map<string, { runs: number; input: number; output: number; cost: number | null; unreported: number }>();
  const jobs = new Map<string, { label: string; executor: "local" | "cloud"; runs: number; input: number; output: number; cost: number | null }>();
  const projects = new Map<string, { runs: number; input: number; output: number; cost: number | null }>();
  const projectRunIds = new Map<string, Set<string>>();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost: number | null = null;
  let unpriced = 0;
  const agentRow = (agentId: string) => {
    let row = agents.get(agentId);
    if (!row) {
      row = { runs: 0, input: 0, output: 0, cost: null, unreported: 0 };
      agents.set(agentId, row);
    }
    return row;
  };
  for (const row of input.rows) {
    const trigger = row.trigger;
    if (trigger.kind === "managed-agent") {
      const agent = agentRow(trigger.agentId);
      agent.input += row.input;
      agent.output += row.output;
      totalInput += row.input;
      totalOutput += row.output;
      if (typeof row.costUsd === "number") {
        agent.cost = (agent.cost ?? 0) + row.costUsd;
        totalCost = (totalCost ?? 0) + row.costUsd;
      } else unpriced += 1;
      const projectKey = row.project ?? "Untagged";
      let project = projects.get(projectKey);
      if (!project) {
        project = { runs: 0, input: 0, output: 0, cost: null };
        projects.set(projectKey, project);
      }
      project.input += row.input;
      project.output += row.output;
      if (typeof row.costUsd === "number") project.cost = (project.cost ?? 0) + row.costUsd;
      const runId = trigger.runId;
      if (runId) {
        let ids = projectRunIds.get(projectKey);
        if (!ids) {
          ids = new Set();
          projectRunIds.set(projectKey, ids);
        }
        if (!ids.has(runId)) {
          ids.add(runId);
          project.runs += 1;
        }
      } else {
        project.runs += 1;
      }
    } else if (trigger.kind === "cloud-job") {
      const key = trigger.jobId ?? trigger.label ?? "unknown";
      let job = jobs.get(key);
      if (!job) {
        job = { label: trigger.label ?? key, executor: trigger.executor ?? "local", runs: 0, input: 0, output: 0, cost: null };
        jobs.set(key, job);
      }
      job.input += row.input;
      job.output += row.output;
      job.runs += 1;
      totalInput += row.input;
      totalOutput += row.output;
      if (typeof row.costUsd === "number") {
        job.cost = (job.cost ?? 0) + row.costUsd;
        totalCost = (totalCost ?? 0) + row.costUsd;
      } else unpriced += 1;
    }
  }
  const recordedRunIds = new Map<string, Set<string>>();
  for (const run of input.agentRuns) {
    const agent = agentRow(run.agentId);
    agent.runs += 1;
    if (!run.usageReported) agent.unreported += 1;
    let ids = recordedRunIds.get(run.agentId);
    if (!ids) {
      ids = new Set();
      recordedRunIds.set(run.agentId, ids);
    }
    ids.add(run.id);
  }
  for (const row of input.rows) {
    if (row.trigger.kind !== "managed-agent" || !row.trigger.runId) continue;
    let ids = recordedRunIds.get(row.trigger.agentId);
    if (!ids) {
      ids = new Set();
      recordedRunIds.set(row.trigger.agentId, ids);
    }
    if (ids.has(row.trigger.runId)) continue;
    ids.add(row.trigger.runId);
    agentRow(row.trigger.agentId).runs += 1;
  }
  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    agents: [...agents.entries()].map(([agentId, row]) => ({
      agentId,
      agentName: input.agentNames.get(agentId) ?? agentId,
      runs: row.runs,
      inputTokens: row.input,
      outputTokens: row.output,
      costUsd: row.cost,
      unreportedRuns: row.unreported,
    })).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    jobs: [...jobs.entries()].map(([jobId, row]) => ({
      jobId,
      label: row.label,
      executor: row.executor,
      runs: row.runs,
      inputTokens: row.input,
      outputTokens: row.output,
      costUsd: row.cost,
    })).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    projects: [...projects.entries()].map(([project, row]) => ({
      project,
      runs: row.runs,
      inputTokens: row.input,
      outputTokens: row.output,
      costUsd: row.cost,
    })).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCostUsd: totalCost,
    unpricedRows: unpriced,
  };
}

export function cloudUsageCsv(report: CloudUsageReport): string {
  const lines = [["kind", "id", "name", "executor", "runs", "input_tokens", "output_tokens", "cost_usd", "runs_without_reported_usage"].join(",")];
  for (const agent of report.agents) {
    lines.push([
      "managed-agent", agent.agentId, agent.agentName, "", agent.runs, agent.inputTokens,
      agent.outputTokens, agent.costUsd, agent.unreportedRuns,
    ].map(csvCell).join(","));
  }
  for (const job of report.jobs) {
    lines.push([
      "cloud-job", job.jobId, job.label, job.executor, job.runs, job.inputTokens,
      job.outputTokens, job.costUsd, "",
    ].map(csvCell).join(","));
  }
  for (const project of report.projects) {
    lines.push([
      "project", project.project, "", "", project.runs, project.inputTokens,
      project.outputTokens, project.costUsd, "",
    ].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
