import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DAILY_CAP_DEFAULT, jobsFileSchema } from "../shared/jobs.ts";
import { JobsStore, keywordMatchScore, perPlatformDailyCap } from "./jobs-store.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const START = new Date("2026-11-26T10:00:00+05:30").getTime();
const DAY = 24 * 60 * 60 * 1000;

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

function makeStore(now: () => number = () => START) {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-jobs-store-"));
  scratch.push(dataDir);
  return { dataDir, store: new JobsStore({ dataDir, now }) };
}

function seedJob(store: JobsStore, id = "job-1") {
  return store.addJob({
    id, platform: "naukri", url: "https://www.naukri.com/job/1", title: "Data Engineer", company: "Acme",
  });
}

describe("jobs.json", () => {
  it("starts empty with the conservative daily cap", () => {
    const { store } = makeStore();
    expect(store.snapshot()).toEqual({
      version: 1, profile: null, resumes: [], jobs: [], queue: [],
      settings: { platforms: {}, dailyCap: DAILY_CAP_DEFAULT, search: { keywords: [], locations: [] }, twoFactor: {}, paused: false, autoApply: true, companyPages: [] },
      runs: [],
    });
    expect(DAILY_CAP_DEFAULT).toBe(10);
  });

  it("replaces an unreadable file with defaults instead of refusing every save", () => {
    const { dataDir, store } = makeStore();
    writeFileSync(join(dataDir, "jobs.json"), "{not json");
    expect(store.snapshot().jobs).toEqual([]);
    store.setProfile({ name: "Santhoshkumar" });
    expect(JSON.parse(readFileSync(join(dataDir, "jobs.json"), "utf8")).profile.name).toBe("Santhoshkumar");
  });

  it("replaces a wrongly shaped file with defaults", () => {
    const { dataDir, store } = makeStore();
    writeFileSync(join(dataDir, "jobs.json"), JSON.stringify({ version: 1, profile: null, resumes: [], jobs: "not a list", queue: [], settings: {} }));
    expect(store.snapshot()).toMatchObject({ jobs: [], queue: [] });
  });

  it("writes whole valid JSON atomically and bumps the version only on a change", () => {
    const { dataDir, store } = makeStore();
    const before = store.version;
    store.setProfile({ name: "Santhoshkumar", skills: ["SQL", "PySpark"] });
    expect(store.version).toBeGreaterThan(before);
    const text = readFileSync(join(dataDir, "jobs.json"), "utf8");
    expect(jobsFileSchema.parse(JSON.parse(text)).profile?.name).toBe("Santhoshkumar");
    expect(readdirSync(dataDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(join(dataDir, "jobs.json"))).toBe(true);
    const version = store.version;
    store.update(() => {});
    expect(store.version).toBe(version);
  });

  it("never persists a credential value, and refuses an unknown key outright", () => {
    const { dataDir, store } = makeStore();
    store.setSettings({ platforms: { naukri: { enabled: true, loginId: "login-1" } } });
    const text = readFileSync(join(dataDir, "jobs.json"), "utf8");
    expect(text).toContain("login-1");
    expect(text.toLowerCase()).not.toContain("password");
    expect(text.toLowerCase()).not.toContain("totp");
    expect(() => jobsFileSchema.parse(JSON.parse(`{"version":1,"profile":null,"resumes":[],"jobs":[],"queue":[],"settings":{"platforms":{},"dailyCap":10,"search":{"keywords":[],"locations":[]},"password":"secret"}}`))).toThrow();
  });

  it("round-trips the profile and settings", () => {
    const { store } = makeStore();
    store.setProfile({ name: "Santhoshkumar", location: "Chennai", salaryExpected: "6 LPA", resumeText: "Data Engineer...", resumeFileName: "resume.txt" });
    expect(store.setProfile({ title: "Data Engineer" })).toMatchObject({ name: "Santhoshkumar", title: "Data Engineer", location: "Chennai", resumeText: "Data Engineer...", resumeFileName: "resume.txt" });
    expect(store.setSettings({ dailyCap: 5, search: { keywords: ["databricks"], locations: ["Chennai"] }, twoFactor: { naukri: true } })).toMatchObject({
      dailyCap: 5, search: { keywords: ["databricks"], locations: ["Chennai"] }, twoFactor: { naukri: true },
    });
  });
});

describe("job status", () => {
  it("moves a job through statuses and stamps the applied date", () => {
    const { store } = makeStore();
    seedJob(store);
    expect(store.setJobStatus("job-1", "queued")?.status).toBe("queued");
    const applied = store.setJobStatus("job-1", "applied");
    expect(applied?.status).toBe("applied");
    expect(applied?.appliedAt).toBe(START);
    expect(applied?.statusAt).toBe(START);
    expect(store.setJobStatus("job-1", "interview")?.status).toBe("interview");
    expect(store.setJobStatus("missing", "saved")).toBeNull();
  });
});

describe("the approval queue and the submit gate", () => {
  it("approves and rejects with the person recorded as the decider", () => {
    const { store } = makeStore();
    seedJob(store);
    const item = store.enqueue("job-1", "resume-1")!;
    expect(item.state).toBe("pending");
    const approved = store.decideQueue(item.id, "approved")!;
    expect(approved.state).toBe("approved");
    expect(approved.decidedBy).toBe("user");
    expect(approved.decidedAt).toBe(START);
    expect(store.decideQueue(item.id, "rejected")?.state).toBe("rejected");
    expect(store.decideQueue("missing", "approved")).toBeNull();
    expect(store.enqueue("missing-job", "resume-1")).toBeNull();
  });

  it("holds the gate shut until the queue item is approved by the user", () => {
    const { store } = makeStore();
    seedJob(store);
    expect(store.submitGate("missing")).toEqual({ allowed: false, reason: "no-such-job" });
    expect(store.submitGate("job-1")).toEqual({ allowed: false, reason: "no-queue-item" });
    const item = store.enqueue("job-1", "resume-1")!;
    expect(store.submitGate("job-1")).toEqual({ allowed: false, reason: "not-approved" });
    store.decideQueue(item.id, "rejected");
    expect(store.submitGate("job-1")).toEqual({ allowed: false, reason: "not-approved" });
    store.update((data) => {
      const one = data.queue.find((entry) => entry.id === item.id)!;
      one.state = "approved";
      delete one.decidedBy;
    });
    expect(store.submitGate("job-1")).toEqual({ allowed: false, reason: "not-approved" });
    store.decideQueue(item.id, "approved");
    expect(store.submitGate("job-1")).toEqual({ allowed: true });
  });

  it("enforces the daily cap, then lets the next day through", () => {
    let now = START;
    const { store } = makeStore(() => now);
    store.setSettings({ dailyCap: 1 });
    const first = seedJob(store, "job-1");
    const second = seedJob(store, "job-2");
    const firstItem = store.enqueue(first.id, "resume-1")!;
    const secondItem = store.enqueue(second.id, "resume-1")!;
    store.decideQueue(firstItem.id, "approved");
    store.decideQueue(secondItem.id, "approved");
    expect(store.submitGate("job-1")).toEqual({ allowed: true });
    store.setJobStatus("job-1", "applied");
    expect(store.appliedToday()).toBe(1);
    expect(store.submitGate("job-2")).toEqual({ allowed: false, reason: "daily-cap" });
    now = START + DAY + 60_000;
    expect(store.submitGate("job-2")).toEqual({ allowed: true });
  });

  it("caps one platform at half the daily cap, so the other platform still gets its share", () => {
    expect(perPlatformDailyCap(10)).toBe(5);
    expect(perPlatformDailyCap(2)).toBe(1);
    expect(perPlatformDailyCap(1)).toBe(1);
    const { store } = makeStore();
    store.setSettings({ dailyCap: 2 });
    const first = seedJob(store, "job-1");
    const second = store.addJob({ id: "job-2", platform: "naukri", url: "https://www.naukri.com/job/2", title: "Data Engineer", company: "Beta" });
    const third = store.addJob({ id: "job-3", platform: "linkedin", url: "https://www.linkedin.com/jobs/3", title: "Data Engineer", company: "Gamma" });
    for (const job of [first, second, third]) {
      const item = store.enqueue(job.id, "resume-1")!;
      store.decideQueue(item.id, "approved");
    }
    expect(store.submitGate("job-1")).toEqual({ allowed: true });
    store.setJobStatus("job-1", "applied");
    expect(store.appliedTodayForPlatform("naukri")).toBe(1);
    expect(store.submitGate("job-2")).toEqual({ allowed: false, reason: "daily-cap", platform: "naukri" });
    expect(store.submitGate("job-3")).toEqual({ allowed: true });
  });

  it("holds the gate shut while applying is paused", () => {
    const { store } = makeStore();
    seedJob(store);
    const item = store.enqueue("job-1", "resume-1")!;
    store.decideQueue(item.id, "approved");
    expect(store.submitGate("job-1")).toEqual({ allowed: true });
    store.setSettings({ paused: true });
    expect(store.submitGate("job-1")).toEqual({ allowed: false, reason: "paused" });
    store.setSettings({ paused: false });
    expect(store.submitGate("job-1")).toEqual({ allowed: true });
  });
});

describe("found jobs and tailored resumes", () => {
  it("scores found jobs against the profile, derives keywords from the JD, and skips repeat urls", () => {
    const { store } = makeStore();
    store.setProfile({ name: "Santhoshkumar", skills: ["Databricks", "PySpark", "SQL"] });
    const { added, skipped } = store.recordFoundJobs([
      { platform: "naukri", url: "https://www.naukri.com/job/1", title: "Data Engineer", company: "Acme", jdText: "We need Databricks and PySpark." },
      { platform: "linkedin", url: "https://www.linkedin.com/jobs/2", title: "Data Engineer", company: "Beta", jdKeywords: ["SQL", "Kafka"] },
      { platform: "naukri", url: "https://www.naukri.com/job/1", title: "Data Engineer", company: "Acme" },
    ]);
    expect(skipped).toBe(1);
    expect(added).toHaveLength(2);
    expect(added[0]).toMatchObject({ matchScore: 100, status: "new", jdKeywords: ["Databricks", "PySpark"] });
    expect(added[1]).toMatchObject({ matchScore: 50, jdKeywords: ["SQL", "Kafka"] });
    expect(store.snapshot().jobs).toHaveLength(2);
  });

  it("records a tailored resume, links it to the job, and repoints a pending queue item at a fresh version", () => {
    const { store } = makeStore();
    seedJob(store);
    const first = store.addResume({ jobId: "job-1", kind: "tailored", path: "/resumes/a.txt", text: "first" });
    expect(store.setJobTailoredResume("job-1", first.id)?.tailoredResumeId).toBe(first.id);
    const item = store.enqueue("job-1", first.id)!;
    const second = store.addResume({ jobId: "job-1", kind: "tailored", path: "/resumes/b.txt", text: "second" });
    expect(store.repointQueue("job-1", second.id)?.tailoredResumeId).toBe(second.id);
    expect(store.snapshot().queue.find((one) => one.id === item.id)?.tailoredResumeId).toBe(second.id);
    expect(store.recordQueueAttempt(item.id, "submitted")?.attempts).toHaveLength(1);
    expect(store.setJobTailoredResume("missing", first.id)).toBeNull();
    expect(store.repointQueue("missing", first.id)).toBeNull();
  });
});

describe("auto-decide and the auto submit gate", () => {
  it("auto-approves ranked queue items up to the remaining cap, and only pending ones", () => {
    const { store } = makeStore();
    store.setSettings({ dailyCap: 1 });
    const first = seedJob(store, "job-1");
    const second = store.addJob({ id: "job-2", platform: "linkedin", url: "https://www.linkedin.com/jobs/2", title: "Data Engineer", company: "Beta" });
    const firstItem = store.enqueue(first.id, "resume-1")!;
    const secondItem = store.enqueue(second.id, "resume-1")!;
    store.decideQueue(secondItem.id, "rejected");
    const approved = store.autoDecideQueue([first.id, second.id]);
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({ id: firstItem.id, state: "approved", decidedBy: "auto", decidedAt: START });
    expect(store.snapshot().queue.find((one) => one.id === secondItem.id)?.state).toBe("rejected");
    expect(store.autoDecideQueue([first.id])).toHaveLength(0);
  });

  it("lets an auto-approved item through the gate only while auto-apply is on", () => {
    const { store } = makeStore();
    seedJob(store);
    const item = store.enqueue("job-1", "resume-1")!;
    store.decideQueue(item.id, "approved");
    store.update((data) => {
      const one = data.queue.find((entry) => entry.id === item.id)!;
      one.decidedBy = "auto";
    });
    expect(store.submitGate("job-1")).toEqual({ allowed: true });
    store.setSettings({ autoApply: false });
    expect(store.submitGate("job-1")).toEqual({ allowed: false, reason: "not-approved" });
    store.setSettings({ autoApply: true });
    expect(store.submitGate("job-1")).toEqual({ allowed: true });
  });

  it("still lets a user-approved item through when auto-apply is off", () => {
    const { store } = makeStore();
    seedJob(store);
    const item = store.enqueue("job-1", "resume-1")!;
    store.decideQueue(item.id, "approved");
    store.setSettings({ autoApply: false });
    expect(store.submitGate("job-1")).toEqual({ allowed: true });
  });
});

describe("run records", () => {
  it("creates, lists newest first, and updates a run", () => {
    const { store } = makeStore();
    const run = store.createRun("auto");
    expect(run).toMatchObject({ kind: "auto", startedAt: START, phase: "searching", searched: 0, found: 0, applied: [], skipped: [], whatsapp: "pending-bridge", queueFallback: false });
    expect(store.listRuns()).toHaveLength(1);
    expect(store.getRun(run.id)?.id).toBe(run.id);
    expect(store.getRun("missing")).toBeNull();
    const updated = store.updateRun(run.id, { phase: "done", finishedAt: START, reportText: "Applied to none." })!;
    expect(updated).toMatchObject({ phase: "done", finishedAt: START, reportText: "Applied to none." });
    expect(store.updateRun("missing", { phase: "done" })).toBeNull();
    expect(store.listRuns()[0]?.phase).toBe("done");
  });

  it("reads a v1 file without runs or the new settings, filling the defaults instead of wiping it", () => {
    const { dataDir, store } = makeStore();
    writeFileSync(join(dataDir, "jobs.json"), JSON.stringify({
      version: 1, profile: { name: "Santhoshkumar", location: "", skills: [], experience: [], links: [], updatedAt: START },
      resumes: [], jobs: [], queue: [],
      settings: { platforms: {}, dailyCap: 10, search: { keywords: [], locations: [] }, twoFactor: {}, paused: false },
    }));
    const data = store.snapshot();
    expect(data.runs).toEqual([]);
    expect(data.settings).toMatchObject({ autoApply: true, companyPages: [] });
    expect(data.profile?.name).toBe("Santhoshkumar");
  });
});

describe("keyword match score", () => {
  it("scores overlap only, case-insensitively", () => {
    expect(keywordMatchScore(["SQL", "PySpark"], ["sql", "kafka"])).toBe(50);
    expect(keywordMatchScore(["SQL"], [])).toBe(0);
    expect(keywordMatchScore([], ["sql"])).toBe(0);
    expect(keywordMatchScore(["Databricks"], ["databricks"])).toBe(100);
  });
});
