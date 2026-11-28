// Job Bot over HTTP. GET /api/jobs reads the profile, settings, found jobs and approval queue; PATCH edits the profile
// or settings; POST approves or rejects a queue item; POST /api/jobs/search starts a Job Apply Bot turn.
// A queue item's loginId is only ever a Vault login id: no route here reads or returns a password, a 2FA key or a token.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import type { LoginBots } from "../../shared/logins.ts";
import { DAILY_CAP_MAX, jobsProfileSchema, type JobRun, type JobsData, type JobsJob, type JobsQueueItem, type JobStatus } from "../../shared/jobs.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { SignedInSites } from "../browser-sites.ts";
import type { CompanyResearchOutcome } from "../jobs-company-research.ts";
import { buildCoverLetterText, buildInterviewPrep, coverLetterDocument, tailorResumeVariant, writeDocumentFiles } from "../jobs-documents.ts";
import { deliverRunReport, type ReportDeliveryOutcome } from "../jobs-report-delivery.ts";
import type { FilegenDocument } from "../filegen/index.ts";
import type { SubmitGate } from "../jobs-store.ts";
import { JobsStore } from "../jobs-store.ts";
import { applyPrompt, parseSearchReport, searchPrompt, tailorResumeText } from "../jobs-resume.ts";
import { JobRunDriver } from "../jobs-run.ts";
import type { TasksStore } from "../tasks-store.ts";
import { extractResumeText } from "../resume-extract.ts";
import { PASS, type RouteHandler } from "./table.ts";

export const JOBS_PATH = "/api/jobs";
export const JOB_PLATFORMS_PATH = "/api/jobs/platforms";

/** Registrable domains the Jobs page can show a sign-in state for; other platforms report null until their domain is confirmed. */
const PLATFORM_SITES: Partial<Record<string, string>> = { naukri: "naukri.com", linkedin: "linkedin.com" };

export interface JobBotRouteDeps {
  store: JobsStore;
  botExists(id: string): boolean;
  loginExists(id: string): boolean;
  /** Who may use a saved login: "all" or the bot ids it is scoped to. */
  loginBots(id: string): LoginBots | null;
  /** The Apply Bot's browser sign-ins, or null when its browser cannot be read. */
  signedInSites(botId: string): Promise<SignedInSites | null>;
  /** The Resume Bot's working folder, or null when it cannot be found. */
  resumeCwd?(botId: string): string | null;
  /** Starts a Job Apply Bot turn; absent until the server wires turns. The turn's reply arrives later through onSettled. */
  startSearch?(input: { botId: string; prompt: string; onSettled?: (text: string) => void }): Promise<{ started: boolean; reason?: string }>;
  /** Starts a Job Apply Bot turn to submit one approved application; the turn's reply says whether it went out. The closing text follows so the run can see a human check. */
  startApply?(input: { botId: string; jobId: string; prompt: string; onSettled?: (applied: boolean, closingText?: string) => void }): Promise<{ started: boolean; reason?: string }>;
  /** Pacing delay between applications; absent, the run driver waits on a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** The task queue, so a run records one task per application; absent, runs apply without queue tasks. */
  tasksStore?: TasksStore | null;
  /** The Apply Bot's main thread, for the run's end-of-run report. */
  botThreadId?(id: string): string | null;
  /** Posts a line into a thread; the run driver uses it for its report. */
  appendMessage?(threadId: string, text: string): void;
  /** Lifts the Job Apply Bot from approval mode ask to auto the first time auto-apply runs; never changes any other mode. Absent, the mode is left alone. */
  liftApplyBotMode?(): void;
  /** Company research for one ranked job; absent, runs tailor without research. */
  researchCompany?(input: { company: string; role?: string; location?: string }): Promise<CompanyResearchOutcome>;
  /** The Vault saved-secret value for a report-bridge secret name; absent, reports stay pending-bridge. */
  resolveReportSecret?(name: string): string | null;
}

const ID = /^[\w-]{1,128}$/u;
const NO_SUCH_JOB = "No such job.";
const NO_SUCH_QUEUE_ITEM = "No such queue item.";
const GATE_ERRORS: Record<Exclude<SubmitGate, { allowed: true }>["reason"], string> = {
  "no-such-job": NO_SUCH_JOB,
  "no-queue-item": "No queue item for that job.",
  "not-approved": "Approve that job in the queue first.",
  "daily-cap": "The daily application cap is reached. Try again tomorrow.",
  paused: "Applying is paused.",
};

