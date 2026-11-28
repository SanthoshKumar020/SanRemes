import { useMemo, useState } from "react";
import { Check, ChevronRight, Inbox, MessageSquarePlus, Monitor, Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import { useShowThreads } from "@/lib/thread-preferences";
import { api, openBot, openThread, useStore, type Bot as StoreBot } from "@/state/store";
import { openInbox, useInboxSupport, useInboxView } from "@/state/inbox";
import { refreshNeedsYou, useTeamPeople } from "@/state/team-people";
import type { LocaleKey } from "@/locales";

export interface RecentConversation {
  botId: string;
  threadId: string;
  title: string;
  detail: string;
  at: number;
}

export function recentConversations(bots: readonly StoreBot[], limit = 5): RecentConversation[] {
  const rows: RecentConversation[] = [];
  for (const bot of bots) {
    if (bot.hidden) continue;
    const lastMessage = bot.messages[bot.messages.length - 1];
    if (lastMessage) {
      rows.push({
        botId: bot.id,
        threadId: bot.threadId,
        title: bot.name,
        detail: (lastMessage.text ?? "").split("\n")[0] ?? "",
        at: lastMessage.at,
      });
    }
    for (const task of bot.tasks ?? []) {
      if (task.archivedAt !== undefined || task.threadId === bot.threadId) continue;
      rows.push({
        botId: bot.id,
        threadId: task.threadId,
        title: task.title,
        detail: bot.name,
        at: task.updatedAt ?? task.lastThreadOrderAt ?? task.createdAt ?? 0,
      });
    }
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, limit);
}

export interface GuideSteps {
  bot: boolean;
  model: boolean;
  message: boolean;
}

export function guideSteps(bots: readonly StoreBot[], instances: ReadonlyArray<{ snapshot: { state: string } }>): GuideSteps {
  return {
    bot: bots.some((bot) => !bot.hidden),
    model: instances.some((instance) => instance.snapshot.state === "available"),
    message: bots.some((bot) => bot.messages.some((message) => message.role === "user")),
  };
}

const HOME_GUIDE_DISMISSED_KEY = "sanremes-home-guide-dismissed";

export function homeGuideDismissed(): boolean {
  try {
    return globalThis.localStorage?.getItem(HOME_GUIDE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function dismissHomeGuide(): void {
  try {
    globalThis.localStorage?.setItem(HOME_GUIDE_DISMISSED_KEY, "1");
  } catch {
  }
}

type GreetingKey = "home.greeting.morning" | "home.greeting.afternoon" | "home.greeting.evening";

function greetingKey(hour: number): GreetingKey {
  return hour < 12 ? "home.greeting.morning" : hour < 18 ? "home.greeting.afternoon" : "home.greeting.evening";
}

const BOT_STATUS: Record<NonNullable<StoreBot["activity"]> | "idle", { key: LocaleKey; dot: string }> = {
  working: { key: "home.bots.working", dot: "bg-success" },
  "waiting-on-you": { key: "home.bots.waiting", dot: "bg-warning" },
  idle: { key: "home.bots.idle", dot: "bg-ink-tertiary" },
  "no-signal": { key: "home.bots.noSignal", dot: "bg-warning" },
  dead: { key: "home.bots.dead", dot: "bg-danger" },
  "parked.computer": { key: "home.bots.parked", dot: "bg-ink-tertiary" },
};

export function HomeDashboard() {
  const { state, dispatch } = useStore();
  const team = useTeamPeople();
  const inbox = useInboxView();
  const inboxSupport = useInboxSupport();
  const showThreads = useShowThreads();
  const [guideDismissed, setGuideDismissed] = useState(homeGuideDismissed);
  const bots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const selected = bots.find((bot) => bot.id === state.selectedId) ?? bots[0] ?? null;
  const recent = useMemo(() => recentConversations(state.bots), [state.bots]);
  const steps = useMemo(() => guideSteps(state.bots, state.instances), [state.bots, state.instances]);
  const guideDone = steps.bot && steps.model && steps.message;
  const needs = team?.needsYou ?? [];
  const attention = needs[0] ?? null;
  const attentionRow = !attention ? (inbox?.rows.find((row) => row.tab === "needs-you") ?? null) : null;

  const newChat = () => {
    if (selected && selected.yourAccess !== "view") dispatch({ type: "newTask", botId: selected.id });
    else dispatch({ type: "newBot" });
  };
  const openRecent = (row: RecentConversation) => {
    const bot = state.bots.find((candidate) => candidate.id === row.botId);
    if (!bot) return;
    if (row.threadId === bot.threadId) openBot(dispatch, bot, showThreads);
    else openThread(dispatch, { botId: bot.id, threadId: row.threadId }, state, showThreads);
  };
  const openAttention = () => {
    if (attentionRow) {
      openInbox({ reading: attentionRow.id });
      return;
    }
    if (!attention?.threadId) {
      openInbox();
      return;
    }
    const botId = "botId" in attention ? attention.botId : attention.botIds[0]!;
    openThread(dispatch, { botId, threadId: attention.threadId }, state, showThreads);
    if (attention.kind === "message") {
      const group = state.groups.find((one) => one.threadId === attention.threadId || one.tasks?.some((task) => task.threadId === attention.threadId));
      void (group
        ? api(`/api/groups/${group.id}/read`, { method: "POST", body: JSON.stringify({ threadId: attention.threadId }) })
        : api(`/api/bots/${botId}/read`, { method: "POST", body: JSON.stringify({ threadId: attention.threadId }) }))
        .then(() => refreshNeedsYou())
        .catch(() => {});
    }
  };

  const attentionBotName = attention
    ? state.bots.find((bot) => bot.id === ("botId" in attention ? attention.botId : attention.botIds[0]!))?.name ?? t("needsYou.aBot")
    : "";
  const attentionTitle = attention
    ? attention.kind === "message"
      ? t("needsYou.message", { name: attention.from })
      : attention.kind === "question"
        ? t("needsYou.asking", { bot: attentionBotName })
        : t("needsYou.fix", { bot: attentionBotName })
    : attentionRow?.text ?? "";
  const attentionText = attention && "text" in attention ? attention.text : "";
  const guideItems: Array<{ key: LocaleKey; done: boolean }> = [
    { key: "home.guide.createBot", done: steps.bot },
    { key: "home.guide.connectModel", done: steps.model },
    { key: "home.guide.sendMessage", done: steps.message },
  ];

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-app">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
        <header>
          <h1 className="text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink">{t(greetingKey(new Date().getHours()))}</h1>
          <p className="mt-1 text-[15px] leading-[22px] text-ink-secondary">{t("home.question")}</p>
        </header>

        <div data-home-section="actions" className="flex flex-wrap gap-2">
          <button type="button" className="ui-button ui-button-primary ui-button-pill" onClick={newChat}>
            <MessageSquarePlus size={16} aria-hidden="true" />
            {t("home.newChat")}
          </button>
          <button type="button" className="ui-button ui-button-pill" onClick={() => dispatch({ type: "newBot" })}>
            <Plus size={16} aria-hidden="true" />
            {t("home.createBot")}
          </button>
          <button type="button" className="ui-button ui-button-pill" disabled={!selected} title={!selected ? t("home.openComputer.noBot") : undefined}
            onClick={() => selected && dispatch({ type: "toggleComputer", open: true, botId: selected.id })}>
            <Monitor size={16} aria-hidden="true" />
            {t("home.openComputer")}
          </button>
          {inboxSupport !== "no" && (
            <button type="button" className="ui-button ui-button-pill" onClick={() => openInbox()}>
              <Inbox size={16} aria-hidden="true" />
              {t("home.checkApprovals")}
            </button>
          )}
        </div>

        <section data-home-section="recent" aria-label={t("home.recent.title")}>
          <h2 className="text-[17px] font-semibold leading-6 text-ink">{t("home.recent.title")}</h2>
          {recent.length === 0 ? (
            <div className="mt-3 flex flex-col items-start gap-3">
              <p className="text-[13px] leading-[18px] text-ink-secondary">{t("home.recent.empty")}</p>
              <button type="button" className="ui-button" onClick={newChat}>{t("home.newChat")}</button>
            </div>
          ) : (
            <ul className="mt-2 flex flex-col">
              {recent.map((row) => (
                <li key={`${row.botId}:${row.threadId}`}>
                  <button type="button" onClick={() => openRecent(row)}
                    className="flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-ink/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium leading-[18px] text-ink">{row.title}</span>
                      <span className="block truncate text-[12px] leading-4 text-ink-secondary">
                        {row.detail}{row.at > 0 ? ` · ${relativeTime(row.at)}` : ""}
                      </span>
                    </span>
                    <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary rtl:-scale-x-100" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section data-home-section="bots" aria-label={t("home.bots.title")}>
          <h2 className="text-[17px] font-semibold leading-6 text-ink">{t("home.bots.title")}</h2>
          {bots.length === 0 ? (
            <div className="mt-3 flex flex-col items-start gap-3">
              <p className="text-[13px] leading-[18px] text-ink-secondary">{t("home.bots.empty")}</p>
              <button type="button" className="ui-button" onClick={() => dispatch({ type: "newBot" })}>{t("home.createBot")}</button>
            </div>
          ) : (
            <ul className="mt-2 flex flex-col">
              {bots.map((bot) => {
                const status = BOT_STATUS[bot.activity ?? "idle"];
                return (
                  <li key={bot.id}>
                    <button type="button" onClick={() => openBot(dispatch, bot, showThreads)}
                      className="flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-ink/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
                      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", status.dot)} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-[18px] text-ink">{bot.name}</span>
                      <span className="shrink-0 text-[12px] leading-4 text-ink-secondary">{t(status.key)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {(attention || attentionRow) && (
          <section data-home-section="attention" aria-label={t("home.attention.title")} className="rounded-xl border border-hairline bg-card p-4">
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-warning" />
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold leading-[22px] text-ink">{t("home.attention.title")}</h2>
                <p className="mt-0.5 truncate text-[13px] leading-[18px] text-ink">{attentionTitle}</p>
                {attentionText && <p className="mt-0.5 truncate text-[13px] leading-[18px] text-ink-secondary">{attentionText}</p>}
              </div>
              <button type="button" className="ui-button shrink-0" onClick={openAttention}>
                {t(attentionRow || !attention?.threadId ? "home.attention.openInbox" : "home.attention.openConversation")}
              </button>
            </div>
          </section>
        )}

        {!guideDone && !guideDismissed && (
          <section data-home-section="guide" aria-label={t("home.guide.title")} className="rounded-xl border border-hairline bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[17px] font-semibold leading-6 text-ink">{t("home.guide.title")}</h2>
              <button type="button" aria-label={t("home.guide.dismiss")} title={t("home.guide.dismiss")}
                onClick={() => { dismissHomeGuide(); setGuideDismissed(true); }}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-ink/[0.06] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <ul className="mt-3 flex flex-col gap-2">
              {guideItems.map((item) => (
                <li key={item.key} className="flex items-center gap-2.5">
                  {item.done
                    ? <span className="flex size-4 shrink-0 items-center justify-center"><Check size={14} aria-hidden="true" className="text-ink-secondary" /></span>
                    : <span aria-hidden="true" className="size-4 shrink-0 rounded-full border border-ink-tertiary" />}
                  <span className={cn("text-[13px] leading-[18px]", item.done ? "text-ink-secondary" : "text-ink")}>{t(item.key)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
