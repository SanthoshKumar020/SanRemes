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
    sleep: async () => {},
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

  it("waits 45–120 seconds between applications, and not before the first", async () => {
    const delays: number[] = [];
    const { driver, applied } = await makeDriver({ sleep: async (ms) => { delays.push(ms); } });
    const run = driver.start();
    await waitFor(driver, run.id, "done");
    expect(applied).toHaveLength(2);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(45_000);
    expect(delays[0]).toBeLessThanOrEqual(120_000);
  });

  it("stops after the current application when paused during the wait between applications", async () => {
    let runId = "";
    let driver!: JobRunDriver;
    const made = await makeDriver({
      sleep: async () => { driver.pause(runId); },
    });
    driver = made.driver;
    const run = driver.start();
    runId = run.id;
    await waitFor(driver, run.id, "stopped");
    const stopped = driver.getRun(run.id)!;
    expect(stopped.applied).toHaveLength(1);
    expect(stopped.reportText).toContain("Stopped early — paused.");
    expect(made.applied).toHaveLength(1);
  });

  it("stops the run when a turn closes with the human-check marker, and says so plainly", async () => {
    const attempted: string[] = [];
    const { driver } = await makeDriver({
      startApply: async (input) => {
        attempted.push(input.jobId);
        input.onSettled?.(false, "HUMAN CHECK: the site asked for a human check before sign-in.");
        return { started: true };
      },
    });
    const run = driver.start();
    await waitFor(driver, run.id, "stopped");
    const stopped = driver.getRun(run.id)!;
    expect(attempted).toHaveLength(1);
    expect(stopped.applied).toHaveLength(1);
    expect(stopped.applied[0]?.status).toBe("not-submitted");
    expect(stopped.reportText).toContain("The run stopped early: the site asked for a human check — the bot stopped and never tried to solve it");
    expect(stopped.takeover?.status).toBe("waiting");
  });

  it("stops the run when a turn closes with a layout change, and records the takeover", async () => {
    const { driver } = await makeDriver({
      startApply: async (input) => {
        input.onSettled?.(false, "LAYOUT CHANGED: the apply button is gone and the form has new fields.");
        return { started: true };
      },
    });
    const run = driver.start();
    await waitFor(driver, run.id, "stopped");
    const stopped = driver.getRun(run.id)!;
    expect(stopped.applied).toHaveLength(1);
    expect(stopped.takeover).toMatchObject({ status: "waiting" });
    expect(stopped.takeover?.reason).toContain("the apply button is gone");
    expect(stopped.reportText).toContain("the run stopped so you can take over");
    expect(driver.abandonTakeover(run.id)?.takeover?.status).toBe("abandoned");
    expect(driver.abandonTakeover("no-such-run")).toBeNull();
  });

  it("stores the layout fingerprint from a successful apply's LAYOUT: line", async () => {
    const { driver, store } = await makeDriver({
      startApply: async (input) => {
        input.onSettled?.(true, "Applied.\nLAYOUT: Apply now | Upload resume | Submit");
        return { started: true };
      },
    });
    const run = driver.start();
    await waitFor(driver, run.id, "done");
    const acme = store.snapshot().jobs.find((job) => job.company === "Acme")!;
    expect(acme.lastGoodLayout?.labels).toEqual(["Apply now", "Upload resume", "Submit"]);
    expect(acme.lastGoodLayout?.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("sends the finished report through the delivery dep and marks the run sent", async () => {
    const delivered: Array<{ runId: string; text: string }> = [];
    const { driver, posted } = await makeDriver({
      deliverReport: async (input) => {
        delivered.push(input);
        return [{ channel: "whatsapp", status: "sent" }];
      },
    });
    const run = driver.start();
    await waitFor(driver, run.id, "done");
    const done = driver.getRun(run.id)!;
    expect(done.whatsapp).toBe("sent");
    expect(done.reportText).toContain("Report sent to WhatsApp.");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.runId).toBe(run.id);
    expect(posted[0]).toBe(done.reportText);
  });

  it("marks the run failed when report delivery fails, and still posts the report", async () => {
    const { driver, posted } = await makeDriver({
      deliverReport: async () => [{ channel: "whatsapp", status: "failed", note: "the bridge could not be reached" }],
    });
    const run = driver.start();
    await waitFor(driver, run.id, "done");
    const done = driver.getRun(run.id)!;
    expect(done.whatsapp).toBe("failed");
    expect(done.reportText).toContain("WhatsApp delivery failed (the bridge could not be reached)");
    expect(posted).toHaveLength(1);
  });

  it("researches each company once per run and still applies when research fails", async () => {
    const researched: string[] = [];
    const { driver, store } = await makeDriver({
      researchCompany: async (input) => {
        researched.push(input.company);
        if (input.company === "Beta") return { ok: false, company: "Beta", reason: "The web search did not answer." };
        return {
          ok: true,
          research: { company: input.company, summary: "Acme builds widgets.", sources: [], researchedAt: 1, searches: 1, pagesRead: 1 },
        };
      },
    });
    const run = driver.start();
    await waitFor(driver, run.id, "done");
    const done = driver.getRun(run.id)!;
    expect(done.applied).toHaveLength(2);
    expect(researched).toEqual(["Acme", "Beta"]);
    const acme = store.snapshot().jobs.find((job) => job.company === "Acme")!;
    expect(acme.companyResearch?.summary).toBe("Acme builds widgets.");
    const beta = store.snapshot().jobs.find((job) => job.company === "Beta")!;
    expect(beta.companyResearch?.failed).toBe(true);
  });

  it("skips the second application on one platform once that platform's daily share is used", async () => {
    const twoNaukri = [
      { platform: "naukri", url: "https://www.naukri.com/job/1", title: "Data Engineer", company: "Acme" },
      { platform: "naukri", url: "https://www.naukri.com/job/2", title: "Data Engineer", company: "Beta" },
    ];
    const { driver, store } = await makeDriver({
      startSearch: async (input) => { input.onSettled?.(reportText(twoNaukri)); return { started: true }; },
    });
    store.setSettings({ dailyCap: 2 });
    const run = driver.start();
    await waitFor(driver, run.id, "done");
    const done = driver.getRun(run.id)!;
    expect(done.applied).toHaveLength(1);
    expect(done.skipped).toHaveLength(1);
    expect(done.skipped[0]).toMatchObject({ company: "Beta", reason: "daily limit for Naukri reached" });
    expect(done.reportText).toContain("daily limit for Naukri reached");
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
