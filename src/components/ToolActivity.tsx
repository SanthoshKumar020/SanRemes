import { Check, ChevronRight, Circle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/state/api";
import type { Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { placeLabelKey, type Place } from "@/lib/place";
import { nameIsCommand } from "@/lib/verify-steps";
import { useAdvancedMode } from "@/lib/interface-mode";
import { toolStepLabel } from "@/lib/tool-step-label";
import { isNoticeCode, routineLineText } from "@/lib/activity-text";
import type { MessageAttachmentContext } from "./AttachmentPreview";
import { LINK_CLASS } from "./ChatLinks";
import { PlaceIcon } from "./PlaceIcon";
import { WorkingDots } from "./WorkingIndicator";

/** One cited page, as a research tool's trailing Sources block names it. */
interface CitedSource {
  url: string;
  title: string;
  fetchedAt: number;
}

const SOURCE_LINE = /^(\d+)\.\s+(.+?)\s+—\s+(https?:\/\/\S+?)(?:\s+\(fetched\s+(\d{4}-\d{2}-\d{2})\))?$/;

/** A tool result's trailing Sources block, split into its body and its cited pages; anything else is left alone. */
function splitSourcesBlock(output: string | undefined): { body: string | undefined; sources: CitedSource[] } {
  if (!output) return { body: output, sources: [] };
  const lines = output.split("\n");
  const at = lines.lastIndexOf("Sources");
  if (at < 0 || at === lines.length - 1) return { body: output, sources: [] };
  const sources: CitedSource[] = [];
  for (const line of lines.slice(at + 1)) {
    const match = SOURCE_LINE.exec(line.trim());
    if (!match) return { body: output, sources: [] };
    sources.push({
      title: match[2]!,
      url: match[3]!,
      fetchedAt: match[4] ? Date.parse(`${match[4]}T00:00:00Z`) : 0,
    });
  }
  if (!sources.length) return { body: output, sources: [] };
  return { body: lines.slice(0, at).join("\n").replace(/\s+$/, ""), sources };
}

function sourceDay(at: number): string {
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString().slice(0, 10) : "";
}

/** Which stored message a step is: a clipped step (its output cut short in conversation pages) loads the rest from it. */
export function ToolActivity({ tool, place = null, live = false, source }: { tool: NonNullable<Message["tool"]>; place?: Place | null; live?: boolean; source?: MessageAttachmentContext }) {
  const [expanded, setExpanded] = useState(false);
  const full = useFullOutput(expanded && tool.clipped ? source : undefined, tool.output);
  const output = full.output ?? tool.output;
  const { body, sources } = splitSourcesBlock(output);
  const failed = tool.ok === false;
  const advanced = useAdvancedMode();
  const notice = isNoticeCode(tool.nameCode);
  const summary = routineLineText(tool.summaryCode, tool.summary ?? "", tool.summaryParams);
  const problem = failed ? tool.problem : undefined;
  const label = problem ?? (advanced && !notice ? tool.label ?? tool.name : toolStepLabel(tool));
  const status = tool.ok === undefined ? (live ? t("toolDetail.running") : t("toolDetail.unverified")) : failed ? t("toolDetail.failed") : t("toolDetail.completed");
  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)} className="group/tool w-fit max-w-full rounded-xl border border-hairline/40 bg-panel text-[13px] open:w-[min(38rem,100%)]" data-testid="tool-activity">
      <summary
        role="button"
        aria-expanded={expanded}
        aria-label={t("toolDetail.label", { name: label, status })}
        className={cn("flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-1.5 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden", failed ? "text-danger" : "text-ink-secondary")}
      >
        <span className="shrink-0" aria-hidden="true">{tool.ok === undefined ? (live ? <WorkingDots size={3.5} /> : <Circle size={13} />) : failed ? <X size={13} /> : <Check size={13} className="text-success" />}</span>
        {place && <PlaceIcon place={place} size={13} className="shrink-0 opacity-70" role="img" aria-label={t(placeLabelKey(place))} data-testid="tool-place" />}
        <span className={cn("min-w-0 max-w-[30rem]", !problem && "truncate", "leading-5", advanced && !notice && !problem ? "font-mono" : "font-medium")}>{label}</span>
        {advanced && tool.summary && tool.summary !== tool.name && !nameIsCommand(tool.name) && <span className="min-w-0 flex-1 truncate font-mono" title={summary}>{summary}</span>}
        <ChevronRight size={13} className="ml-auto shrink-0 group-open/tool:rotate-90" aria-hidden="true" />
      </summary>
      <div className="space-y-3 border-t border-hairline/40 p-3 text-ink-secondary">
        <div className={cn("text-[12px] font-medium", failed && "text-danger")}>{status}</div>
        {label !== tool.name && !notice && <div>
          <div className="mb-1 text-[12px] font-medium">{t("toolDetail.tool")}</div>
          <p dir="ltr" className="break-words font-mono text-xs text-ink" data-testid="tool-name">{tool.name}</p>
        </div>}
        <div>
          <div className="mb-1 text-[12px] font-medium">{t("toolDetail.input")}</div>
          <pre dir="ltr" className="max-h-52 overflow-auto rounded-lg bg-inset p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-ink">{tool.input ?? (tool.summary ? summary : notice ? label : tool.name)}</pre>
        </div>
        <div>
          <div className="mb-1 text-[12px] font-medium">{t("toolDetail.output")}</div>
          {body ? <pre dir="ltr" className="max-h-64 overflow-auto rounded-lg bg-inset p-2.5 font-mono text-xs whitespace-pre-wrap break-words text-ink">{body}</pre> : <p className="text-xs">{tool.ok === undefined ? (live ? t("toolDetail.waiting") : t("toolDetail.unverified")) : t("toolDetail.noOutput")}</p>}
        </div>
        {sources.length > 0 && <div>
          <div className="mb-1 text-[12px] font-medium">{t("toolDetail.sources")}</div>
          <ol className="list-decimal space-y-1 ps-5 text-xs">
            {sources.map((cited, index) => (
              <li key={`${cited.url}#${index}`}>
                <a href={cited.url} className={LINK_CLASS}>{cited.title || cited.url}</a>
                {sourceDay(cited.fetchedAt) && <span className="text-ink-tertiary"> · {t("toolDetail.sourceFetched", { date: sourceDay(cited.fetchedAt) })}</span>}
              </li>
            ))}
          </ol>
        </div>}
        {(full.state === "loading" || full.state === "failed") && <p className="text-[12px] text-ink-secondary" role="status">{t(full.state === "loading" ? "toolDetail.loadingFull" : "toolDetail.partial")}</p>}
        <p className="text-[12px] text-ink-secondary">{t("toolDetail.previewHint")}</p>
      </div>
    </details>
  );
}

type FullOutput = { state: "idle" | "loading" | "done" | "failed"; output?: string };

/** The whole output of a clipped step, fetched when it is opened: kept once it arrives, asked again after a failure. */
function useFullOutput(source: MessageAttachmentContext | undefined, preview: string | undefined): FullOutput {
  const url = source && `/api/threads/${encodeURIComponent(source.threadId)}/messages/${encodeURIComponent(source.messageId)}/tool`;
  const key = url && `${url}#${preview?.length ?? 0}`;
  const [full, setFull] = useState<FullOutput & { key?: string }>({ state: "idle" });
  const have = full.key === key && full.state === "done";
  useEffect(() => {
    if (!url || have) return;
    let current = true;
    const abort = new AbortController();
    setFull({ state: "loading", key });
    api<{ output: string }>(url, { signal: abort.signal })
      .then((body) => { if (current) setFull({ state: "done", key, output: body.output }); })
      .catch(() => { if (current) setFull({ state: "failed", key }); });
    return () => { current = false; abort.abort(); };
  }, [url, key, have]);
  return full.key === key ? full : { state: "idle" };
}
