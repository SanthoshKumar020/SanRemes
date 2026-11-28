// jobs.json in the data dir: the job profile, resume versions, found jobs, the approval queue and job settings.
// Credentials never live here: a platform login is only a Vault login id, and the password stays in logins.json.enc.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DAILY_CAP_DEFAULT, jobRunSchema, jobsFileSchema, jobsJobSchema, jobsProfileSchema, jobsResumeSchema, jobsSettingsSchema, type JobOutcome, type JobPlatform, type JobPlatformSettings, type JobRun, type JobsData, type JobsJob, type JobsProfile, type JobsQueueItem, type JobsResume, type JobsSettings, type JobStatus, type QueueState } from "../shared/jobs.ts";
import type { CompanyResearchOutcome } from "./jobs-company-research.ts";

import { writeFileAtomic } from "./atomic.ts";

export const JOBS_FILE = "jobs.json";
export { DAILY_CAP_DEFAULT } from "../shared/jobs.ts";

export type SubmitGate =
  | { allowed: true }
  | { allowed: false; reason: "no-such-job" | "no-queue-item" | "not-approved" | "paused" }
  | { allowed: false; reason: "daily-cap"; platform?: JobPlatform };

/** One platform may take at most half the day's cap, at least one application. */
export function perPlatformDailyCap(dailyCap: number): number {
  return Math.max(1, Math.floor(dailyCap / 2));
}

/** What PATCH /api/jobs/settings (and the setup wizard's nested form) may change: every field optional, search patchable per key. */
export interface JobsSettingsPatch {
  platforms?: Record<string, JobPlatformSettings>;
  dailyCap?: number;
  search?: { keywords?: string[]; locations?: string[]; minSalary?: string };
  applyBotId?: string;
  resumeBotId?: string;
  paused?: boolean;
  twoFactor?: Record<string, boolean>;
  autoApply?: boolean;
  companyPages?: string[];
  reportBridge?: { whatsappUrl?: string; telegramUrl?: string; secretName?: string };
}

/** The Jobs page tracker: status totals, per-platform results, follow-ups due now, outcome counts. */
export interface TrackerSummary {
  totals: Record<JobStatus, number>;
  perPlatform: { platform: string; applied: number; interview: number; rejected: number; offer: number; conversion: number }[];
  followUpsDue: JobsJob[];
  outcomes: { interview: number; rejected: number; offer: number; noReply: number };
}

/** One found job as a search turn reports it, before the store scores and dedupes it. */
export interface FoundJobInput {
  platform: string;
  url: string;
  title: string;
  company: string;
  location?: string;
  salaryText?: string;
  jdText?: string;
  jdKeywords?: string[];
}

function emptyData(): JobsData {
  return {
    version: 1,
    profile: null,
    resumes: [],
    jobs: [],
    queue: [],
    settings: { platforms: {}, dailyCap: DAILY_CAP_DEFAULT, search: { keywords: [], locations: [] }, twoFactor: {}, paused: false, autoApply: true, companyPages: [] },
    runs: [],
  };
}

/** Keyword overlap between the stored profile skills and a posting's keywords, as a 0–100 score. */
export function keywordMatchScore(skills: readonly string[], jdKeywords: readonly string[]): number {
  const known = new Set(skills.map((skill) => skill.trim().toLowerCase()).filter(Boolean));
  const wanted = jdKeywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length || !known.size) return 0;
  return Math.round((wanted.filter((keyword) => known.has(keyword)).length / wanted.length) * 100);
}

export function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** The profile skills a job description actually names, so a posting without an explicit keyword list still scores. */
export function deriveKeywords(jdText: string, skills: readonly string[]): string[] {
  const text = jdText.toLowerCase();
  return skills.map((skill) => skill.trim()).filter((skill) => skill && text.includes(skill.toLowerCase()));
}

