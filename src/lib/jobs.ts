import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import {
  DAILY_CAP_DEFAULT, DAILY_CAP_MAX,
  type JobsData, type JobsJob, type JobsProfile, type JobsQueueItem, type JobsResume, type JobsSettings, type JobStatus,
} from "../../shared/jobs";
import { addLogin, type LoginFieldsInput } from "./logins";
import { api, type Bot } from "@/state/store";

export type {
  JobsData, JobsJob, JobsProfile, JobsQueueItem, JobsResume, JobsSettings, JobPlatform, JobStatus, QueueState,
} from "../../shared/jobs";
export type { Bot } from "@/state/store";

/** What GET /api/jobs returns: the stored jobs data plus today's applied count for the cap display. */
export interface JobsState extends JobsData {
  appliedToday: number;
}

export interface JobPlatformStatus {
  platform: string;
  enabled: boolean;
  loginId?: string;
  signedIn: boolean | null;
}

export interface ExtractedResume {
  text: string;
  pages: number | null;
  kind: "pdf" | "docx" | "text";
}

export type ResumeDiffLine = { type: "same" | "added" | "removed"; text: string };

export const JOB_BOTS_SECTION = "Jobs";
export const RESUME_BOT_NAME = "Resume Bot";
export const APPLY_BOT_NAME = "Job Apply Bot";
export const DEFAULT_DAILY_CAP = DAILY_CAP_DEFAULT;
export const MAX_DAILY_CAP = DAILY_CAP_MAX;

/** A cap above the default needs the account-risk warning shown again before it sticks. */
export function dailyCapNeedsRiskConfirm(cap: number): boolean {
  return cap > DAILY_CAP_DEFAULT;
}

export function clampDailyCap(value: number): number {
  if (!Number.isFinite(value)) return DAILY_CAP_DEFAULT;
  return Math.min(DAILY_CAP_MAX, Math.max(1, Math.round(value)));
}

export const RESUME_BOT_SOUL = [
  "You write and tailor resumes for one person, from their stored job profile only.",
  "Every resume you make stays on one page.",
  "Never invent skills, experience, salary, certificates, or employers. Tailor only from the stored profile: reorder and reword what is there, drop what does not fit the job, never add what is not there.",
  "When a job asks for something the profile does not have, leave it out and say so plainly instead of filling the gap.",
  "Keep the format plain and ATS-friendly: no tables, no graphics, no columns.",
  "Store each version under the resumes folder and record its path, so the Jobs page can show what changed against the base resume.",
].join("\n");

export const APPLY_BOT_SOUL = [
  "You find jobs and apply to them for one person, from their stored job profile and search settings only.",
  "Apply to ranked matches on your own, up to the daily cap: an auto-approved queue item is the submit gate, and the cap is the limit.",
  "Never invent skills, experience, salary, or certificates in a search, a draft, or a form. Use only what the stored profile says.",
  "Work one job at a time in your own browser profile. Never attach to the person's own signed-in browser.",
  "Never try to solve a human check or CAPTCHA. Stop and hand sign-in to the person instead.",
  "Keep to the daily application cap. When the cap is reached, stop applying and say so.",
  "Report every application: which company, which role, whether it went out, and what stopped it when it did not.",
].join("\n");

export function soulBytes(soul: string): number {
  return new TextEncoder().encode(soul).length;
}

export function jobBotSoulsWithinBudget(): boolean {
  return soulBytes(RESUME_BOT_SOUL) <= BOT_PROFILE_LIMITS.soul && soulBytes(APPLY_BOT_SOUL) <= BOT_PROFILE_LIMITS.soul;
}

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

async function createBot(request: Request, body: Record<string, unknown>): Promise<Bot> {
  return (await request<{ bot: Bot }>("/api/bots", {
    method: "POST",
    body: JSON.stringify({ useDefaults: false, ...body }),
  })).bot;
}

/** The two bots the Jobs setup flow files under the Jobs section. Reuses bots already there instead of making duplicates. */
export async function ensureJobBots(existing: readonly Bot[], request: Request = api): Promise<{ resumeBot: Bot; applyBot: Bot }> {
  const found = (name: string) => existing.find((bot) => bot.name === name && bot.section === JOB_BOTS_SECTION);
  const resumeBot = found(RESUME_BOT_NAME) ?? await createBot(request, {
    name: RESUME_BOT_NAME,
    title: "Tailors your resume for each job",
    description: "Writes single-page, tailored resumes from your stored profile. Never invents skills, experience, salary, or certificates.",
    section: JOB_BOTS_SECTION,
    settings: { soul: RESUME_BOT_SOUL, approvalMode: "ask", browser: false, computer: "off" },
  });
  const applyBot = found(APPLY_BOT_NAME) ?? await createBot(request, {
    name: APPLY_BOT_NAME,
    title: "Finds jobs and drafts applications",
    description: "Searches Naukri and LinkedIn and drafts applications. Submits only what you approved in the Jobs page queue.",
    section: JOB_BOTS_SECTION,
    settings: { soul: APPLY_BOT_SOUL, approvalMode: "auto", browser: true, computer: "browser" },
  });
  return { resumeBot, applyBot };
}

export async function fetchJobs(request: Request = api): Promise<JobsState> {
  return request<JobsState>("/api/jobs");
}

