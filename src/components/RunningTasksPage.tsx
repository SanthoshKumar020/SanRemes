import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Pause, RefreshCw, Square } from "lucide-react";

import { useStoreDispatch } from "@/state/store-select";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { formatElapsed } from "@/lib/working-time";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageActions, ToolPageHeader } from "./ToolPageShell";
import { fetchRunning, pauseBot, stopBotWork, type RunningTaskRow } from "@/lib/running-tasks";

/** Everything working right now, in one list: what it is, whose it is, since when, and how to stop it. */
export function RunningTasksPage() {
  const dispatch = useStoreDispatch();
  const [rows, setRows] = useState<RunningTaskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const loadAbort = useRef<AbortController | null>(null);

  const kindLabel = (kind: RunningTaskRow["kind"]) => t(`running.kind.${kind}`);
  const stateLabel = (state: RunningTaskRow["state"]) => t(`running.state.${state}`);

  const load = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    try {
      const payload = await fetchRunning();
      if (controller.signal.aborted) return;
      setRows(payload.rows);
      setNow(payload.now);
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
    const poll = setInterval(() => void load(), 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
      loadAbort.current?.abort();
    };
  }, [load]);

  const act = async (row: RunningTaskRow, action: "stop" | "pause") => {
    setBusy(`${action}:${row.id}`);
    setError(null);
    try {
      if (action === "stop") await stopBotWork(row.botId);
      else await pauseBot(row.botId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const jump = (row: RunningTaskRow) => {
    if (row.threadId) dispatch({ type: "switchTask", botId: row.botId, threadId: row.threadId });
  };

  return (
    <ToolPage label={t("running.title")}>
      <ToolPageHeader backLabel={t("automations.back")} onBack={() => dispatch({ type: "showChat" })} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>{t("running.title")}</h1>
        <span className="text-[13px] text-ink-secondary">{t("running.subtitle")}</span>
        <ToolPageActions>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title={t("running.reload")}
            aria-label={t("running.reload")}
          >
            <RefreshCw size={14} />
          </button>
        </ToolPageActions>
      </ToolPageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error && (
          <div role="alert" className="mb-3 rounded-xl border border-hairline/60 bg-card px-3.5 py-3 text-[13px] text-danger">
            {t("running.error", { message: error })}
          </div>
        )}
        {rows === null && !error && <p className="py-6 text-[13px] text-ink-secondary">{t("running.loading")}</p>}
        {rows !== null && rows.length === 0 && !error && (
          <p className="py-6 text-[13px] text-ink-secondary">{t("running.empty")}</p>
        )}
        {rows !== null && rows.length > 0 && (
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li key={row.id} className="rounded-xl border border-hairline/60 bg-card px-3.5 py-3">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex shrink-0 items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
                    <Activity size={12} aria-hidden="true" />
                    {kindLabel(row.kind)}
                  </span>
                  <button
                    type="button"
                    onClick={() => jump(row)}
                    disabled={!row.threadId}
                    className={cn("min-w-0 flex-1 text-left", row.threadId && "hover:underline")}
                    title={row.threadId ? t("running.openChat") : undefined}
                  >
                    <span className="block truncate text-[13px] font-medium text-ink">{row.title}</span>
                    <span className="mt-0.5 block truncate text-[12px] text-ink-secondary">
                      {row.botName ?? row.botId}
                      {row.detail ? ` · ${row.detail}` : ""}
                      {` · ${t("running.runningFor", { elapsed: formatElapsed(now - row.startedAt) })}`}
                    </span>
                  </button>
                  <span className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary">
                    {stateLabel(row.state)}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void act(row, "stop")}
                      disabled={busy !== null}
                      className="ui-button ui-button-sm shrink-0"
                      title={t("running.stopHint", { name: row.botName ?? row.botId })}
                    >
                      {busy === `stop:${row.id}` ? t("running.stopping") : <><Square size={13} aria-hidden="true" /> {t("running.stop")}</>}
                    </button>
                    <button
                      type="button"
                      onClick={() => void act(row, "pause")}
                      disabled={busy !== null}
                      className="ui-button ui-button-sm shrink-0"
                      title={t("running.pauseHint", { name: row.botName ?? row.botId })}
                    >
                      {busy === `pause:${row.id}` ? t("running.pausing") : <><Pause size={13} aria-hidden="true" /> {t("running.pause")}</>}
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ToolPage>
  );
}
