import { describe, expect, it, vi } from "vitest";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";

vi.mock("@/state/store", () => ({ api: vi.fn() }));
vi.mock("./logins", () => ({ addLogin: vi.fn() }));

import { addLogin } from "./logins";
import {
  APPLY_BOT_NAME, APPLY_BOT_SOUL, DEFAULT_DAILY_CAP, RESUME_BOT_NAME, RESUME_BOT_SOUL,
  applyQueueItem, approveQueueItem, batchApproveQueue, clampDailyCap, dailyCapNeedsRiskConfirm, emptyJobsState,
  ensureJobBots, extractResume, fetchJobs, fetchPlatforms, jobBotSoulsWithinBudget, rejectQueueItem, resumeDiff,
  savePlatformLogin, saveProfile, saveSettings, sortedJobs, soulBytes, startJobSearch, tailorResume, updateJobStatus,
} from "./jobs";

describe("job bot souls", () => {
  it("fit the 24,000-byte soul budget and carry the hard rules", () => {
    expect(jobBotSoulsWithinBudget()).toBe(true);
    expect(soulBytes(RESUME_BOT_SOUL)).toBeLessThanOrEqual(BOT_PROFILE_LIMITS.soul);
    expect(soulBytes(APPLY_BOT_SOUL)).toBeLessThanOrEqual(BOT_PROFILE_LIMITS.soul);
    expect(RESUME_BOT_SOUL).toContain("one page");
    expect(RESUME_BOT_SOUL).toContain("Never invent skills");
    expect(APPLY_BOT_SOUL).toContain("Never submit an application without an approved queue item");
    expect(APPLY_BOT_SOUL).toContain("Never try to solve a human check or CAPTCHA");
  });
});

describe("daily cap", () => {
  it("defaults to 10, clamps to 1..50, and needs the risk warning re-shown above 10", () => {
    expect(DEFAULT_DAILY_CAP).toBe(10);
    expect(clampDailyCap(0)).toBe(1);
    expect(clampDailyCap(51)).toBe(50);
    expect(clampDailyCap(7.6)).toBe(8);
    expect(dailyCapNeedsRiskConfirm(10)).toBe(false);
    expect(dailyCapNeedsRiskConfirm(11)).toBe(true);
  });
});

describe("ensureJobBots", () => {
  const request = vi.fn();
  const bot = (name: string) => ({ id: `${name}-id`, name, section: "Jobs" });

  it("creates both bots under Jobs with ask mode, no alwaysAllow, and the right browser setup", async () => {
    request.mockResolvedValueOnce({ bot: bot(RESUME_BOT_NAME) }).mockResolvedValueOnce({ bot: bot(APPLY_BOT_NAME) });
    const made = await ensureJobBots([], request);
    expect(made.resumeBot.name).toBe(RESUME_BOT_NAME);
    expect(made.applyBot.name).toBe(APPLY_BOT_NAME);
    const [resumeCall, applyCall] = request.mock.calls.map((call) => JSON.parse(String(call[1].body)));
    expect(resumeCall.useDefaults).toBe(false);
    expect(resumeCall.section).toBe("Jobs");
    expect(resumeCall.settings).toEqual({ soul: RESUME_BOT_SOUL, approvalMode: "ask", browser: false, computer: "off" });
    expect(applyCall.settings).toEqual({ soul: APPLY_BOT_SOUL, approvalMode: "ask", browser: true, computer: "browser" });
    expect(JSON.stringify(resumeCall)).not.toContain("alwaysAllow");
    expect(JSON.stringify(applyCall)).not.toContain("alwaysAllow");
  });

  it("reuses bots already filed under Jobs instead of creating duplicates", async () => {
    request.mockClear();
    const existing = [bot(RESUME_BOT_NAME), bot(APPLY_BOT_NAME)] as never[];
    const made = await ensureJobBots(existing, request);
    expect(request).not.toHaveBeenCalled();
    expect(made.resumeBot.id).toBe("Resume Bot-id");
  });
});

