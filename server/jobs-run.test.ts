import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobsStore } from "./jobs-store.ts";
import { buildReport, JobRunDriver, type JobRunDeps } from "./jobs-run.ts";
import { TasksStore } from "./tasks-store.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

function reportText(jobs: Array<{ platform: string; url: string; title: string; company: string }>): string {
  return [
    "Found two matches.",
    "```sanremes-jobs",
    JSON.stringify(jobs.map((job) => ({ ...job, jdKeywords: ["Databricks", "PySpark"] }))),
    "```",
  ].join("\n");
}

const TWO_JOBS = [
  { platform: "naukri", url: "https://www.naukri.com/job/1", title: "Data Engineer", company: "Acme" },
  { platform: "linkedin", url: "https://www.linkedin.com/jobs/2", title: "Data Engineer", company: "Beta" },
];

async function makeDriver(extra: Partial<JobRunDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-jobs-run-"));
  scratch.push(dataDir);
  const resumeDir = mkdtempSync(join(tmpdir(), "sanremes-jobs-run-resumes-"));
  scratch.push(resumeDir);
  const store = new JobsStore({ dataDir });
  const tasks = new TasksStore({ dataDir });
  store.setProfile({
    name: "Santhoshkumar", title: "Data Engineer", location: "Chennai",
    skills: ["Databricks", "PySpark", "SQL"],
    experience: [{ org: "Swache Technologies", role: "Software Developer", start: "Nov 2025", end: "Aug 2026", bullets: ["Built ETL pipelines in PySpark."] }],
  });
  store.setSettings({ applyBotId: "apply-bot", resumeBotId: "resume-bot" });
  const posted: string[] = [];
  const applied: string[] = [];
  const driver = new JobRunDriver({
    store,
    tasks,
    botExists: (id) => id === "apply-bot" || id === "resume-bot",
    botThreadId: () => "thread-apply",
    startSearch: async (input) => { input.onSettled?.(reportText(TWO_JOBS)); return { started: true }; },
    startApply: async (input) => { applied.push(input.jobId); input.onSettled?.(true); return { started: true }; },
    resumeCwd: () => resumeDir,
    appendMessage: (_threadId, text) => { posted.push(text); },
    ...extra,
  });
  return { driver, store, tasks, posted, applied, resumeDir };
}

async function waitFor(driver: JobRunDriver, id: string, phase: string): Promise<void> {
  await vi.waitFor(() => {
    const run = driver.getRun(id);
    if (!run || run.phase !== phase) throw new Error(`still ${run?.phase ?? "missing"}`);
  }, { timeout: 5_000, interval: 25 });
}

