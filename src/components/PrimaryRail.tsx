import { useState, type CSSProperties } from "react";
import { House, LayoutGrid, MessageSquare, Monitor, Pin, PinOff, Settings, UserCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useDesktopCapabilities, windowFramed } from "./DesktopCapabilities";

/** The places the rail moves between: only destinations that exist. */
export type PrimaryRailDestination = "home" | "team" | "needs-you" | "chat" | "computer" | "settings";

/** Whether the rail shows labels, remembered like the sidebar's width: layout state, not a setting. */
export const PRIMARY_RAIL_PINNED_KEY = "sanremes.primaryRailPinned";

export function parsePrimaryRailPinned(value: string | null): boolean {
  return value === "true";
}

export function loadPrimaryRailPinned(storage?: Pick<Storage, "getItem"> | null): boolean {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parsePrimaryRailPinned(target?.getItem(PRIMARY_RAIL_PINNED_KEY) ?? null);
  } catch {
    return false;
  }
}

export function savePrimaryRailPinned(pinned: boolean, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(PRIMARY_RAIL_PINNED_KEY, pinned ? "true" : "false");
  } catch {
  }
}

const DESTINATIONS: ReadonlyArray<{ id: PrimaryRailDestination; key: LocaleKey; Icon: typeof House }> = [
  { id: "home", key: "primaryRail.home", Icon: House },
  { id: "team", key: "primaryRail.team", Icon: LayoutGrid },
  { id: "needs-you", key: "needsYou.title", Icon: UserCheck },
  { id: "chat", key: "primaryRail.chats", Icon: MessageSquare },
  { id: "computer", key: "primaryRail.computer", Icon: Monitor },
  { id: "settings", key: "primaryRail.settings", Icon: Settings },
];

/**
 * The primary rail: the places, beside the sidebar. Presentational: the caller owns which
 * destination is active and what selecting one does. Pinning is layout state, remembered
 * across restarts; pass `pinned` to own it instead.
 */
export function PrimaryRail({ active, onSelect, pinned: controlledPinned, onPinnedChange }: {
  active: PrimaryRailDestination;
  onSelect: (destination: PrimaryRailDestination) => void;
  pinned?: boolean;
  onPinnedChange?: (pinned: boolean) => void;
}) {
  const { capabilities } = useDesktopCapabilities();
  const [storedPinned, setStoredPinned] = useState(loadPrimaryRailPinned);
  const pinned = controlledPinned ?? storedPinned;
  const setPinned = (next: boolean) => {
    if (controlledPinned === undefined) {
      setStoredPinned(next);
      savePrimaryRailPinned(next);
    }
    onPinnedChange?.(next);
  };
  const framed = windowFramed(capabilities);
  const top = framed ? null : capabilities.windowChrome === "mac-inset" ? "h-[52px]" : "h-3";
  const draggable = capabilities.windowChrome !== "native";
  // SAFETY: Electron's -webkit-app-region is not in React's CSSProperties type; the renderer accepts it as an inline style.
  const drag = !framed && draggable ? ({ WebkitAppRegion: "drag" } as CSSProperties) : undefined;
  const noDrag = !framed && draggable ? ({ WebkitAppRegion: "no-drag" } as CSSProperties) : undefined;
  const pinLabel = t(pinned ? "primaryRail.unpin" : "primaryRail.pin");
  const row = (selected: boolean) => cn(
    "shrink-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
    "transition-colors duration-120 motion-reduce:transition-none",
    selected ? "bg-accent/12 text-accent-text" : "text-ink-secondary hover:bg-ink/[0.06] hover:text-ink active:bg-ink/[0.08]",
  );
  const pinnedRow = "flex h-9 w-full touch:h-11 items-center gap-2 px-2 text-start";
  const iconRow = "mx-auto grid size-9 touch:size-11 place-items-center";
  return <nav aria-label={t("primaryRail.label")} data-primary-rail data-primary-rail-pinned={pinned ? "" : undefined} style={drag}
    className={cn("relative hidden shrink-0 flex-col border-e border-edge bg-panel md:flex", pinned ? "w-40" : "w-16")}>
    {top && <div aria-hidden="true" className={cn(top, "shrink-0")} />}
    <ul className="flex flex-col gap-2 px-2 py-2" style={noDrag}>
      {DESTINATIONS.map(({ id, key, Icon }) => {
        const label = t(key), selected = id === active;
        return <li key={id} className="flex">
          <button type="button" data-primary-rail-destination={id} aria-label={label} title={label}
            aria-current={selected ? "page" : undefined} onClick={() => onSelect(id)}
            className={cn(row(selected), pinned ? pinnedRow : iconRow)}>
            <Icon size={16} aria-hidden="true" className="shrink-0" />
            {pinned && <span className="min-w-0 truncate text-[13px] font-medium leading-[18px]">{label}</span>}
          </button>
        </li>;
      })}
    </ul>
    <div className="flex-1" style={noDrag} />
    <div className="flex flex-col px-2 pb-3 pt-2" style={noDrag}>
      <button type="button" data-primary-rail-pin aria-label={pinLabel} title={pinLabel} aria-pressed={pinned}
        onClick={() => setPinned(!pinned)}
        className={cn(row(false), pinned ? pinnedRow : iconRow)}>
        {pinned ? <PinOff size={16} aria-hidden="true" className="shrink-0" /> : <Pin size={16} aria-hidden="true" className="shrink-0" />}
        {pinned && <span className="min-w-0 truncate text-[13px] font-medium leading-[18px]">{pinLabel}</span>}
      </button>
    </div>
  </nav>;
}
