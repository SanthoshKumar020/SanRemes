// One Job Bot run: search → tailor a resume per match → auto-decide (or queue for approval when
// auto-apply is off) → apply up to the daily cap, one task-queue task per application → a plain-words
// report into the Job Apply Bot's thread. A run is started from the route and keeps going in the
// background; pause stops it after the current application, never mid-submit.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { JobRun, JobRunApplied, JobRunSkipped, JobsJob, JobsQueueItem } from "../shared/jobs.ts";
import type { JobsStore, SubmitGate } from "./jobs-store.ts";
import { applyPrompt, HUMAN_CHECK_MARKER, parseSearchReport, searchPrompt, tailorResumeText } from "./jobs-resume.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { TasksStore } from "./tasks-store.ts";

export interface JobRunTurn {
  started: boolean;
  reason?: string;
}

export interface JobRunDeps {
  store: JobsStore;
  /** Absent, applications run without a queue task; the report says so. */
  tasks?: TasksStore | null;
  botExists(id: string): boolean;
  /** The Apply Bot's main thread, for the end-of-run report. */
  botThreadId?(id: string): string | null;
  startSearch?(input: { botId: string; prompt: string; onSettled?: (text: string) => void }): Promise<JobRunTurn>;
  startApply?(input: { botId: string; jobId: string; prompt: string; onSettled?: (applied: boolean, closingText?: string) => void }): Promise<JobRunTurn>;
  /** The Resume Bot's working folder, or null when it cannot be found. */
  resumeCwd?(botId: string): string | null;
  appendMessage?(threadId: string, text: string): void;
  now?: () => number;
  /** Waits between applications; defaults to a real timer. Tests pass a fake that records the delay. */
  sleep?: (ms: number) => Promise<void>;
}

const SETTLE_TIMEOUT_MS = 20 * 60_000;
const PACE_MIN_MS = 45_000;
const PACE_MAX_MS = 120_000;
const ACTIVE_PHASES: JobRun["phase"][] = ["searching", "tailoring", "applying", "reporting"];

const PLATFORM_NAMES: Record<string, string> = {
  naukri: "Naukri", linkedin: "LinkedIn", indeed: "Indeed", wellfound: "Wellfound",
  cutshort: "Cutshort", hirist: "Hirist", instahyre: "Instahyre",
};

function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform.charAt(0).toUpperCase() + platform.slice(1);
}

function gateReason(gate: Exclude<SubmitGate, { allowed: true }>): string {
  if (gate.reason === "daily-cap") return gate.platform ? `daily limit for ${platformName(gate.platform)} reached` : "daily limit reached";
  if (gate.reason === "paused") return "applying is paused";
  return "not approved";
}

function when(at: number): string {
  return new Date(at).toLocaleString();
}

export class JobRunDriver {
  private readonly deps: JobRunDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pausedIds = new Set<string>();
  private readonly executing = new Set<string>();

  constructor(deps: JobRunDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
  }

  getRun(id: string): JobRun | null {
    return this.deps.store.getRun(id);
  }

  listRuns(): JobRun[] {
    return this.deps.store.listRuns();
  }

  activeRun(): JobRun | null {
    return this.deps.store.listRuns().find((run) => ACTIVE_PHASES.includes(run.phase)) ?? null;
  }

  start(): JobRun {
    const settings = this.deps.store.snapshot().settings;
    const run = this.deps.store.createRun(settings.autoApply ? "auto" : "manual");
    void this.execute(run.id).catch(() => undefined);
    return run;
  }

  pause(id: string): JobRun | null {
    const run = this.deps.store.getRun(id);
    if (!run) return null;
    this.pausedIds.add(id);
    return run;
  }

  resume(id: string): JobRun | null {
    const run = this.deps.store.getRun(id);
    if (!run || run.phase !== "stopped") return null;
    this.pausedIds.delete(id);
    this.deps.store.updateRun(id, { phase: "searching", finishedAt: undefined });
    void this.execute(id).catch(() => undefined);
    return this.deps.store.getRun(id);
  }

  private paused(id: string): boolean {
    return this.pausedIds.has(id) || this.deps.store.snapshot().settings.paused;
  }

