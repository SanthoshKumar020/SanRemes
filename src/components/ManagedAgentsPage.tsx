import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Cloud, Download, Laptop, Pause, Play, Plus, RefreshCw, Trash2 } from "lucide-react";

import { useStoreDispatch } from "@/state/store-select";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageActions, ToolPageHeader } from "./ToolPageShell";
import { Select } from "./Select";
import {
  cloudUsageCsvUrl, createManagedAgent, deleteManagedAgent, fetchCloudSessions, fetchCloudUsageReport,
  fetchHostedBatches, fetchManagedAgents, runManagedAgentNow, setHandoff, setManagedAgentEnabled,
  submitHostedBatch,
  type HandoffState, type ManagedAgentsPayload,
} from "@/lib/managed-agents";
import type { CloudUsageReport } from "../../shared/managed-agents";
import type { BatchRun } from "../../server/batch-runner/batch-runner";
import type { ParallelSession } from "../../server/parallel-sessions";

function sessionStateLabel(state: ParallelSession["state"]): string {
  if (state === "active") return t("managedAgents.sessions.state.active");
  if (state === "conflict") return t("managedAgents.sessions.state.conflict");
  if (state === "pr-open") return t("managedAgents.sessions.state.pr-open");
  return t("managedAgents.sessions.state.closed");
}

function scheduleLabel(agent: ManagedAgentsPayload["agents"][number]["agent"]): string {
  const schedule = agent.schedule;
  if (schedule.type === "manual") return t("managedAgents.schedule.manual");
  if (schedule.type === "routine") return t("managedAgents.schedule.routine");
  if (schedule.type === "daily") return t("managedAgents.schedule.daily", { time: schedule.time });
  return t("managedAgents.schedule.interval", { minutes: schedule.everyMinutes });
}

function runLabel(run: ManagedAgentsPayload["agents"][number]["lastRun"]): string {
  if (!run) return t("managedAgents.neverRan");
  if (run.status === "completed") return t("managedAgents.lastRun.ok", { when: new Date(run.finishedAt).toLocaleString() });
  if (run.status === "stopped") return t("managedAgents.lastRun.stopped", { when: new Date(run.finishedAt).toLocaleString() });
  return t("managedAgents.lastRun.failed", { when: new Date(run.finishedAt).toLocaleString() });
}

