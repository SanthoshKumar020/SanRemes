// Managed agents, the executor contract behind them, and the cloud usage report:
// the wire shapes the Managed Agents page and the Cloud site's billing read.
export type ExecutorKind = "local" | "cloud";

/** Where a task runs when it has a choice: this computer, the Cloud, or whichever is attached. */
export type HandoffPreference = "auto" | "local" | "cloud";

/** A managed agent repeats on its own schedule, follows a linked routine, or runs only by hand. */
export type ManagedAgentSchedule =
  | { type: "manual" }
  | { type: "daily"; time: string; days?: number[] }
  | { type: "interval"; everyMinutes: number }
  | { type: "routine" };

export interface ManagedAgent {
  id: string;
  name: string;
  botId: string;
  instructions: string;
  schedule: ManagedAgentSchedule;
  /** The routine this agent follows, when it was made from one: its runs are the agent's scheduled runs. */
  routineId?: string;
  allowedTools: string[];
  /** A spend cap in whole dollars or tokens, counted over `capPeriod`; absent means no cap. */
  capUsd?: number;
  capTokens?: number;
  capPeriod: "day" | "month";
  /** A cost-code tag: usage rows this agent books carry it, so the usage report groups spend by project. */
  project?: string;
  /** Run this agent when the named agent's run ends: `completed` chains only on success, `always` on any ending. */
  afterRun?: { agentId: string; when: "completed" | "always" };
  /** The chain this queued run belongs to, oldest first: a chain stops before it repeats an agent or passes five hops. */
  pendingChain?: string[];
  enabled: boolean;
  executorPreference: HandoffPreference;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type ManagedAgentRunStatus = "completed" | "failed" | "stopped";

export interface ManagedAgentRun {
  id: string;
  agentId: string;
  status: ManagedAgentRunStatus;
  executor: ExecutorKind;
  manual: boolean;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  /** The tokens a run reported, when its executor reports none. */
  usageReported: boolean;
  result?: string;
  /** Plain words: what failed, or why a cap stopped the run. */
  error?: string;
}

export interface ManagedAgentSummary {
  agent: ManagedAgent;
  lastRun: ManagedAgentRun | null;
  runs: number;
  failures: number;
  /** What the agent's runs add up to: counts, success rate, average duration and total cost. */
  outcomes: ManagedAgentOutcomes;
}

export interface ManagedAgentOutcomes {
  runs: number;
  completed: number;
  failed: number;
  stopped: number;
  /** Completed share of runs that ended, null when no run ended yet. */
  successRate: number | null;
  avgDurationMs: number | null;
  totalCostUsd: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface CloudUsageAgentRow {
  agentId: string;
  agentName: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  unreportedRuns: number;
}

export interface CloudUsageJobRow {
  jobId: string;
  label: string;
  executor: ExecutorKind;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface CloudUsageReport {
  from: string;
  to: string;
  agents: CloudUsageAgentRow[];
  jobs: CloudUsageJobRow[];
  /** Spend by cost-code tag, from the managed-agent rows that carry one; rows with no tag count under "Untagged". */
  projects: CloudUsageProjectRow[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number | null;
  unpricedRows: number;
}

export interface CloudUsageProjectRow {
  project: string;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}
