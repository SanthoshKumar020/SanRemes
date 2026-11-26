import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { JobsStore } from "../jobs-store.ts";
import { dispatchRoutes } from "./table.ts";
import { createJobBotRoutes, type JobBotRouteDeps } from "./job-bot.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const servers: Server[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

async function serve(extra: Partial<JobBotRouteDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-jobs-routes-"));
  scratch.push(dataDir);
  const resumeDir = mkdtempSync(join(tmpdir(), "sanremes-jobs-resumes-"));
  scratch.push(resumeDir);
  const store = new JobsStore({ dataDir, now: () => 1_000 });
  const logins = new Map<string, { bots: string[] | "all" }>([
    ["login-apply", { bots: ["apply-bot"] }],
    ["login-all", { bots: "all" }],
  ]);
  const routes = [createJobBotRoutes({
    store,
    botExists: (id) => id === "apply-bot" || id === "resume-bot",
    loginExists: (id) => logins.has(id),
    loginBots: (id) => logins.get(id)?.bots ?? null,
    signedInSites: async () => ({ running: false, sites: [{ site: "naukri.com", cookies: 1, storage: 1 }] }),
    resumeCwd: () => resumeDir,
    ...extra,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { api, store, resumeDir };
}

function seedProfile(store: JobsStore) {
  store.setProfile({
    name: "Santhoshkumar", title: "Data Engineer", location: "Chennai",
    skills: ["Databricks", "PySpark", "SQL"],
    experience: [{ org: "Swache Technologies", role: "Software Developer", start: "Nov 2025", end: "Aug 2026", bullets: ["Built ETL pipelines in PySpark."] }],
  });
}

function seed(store: JobsStore) {
  const job = store.addJob({ id: "job-1", platform: "naukri", url: "https://www.naukri.com/job/1", title: "Data Engineer", company: "Acme", jdKeywords: ["Databricks", "PySpark"] });
  return { job, item: store.enqueue(job.id, "resume-1")! };
}

it("reads the empty store", async () => {
  const { api } = await serve();
  const { status, body } = await api("/api/jobs");
  expect(status).toBe(200);
  expect(body).toMatchObject({ profile: null, resumes: [], jobs: [], queue: [], settings: { dailyCap: 10 } });
});

it("creates the profile, then merges later patches", async () => {
  const { api } = await serve();
  expect((await api("/api/jobs/profile", { method: "PATCH", body: JSON.stringify({ location: "Chennai" }) })).status).toBe(400);
  const created = await api("/api/jobs/profile", { method: "PATCH", body: JSON.stringify({ name: "Santhoshkumar", skills: ["SQL"] }) });
  expect(created.status).toBe(200);
  expect(created.body.profile).toMatchObject({ name: "Santhoshkumar", location: "" });
  expect(created.body).toMatchObject({ resumes: [], jobs: [], queue: [] });
  const merged = await api("/api/jobs/profile", { method: "PATCH", body: JSON.stringify({ location: "Chennai" }) });
  expect(merged.body.profile).toMatchObject({ name: "Santhoshkumar", location: "Chennai", skills: ["SQL"] });
});

it("takes the setup wizard's nested profile-and-settings form", async () => {
  const { api } = await serve();
  const stepOne = await api("/api/jobs/profile", {
    method: "PATCH",
    body: JSON.stringify({ profile: { name: "Santhoshkumar", location: "Chennai", skills: ["SQL"], experience: [], resumeText: "Data Engineer...", resumeFileName: "resume.txt", updatedAt: 999 } }),
  });
  expect(stepOne.status).toBe(200);
  expect(stepOne.body.profile).toMatchObject({ name: "Santhoshkumar", resumeText: "Data Engineer...", resumeFileName: "resume.txt" });
  const stepTwo = await api("/api/jobs/profile", {
    method: "PATCH",
    body: JSON.stringify({ profile: {}, settings: { dailyCap: 5, platforms: { naukri: { enabled: true } }, twoFactor: { naukri: true, linkedin: false } } }),
  });
  expect(stepTwo.status).toBe(200);
  expect(stepTwo.body.profile.name).toBe("Santhoshkumar");
  expect(stepTwo.body.settings).toMatchObject({ dailyCap: 5, platforms: { naukri: { enabled: true } }, twoFactor: { naukri: true, linkedin: false } });
  expect((await api("/api/jobs/profile", {
    method: "PATCH",
    body: JSON.stringify({ profile: {}, settings: { platforms: { naukri: { enabled: true, loginId: "missing-login" } } } }),
  })).status).toBe(400);
});

it("edits settings, refuses unknown logins and logins scoped beyond the Apply Bot, and never returns a password", async () => {
  const { api } = await serve();
  const capped = await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ dailyCap: 5 }) });
  expect(capped.status).toBe(200);
  expect(capped.body.settings.dailyCap).toBe(5);
  expect((await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ dailyCap: 0 }) })).status).toBe(400);
  expect((await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ dailyCap: 51 }) })).status).toBe(400);
  expect((await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ applyBotId: "missing-bot" }) })).status).toBe(400);
  expect((await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ platforms: { naukri: { enabled: true, loginId: "missing-login" } } }) })).status).toBe(400);
  expect((await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ platforms: { naukri: { enabled: true, loginId: "login-1", password: "secret" } } }) })).status).toBe(400);
  const bot = await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ applyBotId: "apply-bot" }) });
  expect(bot.status).toBe(200);
  expect((await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ platforms: { naukri: { enabled: true, loginId: "login-all" } } }) })).status).toBe(400);
  const scoped = await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ platforms: { naukri: { enabled: true, loginId: "login-apply" } } }) });
  expect(scoped.status).toBe(200);
  const read = await api("/api/jobs");
  expect(JSON.stringify(read.body)).toContain("login-apply");
  expect(JSON.stringify(read.body).toLowerCase()).not.toContain("password");
});

