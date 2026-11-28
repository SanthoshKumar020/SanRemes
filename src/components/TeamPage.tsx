import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import type { LocaleKey } from "@/locales";
import { useStore, type Bot } from "@/state/store";
import { departmentNames } from "./bot-sections";
import { BotAvatar } from "./Avatar";
import { botModel } from "./BotModelBadge";
import { openBotSettings } from "./bot-panel/panel-link";
import { Select } from "./Select";

export type TeamStatusFilter = "active" | "all";

export interface TeamFilters {
  status: TeamStatusFilter;
  workspace: string;
}

const NO_WORKSPACE = "__none__";

const BOT_STATUS: Record<NonNullable<Bot["activity"]> | "idle", { key: LocaleKey; dot: string }> = {
  working: { key: "home.bots.working", dot: "bg-success" },
  "waiting-on-you": { key: "home.bots.waiting", dot: "bg-warning" },
  idle: { key: "home.bots.idle", dot: "bg-ink-tertiary" },
  "no-signal": { key: "home.bots.noSignal", dot: "bg-warning" },
  dead: { key: "home.bots.dead", dot: "bg-danger" },
  "parked.computer": { key: "home.bots.parked", dot: "bg-ink-tertiary" },
};

export function isBotActive(bot: Pick<Bot, "activity">): boolean {
  const activity = bot.activity ?? "idle";
  return activity === "working" || activity === "waiting-on-you" || activity === "idle";
}

export function botLastActiveAt(bot: Pick<Bot, "messages" | "tasks">): number | null {
  let at = 0;
  for (const message of bot.messages ?? []) at = Math.max(at, message.at ?? 0);
  for (const task of bot.tasks ?? []) at = Math.max(at, task.updatedAt ?? task.lastThreadOrderAt ?? task.createdAt ?? 0);
  return at > 0 ? at : null;
}

export function filterTeamBots(bots: readonly Bot[], filters: TeamFilters): Bot[] {
  return bots.filter((bot) => {
    if (filters.status === "active" && !isBotActive(bot)) return false;
    if (filters.workspace === NO_WORKSPACE) return !bot.section;
    if (filters.workspace !== "") return bot.section === filters.workspace;
    return true;
  });
}

export function TeamPage() {
  const { state, dispatch } = useStore();
  const [status, setStatus] = useState<TeamStatusFilter>("active");
  const [workspace, setWorkspace] = useState("");
  const bots = useMemo(() => state.bots.filter((bot) => !bot.hidden), [state.bots]);
  const workspaces = departmentNames(state);
  const shown = useMemo(() => filterTeamBots(bots, { status, workspace }), [bots, status, workspace]);
  const clearFilters = () => {
    setStatus("active");
    setWorkspace("");
  };

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-app">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
        <header className="flex items-center justify-between gap-3">
          <h1 className="text-[20px] font-semibold leading-7 tracking-[-0.01em] text-ink">{t("team.title")}</h1>
          <button type="button" className="ui-button ui-button-primary ui-button-pill touch:min-h-10" onClick={() => dispatch({ type: "newBot" })}>
            <Plus size={16} aria-hidden="true" />
            {t("sidebar.newBot")}
          </button>
        </header>

        <div className="flex flex-wrap gap-2">
          <Select variant="pill" size="sm" aria-label={t("team.filter.status")} value={status}
            onChange={(event) => setStatus(event.currentTarget.value as TeamStatusFilter)}>
            <option value="active">{t("team.filter.statusActive")}</option>
            <option value="all">{t("team.filter.statusAll")}</option>
          </Select>
          <Select variant="pill" size="sm" aria-label={t("team.filter.workspace")} value={workspace}
            onChange={(event) => setWorkspace(event.currentTarget.value)}>
            <option value="">{t("team.filter.allWorkspaces")}</option>
            {workspaces.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
            <option value={NO_WORKSPACE}>{t("team.filter.noWorkspace")}</option>
          </Select>
        </div>

        <section aria-label={t("team.title")}>
          {shown.length === 0 ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-[13px] leading-[18px] text-ink-secondary">
                {t(bots.length === 0 ? "home.bots.empty" : "team.emptyFiltered")}
              </p>
              {bots.length === 0 ? (
                <button type="button" className="ui-button touch:min-h-10" onClick={() => dispatch({ type: "newBot" })}>{t("sidebar.newBot")}</button>
              ) : (
                <button type="button" className="ui-button touch:min-h-10" onClick={clearFilters}>{t("team.clearFilters")}</button>
              )}
            </div>
          ) : (
            <ul className="flex flex-col">
              {shown.map((bot) => {
                const botStatus = BOT_STATUS[bot.activity ?? "idle"];
                const model = botModel(bot, state.instances);
                const lastActive = botLastActiveAt(bot);
                const meta = [
                  model?.label ?? "",
                  lastActive ? t("team.lastActive", { time: relativeTime(lastActive) }) : "",
                ].filter(Boolean).join(" · ");
                return (
                  <li key={bot.id}>
                    <button type="button" onClick={() => openBotSettings(dispatch, "overview", { botId: bot.id })}
                      className="flex w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-ink/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
                      <BotAvatar bot={bot} size={36} />
                      <span className="min-w-0 flex-1">
                        <span dir="auto" className="block truncate text-[13px] font-medium leading-[18px] text-ink">{bot.name}</span>
                        {meta && (
                          <span className="block truncate text-[12px] leading-4 text-ink-secondary">{meta}</span>
                        )}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span aria-hidden="true" className={cn("size-2 rounded-full", botStatus.dot)} />
                        <span className="text-[12px] leading-4 text-ink-secondary">{t(botStatus.key)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
