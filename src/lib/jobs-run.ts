import { api } from "@/state/store";
import type { JobRun, JobRunPhase } from "../../shared/jobs";

export type { JobRun, JobRunApplied, JobRunPhase, JobRunSkipped } from "../../shared/jobs";
export type JobRunKind = JobRun["kind"];

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Starts a run; the run then searches, tailors, and applies on its own up to the daily cap. */
export async function startJobRun(request: Request = api): Promise<{ run: JobRun }> {
  return request<{ run: JobRun }>("/api/jobs/runs", { method: "POST", body: JSON.stringify({}) });
}

export async function fetchJobRuns(request: Request = api): Promise<{ runs: JobRun[] }> {
  return request<{ runs: JobRun[] }>("/api/jobs/runs");
}

export async function fetchJobRun(id: string, request: Request = api): Promise<{ run: JobRun }> {
  return request<{ run: JobRun }>(`/api/jobs/runs/${encodeURIComponent(id)}`);
}

/** Asks a run to stop after the application it is on; it never stops mid-submit. */
export async function pauseJobRun(id: string, request: Request = api): Promise<{ run: JobRun }> {
  return request<{ run: JobRun }>(`/api/jobs/runs/${encodeURIComponent(id)}/pause`, { method: "POST", body: JSON.stringify({}) });
}

export async function resumeJobRun(id: string, request: Request = api): Promise<{ run: JobRun }> {
  return request<{ run: JobRun }>(`/api/jobs/runs/${encodeURIComponent(id)}/resume`, { method: "POST", body: JSON.stringify({}) });
}

const ACTIVE_PHASES: readonly JobRunPhase[] = ["searching", "tailoring", "applying", "reporting"];

/** Still working: polling should keep asking until the phase leaves this set. */
export function isRunActive(run: JobRun): boolean {
  return ACTIVE_PHASES.includes(run.phase);
}

/** The run with the latest start; null when there has never been one. */
export function latestRun(runs: readonly JobRun[]): JobRun | null {
  let latest: JobRun | null = null;
  for (const run of runs) if (latest === null || run.startedAt > latest.startedAt) latest = run;
  return latest;
}

/** The same runs with `run` in place of its older copy, or added when it is new. */
export function upsertRun(runs: readonly JobRun[], run: JobRun): JobRun[] {
  const at = runs.findIndex((one) => one.id === run.id);
  if (at === -1) return [run, ...runs];
  return runs.map((one, index) => (index === at ? run : one));
}