it("approves and rejects queue items, and 404s unknown ones", async () => {
  const { api, store } = await serve();
  const { item } = seed(store);
  const approved = await api(`/api/jobs/queue/${item.id}/approve`, { method: "POST", body: "{}" });
  expect(approved.status).toBe(200);
  expect(approved.body.queue).toMatchObject({ state: "approved", decidedBy: "user", decidedAt: 1_000 });
  const rejected = await api(`/api/jobs/queue/${item.id}/reject`, { method: "POST", body: "{}" });
  expect(rejected.body.queue.state).toBe("rejected");
  expect((await api("/api/jobs/queue/missing/approve", { method: "POST", body: "{}" })).status).toBe(404);
});

it("moves a job through statuses and stamps the applied date", async () => {
  const { api, store } = await serve();
  seed(store);
  const applied = await api("/api/jobs/job-1/status", { method: "PATCH", body: JSON.stringify({ status: "applied" }) });
  expect(applied.status).toBe(200);
  expect(applied.body.job).toMatchObject({ status: "applied", appliedAt: 1_000 });
  expect((await api("/api/jobs/job-1/status", { method: "PATCH", body: JSON.stringify({ status: "hired" }) })).status).toBe(400);
  expect((await api("/api/jobs/missing/status", { method: "PATCH", body: JSON.stringify({ status: "saved" }) })).status).toBe(404);
});

it("starts a search only once the Apply Bot is known, and reports a refused start", async () => {
  const started: Array<{ botId: string; prompt: string }> = [];
  const { api } = await serve({
    startSearch: async (input) => { started.push(input); return { started: true }; },
  });
  expect((await api("/api/jobs/search", { method: "POST", body: "{}" })).status).toBe(409);
  await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ applyBotId: "apply-bot", search: { keywords: ["databricks"], locations: ["Chennai"] } }) });
  const run = await api("/api/jobs/search", { method: "POST", body: "{}" });
  expect(run.status).toBe(202);
  expect(run.body).toEqual({ started: true, botId: "apply-bot" });
  expect(started).toHaveLength(1);
  expect(started[0]!.prompt).toContain("databricks");
  expect(started[0]!.prompt).toContain("Chennai");
  expect(started[0]!.prompt).toContain("at most 10 applications a day");
  const { api: unwired } = await serve();
  await unwired("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ applyBotId: "apply-bot" }) });
  expect((await unwired("/api/jobs/search", { method: "POST", body: "{}" })).status).toBe(503);
  const { api: refused } = await serve({ startSearch: async () => ({ started: false, reason: "That conversation is busy." }) });
  await refused("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ applyBotId: "apply-bot" }) });
  const blocked = await refused("/api/jobs/search", { method: "POST", body: "{}" });
  expect(blocked.status).toBe(409);
  expect(blocked.body.error).toBe("That conversation is busy.");
});

