import { useEffect, useRef, useState } from "react";

import { t } from "@/lib/i18n";
import {
  abandonTakeover, fetchJobRun, fetchJobRuns, isRunActive, latestRun, pauseJobRun, resumeJobRun, resumeTakeover, startJobRun, upsertRun,
  type JobRun,
} from "@/lib/jobs-run";
import {
  applyQueueItem, approveQueueItem, batchApproveQueue, emptyJobsState, fetchJobs, fetchPlatforms, fetchTracker, generateCoverLetter, generateInterviewPrep, generateResumeVariant, rejectQueueItem,
  saveSettings, sortedJobs, startJobSearch, tailorResume, updateJobStatus,
  type JobPlatformStatus, type JobsJob, type JobsState, type JobStatus, type TrackerSummary,
} from "@/lib/jobs";
import { fetchTasks, type Task } from "@/lib/tasks";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageHeader } from "../ToolPageShell";
import { JobSetupWizard } from "./JobSetupWizard";
import { ResumeDiff } from "./ResumeDiff";

const SECTION = "rounded-xl border border-hairline/60 bg-card p-3.5";
const STATUS_ORDER: JobStatus[] = ["new", "queued", "approved", "applied", "interview", "rejected", "saved", "skipped", "expired"];

function dateText(at: number): string {
  return new Date(at).toLocaleDateString();
}

function dateTimeText(at: number): string {
  return new Date(at).toLocaleString();
}

