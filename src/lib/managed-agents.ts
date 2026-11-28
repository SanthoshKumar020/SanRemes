import { api } from "@/state/store";
import type {
  CloudUsageReport, ExecutorKind, HandoffPreference, ManagedAgent, ManagedAgentRun,
  ManagedAgentSchedule, ManagedAgentSummary,
} from "../../shared/managed-agents.ts";
import type { BatchRun } from "../../server/batch-runner/batch-runner.ts";
import type { ParallelSession } from "../../server/parallel-sessions.ts";

export interface ManagedAgentsPayload {
  agents: ManagedAgentSummary[];
  handoff: {
    preference: HandoffPreference;
    executor: ExecutorKind;
    note: string | null;
    cloudAttached: boolean;
  };
}

export interface HandoffState {
  preference: HandoffPreference;
  executor: ExecutorKind;
  note: string | null;
  cloudAttached: boolean;
}

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Every managed agent, with its last run and where its work runs. */
export async function fetchManagedAgents(request: Request = api): Promise<ManagedAgentsPayload> {
  return request<ManagedAgentsPayload>("/api/managed-agents");
}

export async function fetchManagedAgent(id: string, request: Request = api): Promise<{ agent: ManagedAgent; runs: ManagedAgentRun[] }> {
  return request<{ agent: ManagedAgent; runs: ManagedAgentRun[] }>(`/api/managed-agents/${id}`);
}

export interface NewManagedAgent {
  name: string;
  botId: string;
  instructions: string;
  schedule?: ManagedAgentSchedule;
  allowedTools?: string[];
  capUsd?: number;
  capTokens?: number;
  capPeriod?: "day" | "month";
  executorPreference?: HandoffPreference;
}

export async function createManagedAgent(input: NewManagedAgent, request: Request = api): Promise<{ agent: ManagedAgent }> {
  return request<{ agent: ManagedAgent }>("/api/managed-agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createManagedAgentFromRoutine(routineId: string, request: Request = api): Promise<{ agent: ManagedAgent }> {
  return request<{ agent: ManagedAgent }>("/api/managed-agents/from-routine", {
    method: "POST",
    body: JSON.stringify({ routineId }),
  });
}

export async function updateManagedAgent(
  id: string,
  patch: Partial<NewManagedAgent> & { enabled?: boolean },
  request: Request = api,
): Promise<{ agent: ManagedAgent }> {
  return request<{ agent: ManagedAgent }>(`/api/managed-agents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteManagedAgent(id: string, request: Request = api): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>(`/api/managed-agents/${id}`, { method: "DELETE" });
}

export async function runManagedAgentNow(id: string, request: Request = api): Promise<{ started: boolean; agentId: string }> {
  return request<{ started: boolean; agentId: string }>(`/api/managed-agents/${id}/run`, { method: "POST" });
}

export async function setManagedAgentEnabled(id: string, enabled: boolean, request: Request = api): Promise<{ agent: ManagedAgent }> {
  return request<{ agent: ManagedAgent }>(`/api/managed-agents/${id}/${enabled ? "resume" : "pause"}`, { method: "POST" });
}

export async function fetchHandoff(request: Request = api): Promise<HandoffState> {
  return request<HandoffState>("/api/cloud-handoff");
}

export async function setHandoff(preference: HandoffPreference, request: Request = api): Promise<HandoffState> {
  return request<HandoffState>("/api/cloud-handoff", {
    method: "PUT",
    body: JSON.stringify({ preference }),
  });
}

export async function fetchCloudSessions(request: Request = api): Promise<{ sessions: ParallelSession[]; cloudAttached: boolean }> {
  return request<{ sessions: ParallelSession[]; cloudAttached: boolean }>("/api/cloud-sessions");
}

export async function fetchHostedBatches(request: Request = api): Promise<{ batches: BatchRun[]; cloudAttached: boolean }> {
  return request<{ batches: BatchRun[]; cloudAttached: boolean }>("/api/hosted-batches");
}

export async function submitHostedBatch(
  input: { botId: string; prompts: string[]; executor?: HandoffPreference },
  request: Request = api,
): Promise<{ batch: BatchRun; executor: ExecutorKind; note?: string }> {
  return request<{ batch: BatchRun; executor: ExecutorKind; note?: string }>("/api/hosted-batches", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchCloudUsageReport(request: Request = api): Promise<{ report: CloudUsageReport }> {
  return request<{ report: CloudUsageReport }>("/api/cloud-usage/report");
}

export function cloudUsageCsvUrl(): string {
  return "/api/cloud-usage/report?format=csv";
}
