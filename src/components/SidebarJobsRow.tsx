// The Jobs row at the top of the sidebar in Simple mode only: the footer Tools list returns null there, so without
// this row Jobs would have no way in. Advanced mode and the icons column reach it through the footer nav instead.
// A dot marks setup still to do: no bot filed under the Jobs section yet.
import { Briefcase } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useFeature } from "@/lib/use-feature";
import { useStore } from "@/state/store";

export function SidebarJobsRow({ icons, large, simple, onOpened }: {
  icons: boolean;
  large: boolean;
  simple: boolean;
  onOpened?: () => void;
}) {
  const jobBot = useFeature("jobBot");
  const { state, dispatch } = useStore();
  if (!simple || !jobBot) return null;
  const active = state.activeView === "jobs";
  const setupDone = state.bots.some((bot) => bot.section === "Jobs");
  const label = t("sidebar.nav.jobs");
  const open = () => {
    dispatch({ type: "showJobs" });
    onOpened?.();
  };
  const dot = !setupDone && <span data-jobs-setup="pending" aria-hidden="true" className={cn("absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-panel bg-warning", icons ? "size-3" : "size-2.5")} />;
  if (icons) {
    return (
      <button type="button" data-sidebar-jobs="" aria-label={label} title={label} aria-pressed={active} onClick={open}
        className={cn("relative mx-auto mb-1 flex size-[46px] shrink-0 items-center justify-center rounded-xl text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus", active && "bg-raised text-ink")}>
        <Briefcase size={20} aria-hidden="true" />
        {dot}
      </button>
    );
  }
  return (
    <div className="px-3 pb-1">
      <button type="button" data-sidebar-jobs="" aria-label={label} title={label} aria-pressed={active} onClick={open}
        className={cn("flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-raised/60 focus-visible:ring-2 focus-visible:ring-accent/60")}>
        <span className={cn("relative grid shrink-0 place-items-center rounded-full", active ? "bg-ink/[0.16] text-ink" : "bg-raised text-ink-secondary", large ? "size-9" : "size-8")}>
          <Briefcase size={16} aria-hidden="true" />
          {dot}
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-5 text-ink">{label}</span>
      </button>
    </div>
  );
}