  private async execute(runId: string): Promise<void> {
    if (this.executing.has(runId)) return;
    this.executing.add(runId);
    try {
      const stopped = await this.searchAndTailor(runId);
      if (stopped) return;
      const settings = this.deps.store.snapshot().settings;
      if (!settings.autoApply) {
        this.finish(runId, "done", "queued for approval");
        return;
      }
      const ranked = this.rankedJobs(runId);
      this.deps.store.autoDecideQueue(ranked.map((job) => job.id));
      const rankedIds = new Set(ranked.map((job) => job.id));
      const seen = new Set<string>();
      const approved = this.deps.store.snapshot().queue.filter((item) => {
        if (item.state !== "approved" || !rankedIds.has(item.jobId) || seen.has(item.jobId)) return false;
        seen.add(item.jobId);
        return true;
      });
      const humanCheck = await this.applyAll(runId, approved);
      if (this.paused(runId)) {
        this.finish(runId, "stopped", "paused");
        return;
      }
      if (humanCheck) {
        this.finish(runId, "stopped", "the site asked for a human check — the bot stopped and never tried to solve it");
        return;
      }
      this.finish(runId, "done", "applied");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The run stopped unexpectedly.";
      this.finish(runId, "stopped", reason);
    } finally {
      this.executing.delete(runId);
    }
  }

  private async searchAndTailor(runId: string): Promise<boolean> {
    const store = this.deps.store;
    const settings = store.snapshot().settings;
    const applyBotId = settings.applyBotId;
    if (!applyBotId || !this.deps.startSearch) {
      store.updateRun(runId, { phase: "tailoring", searched: 0, found: 0 });
      return false;
    }
    store.updateRun(runId, { phase: "searching" });
    const text = await this.awaitSettled<string>((onSettled) =>
      this.deps.startSearch!({ botId: applyBotId, prompt: searchPrompt(settings), onSettled }));
    const reported = parseSearchReport(text);
    const { added } = store.recordFoundJobs(reported);
    const prior = store.getRun(runId);
    store.updateRun(runId, { phase: "tailoring", searched: (prior?.searched ?? 0) + reported.length, found: (prior?.found ?? 0) + added.length });
    if (this.paused(runId)) {
      this.finish(runId, "stopped", "paused");
      return true;
    }
    this.tailorRanked(runId);
    if (this.paused(runId)) {
      this.finish(runId, "stopped", "paused");
      return true;
    }
    return false;
  }

  /** Best match first; already applied jobs and jobs this run already applied to stay out. */
  private rankedJobs(runId: string): JobsJob[] {
    const store = this.deps.store;
    const done = new Set(store.getRun(runId)?.applied.map((entry) => entry.jobId) ?? []);
    return store.snapshot().jobs
      .filter((job) => job.status === "new" && !done.has(job.id))
      .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
  }

  private tailorRanked(runId: string): void {
    const store = this.deps.store;
    const data = store.snapshot();
    const profile = data.profile;
    const resumeBotId = data.settings.resumeBotId;
    const cwd = resumeBotId ? this.deps.resumeCwd?.(resumeBotId) ?? null : null;
    const remaining = Math.max(0, data.settings.dailyCap - store.appliedToday());
    const ranked = this.rankedJobs(runId);
    const queuedIds = new Set(data.queue.map((one) => one.jobId));
    let tailored = 0;
    for (const job of ranked) {
      if (queuedIds.has(job.id)) continue;
      if (tailored >= remaining) {
        this.addSkipped(runId, { jobId: job.id, company: job.company, title: job.title, reason: "daily limit reached" });
        continue;
      }
      if (!profile) {
        this.addSkipped(runId, { jobId: job.id, company: job.company, title: job.title, reason: "no job profile saved yet" });
        continue;
      }
      if (!cwd) {
        this.addSkipped(runId, { jobId: job.id, company: job.company, title: job.title, reason: "Resume Bot is not set up" });
        continue;
      }
      let text: string;
      try {
        text = tailorResumeText(profile, job);
      } catch {
        this.addSkipped(runId, { jobId: job.id, company: job.company, title: job.title, reason: "the tailored resume did not fit on one page" });
        continue;
      }
      const id = randomUUID();
      const path = join(cwd, "resumes", `${id}.txt`);
      try {
        mkdirSync(join(cwd, "resumes"), { recursive: true });
        writeFileAtomic(path, text);
      } catch {
        this.addSkipped(runId, { jobId: job.id, company: job.company, title: job.title, reason: "the tailored resume could not be saved" });
        continue;
      }
      const resume = store.addResume({ id, jobId: job.id, kind: "tailored", path, text, note: `Tailored for ${job.title} at ${job.company}` });
      store.setJobTailoredResume(job.id, resume.id);
      if (store.enqueue(job.id, resume.id)) queuedIds.add(job.id);
      tailored++;
    }
  }

