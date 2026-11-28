import { useEffect, useState } from "react";
import type { InboxRow, InboxView } from "../../shared/inbox";
import type { NeedsYouItem } from "../../shared/today";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";
import { sameJson } from "@/state/same-json";
import { markAllInboxRead, openInbox, readInboxRow, useInboxMarkingAll, useInboxReady, useInboxSupport, useInboxView } from "@/state/inbox";
import { useTeamPeople } from "@/state/team-people";
import { inboxAttentionEntries, inboxOpenThread } from "./inbox/InboxActive";
import { inboxFixes, rowsIn } from "./inbox/inbox-view";
import { useInboxActions, useInboxJump } from "./inbox/use-inbox-actions";
import { InboxRowItem } from "./inbox/InboxRow";
import { AttentionThreadRows, type AttentionThread } from "./SidebarBotActivity";
import { NeedsYouLine } from "./TeamOwner";

export interface NeedsYouPageItems {
  rows: InboxRow[];
  fixes: NeedsYouItem[];
  attention: AttentionThread[];
}

/** The page's three lists as one: the asks waiting on the person, newest first; a team's fixes; and the
 * conversations at work, without a conversation the fixes already list. */
export function needsYouPageItems(view: InboxView | null, fixes: NeedsYouItem[], attention: readonly AttentionThread[]): NeedsYouPageItems {
  const rows = rowsIn(view, "needs-you").sort((a, b) => b.at - a.at);
  const fixed = new Set(fixes.map((item) => item.threadId).filter((threadId): threadId is string => threadId !== undefined));
  return { rows, fixes, attention: attention.filter((entry) => !fixed.has(entry.task.threadId)) };
}

/** The approvals, questions and fixes waiting on the person, and the conversations at work: each row shows its
 * action and context, and opens where it is answered. */
export function NeedsYouPage() {
  const { dispatch } = useStore();
  const view = useInboxView();
  const support = useInboxSupport();
  const ready = useInboxReady();
  const markingAll = useInboxMarkingAll();
  const team = useTeamPeople();
  const { run } = useInboxActions(view);
  const jump = useInboxJump();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const entries = useStoreSelector((state) => inboxAttentionEntries(state, view), sameJson);
  const current = useStoreSelector((state) => inboxOpenThread(state), sameJson);
  const { rows, fixes, attention } = needsYouPageItems(view, inboxFixes(team?.needsYou, view), entries);
  const loading = !ready && support !== "no";
  const empty = !loading && rows.length === 0 && fixes.length === 0 && attention.length === 0;
  const anyUnread = (view?.rows ?? []).some((row) => row.unread);
  const open = (row: InboxRow) => {
    readInboxRow(row);
    openInbox({ reading: row.id });
  };
  return (
    <main data-needs-you-page className="min-w-0 flex-1 overflow-y-auto bg-app">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
        <header className="flex items-start justify-between gap-3">
          <h1 className="text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink">{t("needsYou.title")}</h1>
          {anyUnread && (
            <button type="button" data-needs-you-mark-all onClick={markAllInboxRead} disabled={markingAll}
              className="mt-1 inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-1 text-[12px] text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50 disabled:hover:no-underline touch:min-h-10 touch:px-2">
              {t("inbox.markAllRead")}
            </button>
          )}
        </header>
        {loading ? (
          <p role="status" className="text-[13px] leading-[18px] text-ink-secondary">{t("needsYouPage.loading")}</p>
        ) : empty ? (
          <div className="flex flex-col items-start gap-3">
            <p role="status" className="text-[13px] leading-[18px] text-ink-secondary">{t("needsYouPage.empty")}</p>
            <button type="button" className="ui-button touch:min-h-10" onClick={() => dispatch({ type: "showChat" })}>{t("needsYouPage.emptyAction")}</button>
          </div>
        ) : (
          <>
            {(rows.length > 0 || fixes.length > 0) && (
              <section aria-label={t("needsYou.title")}>
                <div role="list" aria-live="polite" data-needs-you-list className="flex flex-col gap-0.5">
                  {rows.map((row) => <InboxRowItem key={row.id} row={row} now={now} onOpen={open} onAction={run} />)}
                  {fixes.map((item) => <NeedsYouLine key={`${item.kind}:${item.id}`} item={item} />)}
                </div>
              </section>
            )}
            {attention.length > 0 && (
              <section aria-label={t("needsYouPage.activeThreads")}>
                <h2 className="text-[17px] font-semibold leading-6 text-ink">{t("needsYouPage.activeThreads")}</h2>
                <div className="mt-2 flex flex-col">
                  <AttentionThreadRows entries={attention} unreadDot current={current} onJump={jump} />
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
