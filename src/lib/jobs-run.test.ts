import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

import {
  fetchJobRun, fetchJobRuns, isRunActive, latestRun, pauseJobRun, resumeJobRun, startJobRun, upsertRun,
  type JobRun,
} from "./jobs-run";

const run = (over: Partial<JobRun> = {}): JobRun => ({
  id: "run-1",
  kind: "auto",
  startedAt: 100,
  phase: "applying",
  searched: 14,
  found: 10,
  applied: [],
  skipped: [],
  reportText: "",
  whatsapp: "pending-bridge",
  queueFallback: false,
  ...over,
});

describe("job run endpoints", () => {
  const request = vi.fn();
  beforeEach(() => request.mockClear());

  it("starts a run with an empty body and reads the run back", async () => {
    request.mockResolvedValueOnce({ run: run() });
    expect(await startJobRun(request)).toEqual({ run: run() });
    expect(request).toHaveBeenCalledWith("/api/jobs/runs", { method: "POST", body: "{}" });
  });

  it("lists runs and fetches one by id", async () => {
    request.mockResolvedValueOnce({ runs: [run()] }).mockResolvedValueOnce({ run: run({ id: "run-2" }) });
    expect(await fetchJobRuns(request)).toEqual({ runs: [run()] });
    expect(await fetchJobRun("run-2", request)).toEqual({ run: run({ id: "run-2" }) });
    expect(request).toHaveBeenNthCalledWith(1, "/api/jobs/runs");
    expect(request).toHaveBeenNthCalledWith(2, "/api/jobs/runs/run-2");
  });

  it("pauses and resumes with an empty body", async () => {
    request.mockResolvedValueOnce({ run: run({ phase: "stopped" }) }).mockResolvedValueOnce({ run: run({ phase: "applying" }) });
    expect((await pauseJobRun("run-1", request)).run.phase).toBe("stopped");
    expect((await resumeJobRun("run-1", request)).run.phase).toBe("applying");
    expect(request).toHaveBeenNthCalledWith(1, "/api/jobs/runs/run-1/pause", { method: "POST", body: "{}" });
    expect(request).toHaveBeenNthCalledWith(2, "/api/jobs/runs/run-1/resume", { method: "POST", body: "{}" });
  });
});

describe("run helpers", () => {
  it("treats searching, tailoring, applying, and reporting as active, done and stopped as finished", () => {
    for (const phase of ["searching", "tailoring", "applying", "reporting"] as const) expect(isRunActive(run({ phase }))).toBe(true);
    for (const phase of ["done", "stopped"] as const) expect(isRunActive(run({ phase }))).toBe(false);
  });

  it("picks the latest run by start time and null when there is none", () => {
    expect(latestRun([])).toBeNull();
    expect(latestRun([run({ id: "a", startedAt: 5 }), run({ id: "b", startedAt: 9 })])?.id).toBe("b");
  });

  it("replaces a run in place and prepends a new one", () => {
    const first = run({ id: "a", phase: "searching" });
    const second = run({ id: "b", phase: "done" });
    expect(upsertRun([first], run({ id: "a", phase: "done" }))).toEqual([run({ id: "a", phase: "done" })]);
    expect(upsertRun([first], second)).toEqual([second, first]);
  });
});
