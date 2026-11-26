// jobs.json as the server stores it and the Jobs page reads it: the job profile, resume versions, found jobs,
// the approval queue and job settings. A platform login is only a Vault login id here; the password never is.
import { z } from "zod";

export const DAILY_CAP_DEFAULT = 10;
export const DAILY_CAP_MAX = 50;

export const jobPlatformSchema = z.enum(["naukri", "linkedin", "indeed", "wellfound", "cutshort", "hirist", "instahyre"]);
export type JobPlatform = z.infer<typeof jobPlatformSchema>;

export const jobStatusSchema = z.enum(["new", "queued", "approved", "applied", "interview", "rejected", "saved", "skipped", "expired"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const queueStateSchema = z.enum(["pending", "approved", "rejected"]);
export type QueueState = z.infer<typeof queueStateSchema>;

const idSchema = z.string().regex(/^[\w-]{1,128}$/u);
const textSchema = (max: number) => z.string().max(max);
const stringList = (maxItems: number, maxEach: number) => z.array(z.string().max(maxEach)).max(maxItems).default([]);

const experienceSchema = z.object({
  org: textSchema(200),
  role: textSchema(200),
  start: textSchema(40),
  end: textSchema(40).optional(),
  bullets: z.array(z.string().max(500)).max(20).default([]),
}).strict();

export const jobsProfileSchema = z.object({
  name: textSchema(200).min(1),
  title: textSchema(200).optional(),
  location: textSchema(200).default(""),
  noticePeriod: textSchema(100).optional(),
  salaryCurrent: textSchema(100).optional(),
  salaryExpected: textSchema(100).optional(),
  skills: stringList(200, 100),
  experience: z.array(experienceSchema).max(20).default([]),
  /** Total years of experience, as the person states it; the resume parser fills this, the tailor does not read it. */
  yearsOfExperience: z.number().min(0).max(50).optional(),
  education: textSchema(500).optional(),
  links: stringList(20, 500),
  updatedAt: z.number(),
  sourceResumeId: z.string().max(128).optional(),
  /** The pasted or uploaded resume text as the person gave it, kept until extraction runs. */
  resumeText: textSchema(200_000).optional(),
  resumeFileName: textSchema(300).optional(),
}).strict();
export type JobsProfile = z.infer<typeof jobsProfileSchema>;

export const jobsResumeSchema = z.object({
  id: idSchema,
  jobId: z.string().max(128).nullable().optional(),
  kind: z.enum(["base", "tailored"]),
  path: textSchema(1024).min(1),
  createdAt: z.number(),
  note: textSchema(500).optional(),
  /** The tailored text itself, so the Jobs page can show the diff without a file route. */
  text: textSchema(20_000).optional(),
}).strict();
export type JobsResume = z.infer<typeof jobsResumeSchema>;

export const jobsJobSchema = z.object({
  id: idSchema,
  platform: jobPlatformSchema,
  url: z.string().url().max(2048),
  title: textSchema(300).min(1),
  company: textSchema(300).min(1),
  location: textSchema(200).optional(),
  salaryText: textSchema(200).optional(),
  postedAt: z.number().optional(),
  foundAt: z.number(),
  jdText: textSchema(50_000).optional(),
  jdKeywords: stringList(100, 100),
  matchScore: z.number().min(0).max(100).optional(),
  status: jobStatusSchema,
  statusAt: z.number(),
  tailoredResumeId: z.string().max(128).optional(),
  appliedAt: z.number().optional(),
  notes: textSchema(2000).optional(),
}).strict();
export type JobsJob = z.infer<typeof jobsJobSchema>;

export const jobsQueueItemSchema = z.object({
  id: idSchema,
  jobId: idSchema,
  tailoredResumeId: idSchema,
  state: queueStateSchema,
  decidedAt: z.number().optional(),
  decidedBy: z.enum(["user", "auto"]).optional(),
  attempts: z.array(z.object({ at: z.number(), result: textSchema(500) }).strict()).max(50).default([]),
}).strict();
export type JobsQueueItem = z.infer<typeof jobsQueueItemSchema>;

export const jobRunPhaseSchema = z.enum(["searching", "tailoring", "applying", "reporting", "done", "stopped"]);
export type JobRunPhase = z.infer<typeof jobRunPhaseSchema>;

export const jobRunAppliedSchema = z.object({
  jobId: idSchema,
  company: textSchema(300),
  title: textSchema(300),
  location: textSchema(200).optional(),
  url: z.string().url().max(2048),
  appliedAt: z.number(),
  status: z.enum(["submitted", "not-submitted"]),
  requisition: textSchema(200).optional(),
  taskId: z.string().max(128).optional(),
}).strict();
export type JobRunApplied = z.infer<typeof jobRunAppliedSchema>;

export const jobRunSkippedSchema = z.object({
  jobId: idSchema,
  company: textSchema(300),
  title: textSchema(300),
  reason: textSchema(500),
}).strict();
export type JobRunSkipped = z.infer<typeof jobRunSkippedSchema>;

export const jobRunSchema = z.object({
  id: idSchema,
  kind: z.enum(["auto", "manual"]),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  phase: jobRunPhaseSchema,
  searched: z.number().int().min(0).default(0),
  found: z.number().int().min(0).default(0),
  applied: z.array(jobRunAppliedSchema).max(500).default([]),
  skipped: z.array(jobRunSkippedSchema).max(500).default([]),
  reportText: z.string().max(50_000).default(""),
  whatsapp: z.enum(["sent", "pending-bridge", "not-configured"]).default("pending-bridge"),
  /** True when at least one application ran without its queue task because the queue was unavailable. */
  queueFallback: z.boolean().default(false),
}).strict();
export type JobRun = z.infer<typeof jobRunSchema>;

export const platformSettingsSchema = z.object({
  enabled: z.boolean(),
  loginId: z.string().max(128).optional(),
}).strict();
export type JobPlatformSettings = z.infer<typeof platformSettingsSchema>;

export const jobsSettingsSchema = z.object({
  platforms: z.record(z.string().min(1).max(64), platformSettingsSchema).default({}),
  dailyCap: z.number().int().min(1).max(DAILY_CAP_MAX).default(DAILY_CAP_DEFAULT),
  search: z.object({
    keywords: stringList(50, 100),
    locations: stringList(50, 100),
    minSalary: textSchema(100).optional(),
  }).strict().default({ keywords: [], locations: [] }),
  applyBotId: z.string().max(128).optional(),
  resumeBotId: z.string().max(128).optional(),
  /** The pause-all switch on the Jobs page: while true, no application may be submitted. */
  paused: z.boolean().default(false),
  /** Whether each platform account has 2FA, as the person answered in setup. */
  twoFactor: z.record(z.string().min(1).max(64), z.boolean()).default({}),
  /** Apply to ranked matches on their own, up to the daily cap; off restores the approval queue. */
  autoApply: z.boolean().default(true),
  /** Company career pages to search alongside the platforms; empty means platforms only. */
  companyPages: stringList(50, 2048),
}).strict();
export type JobsSettings = z.infer<typeof jobsSettingsSchema>;

export const jobsFileSchema = z.object({
  version: z.literal(1),
  profile: jobsProfileSchema.nullable(),
  resumes: z.array(jobsResumeSchema),
  jobs: z.array(jobsJobSchema),
  queue: z.array(jobsQueueItemSchema),
  settings: jobsSettingsSchema,
  runs: z.array(jobRunSchema).default([]),
}).strict();
export type JobsData = z.infer<typeof jobsFileSchema>;

export interface JobPlatformStatus {
  platform: string;
  enabled: boolean;
  loginId?: string;
  /** Null before the Apply Bot is set up, or for a platform whose sign-in domain is not confirmed. */
  signedIn: boolean | null;
}