/** Long-running agents, defined once and run on a schedule or by hand, on this computer or on the Cloud. */
export function ManagedAgentsPage() {
  const dispatch = useStoreDispatch();
  const { state } = useStore();
  const [payload, setPayload] = useState<ManagedAgentsPayload | null>(null);
  const [report, setReport] = useState<CloudUsageReport | null>(null);
  const [sessions, setSessions] = useState<ParallelSession[]>([]);
  const [batches, setBatches] = useState<BatchRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [botId, setBotId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [schedule, setSchedule] = useState<"manual" | "daily" | "interval">("manual");
  const [time, setTime] = useState("08:00");
  const [everyMinutes, setEveryMinutes] = useState("60");
  const [capUsd, setCapUsd] = useState("");
  const [batchBotId, setBatchBotId] = useState("");
  const [batchPrompts, setBatchPrompts] = useState("");
  const back = useRef<HTMLButtonElement>(null);
  const loadAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    try {
      const [agents, usage, cloudSessions, hosted] = await Promise.all([
        fetchManagedAgents(),
        fetchCloudUsageReport().catch(() => null),
        fetchCloudSessions().catch(() => null),
        fetchHostedBatches().catch(() => null),
      ]);
      if (controller.signal.aborted) return;
      setPayload(agents);
      setReport(usage?.report ?? null);
      setSessions(cloudSessions?.sessions ?? []);
      setBatches(hosted?.batches ?? []);
      setError(null);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
  }, []);

  useEffect(() => {
    back.current?.focus({ preventScroll: true });
    void load();
    const poll = setInterval(() => void load(), 15_000);
    return () => {
      clearInterval(poll);
      loadAbort.current?.abort();
    };
  }, [load]);

  const act = async (key: string, work: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const chosenBot = botId || state.bots[0]?.id;
    if (!name.trim() || !instructions.trim() || !chosenBot) return;
    await act("create", () => createManagedAgent({
      name: name.trim(),
      botId: chosenBot,
      instructions: instructions.trim(),
      schedule: schedule === "daily"
        ? { type: "daily", time }
        : schedule === "interval"
          ? { type: "interval", everyMinutes: Math.max(5, Number(everyMinutes) || 60) }
          : { type: "manual" },
      ...(capUsd.trim() ? { capUsd: Math.max(0.01, Number(capUsd) || 0) } : {}),
    }), t("managedAgents.created"));
    setName("");
    setInstructions("");
    setCapUsd("");
    setShowForm(false);
  };

  const submitBatch = async () => {
    const chosenBot = batchBotId || state.bots[0]?.id;
    const prompts = batchPrompts.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!chosenBot || prompts.length === 0) return;
    await act("batch", () => submitHostedBatch({ botId: chosenBot, prompts }), t("managedAgents.batchStarted"));
    setBatchPrompts("");
  };

  const handoff = payload?.handoff;
  const botName = (id: string) => state.bots.find((bot) => bot.id === id)?.name ?? id;
  const handoffChanged = async (preference: HandoffState["preference"]) => {
    await act("handoff", () => setHandoff(preference));
  };

  return (
    <ToolPage label={t("managedAgents.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={() => dispatch({ type: "showChat" })} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>{t("managedAgents.title")}</h1>
        <span className="text-[13px] text-ink-secondary">{t("managedAgents.subtitle")}</span>
        <ToolPageActions>
          <button type="button" className="ui-button ui-button-md" onClick={() => void load()} disabled={busy !== null}>
            <RefreshCw size={16} aria-hidden="true" />
            {t("managedAgents.reload")}
          </button>
          <button type="button" className="ui-button ui-button-md ui-button-primary" onClick={() => setShowForm((open) => !open)}>
            <Plus size={16} aria-hidden="true" />
            {t("managedAgents.new")}
          </button>
        </ToolPageActions>
      </ToolPageHeader>

      {error && <p role="status" className="mt-3 text-[13px] text-danger">{error}</p>}
      {notice && <p role="status" className="mt-3 text-[13px] text-ink-secondary">{notice}</p>}

      {handoff && (
        <section aria-label={t("managedAgents.handoff.title")} className="mt-4 rounded-xl border border-hairline p-4">
          <h2 className="text-[15px] font-medium text-ink">{t("managedAgents.handoff.title")}</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">
            {handoff.executor === "cloud"
              ? t("managedAgents.handoff.cloud")
              : t("managedAgents.handoff.local")}
            {handoff.note ? ` ${handoff.note}` : ""}
          </p>
          <label className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
            {t("managedAgents.handoff.label")}
            <Select
              aria-label={t("managedAgents.handoff.label")}
              value={handoff.preference}
              disabled={busy === "handoff"}
              onChange={(event) => void handoffChanged(event.target.value as HandoffState["preference"])}
            >
              <option value="auto">{t("managedAgents.handoff.auto")}</option>
              <option value="local">{t("managedAgents.handoff.localOption")}</option>
              <option value="cloud">{t("managedAgents.handoff.cloudOption")}</option>
            </Select>
          </label>
        </section>
      )}

      {showForm && (
        <section aria-label={t("managedAgents.new")} className="mt-4 rounded-xl border border-hairline p-4">
          <div className="grid gap-3">
            <label className="grid gap-1 text-[13px] text-ink-secondary">
              {t("managedAgents.field.name")}
              <input
                className="rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                value={name}
                onChange={(event) => setName(event.target.value)}
                dir="auto"
              />
            </label>
            <label className="grid gap-1 text-[13px] text-ink-secondary">
              {t("managedAgents.field.bot")}
              <Select aria-label={t("managedAgents.field.bot")} value={(botId || state.bots[0]?.id) ?? ""} onChange={(event) => setBotId(event.target.value)}>
                {state.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
              </Select>
            </label>
            <label className="grid gap-1 text-[13px] text-ink-secondary">
              {t("managedAgents.field.instructions")}
              <textarea
                className="min-h-20 rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                dir="auto"
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <label className="grid gap-1 text-[13px] text-ink-secondary">
                {t("managedAgents.field.schedule")}
                <Select aria-label={t("managedAgents.field.schedule")} value={schedule} onChange={(event) => setSchedule(event.target.value as "manual" | "daily" | "interval")}>
                  <option value="manual">{t("managedAgents.schedule.manual")}</option>
                  <option value="daily">{t("managedAgents.schedule.dailyOption")}</option>
                  <option value="interval">{t("managedAgents.schedule.intervalOption")}</option>
                </Select>
              </label>
              {schedule === "daily" && (
                <label className="grid gap-1 text-[13px] text-ink-secondary">
                  {t("managedAgents.field.time")}
                  <input
                    type="time"
                    className="rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                  />
                </label>
              )}
              {schedule === "interval" && (
                <label className="grid gap-1 text-[13px] text-ink-secondary">
                  {t("managedAgents.field.everyMinutes")}
                  <input
                    type="number"
                    min={5}
                    max={1440}
                    className="w-24 rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                    value={everyMinutes}
                    onChange={(event) => setEveryMinutes(event.target.value)}
                  />
                </label>
              )}
              <label className="grid gap-1 text-[13px] text-ink-secondary">
                {t("managedAgents.field.capUsd")}
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder={t("managedAgents.field.capNone")}
                  className="w-28 rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                  value={capUsd}
                  onChange={(event) => setCapUsd(event.target.value)}
                />
              </label>
            </div>
            <div>
              <button
                type="button"
                className="ui-button ui-button-md ui-button-primary"
                disabled={busy === "create" || !name.trim() || !instructions.trim()}
                onClick={() => void create()}
              >
                {t("managedAgents.create")}
              </button>
            </div>
          </div>
        </section>
      )}

      {!payload ? (
        <p className="mt-6 text-[13px] text-ink-secondary">{t("managedAgents.loading")}</p>
      ) : payload.agents.length === 0 ? (
        <p className="mt-6 text-[13px] text-ink-secondary">{t("managedAgents.empty")}</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {payload.agents.map(({ agent, lastRun, runs, failures }) => (
            <li key={agent.id} className="rounded-xl border border-hairline p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
                    <Bot size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
                    <span className="truncate">{agent.name}</span>
                    {!agent.enabled && <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-ink-secondary">{t("managedAgents.paused")}</span>}
                  </p>
                  <p className="mt-1 truncate text-[13px] text-ink-secondary" dir="auto">{botName(agent.botId)} · {scheduleLabel(agent)}</p>
                  <p className="mt-1 text-[12px] text-ink-tertiary">
                    {runLabel(lastRun)}
                    {agent.nextRunAt ? ` · ${t("managedAgents.nextRun", { when: new Date(agent.nextRunAt).toLocaleString() })}` : ""}
                    {runs > 0 ? ` · ${t("managedAgents.runs", { count: runs, failures })}` : ""}
                    {agent.capUsd !== undefined ? ` · ${t("managedAgents.cap", { amount: agent.capUsd.toFixed(2) })}` : ""}
                  </p>
                  {lastRun?.error && <p className="mt-1 text-[12px] text-danger" dir="auto">{lastRun.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className="ui-icon-button"
                    aria-label={t("managedAgents.runNow")}
                    title={t("managedAgents.runNow")}
                    disabled={!agent.enabled || busy === `run:${agent.id}`}
                    onClick={() => void act(`run:${agent.id}`, () => runManagedAgentNow(agent.id), t("managedAgents.runStarted"))}
                  >
                    <Play size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="ui-icon-button"
                    aria-label={agent.enabled ? t("managedAgents.pause") : t("managedAgents.resume")}
                    title={agent.enabled ? t("managedAgents.pause") : t("managedAgents.resume")}
                    disabled={busy === `toggle:${agent.id}`}
                    onClick={() => void act(`toggle:${agent.id}`, () => setManagedAgentEnabled(agent.id, !agent.enabled))}
                  >
                    {agent.enabled ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    className="ui-icon-button"
                    aria-label={t("managedAgents.delete")}
                    title={t("managedAgents.delete")}
                    disabled={busy === `delete:${agent.id}`}
                    onClick={() => void act(`delete:${agent.id}`, () => deleteManagedAgent(agent.id))}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section aria-label={t("managedAgents.sessions.title")} className="mt-6">
        <h2 className="text-[15px] font-medium text-ink">{t("managedAgents.sessions.title")}</h2>
        {sessions.length === 0 ? (
          <p className="mt-1 text-[13px] text-ink-secondary">{t("managedAgents.sessions.empty")}</p>
        ) : (
          <ul className="mt-2 grid gap-2">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center gap-2 text-[13px] text-ink-secondary">
                {session.state === "pr-open" ? <Cloud size={14} aria-hidden="true" /> : <Laptop size={14} aria-hidden="true" />}
                <span className="truncate">{session.branch}</span>
                <span className="shrink-0 text-ink-tertiary">{sessionStateLabel(session.state)}</span>
                {session.prUrl && <a className="shrink-0 text-accent-text" href={session.prUrl} target="_blank" rel="noreferrer">{t("managedAgents.sessions.pr")}</a>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t("managedAgents.batches.title")} className="mt-6">
        <h2 className="text-[15px] font-medium text-ink">{t("managedAgents.batches.title")}</h2>
        <div className="mt-2 grid gap-2">
          <label className="grid gap-1 text-[13px] text-ink-secondary">
            {t("managedAgents.batches.bot")}
            <Select aria-label={t("managedAgents.batches.bot")} value={(batchBotId || state.bots[0]?.id) ?? ""} onChange={(event) => setBatchBotId(event.target.value)}>
              {state.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </Select>
          </label>
          <label className="grid gap-1 text-[13px] text-ink-secondary">
            {t("managedAgents.batches.prompts")}
            <textarea
              className="min-h-20 rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
              value={batchPrompts}
              onChange={(event) => setBatchPrompts(event.target.value)}
              dir="auto"
              placeholder={t("managedAgents.batches.promptsPlaceholder")}
            />
          </label>
          <div>
            <button
              type="button"
              className="ui-button ui-button-md"
              disabled={busy === "batch" || !batchPrompts.trim()}
              onClick={() => void submitBatch()}
            >
              {t("managedAgents.batches.submit")}
            </button>
          </div>
        </div>
        {batches.length > 0 && (
          <ul className="mt-3 grid gap-2">
            {batches.slice(0, 5).map((batch) => (
              <li key={batch.id} className="text-[13px] text-ink-secondary">
                {t("managedAgents.batches.row", {
                  done: batch.results.filter((result) => result.status === "done").length,
                  failed: batch.results.filter((result) => result.status === "failed").length,
                  total: batch.prompts.length,
                })}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t("managedAgents.usage.title")} className="mt-6">
        <h2 className="text-[15px] font-medium text-ink">{t("managedAgents.usage.title")}</h2>
        {report ? (
          <p className="mt-1 text-[13px] text-ink-secondary">
            {t("managedAgents.usage.summary", {
              input: report.totalInputTokens.toLocaleString("en-US"),
              output: report.totalOutputTokens.toLocaleString("en-US"),
              cost: report.totalCostUsd === null ? t("managedAgents.usage.unpriced") : `$${report.totalCostUsd.toFixed(2)}`,
            })}
          </p>
        ) : (
          <p className="mt-1 text-[13px] text-ink-secondary">{t("managedAgents.usage.empty")}</p>
        )}
        <a href={cloudUsageCsvUrl()} download className="ui-button ui-button-md mt-2 inline-flex">
          <Download size={16} aria-hidden="true" />
          {t("managedAgents.usage.download")}
        </a>
      </section>

      <p className="mt-6 text-[12px] text-ink-tertiary">{t("managedAgents.note")}</p>
    </ToolPage>
  );
}