  /** True when a turn ended because the site asked for a human check, so the run stops. */
  private async applyAll(runId: string, approved: readonly JobsQueueItem[]): Promise<boolean> {
    const store = this.deps.store;
    store.updateRun(runId, { phase: "applying" });
    const settings = store.snapshot().settings;
    const applyBotId = settings.applyBotId!;
    let queueFallback = !this.deps.tasks;
    let attempted = 0;
    for (const item of approved) {
      if (this.paused(runId)) return false;
      const data = store.snapshot();
      const job = data.jobs.find((one) => one.id === item.jobId);
      const resume = data.resumes.find((one) => one.id === item.tailoredResumeId);
      if (!job || !resume) {
        if (job) this.addSkipped(runId, { jobId: job.id, company: job.company, title: job.title, reason: "the tailored resume is missing" });
        continue;
      }
      const gate = store.submitGate(job.id);
      if (!gate.allowed) {
        this.addSkipped(runId, { jobId: job.id, company: job.company, title: job.title, reason: gateReason(gate) });
        continue;
      }
      if (attempted > 0) {
        await this.sleep(PACE_MIN_MS + Math.random() * (PACE_MAX_MS - PACE_MIN_MS));
        if (this.paused(runId)) return false;
      }
      let taskId: string | undefined;
      if (this.deps.tasks && applyBotId) {
        try {
          const task = this.deps.tasks.create({
            title: `Apply: ${job.title} at ${job.company}`,
            goal: `Submit the application for "${job.title}" at ${job.company} (${job.url}). Use the tailored resume at ${resume.path}. Fill every field only from the stored job profile; never invent skills, experience, salary, or certificates. Never try to solve a human check or CAPTCHA: stop and hand sign-in to the person instead.`,
            assigneeBotId: applyBotId,
          });
          taskId = task.id;
          const claimed = this.deps.tasks.claim(task.id, applyBotId);
          if (claimed && claimed !== "not-queued") this.deps.tasks.start(task.id, applyBotId);
        } catch {
          queueFallback = true;
        }
      }
      let applied = false;
      let closingText: string | undefined;
      try {
        const outcome = await this.awaitSettled<{ applied: boolean; closingText?: string }>((onSettled) =>
          this.deps.startApply!({
            botId: applyBotId, jobId: job.id, prompt: applyPrompt(job, resume.path),
            onSettled: (settledApplied, settledText) => onSettled({ applied: settledApplied, closingText: settledText }),
          }));
        applied = outcome.applied;
        closingText = outcome.closingText;
      } catch {
        applied = false;
      }
      attempted++;
      if (taskId && this.deps.tasks) {
        try {
          if (applied) this.deps.tasks.complete(taskId, applyBotId, "Application submitted.");
          else this.deps.tasks.fail(taskId, applyBotId, "Application was not submitted.");
        } catch {
          queueFallback = true;
        }
      }
      store.recordQueueAttempt(item.id, applied ? "submitted" : "not submitted");
      if (applied) store.setJobStatus(job.id, "applied");
      this.addApplied(runId, {
        jobId: job.id, company: job.company, title: job.title,
        ...(job.location ? { location: job.location } : {}),
        url: job.url, appliedAt: this.now(), status: applied ? "submitted" : "not-submitted",
        ...(taskId ? { taskId } : {}),
      });
      if (closingText?.trimStart().startsWith(HUMAN_CHECK_MARKER)) {
        if (queueFallback) this.deps.store.updateRun(runId, { queueFallback: true });
        return true;
      }
    }
    if (queueFallback) this.deps.store.updateRun(runId, { queueFallback: true });
    return false;
  }