export class JobsStore {
  private readonly file: string;
  private readonly now: () => number;
  private cache: JobsData | null = null;
  private unreadableWarned = false;
  version = 0;

  constructor(options: { dataDir: string; now?: () => number }) {
    this.file = join(options.dataDir, JOBS_FILE);
    this.now = options.now ?? Date.now;
  }

  private read(): JobsData {
    if (this.cache) return this.cache;
    let data = emptyData();
    if (existsSync(this.file)) {
      try {
        data = jobsFileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      } catch {
        if (!this.unreadableWarned) console.warn("jobs: jobs.json could not be read; it will be replaced on the next save");
        this.unreadableWarned = true;
        data = emptyData();
      }
    }
    this.cache = data;
    this.version++;
    return data;
  }

  private write(data: JobsData): void {
    const parsed = jobsFileSchema.parse(data);
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`);
    this.cache = parsed;
    this.version++;
  }

  snapshot(): JobsData {
    return structuredClone(this.read());
  }

  update(mutator: (data: JobsData) => void): JobsData {
    const next = structuredClone(this.read());
    mutator(next);
    if (JSON.stringify(next) !== JSON.stringify(this.cache)) this.write(next);
    return structuredClone(this.cache!);
  }

  setProfile(patch: Partial<JobsProfile>): JobsProfile {
    const at = this.now();
    const updated = this.update((data) => {
      const current = data.profile ?? { name: "", location: "", skills: [], experience: [], links: [], updatedAt: at };
      data.profile = jobsProfileSchema.parse({ ...current, ...patch, updatedAt: at });
    });
    return updated.profile!;
  }

  setSettings(patch: JobsSettingsPatch): JobsSettings {
    const updated = this.update((data) => {
      const search = { ...data.settings.search, ...patch.search };
      const platforms = { ...data.settings.platforms, ...patch.platforms };
      const reportBridge = patch.reportBridge ? { ...data.settings.reportBridge, ...patch.reportBridge } : data.settings.reportBridge;
      const merged = { ...data.settings, ...patch, platforms, search };
      if (reportBridge) merged.reportBridge = reportBridge;
      data.settings = jobsSettingsSchema.parse(merged);
    });
    return updated.settings;
  }

  addJob(input: Omit<JobsJob, "id" | "status" | "statusAt" | "foundAt" | "jdKeywords"> & { id?: string; foundAt?: number; jdKeywords?: string[] }): JobsJob {
    const at = this.now();
    const job: JobsJob = jobsJobSchema.parse({
      ...input, id: input.id ?? randomUUID(), status: "new", statusAt: at, foundAt: input.foundAt ?? at,
    });
    this.update((data) => { data.jobs.push(job); });
    return job;
  }

  addResume(input: Omit<JobsResume, "id" | "createdAt"> & { id?: string }): JobsResume {
    const at = this.now();
    const resume: JobsResume = jobsResumeSchema.parse({ ...input, id: input.id ?? randomUUID(), createdAt: at });
    this.update((data) => { data.resumes.push(resume); });
    return resume;
  }

  setJobTailoredResume(jobId: string, resumeId: string): JobsJob | null {
    let changed: JobsJob | null = null;
    this.update((data) => {
      const job = data.jobs.find((one) => one.id === jobId);
      if (!job) return;
      job.tailoredResumeId = resumeId;
      changed = { ...job };
    });
    return changed;
  }

  /** Points a still-pending queue item at a freshly tailored resume for the same job. */
  repointQueue(jobId: string, tailoredResumeId: string): JobsQueueItem | null {
    let changed: JobsQueueItem | null = null;
    this.update((data) => {
      const item = data.queue.find((one) => one.jobId === jobId && one.state === "pending");
      if (!item) return;
      item.tailoredResumeId = tailoredResumeId;
      changed = { ...item };
    });
    return changed;
  }

  recordQueueAttempt(id: string, result: string): JobsQueueItem | null {
    const at = this.now();
    let changed: JobsQueueItem | null = null;
    this.update((data) => {
      const item = data.queue.find((one) => one.id === id);
      if (!item) return;
      item.attempts.push({ at, result });
      changed = { ...item };
    });
    return changed;
  }

  /** Records found jobs, scoring each against the stored profile skills and skipping urls already known. */
  recordFoundJobs(inputs: readonly FoundJobInput[]): { added: JobsJob[]; skipped: number } {
    const at = this.now();
    const data = this.read();
    const skills = data.profile?.skills ?? [];
    const knownUrls = new Set(data.jobs.map((job) => job.url.toLowerCase()));
    const added: JobsJob[] = [];
    let skipped = 0;
    for (const input of inputs) {
      if (knownUrls.has(input.url.toLowerCase())) { skipped++; continue; }
      const jdKeywords = [...new Set((input.jdKeywords ?? deriveKeywords(input.jdText ?? "", skills)).map((keyword) => keyword.trim()).filter(Boolean))];
      const job: JobsJob = jobsJobSchema.parse({
        ...input, jdKeywords, id: randomUUID(), status: "new", statusAt: at, foundAt: at,
        matchScore: keywordMatchScore(skills, jdKeywords),
      });
      knownUrls.add(job.url.toLowerCase());
      added.push(job);
    }
    if (added.length) this.update((next) => { next.jobs.push(...added); });
    return { added, skipped };
  }

  setJobStatus(id: string, status: JobStatus, appliedAt?: number): JobsJob | null {
    const at = this.now();
    let changed: JobsJob | null = null;
    this.update((data) => {
      const job = data.jobs.find((one) => one.id === id);
      if (!job) return;
      job.status = status;
      job.statusAt = at;
      if (status === "applied") job.appliedAt = appliedAt ?? at;
      changed = { ...job };
    });
    return changed;
  }

  /** Records how an application ended. Interview and rejected move the job status; offer and no-reply leave it where it is: the status list has no offer state, and a silent application stays applied. */
  recordOutcome(jobId: string, outcome: { kind: JobOutcome["kind"]; note?: string }): JobsJob | null {
    const at = this.now();
    let changed: JobsJob | null = null;
    this.update((data) => {
      const job = data.jobs.find((one) => one.id === jobId);
      if (!job) return;
      job.outcome = { kind: outcome.kind, at, ...(outcome.note ? { note: outcome.note } : {}) };
      if (outcome.kind === "interview" || outcome.kind === "rejected") {
        job.status = outcome.kind;
        job.statusAt = at;
      }
      changed = { ...job };
    });
    return changed;
  }

  /** Sets a follow-up date and note; a null date clears the follow-up and its note. */
  setFollowUp(jobId: string, at: number | null, note?: string): JobsJob | null {
    let changed: JobsJob | null = null;
    this.update((data) => {
      const job = data.jobs.find((one) => one.id === jobId);
      if (!job) return;
      if (at === null) {
        delete job.followUpAt;
        delete job.followUpNote;
      } else {
        job.followUpAt = at;
        if (note === undefined) delete job.followUpNote;
        else job.followUpNote = note;
      }
      changed = { ...job };
    });
    return changed;
  }

  /** Stores company research on the job. A failed attempt is stored too, with an empty summary, so the next run knows it was tried. */
  recordCompanyResearch(jobId: string, outcome: CompanyResearchOutcome): JobsJob | null {
    const at = this.now();
    let changed: JobsJob | null = null;
    this.update((data) => {
      const job = data.jobs.find((one) => one.id === jobId);
      if (!job) return;
      job.companyResearch = outcome.ok
        ? { summary: outcome.research.summary, sources: outcome.research.sources, researchedAt: outcome.research.researchedAt, searches: outcome.research.searches, pagesRead: outcome.research.pagesRead }
        : { summary: "", sources: [], researchedAt: at, failed: true, reason: outcome.reason };
      changed = { ...job };
    });
    return changed;
  }

  setCoverLetter(jobId: string, resumeId: string): JobsJob | null {
    let changed: JobsJob | null = null;
    this.update((data) => {
      const job = data.jobs.find((one) => one.id === jobId);
      if (!job) return;
      job.coverLetterId = resumeId;
      changed = { ...job };
    });
    return changed;
  }

  setInterviewPrep(jobId: string, resumeId: string): JobsJob | null {
    let changed: JobsJob | null = null;
    this.update((data) => {
      const job = data.jobs.find((one) => one.id === jobId);
      if (!job) return;
      job.interviewPrepId = resumeId;
      changed = { ...job };
    });
    return changed;
  }

  setLastGoodLayout(jobId: string, fingerprint: string, labels: readonly string[]): JobsJob | null {
    const at = this.now();
    let changed: JobsJob | null = null;
    this.update((data) => {
      const job = data.jobs.find((one) => one.id === jobId);
      if (!job) return;
      job.lastGoodLayout = { fingerprint, labels: [...labels], at };
      changed = { ...job };
    });
    return changed;
  }

  enqueue(jobId: string, tailoredResumeId: string): JobsQueueItem | null {
    const item: JobsQueueItem = { id: randomUUID(), jobId, tailoredResumeId, state: "pending", attempts: [] };
    let added: JobsQueueItem | null = null;
    this.update((data) => {
      if (!data.jobs.some((job) => job.id === jobId)) return;
      if (data.queue.some((one) => one.jobId === jobId && one.state === "pending")) return;
      data.queue.push(item);
      added = { ...item };
    });
    return added;
  }

  decideQueue(id: string, state: Extract<QueueState, "approved" | "rejected">): JobsQueueItem | null {
    const at = this.now();
    let changed: JobsQueueItem | null = null;
    this.update((data) => {
      const item = data.queue.find((one) => one.id === id);
      if (!item) return;
      item.state = state;
      item.decidedAt = at;
      item.decidedBy = "user";
      changed = { ...item };
    });
    return changed;
  }

  /** Approves still-pending queue items as the run's own decision, best rank first, up to the remaining daily cap. */
  autoDecideQueue(jobIds: readonly string[]): JobsQueueItem[] {
    const at = this.now();
    const approved: JobsQueueItem[] = [];
    this.update((data) => {
      const remaining = data.settings.dailyCap - data.jobs.filter((job) => job.status === "applied" && job.appliedAt !== undefined && sameLocalDay(job.appliedAt, at)).length;
      for (const jobId of jobIds) {
        if (approved.length >= remaining) break;
        const item = data.queue.find((one) => one.jobId === jobId && one.state === "pending");
        if (!item) continue;
        item.state = "approved";
        item.decidedAt = at;
        item.decidedBy = "auto";
        approved.push({ ...item });
      }
    });
    return approved;
  }

  createRun(kind: JobRun["kind"]): JobRun {
    const run: JobRun = jobRunSchema.parse({
      id: randomUUID(), kind, startedAt: this.now(), phase: "searching",
      searched: 0, found: 0, applied: [], skipped: [], reportText: "", whatsapp: "pending-bridge",
    });
    this.update((data) => { data.runs.push(run); });
    return run;
  }

  getRun(id: string): JobRun | null {
    const run = this.read().runs.find((one) => one.id === id);
    return run ? structuredClone(run) : null;
  }

  listRuns(): JobRun[] {
    return structuredClone(this.read().runs).sort((a, b) => b.startedAt - a.startedAt);
  }

  updateRun(id: string, patch: Partial<JobRun>): JobRun | null {
    let changed: JobRun | null = null;
    this.update((data) => {
      const run = data.runs.find((one) => one.id === id);
      if (!run) return;
      Object.assign(run, jobRunSchema.parse({ ...run, ...patch }));
      changed = { ...run };
    });
    return changed;
  }

  setRunTakeover(runId: string, takeover: NonNullable<JobRun["takeover"]>): JobRun | null {
    return this.updateRun(runId, { takeover });
  }

  clearRunTakeover(runId: string): JobRun | null {
    let changed: JobRun | null = null;
    this.update((data) => {
      const run = data.runs.find((one) => one.id === runId);
      if (!run) return;
      delete run.takeover;
      changed = { ...run };
    });
    return changed;
  }

  /** Status totals, per-platform results with interview conversion, follow-ups due now, outcome counts. */
  trackerSummary(): TrackerSummary {
    const data = this.read();
    const now = this.now();
    const totals: Record<JobStatus, number> = { new: 0, queued: 0, approved: 0, applied: 0, interview: 0, rejected: 0, saved: 0, skipped: 0, expired: 0 };
    const byPlatform = new Map<string, { platform: string; applied: number; interview: number; rejected: number; offer: number }>();
    const outcomes = { interview: 0, rejected: 0, offer: 0, noReply: 0 };
    for (const job of data.jobs) {
      totals[job.status]++;
      const row = byPlatform.get(job.platform) ?? { platform: job.platform, applied: 0, interview: 0, rejected: 0, offer: 0 };
      byPlatform.set(job.platform, row);
      if (job.status === "applied") row.applied++;
      if (job.outcome?.kind === "interview") { row.interview++; outcomes.interview++; }
      if (job.outcome?.kind === "rejected") { row.rejected++; outcomes.rejected++; }
      if (job.outcome?.kind === "offer") { row.offer++; outcomes.offer++; }
      if (job.outcome?.kind === "no-reply") outcomes.noReply++;
    }
    const perPlatform = [...byPlatform.values()]
      .sort((a, b) => a.platform.localeCompare(b.platform))
      .map((row) => ({ ...row, conversion: row.applied === 0 ? 0 : Math.round((row.interview / row.applied) * 100) }));
    const followUpsDue = data.jobs
      .filter((job) => job.followUpAt !== undefined && job.followUpAt <= now && (job.status === "applied" || job.status === "interview"))
      .sort((a, b) => (a.followUpAt ?? 0) - (b.followUpAt ?? 0))
      .map((job) => structuredClone(job));
    return { totals, perPlatform, followUpsDue, outcomes };
  }

  appliedToday(now: number = this.now()): number {
    return this.read().jobs.filter((job) => job.status === "applied" && job.appliedAt !== undefined && sameLocalDay(job.appliedAt, now)).length;
  }

  appliedTodayForPlatform(platform: JobPlatform, now: number = this.now()): number {
    return this.read().jobs.filter((job) => job.platform === platform && job.status === "applied" && job.appliedAt !== undefined && sameLocalDay(job.appliedAt, now)).length;
  }

  submitGate(jobId: string, now: number = this.now()): SubmitGate {
    const data = this.read();
    if (data.settings.paused) return { allowed: false, reason: "paused" };
    const job = data.jobs.find((one) => one.id === jobId);
    if (!job) return { allowed: false, reason: "no-such-job" };
    const item = data.queue.find((one) => one.jobId === jobId);
    if (!item) return { allowed: false, reason: "no-queue-item" };
    if (item.state !== "approved") return { allowed: false, reason: "not-approved" };
    if (item.decidedBy === "auto" && !data.settings.autoApply) return { allowed: false, reason: "not-approved" };
    if (item.decidedBy !== "user" && item.decidedBy !== "auto") return { allowed: false, reason: "not-approved" };
    if (this.appliedToday(now) >= data.settings.dailyCap) return { allowed: false, reason: "daily-cap" };
    if (this.appliedTodayForPlatform(job.platform, now) >= perPlatformDailyCap(data.settings.dailyCap)) return { allowed: false, reason: "daily-cap", platform: job.platform };
    return { allowed: true };
  }
}