describe("the run driver", () => {
  it("searches, tailors, auto-decides and applies, one queue task each, then reports", async () => {
    const { driver, store, tasks, posted, applied } = await makeDriver();
    const run = driver.start();
    expect(run).toMatchObject({ kind: "auto", phase: "searching", whatsapp: "pending-bridge" });
    await waitFor(driver, run.id, "done");
    const done = driver.getRun(run.id)!;
    expect(done).toMatchObject({ searched: 2, found: 2 });
    expect(done.applied).toHaveLength(2);
    expect(done.applied[0]).toMatchObject({ company: "Acme", title: "Data Engineer", status: "submitted" });
    expect(done.applied[0]?.taskId).toMatch(/^[\w-]{1,128}$/u);
    expect(done.skipped).toEqual([]);
    expect(applied).toHaveLength(2);
    expect(store.snapshot().jobs).toHaveLength(2);
    expect(store.snapshot().jobs.every((job) => job.status === "applied")).toBe(true);
    expect(store.snapshot().queue.every((item) => item.state === "approved" && item.decidedBy === "auto")).toBe(true);
    expect(tasks.list("done")).toHaveLength(2);
    expect(tasks.list("done")[0]).toMatchObject({ title: "Apply: Data Engineer at Acme" });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("Applied to 2:");
    expect(posted[0]).toContain("Data Engineer at Acme");
    expect(posted[0]).toContain("Data Engineer at Beta");
    expect(posted[0]).toContain("WhatsApp delivery is pending bridge setup");
    expect(done.reportText).toBe(posted[0]);
  });

  it("queues for approval and applies nothing when auto-apply is off", async () => {
    const { driver, store, posted } = await makeDriver();
    store.setSettings({ autoApply: false });
    const run = driver.start();
    expect(run.kind).toBe("manual");
    await waitFor(driver, run.id, "done");
    const done = driver.getRun(run.id)!;
    expect(done.applied).toEqual([]);
    expect(store.snapshot().queue).toHaveLength(2);
    expect(store.snapshot().queue.every((item) => item.state === "pending")).toBe(true);
    expect(done.reportText).toContain("waiting for your approval in the queue");
    expect(posted).toHaveLength(1);
  });

  it("applies only up to the remaining daily cap and skips the rest in plain words", async () => {
    const { driver, store } = await makeDriver();
    store.setSettings({ dailyCap: 1 });
    const run = driver.start();
    await waitFor(driver, run.id, "done");
    const done = driver.getRun(run.id)!;
    expect(done.applied).toHaveLength(1);
    expect(done.skipped).toHaveLength(1);
    expect(done.skipped[0]).toMatchObject({ company: "Beta", reason: "daily limit reached" });
    expect(done.reportText).toContain("Skipped 1:");
    expect(done.reportText).toContain("daily limit reached");
  });

  it("still applies without queue tasks when the queue is absent, and says so", async () => {
    const { driver, store } = await makeDriver({ tasks: null });
    const run = driver.start();
    await waitFor(driver, run.id, "done");
    const done = driver.getRun(run.id)!;
    expect(done.applied).toHaveLength(2);
    expect(done.applied[0]?.taskId).toBeUndefined();
    expect(done.queueFallback).toBe(true);
    expect(done.reportText).toContain("without a queue task because the task queue was unavailable");
    expect(store.snapshot().jobs.every((job) => job.status === "applied")).toBe(true);
  });

  it("records a turn that reports no submission, and keeps going", async () => {
    let calls = 0;
    const { driver } = await makeDriver({
      startApply: async (input) => { calls++; input.onSettled?.(calls === 2); return { started: true }; },
    });
    const run = driver.start();
    await waitFor(driver, run.id, "done");
    const done = driver.getRun(run.id)!;
    expect(done.applied).toHaveLength(2);
    expect(done.applied.map((entry) => entry.status)).toEqual(["not-submitted", "submitted"]);
    expect(done.reportText).toContain("Tried but not submitted (1):");
  });
});

describe("pause and resume", () => {
  it("stops after the current application and resumes the rest", async () => {
    let runId = "";
    let pausedOnce = false;
    let driver!: JobRunDriver;
    const made = await makeDriver({
      startApply: async (input) => {
        input.onSettled?.(true);
        if (!pausedOnce) { pausedOnce = true; driver.pause(runId); }
        return { started: true };
      },
    });
    driver = made.driver;
    const run = driver.start();
    runId = run.id;
    await waitFor(driver, run.id, "stopped");
    const stopped = driver.getRun(run.id)!;
    expect(stopped.applied).toHaveLength(1);
    expect(stopped.reportText).toContain("Stopped early — paused.");
    const resumed = driver.resume(run.id)!;
    expect(resumed.phase).toBe("searching");
    await waitFor(driver, run.id, "done");
    expect(driver.getRun(run.id)?.applied).toHaveLength(2);
  });
});

describe("buildReport", () => {
  it("says applied, not submitted and skipped in plain words", () => {
    const text = buildReport({
      id: "run-1", kind: "auto", startedAt: 1_000, phase: "done", searched: 3, found: 2,
      applied: [
        { jobId: "job-1", company: "Acme", title: "Data Engineer", location: "Chennai", url: "https://www.naukri.com/job/1", appliedAt: 2_000, status: "submitted" },
        { jobId: "job-2", company: "Beta", title: "Data Engineer", url: "https://www.linkedin.com/jobs/2", appliedAt: 3_000, status: "not-submitted" },
      ],
      skipped: [{ jobId: "job-3", company: "Gamma", title: "Data Engineer", reason: "already applied" }],
      reportText: "", whatsapp: "pending-bridge", queueFallback: false,
    }, "applied");
    expect(text).toContain("Found 2 new jobs from 3 reported matches.");
    expect(text).toContain("Applied to 1:");
    expect(text).toContain("Data Engineer at Acme, Chennai — submitted");
    expect(text).toContain("Tried but not submitted (1):");
    expect(text).toContain("Skipped 1:");
    expect(text).toContain("Data Engineer at Gamma — already applied.");
    expect(text).toContain("WhatsApp delivery is pending bridge setup");
  });
});