describe("jobs api", () => {
  it("fetches the jobs state and saves the profile with its settings under their own keys", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ version: 1, profile: null })
      .mockResolvedValueOnce({ version: 1, profile: { name: "A" } });
    expect((await fetchJobs(request)).profile).toBeNull();
    expect(request.mock.calls[0]![0]).toBe("/api/jobs");
    await saveProfile({ profile: { name: "A", location: "Chennai" }, settings: { dailyCap: 10 } }, request);
    const [, init] = request.mock.calls[1]!;
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(String(init!.body))).toEqual({ profile: { name: "A", location: "Chennai" }, settings: { dailyCap: 10 } });
  });

  it("scopes a platform login to only the Job Apply Bot", async () => {
    vi.mocked(addLogin).mockResolvedValue({ id: "login-1", username: "san@example.com" } as never);
    const saved = await savePlatformLogin("naukri.com", { username: "san@example.com", password: "secret", totp: "" }, "apply-1");
    expect(saved).toEqual({ id: "login-1", username: "san@example.com" });
    expect(addLogin).toHaveBeenCalledWith("naukri.com", { username: "san@example.com", password: "secret", totp: "" }, ["apply-1"]);
  });

  it("starts empty, with the default cap and no profile", () => {
    const state = emptyJobsState();
    expect(state.profile).toBeNull();
    expect(state.settings.dailyCap).toBe(DEFAULT_DAILY_CAP);
    expect(state.settings.paused).toBe(false);
    expect(state.appliedToday).toBe(0);
    expect(state.jobs).toEqual([]);
    expect(state.queue).toEqual([]);
  });

  it("calls the queue, search, tailor, apply and status routes with the right paths", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ queue: { id: "q-1", state: "approved" } })
      .mockResolvedValueOnce({ queue: { id: "q-1", state: "rejected" } })
      .mockResolvedValueOnce({ results: [{ id: "q-1", state: "approved" }] })
      .mockResolvedValueOnce({ started: true, botId: "apply-1" })
      .mockResolvedValueOnce({ started: true, botId: "apply-1" })
      .mockResolvedValueOnce({ resume: { id: "r-1" }, job: { id: "job-1" }, queue: null })
      .mockResolvedValueOnce({ job: { id: "job-1", status: "applied" } })
      .mockResolvedValueOnce({ settings: { paused: true } })
      .mockResolvedValueOnce({ platforms: [] });
    expect((await approveQueueItem("q-1", request)).queue.state).toBe("approved");
    expect((await rejectQueueItem("q-1", request)).queue.state).toBe("rejected");
    expect((await batchApproveQueue(["q-1"], request)).results).toHaveLength(1);
    expect((await applyQueueItem("q-1", request)).started).toBe(true);
    expect((await startJobSearch(request)).started).toBe(true);
    expect((await tailorResume("job-1", request)).resume.id).toBe("r-1");
    expect((await updateJobStatus("job-1", "applied", request)).job.status).toBe("applied");
    expect((await saveSettings({ paused: true }, request)).settings.paused).toBe(true);
    expect((await fetchPlatforms(request)).platforms).toEqual([]);
    const paths = request.mock.calls.map((call) => `${call[1]?.method ?? "GET"} ${call[0]}`);
    expect(paths).toEqual([
      "POST /api/jobs/queue/q-1/approve",
      "POST /api/jobs/queue/q-1/reject",
      "POST /api/jobs/queue/batch-approve",
      "POST /api/jobs/queue/q-1/apply",
      "POST /api/jobs/search",
      "POST /api/jobs/job-1/tailor",
      "PATCH /api/jobs/job-1/status",
      "PATCH /api/jobs/settings",
      "GET /api/jobs/platforms",
    ]);
  });

  it("sends a resume file base64-encoded for server extraction", async () => {
    const request = vi.fn().mockResolvedValue({ text: "Santhoshkumar", pages: 1, kind: "pdf" });
    const file = new File(["hello"], "resume.pdf", { type: "application/pdf" });
    const extracted = await extractResume(file, request);
    expect(extracted).toEqual({ text: "Santhoshkumar", pages: 1, kind: "pdf" });
    const [, init] = request.mock.calls[0]!;
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual({ filename: "resume.pdf", dataBase64: Buffer.from("hello").toString("base64") });
  });
});

describe("resume diff and job sorting", () => {
  it("marks added and removed lines so invented lines stand out", () => {
    const diff = resumeDiff("Santhoshkumar\nDatabricks, SQL\nOld line", "Santhoshkumar\nDatabricks, SQL, PySpark\nNew line");
    expect(diff).toEqual([
      { type: "same", text: "Santhoshkumar" },
      { type: "removed", text: "Databricks, SQL" },
      { type: "removed", text: "Old line" },
      { type: "added", text: "Databricks, SQL, PySpark" },
      { type: "added", text: "New line" },
    ]);
  });

  it("sorts found jobs best match first", () => {
    const jobs = [
      { id: "a", matchScore: 20 },
      { id: "b", matchScore: 90 },
      { id: "c" },
    ] as never[];
    expect(sortedJobs(jobs).map((job) => job.id)).toEqual(["b", "a", "c"]);
  });
});