const isJson = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
  String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";

const settingsBody = z.object({
  platforms: z.record(z.string().min(1).max(64), z.object({ enabled: z.boolean(), loginId: z.string().max(128).optional() }).strict()).optional(),
  dailyCap: z.number().int().min(1).max(DAILY_CAP_MAX).optional(),
  search: z.object({
    keywords: z.array(z.string().max(100)).max(50).optional(),
    locations: z.array(z.string().max(100)).max(50).optional(),
    minSalary: z.string().max(100).optional(),
  }).strict().optional(),
  applyBotId: z.string().max(128).optional(),
  resumeBotId: z.string().max(128).optional(),
  paused: z.boolean().optional(),
  autoApply: z.boolean().optional(),
  companyPages: z.array(z.string().max(2048)).max(50).optional(),
  twoFactor: z.record(z.string().min(1).max(64), z.boolean()).optional(),
  reportBridge: z.object({
    whatsappUrl: z.string().url().max(2048).optional(),
    telegramUrl: z.string().url().max(2048).optional(),
    secretName: z.string().max(128).optional(),
  }).strict().optional(),
}).strict();
const profileBody = jobsProfileSchema.partial().strict();
/** The setup wizard's shape: the profile and the settings under their own keys. */
const nestedProfileBody = z.object({ profile: profileBody.optional(), settings: settingsBody.optional() }).strict();
const statusBody = z.object({
  status: z.enum(["new", "queued", "approved", "applied", "interview", "rejected", "saved", "skipped", "expired"]),
  appliedAt: z.number().optional(),
}).strict();
const searchBody = z.object({ applyBotId: z.string().max(128).optional() }).strict();
const extractBody = z.object({ filename: z.string().min(1).max(300), dataBase64: z.string().min(1).max(14_000_000) }).strict();
const batchApproveBody = z.object({ ids: z.array(z.string().regex(ID)).min(1).max(50) }).strict();
const outcomeBody = z.object({
  kind: z.enum(["interview", "rejected", "offer", "no-reply"]),
  note: z.string().max(500).optional(),
}).strict();
const followUpBody = z.object({ at: z.number().int().nullable(), note: z.string().max(500).optional() }).strict();
const variantBody = z.object({ platform: z.enum(["naukri", "linkedin", "default"]).optional() }).strict();