/** The route's own reason, word for word; the generic line only when it says nothing. */
function routeReason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The Jobs hub: setup, profile, resume versions, job matches, approval queue, tracking. */
export function JobBotPage() {
  const dispatch = useStoreDispatch();
  const bots = useStoreSelector((state) => state.bots);
  const [jobs, setJobs] = useState<JobsState | null>(null);
  const [platforms, setPlatforms] = useState<JobPlatformStatus[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [tailoring, setTailoring] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [busyQueue, setBusyQueue] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [queueTasks, setQueueTasks] = useState<Task[] | null>(null);
  const [queueTasksFailed, setQueueTasksFailed] = useState(false);
  const [companyPages, setCompanyPages] = useState<string[]>([]);
  const [newPage, setNewPage] = useState("");
  const [savingPages, setSavingPages] = useState(false);
  const [tracker, setTracker] = useState<TrackerSummary | null>(null);
  const [docBusy, setDocBusy] = useState<string | null>(null);
  const [takeoverBusy, setTakeoverBusy] = useState<string | null>(null);
  const runPoll = useRef(0);
  /** A run takes minutes, so keep asking every 3s until it finishes or stops; a new poll cancels the old one. */
  const pollRun = async (id: string) => {
    const token = ++runPoll.current;
    for (let attempt = 0; attempt < 200; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (runPoll.current !== token) return;
      try {
        const { run } = await fetchJobRun(id);
        setRuns((prev) => upsertRun(prev ?? [], run));
        void fetchTasks().then(({ tasks }) => setQueueTasks(tasks)).catch(() => undefined);
        if (!isRunActive(run)) return;
      } catch {
        return;
      }
    }
  };
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    let live = true;
    fetchJobs()
      .then((state) => { if (live) { setJobs(state); setSetupOpen(!state.profile); setCompanyPages(state.settings.companyPages ?? []); } })
      .catch(() => { if (live) { setJobs(emptyJobsState()); setLoadFailed(true); setSetupOpen(true); } });
    fetchPlatforms().then((state) => { if (live) setPlatforms(state.platforms); }).catch(() => undefined);
    fetchJobRuns()
      .then(({ runs: found }) => {
        if (!live) return;
        setRuns(found);
        const current = latestRun(found);
        if (current && isRunActive(current)) void pollRun(current.id);
      })
      .catch(() => { if (live) setRuns([]); });
    fetchTasks()
      .then(({ tasks }) => { if (live) setQueueTasks(tasks); })
      .catch(() => { if (live) { setQueueTasks([]); setQueueTasksFailed(true); } });
    fetchTracker()
      .then(({ tracker: found }) => { if (live) setTracker(found); })
      .catch(() => undefined);
    return () => { live = false; runPoll.current += 1; };
  }, []);

  const profile = jobs?.profile ?? null;
  const settings = jobs?.settings;
  const capReached = jobs !== null && settings !== undefined && (jobs.appliedToday ?? 0) >= settings.dailyCap;
  const paused = settings?.paused ?? false;

  const refresh = async () => setJobs(await fetchJobs());
  /** A search or apply turn settles after its route answers, so poll until the store shows the result. */
  const pollFor = async (done: (state: JobsState) => boolean) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const state = await fetchJobs();
      setJobs(state);
      if (done(state)) return true;
    }
    return false;
  };
  const runSearch = async () => {
    if (searching) return;
    setSearching(true);
    setError("");
    setNotice("");
    try {
      const before = jobs?.jobs.length ?? 0;
      await startJobSearch();
      const changed = await pollFor((state) => state.jobs.length > before);
      if (changed) {
        const after = (await fetchJobs()).jobs.length;
        setNotice(t("jobs.matches.recorded", { count: after - before }));
      }
    } catch (error) {
      setError(routeReason(error, t("jobs.error.search")));
    } finally {
      setSearching(false);
    }
  };
  const runTailor = async (job: JobsJob) => {
    if (tailoring) return;
    setTailoring(job.id);
    setError("");
    try {
      await tailorResume(job.id);
      await refresh();
    } catch (error) {
      setError(routeReason(error, t("jobs.error.tailor")));
    } finally {
      setTailoring(null);
    }
  };
  const decide = async (id: string, approve: boolean) => {
    if (busyQueue) return;
    setBusyQueue(id);
    setError("");
    try {
      if (approve) await approveQueueItem(id); else await rejectQueueItem(id);
      await refresh();
    } catch (error) {
      setError(routeReason(error, t("jobs.error.queue")));
    } finally {
      setBusyQueue(null);
    }
  };
  const approveAll = async () => {
    if (!jobs || busyQueue) return;
    const pending = jobs.queue.filter((item) => item.state === "pending").map((item) => item.id);
    if (!pending.length) return;
    setBusyQueue("all");
    setError("");
    try {
      await batchApproveQueue(pending);
      await refresh();
    } catch (error) {
      setError(routeReason(error, t("jobs.error.queue")));
    } finally {
      setBusyQueue(null);
    }
  };
  const runApply = async (id: string) => {
    if (applying) return;
    setApplying(id);
    setError("");
    try {
      await applyQueueItem(id);
      await pollFor((state) => {
        const item = state.queue.find((one) => one.id === id);
        return (item?.attempts.length ?? 0) > 0;
      });
    } catch (error) {
      setError(routeReason(error, t("jobs.error.apply")));
    } finally {
      setApplying(null);
    }
  };
  const changeStatus = async (job: JobsJob, status: JobStatus) => {
    setError("");
    try {
      await updateJobStatus(job.id, status);
      await refresh();
    } catch (error) {
      setError(routeReason(error, t("jobs.error.status")));
    }
  };
  const togglePause = async () => {
    if (pausing) return;
    setPausing(true);
    setError("");
    try {
      setJobs(await saveSettings({ paused: !paused }));
    } catch (error) {
      setError(routeReason(error, t("jobs.error.queue")));
    } finally {
      setPausing(false);
    }
  };
  const startRun = async () => {
    if (runBusy) return;
    setRunBusy(true);
    setError("");
    try {
      const { run } = await startJobRun();
      setRuns((prev) => upsertRun(prev ?? [], run));
      void pollRun(run.id);
    } catch (error) {
      setError(routeReason(error, t("jobs.run.startFailed")));
    } finally {
      setRunBusy(false);
    }
  };
  const pauseRun = async (run: JobRun) => {
    if (runBusy) return;
    setRunBusy(true);
    setError("");
    try {
      const { run: next } = await pauseJobRun(run.id);
      setRuns((prev) => upsertRun(prev ?? [], next));
      void pollRun(run.id);
    } catch (error) {
      setError(routeReason(error, t("jobs.run.pauseFailed")));
    } finally {
      setRunBusy(false);
    }
  };
  const resumeRun = async (run: JobRun) => {
    if (runBusy) return;
    setRunBusy(true);
    setError("");
    try {
      const { run: next } = await resumeJobRun(run.id);
      setRuns((prev) => upsertRun(prev ?? [], next));
      void pollRun(run.id);
    } catch (error) {
      setError(routeReason(error, t("jobs.run.resumeFailed")));
    } finally {
      setRunBusy(false);
    }
  };
  const refreshRun = async (run: JobRun) => {
    if (runBusy) return;
    setRunBusy(true);
    setError("");
    try {
      const { run: next } = await fetchJobRun(run.id);
      setRuns((prev) => upsertRun(prev ?? [], next));
      if (isRunActive(next)) void pollRun(run.id);
    } catch (error) {
      setError(routeReason(error, t("jobs.run.refreshFailed")));
    } finally {
      setRunBusy(false);
    }
  };
  const resumeTakeoverRun = async (run: JobRun) => {
    if (takeoverBusy) return;
    setTakeoverBusy(`resume:${run.id}`);
    setError("");
    try {
      const { run: next } = await resumeTakeover(run.id);
      setRuns((prev) => upsertRun(prev ?? [], next));
      setNotice(t("jobs.takeover.resumed"));
      if (isRunActive(next)) void pollRun(run.id);
    } catch (error) {
      setError(routeReason(error, t("jobs.takeover.failed")));
    } finally {
      setTakeoverBusy(null);
    }
  };
  const abandonTakeoverRun = async (run: JobRun) => {
    if (takeoverBusy) return;
    setTakeoverBusy(`abandon:${run.id}`);
    setError("");
    try {
      const { run: next } = await abandonTakeover(run.id);
      setRuns((prev) => upsertRun(prev ?? [], next));
      setNotice(t("jobs.takeover.done"));
    } catch (error) {
      setError(routeReason(error, t("jobs.takeover.failed")));
    } finally {
      setTakeoverBusy(null);
    }
  };
  const makeDocument = async (job: JobsJob, kind: "cover-letter" | "interview-prep" | "resume-variant", label: string) => {
    if (docBusy) return;
    setDocBusy(`${kind}:${job.id}`);
    setError("");
    try {
      if (kind === "cover-letter") await generateCoverLetter(job.id);
      else if (kind === "interview-prep") await generateInterviewPrep(job.id);
      else await generateResumeVariant(job.id, job.platform === "linkedin" ? "linkedin" : job.platform === "naukri" ? "naukri" : "default");
      await refresh();
      setNotice(t("jobs.documents.ready", { kind: label, company: job.company }));
    } catch (error) {
      setError(routeReason(error, t("jobs.documents.failed")));
    } finally {
      setDocBusy(null);
    }
  };
  const pageUrlOk = (value: string): boolean => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  };
  const addCompanyPage = async () => {
    const value = newPage.trim();
    if (!pageUrlOk(value) || companyPages.includes(value)) {
      setError(t("jobs.page.companyPagesInvalid"));
      return;
    }
    const next = [...companyPages, value];
    setSavingPages(true);
    setError("");
    try {
      await saveSettings({ companyPages: next });
      setCompanyPages(next);
      setNewPage("");
      setNotice(t("jobs.page.companyPagesSaved"));
    } catch (error) {
      setError(routeReason(error, t("jobs.page.companyPagesSaveFailed")));
    } finally {
      setSavingPages(false);
    }
  };
  const removeCompanyPage = async (value: string) => {
    const next = companyPages.filter((page) => page !== value);
    setSavingPages(true);
    setError("");
    try {
      await saveSettings({ companyPages: next });
      setCompanyPages(next);
      setNotice(t("jobs.page.companyPagesSaved"));
    } catch (error) {
      setError(routeReason(error, t("jobs.page.companyPagesSaveFailed")));
    } finally {
      setSavingPages(false);
    }
  };

  const jobById = (id: string) => jobs?.jobs.find((job) => job.id === id);
  const latest = runs ? latestRun(runs) : null;
  const takeoverRun = runs?.find((run) => run.takeover?.status === "waiting") ?? null;
  const takeoverJob = takeoverRun?.takeover ? jobById(takeoverRun.takeover.jobId) : undefined;
  const runTasks = latest?.applied.filter((entry) => entry.taskId !== undefined) ?? [];
  const taskById = (id: string) => queueTasks?.find((task) => task.id === id);
  const botName = (botId: string | null): string => {
    if (botId === null) return t("jobs.page.taskUnassigned");
    return bots.find((bot) => bot.id === botId)?.name ?? botId;
  };
  const lockAge = (lockedAt: number | null): string => {
    if (lockedAt === null) return "";
    const minutes = Math.max(0, Math.floor((Date.now() - lockedAt) / 60000));
    if (minutes < 1) return t("jobs.page.lockAgeJustNow");
    if (minutes < 60) return t("jobs.page.lockAgeMinutes", { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t("jobs.page.lockAgeHours", { count: hours });
    return t("jobs.page.lockAgeDays", { count: Math.floor(hours / 24) });
  };
  const pendingQueue = jobs?.queue.filter((item) => item.state === "pending") ?? [];

  return (
    <ToolPage label={t("jobs.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={() => dispatch({ type: "showChat" })} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>{t("jobs.title")}</h1>
      </ToolPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-jobs-page={jobs ? "ready" : "loading"}>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
          {loadFailed && (
            <p role="alert" className="rounded-xl border border-warning/40 bg-card px-3.5 py-2.5 text-[13px] text-ink-secondary">
              {t("jobs.page.loadFailed")}
            </p>
          )}
          {error && <p role="alert" className="rounded-xl border border-danger/40 bg-card px-3.5 py-2.5 text-[13px] text-ink-secondary">{error}</p>}
          {notice && <p role="status" className="rounded-xl border border-hairline/60 bg-card px-3.5 py-2.5 text-[13px] text-ink-secondary">{notice}</p>}
          {!jobs ? (
            <p className="px-2 py-8 text-center text-[13px] text-ink-secondary">{t("jobs.page.loading")}</p>
          ) : setupOpen ? (
            <>
              <p className="text-[14px] leading-relaxed text-ink-secondary">{t("jobs.page.setupNeeded")}</p>
              <JobSetupWizard
                existingBots={bots}
                initialProfile={profile}
                initialSettings={jobs.settings}
                onDone={(state) => { setJobs(state); setSetupOpen(false); }}
              />
            </>
          ) : (
            <>
              <section aria-label={t("jobs.page.profile")} className={SECTION}>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[14px] font-semibold text-ink">{t("jobs.page.profile")}</h2>
                  <button type="button" onClick={() => setSetupOpen(true)} className="ui-button ui-button-md">{t("jobs.page.editSetup")}</button>
                </div>
                {profile ? (
                  <div className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
                    <p><span className="font-medium text-ink">{profile.name}</span>{profile.title ? ` · ${profile.title}` : ""} · {profile.location}</p>
                    {profile.skills.length > 0 && <p className="mt-1">{profile.skills.join(", ")}</p>}
                    <p className="mt-1">{t("jobs.page.setupDone")}</p>
                  </div>
                ) : (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.page.setupNeeded")}</p>
                )}
              </section>

              <section aria-label={t("jobs.run.title")} className={SECTION}>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[14px] font-semibold text-ink">{t("jobs.run.title")}</h2>
                  {latest && isRunActive(latest) ? (
                    <button type="button" onClick={() => void pauseRun(latest)} disabled={runBusy} className="ui-button ui-button-md disabled:opacity-50">
                      {runBusy ? t("jobs.run.pausing") : t("jobs.run.pause")}
                    </button>
                  ) : latest && latest.phase === "stopped" ? (
                    <button type="button" onClick={() => void resumeRun(latest)} disabled={runBusy} className="ui-button ui-button-md ui-button-primary disabled:opacity-50">
                      {runBusy ? t("jobs.run.resuming") : t("jobs.run.resume")}
                    </button>
                  ) : (
                    <button type="button" onClick={() => void startRun()} disabled={runBusy} className="ui-button ui-button-md ui-button-primary disabled:opacity-50">
                      {runBusy ? t("jobs.run.starting") : t("jobs.run.start")}
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("jobs.run.body")}</p>
                {runs === null ? (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.page.loading")}</p>
                ) : latest === null ? (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.run.none")}</p>
                ) : (
                  <div className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
                    <p>
                      <span className="font-medium text-ink">{t(`jobs.run.phase.${latest.phase}`)}</span>
                      {` · ${t("jobs.run.counts", { searched: latest.searched, found: latest.found, applied: latest.applied.length })}`}
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-tertiary">{t("jobs.run.startedAt", { date: dateTimeText(latest.startedAt) })}</p>
                    <div className="mt-2">
                      <button type="button" onClick={() => void refreshRun(latest)} disabled={runBusy} className="ui-button ui-button-md disabled:opacity-50">
                        {t("jobs.run.refresh")}
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {takeoverRun !== null && takeoverRun.takeover && (
                <section aria-label={t("jobs.takeover.title")} className={SECTION}>
                  <h2 className="text-[14px] font-semibold text-ink">{t("jobs.takeover.title")}</h2>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
                    {t("jobs.takeover.body", {
                      company: takeoverJob ? `${takeoverJob.title} at ${takeoverJob.company}` : takeoverRun.takeover.jobId,
                      reason: takeoverRun.takeover.reason,
                    })}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {takeoverJob && (
                      <a href={takeoverJob.url} target="_blank" rel="noreferrer" className="ui-button ui-button-md">{t("jobs.takeover.openJob")}</a>
                    )}
                    <button type="button" onClick={() => void resumeTakeoverRun(takeoverRun)} disabled={takeoverBusy !== null} className="ui-button ui-button-md ui-button-primary disabled:opacity-50">
                      {takeoverBusy === `resume:${takeoverRun.id}` ? t("jobs.takeover.resuming") : t("jobs.takeover.resume")}
                    </button>
                    <button type="button" onClick={() => void abandonTakeoverRun(takeoverRun)} disabled={takeoverBusy !== null} className="ui-button ui-button-md disabled:opacity-50">
                      {takeoverBusy === `abandon:${takeoverRun.id}` ? t("jobs.takeover.abandoning") : t("jobs.takeover.abandon")}
                    </button>
                  </div>
                </section>
              )}

              {latest !== null && (latest.applied.length > 0 || latest.skipped.length > 0 || latest.reportText !== "") && (
                <section aria-label={t("jobs.report.title")} className={SECTION}>
                  <h2 className="text-[14px] font-semibold text-ink">{t("jobs.report.title")}</h2>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("jobs.report.body")}</p>
                  {latest.reportText !== "" && <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{latest.reportText}</p>}
                  <h3 className="mt-3 text-[13px] font-medium text-ink">{t("jobs.report.applied")}</h3>
                  {latest.applied.length === 0 ? (
                    <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.report.appliedEmpty")}</p>
                  ) : (
                    <div className="mt-1 overflow-x-auto">
                      <table className="w-full text-left text-[13px] leading-relaxed text-ink-secondary">
                        <thead>
                          <tr className="text-[12px] text-ink-tertiary">
                            <th className="py-1 pe-3 font-medium">{t("jobs.report.colCompany")}</th>
                            <th className="py-1 pe-3 font-medium">{t("jobs.report.colRole")}</th>
                            <th className="py-1 pe-3 font-medium">{t("jobs.report.colLocation")}</th>
                            <th className="py-1 pe-3 font-medium">{t("jobs.report.colAppliedAt")}</th>
                            <th className="py-1 pe-3 font-medium">{t("jobs.report.colStatus")}</th>
                            <th className="py-1 pe-3 font-medium">{t("jobs.report.colLink")}</th>
                            <th className="py-1 font-medium">{t("jobs.report.colTask")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {latest.applied.map((entry) => {
                            const task = entry.taskId === undefined ? undefined : taskById(entry.taskId);
                            return (
                              <tr key={entry.jobId} className="border-t border-hairline/60 align-top">
                                <td className="py-2 pe-3 font-medium text-ink">{entry.company}</td>
                                <td className="py-2 pe-3">{entry.title}</td>
                                <td className="py-2 pe-3">{entry.location ?? t("jobs.report.notAvailable")}</td>
                                <td className="py-2 pe-3 tabular-nums">{dateTimeText(entry.appliedAt)}</td>
                                <td className="py-2 pe-3">{t(`jobs.report.status.${entry.status}`)}</td>
                                <td className="py-2 pe-3">
                                  <a href={entry.url} target="_blank" rel="noreferrer" className="text-accent-text underline">{t("jobs.report.openPosting")}</a>
                                  {entry.requisition && <span className="block text-[12px] text-ink-tertiary">{entry.requisition}</span>}
                                </td>
                                <td className="py-2">
                                  {entry.taskId === undefined ? t("jobs.report.noTask") : task ? t(`jobs.page.taskState.${task.state}`) : t("jobs.page.taskGone")}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <h3 className="mt-3 text-[13px] font-medium text-ink">{t("jobs.report.skipped")}</h3>
                  {latest.skipped.length === 0 ? (
                    <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.report.skippedEmpty")}</p>
                  ) : (
                    <ul className="mt-1 flex flex-col gap-2">
                      {latest.skipped.map((entry) => (
                        <li key={entry.jobId} className="rounded-lg border border-hairline/60 p-3">
                          <p className="text-[13px] font-medium text-ink">{entry.title} · {entry.company}</p>
                          <p className="mt-0.5 text-[12px] text-ink-secondary">{entry.reason}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-3 text-[13px] leading-relaxed text-ink-secondary" role="status">
                    {latest.whatsapp === "sent"
                      ? t("jobs.report.whatsappSent")
                      : latest.whatsapp === "pending-bridge"
                        ? t("jobs.report.whatsappPending")
                        : latest.whatsapp === "failed"
                          ? t("jobs.report.whatsappFailed")
                          : t("jobs.report.whatsappNotConfigured")}
                  </p>
                </section>
              )}

              <section aria-label={t("jobs.tracker.title")} className={SECTION}>
                <h2 className="text-[14px] font-semibold text-ink">{t("jobs.tracker.title")}</h2>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("jobs.tracker.body")}</p>
                {tracker === null ? (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.page.loading")}</p>
                ) : jobs.jobs.length === 0 ? (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.tracker.empty")}</p>
                ) : (
                  <>
                    <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
                      {t("jobs.tracker.applied", { count: tracker.totals.applied })}
                      {` · ${t("jobs.tracker.interviews", { count: tracker.outcomes.interview })}`}
                      {` · ${t("jobs.tracker.rejected", { count: tracker.outcomes.rejected })}`}
                      {` · ${t("jobs.tracker.offers", { count: tracker.outcomes.offer })}`}
                      {` · ${t("jobs.tracker.noReply", { count: tracker.outcomes.noReply })}`}
                    </p>
                    <h3 className="mt-3 text-[13px] font-medium text-ink">{t("jobs.tracker.perPlatform")}</h3>
                    {tracker.perPlatform.length === 0 ? (
                      <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.tracker.empty")}</p>
                    ) : (
                      <ul className="mt-1 flex flex-col gap-1 text-[13px] text-ink-secondary">
                        {tracker.perPlatform.map((row) => (
                          <li key={row.platform}>
                            {row.platform}: {t("jobs.tracker.applied", { count: row.applied })} · {t("jobs.tracker.conversion", { conversion: row.conversion })}
                          </li>
                        ))}
                      </ul>
                    )}
                    <h3 className="mt-3 text-[13px] font-medium text-ink">{t("jobs.tracker.followUps")}</h3>
                    {tracker.followUpsDue.length === 0 ? (
                      <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.tracker.followUpsEmpty")}</p>
                    ) : (
                      <ul className="mt-1 flex flex-col gap-2">
                        {tracker.followUpsDue.map((job) => (
                          <li key={job.id} className="rounded-lg border border-hairline/60 p-3">
                            <p className="text-[13px] font-medium text-ink">{job.title} · {job.company}</p>
                            <p className="mt-0.5 text-[12px] text-ink-secondary">
                              {t("jobs.tracker.followUpDue", { date: dateText(job.followUpAt ?? 0) })}
                              {job.followUpNote ? ` · ${job.followUpNote}` : ""}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>

              <section aria-label={t("jobs.page.taskQueue")} className={SECTION}>
                <h2 className="text-[14px] font-semibold text-ink">{t("jobs.page.taskQueue")}</h2>
                {queueTasksFailed && (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.page.taskQueueLoadFailed")}</p>
                )}
                {latest === null || runTasks.length === 0 ? (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.page.taskQueueEmpty")}</p>
                ) : queueTasks === null ? (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.page.loading")}</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {runTasks.map((entry) => {
                      const task = entry.taskId === undefined ? undefined : taskById(entry.taskId);
                      return (
                        <li key={entry.jobId} className="rounded-lg border border-hairline/60 p-3">
                          <p className="text-[13px] font-medium text-ink">{entry.title} · {entry.company}</p>
                          {task === undefined ? (
                            <p className="mt-0.5 text-[12px] text-ink-secondary">{t("jobs.page.taskGone")}</p>
                          ) : (
                            <p className="mt-0.5 text-[12px] text-ink-secondary">
                              {t(`jobs.page.taskState.${task.state}`)} · {botName(task.assigneeBotId)}
                              {task.lockedAt !== null && ` · ${t("jobs.page.taskHeldFor", { age: lockAge(task.lockedAt) })}`}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section aria-label={t("jobs.platforms.title")} className={SECTION}>
                <h2 className="text-[14px] font-semibold text-ink">{t("jobs.platforms.title")}</h2>
                {platforms.length === 0 ? (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.platforms.unknown")}</p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-1 text-[13px] text-ink-secondary">
                    {platforms.map((entry) => (
                      <li key={entry.platform}>
                        {entry.platform}: {entry.signedIn === true ? t("jobs.platforms.signedIn") : entry.signedIn === false ? t("jobs.platforms.needsSignIn") : t("jobs.platforms.unknown")}
                        {entry.signedIn === false && <span className="block text-[12px] text-ink-tertiary">{t("jobs.platforms.signInHint")}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-label={t("jobs.page.companyPages")} className={SECTION}>
                <h2 className="text-[14px] font-semibold text-ink">{t("jobs.page.companyPages")}</h2>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("jobs.page.companyPagesBody")}</p>
                {companyPages.length === 0 ? (
                  <p className="mt-2 text-[13px] text-ink-secondary">{t("jobs.page.companyPagesEmpty")}</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {companyPages.map((page) => (
                      <li key={page} className="flex items-center justify-between gap-2 rounded-lg border border-hairline/60 px-3 py-2">
                        <span className="min-w-0 truncate text-[13px] text-ink-secondary">{page}</span>
                        <button type="button" onClick={() => void removeCompanyPage(page)} disabled={savingPages} aria-label={t("jobs.page.companyPagesRemove", { url: page })} className="ui-button ui-button-md shrink-0 disabled:opacity-50">
                          {t("jobs.page.companyPagesRemoveButton")}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 flex gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-1 text-[12px] font-medium text-ink-secondary">
                    {t("jobs.page.companyPagesLabel")}
                    <input type="url" autoComplete="off" value={newPage} onChange={(event) => setNewPage(event.target.value)} placeholder={t("jobs.page.companyPagesPlaceholder")} disabled={savingPages} className="w-full min-w-0 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60" />
                  </label>
                  <button type="button" onClick={() => void addCompanyPage()} disabled={savingPages || newPage.trim() === ""} className="ui-button ui-button-md self-end disabled:opacity-50">
                    {t("jobs.page.companyPagesAdd")}
                  </button>
                </div>
              </section>

              <section aria-label={t("jobs.page.resumes")} className={SECTION}>
                <h2 className="text-[14px] font-semibold text-ink">{t("jobs.page.resumes")}</h2>
                <h3 className="mt-2 text-[13px] font-medium text-ink">{t("jobs.resumes.base")}</h3>
                {profile?.resumeText
                  ? <pre className="mt-1 max-h-48 overflow-y-auto rounded-lg bg-inset p-3 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{profile.resumeText}</pre>
                  : <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.resumes.baseEmpty")}</p>}
                <h3 className="mt-3 text-[13px] font-medium text-ink">{t("jobs.resumes.tailored")}</h3>
                {jobs.resumes.length === 0 ? (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.resumes.none")}</p>
                ) : (
                  <ul className="mt-1 flex flex-col gap-2">
                    {jobs.resumes.map((resume) => {
                      const job = resume.jobId ? jobById(resume.jobId) : undefined;
                      return (
                        <li key={resume.id} className="rounded-lg border border-hairline/60 p-3">
                          <p className="text-[13px] text-ink-secondary">{resume.note ?? resume.path}{job ? ` · ${job.title} at ${job.company}` : ""}</p>
                          {resume.text && profile?.resumeText && (
                            <div className="mt-2">
                              <button type="button" onClick={() => setDiffFor(diffFor === resume.id ? null : resume.id)} className="ui-button ui-button-md">
                                {t("jobs.resumes.diffTitle")}
                              </button>
                              {diffFor === resume.id && <ResumeDiff base={profile.resumeText} tailored={resume.text} />}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section aria-label={t("jobs.page.matches")} className={SECTION}>
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[14px] font-semibold text-ink">{t("jobs.page.matches")}</h2>
                  <button type="button" onClick={() => void runSearch()} disabled={searching} className="ui-button ui-button-md ui-button-primary disabled:opacity-50">
                    {searching ? t("jobs.matches.searching") : t("jobs.matches.search")}
                  </button>
                </div>
                {jobs.jobs.length === 0 ? (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.matches.none")}</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {sortedJobs(jobs.jobs).map((job) => {
                      const queued = jobs.queue.some((item) => item.jobId === job.id && item.state !== "rejected");
                      return (
                        <li key={job.id} className="rounded-lg border border-hairline/60 p-3">
                          <p className="text-[13px] font-medium text-ink">{job.title} · {job.company}</p>
                          <p className="mt-0.5 text-[12px] text-ink-secondary">
                            {job.platform}{job.location ? ` · ${job.location}` : ""} · {t("jobs.matches.matchScore", { score: job.matchScore ?? 0 })}
                          </p>
                          <p className="mt-0.5 text-[12px] text-ink-secondary">
                            {job.salaryText ? `${t("jobs.matches.salaryPosted", { salary: job.salaryText })} · ` : ""}{profile?.salaryExpected ? t("jobs.matches.salaryExpected", { salary: profile.salaryExpected }) : ""}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button type="button" onClick={() => void runTailor(job)} disabled={tailoring !== null || queued} className="ui-button ui-button-md disabled:opacity-50">
                              {tailoring === job.id ? t("jobs.matches.tailoring") : queued ? t("jobs.matches.queued") : t("jobs.matches.tailor")}
                            </button>
                            <button type="button" onClick={() => void makeDocument(job, "cover-letter", t("jobs.documents.coverLetter"))} disabled={docBusy !== null} className="ui-button ui-button-md disabled:opacity-50">
                              {docBusy === `cover-letter:${job.id}` ? t("jobs.documents.coverLetterMaking") : t("jobs.documents.coverLetter")}
                            </button>
                            <button type="button" onClick={() => void makeDocument(job, "interview-prep", t("jobs.documents.interviewPrep"))} disabled={docBusy !== null} className="ui-button ui-button-md disabled:opacity-50">
                              {docBusy === `interview-prep:${job.id}` ? t("jobs.documents.interviewPrepMaking") : t("jobs.documents.interviewPrep")}
                            </button>
                            <button type="button" onClick={() => void makeDocument(job, "resume-variant", t("jobs.documents.resumeVariant"))} disabled={docBusy !== null} className="ui-button ui-button-md disabled:opacity-50">
                              {docBusy === `resume-variant:${job.id}` ? t("jobs.documents.resumeVariantMaking") : t("jobs.documents.resumeVariant")}
                            </button>
                          </div>
                          {(job.coverLetterId || job.interviewPrepId) && (
                            <p className="mt-1 text-[12px] text-ink-secondary">
                              {[job.coverLetterId ? t("jobs.documents.coverLetterReady") : null, job.interviewPrepId ? t("jobs.documents.interviewPrepReady") : null].filter(Boolean).join(" · ")}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section aria-label={t("jobs.page.queue")} className={SECTION}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-[14px] font-semibold text-ink">{t("jobs.page.queue")}</h2>
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-ink-secondary">{settings ? t("jobs.queue.cap", { applied: jobs.appliedToday ?? 0, cap: settings.dailyCap }) : ""}</span>
                    <button type="button" onClick={() => void togglePause()} disabled={pausing} className="ui-button ui-button-md disabled:opacity-50">
                      {paused ? t("jobs.queue.resume") : t("jobs.queue.pause")}
                    </button>
                  </div>
                </div>
                <p className="mt-2 rounded-lg border border-warning/40 bg-card px-3 py-2 text-[13px] leading-relaxed text-ink" role="note">{t("jobs.platforms.riskWarning")}</p>
                {paused && <p className="mt-2 text-[13px] text-ink-secondary">{t("jobs.queue.pausedNote")}</p>}
                {pendingQueue.length > 1 && (
                  <div className="mt-2">
                    <button type="button" onClick={() => void approveAll()} disabled={busyQueue !== null} className="ui-button ui-button-md disabled:opacity-50">
                      {t("jobs.queue.approveAll")}
                    </button>
                  </div>
                )}
                {jobs.queue.length === 0 ? (
                  <p className="mt-2 text-[13px] text-ink-secondary">{t("jobs.queue.empty")}</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-2">
                    {jobs.queue.map((item) => {
                      const job = jobById(item.jobId);
                      if (!job) return null;
                      const canApply = item.state === "approved" && !paused && !capReached;
                      return (
                        <li key={item.id} className="rounded-lg border border-hairline/60 p-3">
                          <p className="text-[13px] font-medium text-ink">{job.title} · {job.company}</p>
                          <p className="mt-0.5 text-[12px] text-ink-secondary">
                            {job.platform} · {t("jobs.matches.matchScore", { score: job.matchScore ?? 0 })} · {item.state === "pending" ? t("jobs.status.queued") : item.state === "approved" ? t("jobs.status.approved") : t("jobs.status.rejected")}
                          </p>
                          <div className="mt-2 flex gap-2">
                            {item.state === "pending" && (
                              <>
                                <button type="button" onClick={() => void decide(item.id, true)} disabled={busyQueue !== null} className="ui-button ui-button-md ui-button-primary disabled:opacity-50">{t("jobs.queue.approve")}</button>
                                <button type="button" onClick={() => void decide(item.id, false)} disabled={busyQueue !== null} className="ui-button ui-button-md disabled:opacity-50">{t("jobs.queue.reject")}</button>
                              </>
                            )}
                            {item.state === "approved" && (
                              <button type="button" onClick={() => void runApply(item.id)} disabled={!canApply || applying !== null} className="ui-button ui-button-md ui-button-primary disabled:opacity-50">
                                {applying === item.id ? t("jobs.queue.applying") : job.status === "applied" ? t("jobs.queue.applied") : t("jobs.queue.apply")}
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section aria-label={t("jobs.page.tracking")} className={SECTION}>
                <h2 className="text-[14px] font-semibold text-ink">{t("jobs.page.tracking")}</h2>
                {jobs.jobs.length === 0 ? (
                  <p className="mt-1 text-[13px] text-ink-secondary">{t("jobs.tracking.empty")}</p>
                ) : (
                  STATUS_ORDER.map((status) => {
                    const rows = jobs.jobs.filter((job) => job.status === status);
                    if (!rows.length) return null;
                    return (
                      <div key={status} className="mt-2">
                        <h3 className="text-[13px] font-medium text-ink">{t(`jobs.status.${status}`)}</h3>
                        <ul className="mt-1 flex flex-col gap-2">
                          {rows.map((job) => (
                            <li key={job.id} className="rounded-lg border border-hairline/60 p-3">
                              <p className="text-[13px] font-medium text-ink">{job.title} · {job.company}</p>
                              <p className="mt-0.5 text-[12px] text-ink-secondary">
                                {job.platform}{job.appliedAt ? ` · ${t("jobs.tracking.appliedAt", { date: dateText(job.appliedAt) })}` : ` · ${t("jobs.tracking.statusAt", { date: dateText(job.statusAt) })}`}
                              </p>
                              <label className="mt-2 flex items-center gap-2 text-[12px] text-ink-secondary">
                                {t("jobs.tracking.changeStatus")}
                                <select value={job.status} onChange={(event) => void changeStatus(job, event.target.value as JobStatus)} className="min-w-0 rounded-lg border border-hairline/60 bg-inset px-2 py-1 text-[12px] text-ink outline-none">
                                  {STATUS_ORDER.map((option) => (
                                    <option key={option} value={option}>{t(`jobs.status.${option}`)}</option>
                                  ))}
                                </select>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </ToolPage>
  );
}
