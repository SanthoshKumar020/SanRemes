// jobs.json in the data dir: the job profile, resume versions, found jobs, the approval queue and job settings.
// Credentials never live here: a platform login is only a Vault login id, and the password stays in logins.json.enc.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DAILY_CAP_DEFAULT, jobsFileSchema, jobsJobSchema, jobsProfileSchema, jobsResumeSchema, jobsSettingsSchema, type JobPlatformSettings, type JobsData, type JobsJob, type JobsProfile, type JobsQueueItem, type JobsResume, type JobsSettings, type JobStatus, type QueueState } from "../shared/jobs.ts";

import { writeFileAtomic } from "./atomic.ts";

export const JOBS_FILE = "jobs.json";
export { DAILY_CAP_DEFAULT } from "../shared/jobs.ts";

export type SubmitGate =
  | { allowed: true }
  | { allowed: false; reason: "no-such-job" | "no-queue-item" | "not-approved" | "daily-cap" | "paused" };

/** What PATCH /api/jobs/settings (and the setup wizard's nested form) may change: every field optional, search patchable per key. */
export interface JobsSettingsPatch {
  platforms?: Record<string, JobPlatformSettings>;
  dailyCap?: number;
  search?: { keywords?: string[]; locations?: string[]; minSalary?: string };
  applyBotId?: string;
  resumeBotId?: string;
  paused?: boolean;
  twoFactor?: Record<string, boolean>;
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
    settings: { platforms: {}, dailyCap: DAILY_CAP_DEFAULT, search: { keywords: [], locations: [] }, twoFactor: {}, paused: false },
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
      data.settings = jobsSettingsSchema.parse({ ...data.settings, ...patch, platforms, search });
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

  appliedToday(now: number = this.now()): number {
    return this.read().jobs.filter((job) => job.status === "applied" && job.appliedAt !== undefined && sameLocalDay(job.appliedAt, now)).length;
  }

  submitGate(jobId: string, now: number = this.now()): SubmitGate {
    const data = this.read();
    if (data.settings.paused) return { allowed: false, reason: "paused" };
    if (!data.jobs.some((job) => job.id === jobId)) return { allowed: false, reason: "no-such-job" };
    const item = data.queue.find((one) => one.jobId === jobId);
    if (!item) return { allowed: false, reason: "no-queue-item" };
    if (item.state !== "approved" || item.decidedBy !== "user") return { allowed: false, reason: "not-approved" };
    if (this.appliedToday(now) >= data.settings.dailyCap) return { allowed: false, reason: "daily-cap" };
    return { allowed: true };
  }
}