it("reports platform sign-in from the Apply Bot's browser", async () => {
  const { api } = await serve();
  await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ applyBotId: "apply-bot", platforms: { naukri: { enabled: true, loginId: "login-apply" }, linkedin: { enabled: true } } }) });
  const { status, body } = await api("/api/jobs/platforms");
  expect(status).toBe(200);
  expect(body.platforms).toEqual([
    { platform: "naukri", enabled: true, loginId: "login-apply", signedIn: true },
    { platform: "linkedin", enabled: true, signedIn: false },
  ]);
  const { api: unset } = await serve();
  const bare = await unset("/api/jobs/platforms");
  expect(bare.body).toEqual({ platforms: [] });
  const { api: broken } = await serve({ signedInSites: async () => { throw new Error("browser down"); } });
  await broken("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ applyBotId: "apply-bot", platforms: { naukri: { enabled: true } } }) });
  expect((await broken("/api/jobs/platforms")).status).toBe(503);
});

it("extracts resume text and refuses unreadable files", async () => {
  const { api } = await serve();
  const text = Buffer.from("Santhoshkumar, Data Engineer", "utf8").toString("base64");
  const ok = await api("/api/jobs/extract", { method: "POST", body: JSON.stringify({ filename: "resume.txt", dataBase64: text }) });
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ text: "Santhoshkumar, Data Engineer", kind: "text", pages: null });
  expect((await api("/api/jobs/extract", { method: "POST", body: JSON.stringify({ filename: "resume.exe", dataBase64: text }) })).status).toBe(400);
  expect((await api("/api/jobs/extract", { method: "POST", body: JSON.stringify({ filename: "resume.pdf", dataBase64: Buffer.from("not a pdf").toString("base64") }) })).status).toBe(400);
  expect((await api("/api/jobs/extract", { method: "POST", body: JSON.stringify({ filename: "resume.txt" }) })).status).toBe(400);
});

it("records the matches a search turn reports, scored and deduped", async () => {
  const report = [
    "Found two matches.",
    "```sanremes-jobs",
    JSON.stringify([
      { platform: "naukri", url: "https://www.naukri.com/job/1", title: "Data Engineer", company: "Acme", jdKeywords: ["Databricks", "PySpark"] },
      { platform: "linkedin", url: "https://www.linkedin.com/jobs/2", title: "Data Engineer", company: "Beta", jdText: "Databricks and SQL." },
      { platform: "naukri", url: "https://www.naukri.com/job/1", title: "Data Engineer", company: "Acme" },
    ]),
    "```",
  ].join("\n");
  const { api, store } = await serve({
    startSearch: async (input) => { input.onSettled?.(report); return { started: true }; },
  });
  seedProfile(store);
  await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ applyBotId: "apply-bot" }) });
  const run = await api("/api/jobs/search", { method: "POST", body: "{}" });
  expect(run.status).toBe(202);
  expect(run.body).toEqual({ started: true, botId: "apply-bot" });
  const read = await api("/api/jobs");
  expect(read.body.jobs).toHaveLength(2);
  expect(read.body.jobs[0]).toMatchObject({ matchScore: 100 });
  expect(read.body.jobs[1]).toMatchObject({ matchScore: 100 });
});

it("tailors a one-page resume into the Resume Bot workspace and queues the job", async () => {
  const { api, store, resumeDir } = await serve();
  seed(store);
  expect((await api("/api/jobs/job-1/tailor", { method: "POST", body: "{}" })).status).toBe(400);
  seedProfile(store);
  expect((await api("/api/jobs/job-1/tailor", { method: "POST", body: "{}" })).status).toBe(409);
  await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ resumeBotId: "resume-bot" }) });
  const tailored = await api("/api/jobs/job-1/tailor", { method: "POST", body: "{}" });
  expect(tailored.status).toBe(200);
  expect(tailored.body.resume).toMatchObject({ kind: "tailored", jobId: "job-1" });
  expect(tailored.body.resume.text).toContain("Santhoshkumar");
  expect(tailored.body.resume.text).not.toContain("Kafka");
  expect(tailored.body.queue).toMatchObject({ jobId: "job-1", state: "pending" });
  expect(existsSync(tailored.body.resume.path)).toBe(true);
  expect(tailored.body.resume.path.startsWith(resumeDir)).toBe(true);
  expect(readFileSync(tailored.body.resume.path, "utf8")).toBe(tailored.body.resume.text);
  expect((await api("/api/jobs/missing/tailor", { method: "POST", body: "{}" })).status).toBe(404);
  const { api: noWorkspace, store: noStore } = await serve({ resumeCwd: () => null });
  seed(noStore);
  seedProfile(noStore);
  await noWorkspace("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ resumeBotId: "resume-bot" }) });
  expect((await noWorkspace("/api/jobs/job-1/tailor", { method: "POST", body: "{}" })).status).toBe(503);
});

