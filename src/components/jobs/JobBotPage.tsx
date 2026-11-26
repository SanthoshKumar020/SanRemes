import { useEffect, useRef, useState } from "react";

import { t } from "@/lib/i18n";
import {
  applyQueueItem, approveQueueItem, batchApproveQueue, emptyJobsState, fetchJobs, fetchPlatforms, rejectQueueItem,
  saveSettings, sortedJobs, startJobSearch, tailorResume, updateJobStatus,
  type JobPlatformStatus, type JobsJob, type JobsState, type JobStatus,
} from "@/lib/jobs";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageHeader } from "../ToolPageShell";
import { JobSetupWizard } from "./JobSetupWizard";
import { ResumeDiff } from "./ResumeDiff";

const SECTION = "rounded-xl border border-hairline/60 bg-card p-3.5";
const STATUS_ORDER: JobStatus[] = ["new", "queued", "approved", "applied", "interview", "rejected", "saved", "skipped", "expired"];

function dateText(at: number): string {
  return new Date(at).toLocaleDateString();
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
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    let live = true;
    fetchJobs()
      .then((state) => { if (live) { setJobs(state); setSetupOpen(!state.profile); } })
      .catch(() => { if (live) { setJobs(emptyJobsState()); setLoadFailed(true); setSetupOpen(true); } });
    fetchPlatforms().then((state) => { if (live) setPlatforms(state.platforms); }).catch(() => undefined);
    return () => { live = false; };
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
    } catch {
      setError(t("jobs.error.search"));
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
    } catch {
      setError(t("jobs.error.tailor"));
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
    } catch {
      setError(t("jobs.error.queue"));
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
    } catch {
      setError(t("jobs.error.queue"));
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
    } catch {
      setError(t("jobs.error.apply"));
    } finally {
      setApplying(null);
    }
  };
  const changeStatus = async (job: JobsJob, status: JobStatus) => {
    setError("");
    try {
      await updateJobStatus(job.id, status);
      await refresh();
    } catch {
      setError(t("jobs.error.status"));
    }
  };
  const togglePause = async () => {
    if (pausing) return;
    setPausing(true);
    setError("");
    try {
      setJobs(await saveSettings({ paused: !paused }));
    } catch {
      setError(t("jobs.error.queue"));
    } finally {
      setPausing(false);
    }
  };

  const jobById = (id: string) => jobs?.jobs.find((job) => job.id === id);
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
                          <div className="mt-2 flex gap-2">
                            <button type="button" onClick={() => void runTailor(job)} disabled={tailoring !== null || queued} className="ui-button ui-button-md disabled:opacity-50">
                              {tailoring === job.id ? t("jobs.matches.tailoring") : queued ? t("jobs.matches.queued") : t("jobs.matches.tailor")}
                            </button>
                          </div>
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