  private addApplied(runId: string, entry: JobRunApplied): void {
    const run = this.deps.store.getRun(runId);
    if (!run) return;
    this.deps.store.updateRun(runId, { applied: [...run.applied, entry] });
  }

  private addSkipped(runId: string, entry: JobRunSkipped): void {
    const run = this.deps.store.getRun(runId);
    if (!run) return;
    this.deps.store.updateRun(runId, { skipped: [...run.skipped, entry] });
  }

  /** Waits for a turn's onSettled; a turn that never settles is a failure, not a hang. */
  private awaitSettled<T>(start: (resolve: (value: T) => void) => Promise<JobRunTurn>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The turn did not finish in time.")), SETTLE_TIMEOUT_MS);
      timer.unref?.();
      const done = (value: T) => { clearTimeout(timer); resolve(value); };
      start(done).then((turn) => {
        if (!turn.started) { clearTimeout(timer); reject(new Error(turn.reason ?? "The turn could not start.")); }
      }).catch((error: unknown) => { clearTimeout(timer); reject(error); });
    });
  }

  private finish(runId: string, phase: "done" | "stopped", note: string): void {
    const store = this.deps.store;
    store.updateRun(runId, { phase: "reporting" });
    const run = store.getRun(runId);
    if (!run) return;
    const reportText = buildReport(run, note);
    store.updateRun(runId, { phase, finishedAt: this.now(), reportText, whatsapp: "pending-bridge" });
    const applyBotId = store.snapshot().settings.applyBotId;
    const threadId = applyBotId ? this.deps.botThreadId?.(applyBotId) ?? null : null;
    if (threadId && this.deps.appendMessage) {
      try { this.deps.appendMessage(threadId, reportText); } catch { /* The saved report is the record; a failed post changes nothing. */ }
    }
  }
}

/** Plain words, no jargon: every application with its outcome, every skip with its reason. */
export function buildReport(run: JobRun, note: string): string {
  const lines = [`Job search report — ${when(run.startedAt)}`];
  const submitted = run.applied.filter((entry) => entry.status === "submitted");
  const notSubmitted = run.applied.filter((entry) => entry.status !== "submitted");
  if (note === "paused") lines.push("Stopped early — paused. What is below already happened.");
  if (note === "queued for approval") lines.push("Auto-apply is off, so nothing was submitted. These jobs are waiting for your approval in the queue.");
  if (run.kind === "manual" && note !== "queued for approval") lines.push("Auto-apply is off, so nothing was submitted.");
  if (note !== "paused" && note !== "queued for approval" && note !== "applied") lines.push(`The run stopped early: ${note}`);
  lines.push(`Found ${run.found} new jobs from ${run.searched} reported matches.`);
  if (submitted.length) {
    lines.push(`Applied to ${submitted.length}:`);
    for (const entry of submitted) {
      lines.push(`- ${entry.title} at ${entry.company}${entry.location ? `, ${entry.location}` : ""} — submitted ${when(entry.appliedAt)}. ${entry.url}`);
    }
  } else if (run.applied.length === 0) {
    lines.push("Applied to none.");
  }
  if (notSubmitted.length) {
    lines.push(`Tried but not submitted (${notSubmitted.length}):`);
    for (const entry of notSubmitted) lines.push(`- ${entry.title} at ${entry.company} — not submitted. ${entry.url}`);
  }
  const skipped = run.skipped;
  if (skipped.length) {
    lines.push(`Skipped ${skipped.length}:`);
    for (const entry of skipped) lines.push(`- ${entry.title} at ${entry.company} — ${entry.reason}.`);
  }
  if (run.queueFallback) {
    lines.push("Some applications ran without a queue task because the task queue was unavailable.");
  }
  lines.push("WhatsApp delivery is pending bridge setup — read the report here.");
  return lines.join("\n");
}