export function createJobBotRoutes(deps: JobBotRouteDeps): RouteHandler {
  const { store } = deps;
  const runs = new JobRunDriver({
    store,
    tasks: deps.tasksStore ?? null,
    botExists: deps.botExists,
    botThreadId: deps.botThreadId,
    startSearch: deps.startSearch,
    startApply: deps.startApply,
    sleep: deps.sleep,
    resumeCwd: deps.resumeCwd,
    appendMessage: deps.appendMessage,
    researchCompany: deps.researchCompany,
    deliverReport: async ({ runId, text }) => {
      const bridge = store.snapshot().settings.reportBridge;
      if (!bridge || (!bridge.whatsappUrl && !bridge.telegramUrl)) return [];
      const channels = (["whatsapp", "telegram"] as const)
        .filter((channel) => bridge[channel === "whatsapp" ? "whatsappUrl" : "telegramUrl"]);
      const secret = bridge.secretName ? deps.resolveReportSecret?.(bridge.secretName) ?? null : null;
      if (!secret) {
        return channels.map((channel): ReportDeliveryOutcome => ({ channel, status: "failed", note: "the bridge secret is not saved" }));
      }
      const outcomes = await deliverRunReport({
        runId,
        text,
        ...(bridge.whatsappUrl ? { whatsapp: { url: bridge.whatsappUrl, secret } } : {}),
        ...(bridge.telegramUrl ? { telegram: { url: bridge.telegramUrl, secret } } : {}),
      });
      return outcomes.filter((outcome) => channels.includes(outcome.channel));
    },
  });
  const state = (): Omit<JobsData, "version"> & { version: number; appliedToday: number } => {
    const data = store.snapshot();
    return { version: store.version, profile: data.profile, resumes: data.resumes, jobs: data.jobs, queue: data.queue, runs: store.listRuns(), settings: data.settings, appliedToday: store.appliedToday() };
  };
  /** A settings patch is refused whole when a bot id is unknown or a login id is unknown or not scoped to only the Job Apply Bot. */
  const settingsError = (patch: z.infer<typeof settingsBody>): string | null => {
    const applyBotId = patch.applyBotId ?? store.snapshot().settings.applyBotId;
    if (patch.applyBotId !== undefined && !deps.botExists(patch.applyBotId)) return "No such bot.";
    if (patch.resumeBotId !== undefined && !deps.botExists(patch.resumeBotId)) return "No such bot.";
    for (const platform of Object.values(patch.platforms ?? {})) {
      if (platform.loginId === undefined) continue;
      if (!deps.loginExists(platform.loginId)) return "No such saved login.";
      const bots = deps.loginBots(platform.loginId);
      if (applyBotId && bots !== null && !(Array.isArray(bots) && bots.length === 1 && bots[0] === applyBotId)) {
        return "That login is not scoped to only the Job Apply Bot.";
      }
    }
    return null;
  };
  return async ({ req, res, path, method, json, readBody }) => {
    if (path === JOB_PLATFORMS_PATH) {
      if (method !== "GET") return json(res, 405, { error: "Use GET." });
      const data = store.snapshot();
      const applyBotId = data.settings.applyBotId;
      let sites: SignedInSites | null = null;
      if (applyBotId) {
        try { sites = await deps.signedInSites(applyBotId); }
        catch { return json(res, 503, { error: "Could not read the Job Apply Bot's sign-ins." }); }
      }
      const signedIn = new Set(sites?.sites.map((site) => site.site) ?? []);
      const platforms = Object.entries(data.settings.platforms).map(([platform, settings]) => ({
        platform, enabled: settings.enabled, ...(settings.loginId ? { loginId: settings.loginId } : {}),
        signedIn: applyBotId && PLATFORM_SITES[platform] ? signedIn.has(PLATFORM_SITES[platform]!) : null,
      }));
      return json(res, 200, { platforms, ...(applyBotId ? { applyBotId } : {}) });
    }
    if (path === JOBS_PATH) {
      if (method === "GET") return json(res, 200, state());
      return json(res, 405, { error: "Use GET." });
    }
    if (path !== JOBS_PATH && !path.startsWith(`${JOBS_PATH}/`)) return PASS;
    if ((method === "POST" || method === "PATCH") && !isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
    const rest = path.slice(JOBS_PATH.length + 1);
    if (rest === "profile" && method === "PATCH") {
      const raw = await readBody(req, 512_000);
      const nested = nestedProfileBody.safeParse(raw);
      const flat = nested.success ? null : profileBody.safeParse(raw);
      if (!nested.success && !flat?.success) return json(res, 400, { error: "Send the profile fields to change." });
      const profilePatch = nested.success ? nested.data.profile : flat!.data;
      const settingsPatch = nested.success ? nested.data.settings : undefined;
      if (profilePatch) {
        // Absent fields must not wipe what is stored: the parsed patch fills array defaults, so only keys the
        // request actually sent reach the store.
        const sent = (nested.success ? (raw as { profile?: unknown }).profile : raw) as Record<string, unknown> | undefined;
        if (sent && typeof sent === "object") {
          for (const key of Object.keys(profilePatch)) if (!(key in sent)) delete (profilePatch as Record<string, unknown>)[key];
        }
      }
      if (settingsPatch) {
        const error = settingsError(settingsPatch);
        if (error) return json(res, 400, { error });
      }
      if (profilePatch && Object.keys(profilePatch).length) {
        if (!store.snapshot().profile && !profilePatch.name?.trim()) return json(res, 400, { error: "Send a name for the profile." });
        try { store.setProfile(profilePatch); }
        catch { return json(res, 400, { error: "Send the profile fields to change." }); }
      }
      if (settingsPatch) {
        try { store.setSettings(settingsPatch); }
        catch { return json(res, 400, { error: "Send the settings to change." }); }
        if (settingsPatch.autoApply === true) deps.liftApplyBotMode?.();
      }
      return json(res, 200, state());
    }
    if (rest === "settings" && method === "PATCH") {
      const body = settingsBody.safeParse(await readBody(req, 64_000));
      if (!body.success) return json(res, 400, { error: "Send the settings to change." });
      const error = settingsError(body.data);
      if (error) return json(res, 400, { error });
      try { store.setSettings(body.data); }
      catch { return json(res, 400, { error: "Send the settings to change." }); }
      if (body.data.autoApply === true) deps.liftApplyBotMode?.();
      return json(res, 200, state());
    }
    if (rest === "search" && method === "POST") {
      const body = searchBody.safeParse(await readBody(req, 4096));
      if (!body.success) return json(res, 400, { error: "Send applyBotId, if the Job Apply Bot is not the one saved in settings." });
      const applyBotId = body.data.applyBotId ?? store.snapshot().settings.applyBotId;
      if (!applyBotId) return json(res, 409, { error: "Set up the Job Apply Bot first." });
      if (!deps.botExists(applyBotId)) return json(res, 404, { error: "No such bot." });
      if (!deps.startSearch) return json(res, 503, { error: "Job search turns are not wired up yet." });
      const started = await deps.startSearch({
        botId: applyBotId,
        prompt: searchPrompt(store.snapshot().settings),
        onSettled: (text) => {
          try {
            const reported = parseSearchReport(text);
            if (reported.length) store.recordFoundJobs(reported);
          } catch {
            // A turn that reports nothing parseable simply records nothing.
          }
        },
      });
      if (!started.started) return json(res, 409, { error: started.reason ?? "The search could not start." });
      return json(res, 202, { started: true, botId: applyBotId });
    }
    if (rest === "runs" && method === "POST") {
      const data = store.snapshot();
      if (!data.profile) return json(res, 409, { error: "Set up the profile first." });
      const applyBotId = data.settings.applyBotId;
      if (!applyBotId) return json(res, 409, { error: "Set up the Job Apply Bot first." });
      if (!deps.botExists(applyBotId)) return json(res, 404, { error: "No such bot." });
      if (!deps.startSearch || !deps.startApply) return json(res, 503, { error: "Job runs are not wired up yet." });
      const active = runs.activeRun();
      if (active) return json(res, 409, { error: "A run is already going.", run: active });
      if (data.settings.autoApply) deps.liftApplyBotMode?.();
      return json(res, 201, { run: runs.start() });
    }
    if (rest === "runs" && method === "GET") {
      return json(res, 200, { runs: runs.listRuns() });
    }
    const runRoute = /^runs\/([\w-]{1,128})(?:\/(pause|resume))?$/u.exec(rest);
    if (runRoute && method === "GET" && !runRoute[2]) {
      const run: JobRun | null = runs.getRun(runRoute[1]!);
      return run ? json(res, 200, { run }) : json(res, 404, { error: "No such run." });
    }
    if (runRoute && method === "POST" && runRoute[2]) {
      if (runRoute[2] === "pause") {
        const run: JobRun | null = runs.pause(runRoute[1]!);
        return run ? json(res, 200, { run }) : json(res, 404, { error: "No such run." });
      }
      const current = runs.getRun(runRoute[1]!);
      if (!current) return json(res, 404, { error: "No such run." });
      if (current.phase !== "stopped") return json(res, 409, { error: "That run is not paused.", phase: current.phase });
      return json(res, 200, { run: runs.resume(runRoute[1]!)! });
    }
    const takeover = /^runs\/([\w-]{1,128})\/takeover\/(resume|abandon)$/u.exec(rest);
    if (takeover && method === "POST") {
      const current = runs.getRun(takeover[1]!);
      if (!current) return json(res, 404, { error: "No such run." });
      if (!current.takeover) return json(res, 409, { error: "That run has no takeover waiting." });
      if (takeover[2] === "abandon") {
        return json(res, 200, { run: runs.abandonTakeover(takeover[1]!)! });
      }
      if (current.phase !== "stopped") return json(res, 409, { error: "That run is not paused.", phase: current.phase });
      return json(res, 200, { run: runs.resume(takeover[1]!)! });
    }
    if (rest === "tracker" && method === "GET") {
      return json(res, 200, { tracker: store.trackerSummary() });
    }
    const outcome = /^([\w-]{1,128})\/outcome$/u.exec(rest);
    if (outcome && method === "POST") {
      const body = outcomeBody.safeParse(await readBody(req, 4096));
      if (!body.success) return json(res, 400, { error: "Send an outcome: interview, rejected, offer, or no-reply." });
      const changed = store.recordOutcome(outcome[1]!, { kind: body.data.kind, ...(body.data.note ? { note: body.data.note } : {}) });
      return changed ? json(res, 200, { job: changed }) : json(res, 404, { error: NO_SUCH_JOB });
    }
    const followUp = /^([\w-]{1,128})\/follow-up$/u.exec(rest);
    if (followUp && method === "POST") {
      const body = followUpBody.safeParse(await readBody(req, 4096));
      if (!body.success) return json(res, 400, { error: "Send a follow-up date, or null to clear it." });
      const changed = store.setFollowUp(followUp[1]!, body.data.at, body.data.note);
      return changed ? json(res, 200, { job: changed }) : json(res, 404, { error: NO_SUCH_JOB });
    }
    const documentRoute = /^([\w-]{1,128})\/(cover-letter|interview-prep)$/u.exec(rest);
    if (documentRoute && method === "POST") {
      const data = store.snapshot();
      const job = data.jobs.find((one) => one.id === documentRoute[1]);
      if (!job) return json(res, 404, { error: NO_SUCH_JOB });
      if (!data.profile) return json(res, 400, { error: "Set up the profile first." });
      const resumeBotId = data.settings.resumeBotId;
      if (!resumeBotId) return json(res, 409, { error: "Set up the Resume Bot first." });
      const cwd = deps.resumeCwd?.(resumeBotId) ?? null;
      if (!cwd) return json(res, 503, { error: "The Resume Bot's workspace could not be found." });
      const kind = documentRoute[2] as "cover-letter" | "interview-prep";
      const prep = kind === "interview-prep" ? buildInterviewPrep(data.profile, job, job.companyResearch?.summary) : null;
      const text = prep?.text ?? buildCoverLetterText(data.profile, job);
      const doc: FilegenDocument = prep?.document ?? coverLetterDocument(data.profile, job);
      let files: { docxPath: string; pdfPath: string };
      try {
        files = await writeDocumentFiles(join(cwd, "documents"), `${kind}-${job.id}`.slice(0, 100), doc);
      } catch {
        return json(res, 503, { error: "The document could not be saved." });
      }
      const resume = store.addResume({
        jobId: job.id, kind, path: files.docxPath, text,
        note: `${kind === "cover-letter" ? "Cover letter" : "Interview prep"} for ${job.title} at ${job.company}`,
      });
      if (kind === "cover-letter") store.setCoverLetter(job.id, resume.id);
      else store.setInterviewPrep(job.id, resume.id);
      return json(res, 200, { resume, job: store.snapshot().jobs.find((one) => one.id === job.id)!, pdfPath: files.pdfPath });
    }
    const variant = /^([\w-]{1,128})\/resume-variant$/u.exec(rest);
    if (variant && method === "POST") {
      const body = variantBody.safeParse(await readBody(req, 4096));
      if (!body.success) return json(res, 400, { error: "Send a platform: naukri, linkedin, or default." });
      const data = store.snapshot();
      const job = data.jobs.find((one) => one.id === variant[1]);
      if (!job) return json(res, 404, { error: NO_SUCH_JOB });
      if (!data.profile) return json(res, 400, { error: "Set up the profile first." });
      const resumeBotId = data.settings.resumeBotId;
      if (!resumeBotId) return json(res, 409, { error: "Set up the Resume Bot first." });
      const cwd = deps.resumeCwd?.(resumeBotId) ?? null;
      if (!cwd) return json(res, 503, { error: "The Resume Bot's workspace could not be found." });
      const platform = body.data.platform ?? "default";
      let text: string;
      try {
        text = tailorResumeVariant(data.profile, job, platform);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "That resume variant does not fit on one page." });
      }
      const id = randomUUID();
      const path = join(cwd, "resumes", `${id}.txt`);
      try {
        mkdirSync(join(cwd, "resumes"), { recursive: true });
        writeFileAtomic(path, text);
      } catch {
        return json(res, 503, { error: "The resume variant could not be saved." });
      }
      const resume = store.addResume({ id, jobId: job.id, kind: "tailored", path, text, note: `Resume variant for ${job.title} at ${job.company} (${platform})` });
      store.setJobTailoredResume(job.id, resume.id);
      return json(res, 200, { resume, job: store.snapshot().jobs.find((one) => one.id === job.id)! });
    }
    if (rest === "extract" && method === "POST") {
      const body = extractBody.safeParse(await readBody(req, 14_000_000));
      if (!body.success) return json(res, 400, { error: "Send the resume filename and its base64 contents." });
      let buffer: Buffer;
      try {
        buffer = Buffer.from(body.data.dataBase64, "base64");
      } catch {
        return json(res, 400, { error: "Send the resume filename and its base64 contents." });
      }
      try {
        const extracted = await extractResumeText(buffer, body.data.filename);
        return json(res, 200, extracted);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "That file could not be read." });
      }
    }
    const tailor = /^([\w-]{1,128})\/tailor$/u.exec(rest);
    if (tailor && method === "POST") {
      const data = store.snapshot();
      const job = data.jobs.find((one) => one.id === tailor[1]);
      if (!job) return json(res, 404, { error: NO_SUCH_JOB });
      if (!data.profile) return json(res, 400, { error: "Set up the profile first." });
      const resumeBotId = data.settings.resumeBotId;
      if (!resumeBotId) return json(res, 409, { error: "Set up the Resume Bot first." });
      const cwd = deps.resumeCwd?.(resumeBotId) ?? null;
      if (!cwd) return json(res, 503, { error: "The Resume Bot's workspace could not be found." });
      let text: string;
      try {
        text = tailorResumeText(data.profile, job);
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "That tailored resume does not fit on one page." });
      }
      const id = randomUUID();
      const path = join(cwd, "resumes", `${id}.txt`);
      try {
        mkdirSync(join(cwd, "resumes"), { recursive: true });
        writeFileAtomic(path, text);
      } catch {
        return json(res, 503, { error: "The tailored resume could not be saved." });
      }
      const resume = store.addResume({ id, jobId: job.id, kind: "tailored", path, text, note: `Tailored for ${job.title} at ${job.company}` });
      store.setJobTailoredResume(job.id, resume.id);
      const queue = store.enqueue(job.id, resume.id) ?? store.repointQueue(job.id, resume.id);
      return json(res, 200, { resume, job: store.snapshot().jobs.find((one) => one.id === job.id)!, queue });
    }
    if (rest === "queue/batch-approve" && method === "POST") {
      const body = batchApproveBody.safeParse(await readBody(req, 4096));
      if (!body.success) return json(res, 400, { error: "Send the queue ids to approve." });
      const results = body.data.ids.map((id) => {
        const item = store.decideQueue(id, "approved");
        return item ? { id: item.id, state: item.state } : { id, error: NO_SUCH_QUEUE_ITEM };
      });
      return json(res, 200, { results, ...state() });
    }
    const apply = /^queue\/([\w-]{1,128})\/apply$/u.exec(rest);
    if (apply && method === "POST") {
      const data = store.snapshot();
      const item = data.queue.find((one) => one.id === apply[1]);
      if (!item) return json(res, 404, { error: NO_SUCH_QUEUE_ITEM });
      const gate = store.submitGate(item.jobId);
      if (!gate.allowed) return json(res, 409, { error: GATE_ERRORS[gate.reason], reason: gate.reason });
      const applyBotId = data.settings.applyBotId;
      if (!applyBotId) return json(res, 409, { error: "Set up the Job Apply Bot first." });
      if (!deps.botExists(applyBotId)) return json(res, 404, { error: "No such bot." });
      if (!deps.startApply) return json(res, 503, { error: "Job apply turns are not wired up yet." });
      const job = data.jobs.find((one) => one.id === item.jobId)!;
      const resume = data.resumes.find((one) => one.id === item.tailoredResumeId);
      if (!resume) return json(res, 409, { error: "Tailor a resume for that job first." });
      const started = await deps.startApply({
        botId: applyBotId,
        jobId: job.id,
        prompt: applyPrompt(job, resume.path, job.lastGoodLayout?.labels),
        onSettled: (applied) => {
          try {
            store.recordQueueAttempt(item.id, applied ? "submitted" : "not submitted");
            if (applied) store.setJobStatus(job.id, "applied");
          } catch {
            // The attempt is already decided; a recording failure changes nothing about the submission.
          }
        },
      });
      if (!started.started) return json(res, 409, { error: started.reason ?? "The application could not start." });
      return json(res, 202, { started: true, botId: applyBotId });
    }
    const queue = /^queue\/([\w-]{1,128})\/(approve|reject)$/u.exec(rest);
    if (queue && method === "POST") {
      const item: JobsQueueItem | null = store.decideQueue(queue[1]!, queue[2] === "approve" ? "approved" : "rejected");
      return item ? json(res, 200, { queue: item }) : json(res, 404, { error: NO_SUCH_QUEUE_ITEM });
    }
    const job = /^([\w-]{1,128})\/status$/u.exec(rest);
    if (job && method === "PATCH") {
      if (!ID.test(job[1]!)) return json(res, 404, { error: NO_SUCH_JOB });
      const body = statusBody.safeParse(await readBody(req, 4096));
      if (!body.success) return json(res, 400, { error: "Send a job status." });
      const changed: JobsJob | null = store.setJobStatus(job[1]!, body.data.status as JobStatus, body.data.appliedAt);
      return changed ? json(res, 200, { job: changed }) : json(res, 404, { error: NO_SUCH_JOB });
    }
    return json(res, 405, { error: "Use GET, PATCH or POST." });
  };
}