it("approves a batch of queue rows at once and reports the ones it cannot find", async () => {
  const { api, store } = await serve();
  const { item } = seed(store);
  const second = store.addJob({ id: "job-2", platform: "linkedin", url: "https://www.linkedin.com/jobs/2", title: "Data Engineer", company: "Beta" });
  const secondItem = store.enqueue(second.id, "resume-1")!;
  const batch = await api("/api/jobs/queue/batch-approve", { method: "POST", body: JSON.stringify({ ids: [item.id, secondItem.id, "missing"] }) });
  expect(batch.status).toBe(200);
  expect(batch.body.results).toEqual([
    { id: item.id, state: "approved" },
    { id: secondItem.id, state: "approved" },
    { id: "missing", error: "No such queue item." },
  ]);
  expect((await api("/api/jobs/queue/batch-approve", { method: "POST", body: JSON.stringify({ ids: [] }) })).status).toBe(400);
});

it("submits only through the gate: approved, under the cap, and unpaused", async () => {
  const applied: Array<{ botId: string; jobId: string; prompt: string }> = [];
  const { api, store } = await serve({
    startApply: async (input) => { applied.push(input); input.onSettled?.(true); return { started: true }; },
  });
  const { item } = seed(store);
  store.addResume({ id: "resume-1", kind: "tailored", path: "/resumes/r.txt", text: "Santhoshkumar" });
  await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ applyBotId: "apply-bot" }) });
  expect((await api(`/api/jobs/queue/${item.id}/apply`, { method: "POST", body: "{}" })).status).toBe(409);
  store.decideQueue(item.id, "approved");
  await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ paused: true }) });
  const paused = await api(`/api/jobs/queue/${item.id}/apply`, { method: "POST", body: "{}" });
  expect(paused.status).toBe(409);
  expect(paused.body.reason).toBe("paused");
  await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ paused: false, dailyCap: 1 }) });
  store.setJobStatus("job-1", "applied");
  const capped = await api(`/api/jobs/queue/${item.id}/apply`, { method: "POST", body: "{}" });
  expect(capped.status).toBe(409);
  expect(capped.body.reason).toBe("daily-cap");
  store.setJobStatus("job-1", "approved");
  const sent = await api(`/api/jobs/queue/${item.id}/apply`, { method: "POST", body: "{}" });
  expect(sent.status).toBe(202);
  expect(sent.body).toEqual({ started: true, botId: "apply-bot" });
  expect(applied).toHaveLength(1);
  expect(applied[0]!.prompt).toContain("SANREMES-APPLIED job-1");
  const read = await api("/api/jobs");
  expect(read.body.jobs[0]).toMatchObject({ status: "applied" });
  expect(read.body.queue[0].attempts).toHaveLength(1);
  expect((await api("/api/jobs/queue/missing/apply", { method: "POST", body: "{}" })).status).toBe(404);
});

it("leaves the job unapplied when the apply turn reports no submission", async () => {
  const { api, store } = await serve({
    startApply: async (input) => { input.onSettled?.(false); return { started: true }; },
  });
  const { item } = seed(store);
  seedProfile(store);
  await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ applyBotId: "apply-bot", resumeBotId: "resume-bot" }) });
  await api("/api/jobs/job-1/tailor", { method: "POST", body: "{}" });
  store.decideQueue(item.id, "approved");
  const sent = await api(`/api/jobs/queue/${item.id}/apply`, { method: "POST", body: "{}" });
  expect(sent.status).toBe(202);
  expect(sent.body).toEqual({ started: true, botId: "apply-bot" });
  const read = await api("/api/jobs");
  expect(read.body.jobs[0].status).toBe("new");
  expect(read.body.queue[0].attempts).toHaveLength(1);
});

it("refuses an unknown Resume Bot id in settings", async () => {
  const { api } = await serve();
  expect((await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ resumeBotId: "missing-bot" }) })).status).toBe(400);
  const ok = await api("/api/jobs/settings", { method: "PATCH", body: JSON.stringify({ resumeBotId: "resume-bot", paused: true }) });
  expect(ok.status).toBe(200);
  expect(ok.body.settings).toMatchObject({ resumeBotId: "resume-bot", paused: true });
  expect(ok.body.appliedToday).toBe(0);
});