export async function fetchPlatforms(request: Request = api): Promise<{ platforms: JobPlatformStatus[]; applyBotId?: string }> {
  return request<{ platforms: JobPlatformStatus[]; applyBotId?: string }>("/api/jobs/platforms");
}

export interface ProfileSave {
  profile?: Partial<JobsProfile>;
  settings?: Partial<JobsSettings>;
}

/** Stores the profile fields and the raw resume input. Extraction and tailoring are a later step. */
export async function saveProfile(input: ProfileSave, request: Request = api): Promise<JobsState> {
  return request<JobsState>("/api/jobs/profile", { method: "PATCH", body: JSON.stringify(input) });
}

/** Stores job settings on their own: the daily cap, the pause switch, and the two bot ids. */
export async function saveSettings(settings: Partial<JobsSettings>, request: Request = api): Promise<JobsState> {
  return request<JobsState>("/api/jobs/settings", { method: "PATCH", body: JSON.stringify(settings) });
}

/** Sends a resume file to the server for text extraction; the text comes back for the person to check. */
export async function extractResume(file: File, request: Request = api): Promise<ExtractedResume> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return request<ExtractedResume>("/api/jobs/extract", {
    method: "POST",
    body: JSON.stringify({ filename: file.name, dataBase64: btoa(binary) }),
  });
}

/** Asks the Resume Bot's workspace for a one-page tailored resume for a job, and queues the job for approval. */
export async function tailorResume(jobId: string, request: Request = api): Promise<{ resume: JobsResume; job: JobsJob; queue: JobsQueueItem | null }> {
  return request<{ resume: JobsResume; job: JobsJob; queue: JobsQueueItem | null }>(`/api/jobs/${jobId}/tailor`, { method: "POST" });
}

/** Starts a Job Apply Bot search turn; found jobs land in the queue once the turn reports them. */
export async function startJobSearch(request: Request = api): Promise<{ started: boolean; botId: string }> {
  return request<{ started: boolean; botId: string }>("/api/jobs/search", { method: "POST", body: JSON.stringify({}) });
}

export async function approveQueueItem(id: string, request: Request = api): Promise<{ queue: JobsQueueItem }> {
  return request<{ queue: JobsQueueItem }>(`/api/jobs/queue/${id}/approve`, { method: "POST" });
}

export async function rejectQueueItem(id: string, request: Request = api): Promise<{ queue: JobsQueueItem }> {
  return request<{ queue: JobsQueueItem }>(`/api/jobs/queue/${id}/reject`, { method: "POST" });
}

/** Approves several queue rows at once; the submit gate still applies per row when anything is sent. */
export async function batchApproveQueue(ids: string[], request: Request = api): Promise<{ results: Array<{ id: string; state?: string; error?: string }> }> {
  return request<{ results: Array<{ id: string; state?: string; error?: string }> }>("/api/jobs/queue/batch-approve", { method: "POST", body: JSON.stringify({ ids }) });
}

/** Starts the Apply Bot turn that submits one approved application; refused unless the gate passes. */
export async function applyQueueItem(id: string, request: Request = api): Promise<{ started: boolean; botId: string }> {
  return request<{ started: boolean; botId: string }>(`/api/jobs/queue/${id}/apply`, { method: "POST" });
}

export async function updateJobStatus(id: string, status: JobStatus, request: Request = api): Promise<{ job: JobsJob }> {
  return request<{ job: JobsJob }>(`/api/jobs/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
}

/** Found jobs ranked best match first; ties keep the order they were found in. */
export function sortedJobs(jobs: readonly JobsJob[]): JobsJob[] {
  return [...jobs].sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
}

/** Line-level diff between the base resume and a tailored one, so invented lines stand out. */
export function resumeDiff(base: string, tailored: string): ResumeDiffLine[] {
  const a = base.split("\n");
  const b = tailored.split("\n");
  const rows: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      rows[i]![j] = a[i] === b[j] ? rows[i + 1]![j + 1]! + 1 : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
    }
  }
  const out: ResumeDiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ type: "same", text: a[i]! }); i++; j++; }
    else if (rows[i + 1]![j]! >= rows[i]![j + 1]!) { out.push({ type: "removed", text: a[i]! }); i++; }
    else { out.push({ type: "added", text: b[j]! }); j++; }
  }
  while (i < a.length) { out.push({ type: "removed", text: a[i]! }); i++; }
  while (j < b.length) { out.push({ type: "added", text: b[j]! }); j++; }
  return out;
}

/** Saves a platform login for the Job Apply Bot alone. The typed password is dropped once saved and never read back. */
export async function savePlatformLogin(
  site: "naukri.com" | "linkedin.com",
  fields: LoginFieldsInput,
  applyBotId: string,
): Promise<{ id: string; username: string }> {
  const login = await addLogin(site, fields, [applyBotId]);
  return { id: login.id, username: login.username };
}

export function emptyJobsState(): JobsState {
  return {
    version: 1,
    profile: null,
    resumes: [],
    jobs: [],
    queue: [],
    runs: [],
    settings: { platforms: {}, dailyCap: DAILY_CAP_DEFAULT, search: { keywords: [], locations: [] }, twoFactor: {}, paused: false, autoApply: true, companyPages: [] },
    appliedToday: 0,
  };
}
