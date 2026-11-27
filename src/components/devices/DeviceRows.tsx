import { useEffect, useId, useRef, type ReactNode } from "react";
import { Check, ChevronRight, CircleAlert, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Device, DeviceAction, DeviceGroup } from "@/lib/devices";
import { SettingsEmptyRow, SettingsGroup, SettingsMark, SettingsRows } from "../SettingsPrimitives";
import { actionLabel, DeviceDetails } from "./DeviceDetails";
import { BotsOn, botsLabel, needOf, StatusLine, useBotsOn } from "./device-parts";
import { KIND_ICON, groupLabel, statusText } from "./device-words";

export interface NetworkAction {
  label: string;
  run?: () => void;
  href?: string;
  busy?: boolean;
}

/** What the open row's details need from the page. */
export interface Opened {
  id: string | null;
  pairing: boolean;
  toggle: (id: string) => void;
  close: () => void;
  onPairing: (device: Device, open: boolean, connected?: boolean) => void;
  onRemoved: (notice: string | null, device: Device) => void;
}

const SLOT = "flex size-8 shrink-0 items-center justify-center text-ink-secondary";

/**
 * One device: its kind's mark, its name, its state and how it connects in one line, the bots on it, and the one thing it
 * needs. The whole row opens its details right under it, in the same card; Escape closes them (the page listens).
 */
function DeviceRow({ device, mark, opened, onAction, now }: {
  device: Device; mark?: ReactNode; opened: Opened; onAction: (device: Device, action: DeviceAction) => void; now: number;
}) {
  const Icon = KIND_ICON[device.kind];
  const bots = useBotsOn(device);
  const need = needOf(device);
  const open = opened.id === device.id;
  const detailsId = useId();
  const node = device.here ? "here" : device.id;
  const label = [device.name, statusText(device, now), botsLabel(bots)].filter(Boolean).join(", ");
  return (
    <div data-device-row={device.id} data-device-status={device.status} data-open={open ? "" : undefined} className="scroll-mt-4">
      <div className="relative flex min-h-11 items-center gap-3 px-4 py-3">
        <span aria-hidden="true" className={SLOT}>{mark ?? <SettingsMark><Icon /></SettingsMark>}</span>
        <button type="button" data-device-node={node} aria-expanded={open} aria-controls={detailsId} aria-label={label} title={device.name}
          onClick={() => opened.toggle(device.id)}
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 text-start after:absolute after:inset-0 after:content-[''] hover:after:bg-ink/[0.03] focus-visible:outline-none! focus-visible:after:rounded-xl focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus">
          <span className="break-words text-[14px] font-medium leading-5 text-ink">{device.name}</span>
          <StatusLine device={device} now={now} />
          {bots.length > 0 && <span className="pt-1 @min-[480px]/rows:hidden"><BotsOn bots={bots} /></span>}
        </button>
        {bots.length > 0 && <span className="hidden @min-[480px]/rows:flex"><BotsOn bots={bots} /></span>}
        {need && !open && (
          <button type="button" data-row-action={need.type} onClick={() => onAction(device, need)} aria-label={`${actionLabel(need)}: ${device.name}`}
            className="ui-button ui-button-sm relative z-10 shrink-0">{actionLabel(need)}</button>
        )}
        <ChevronRight size={14} aria-hidden="true" className={cn("-me-1 shrink-0 text-ink-tertiary transition-transform duration-150 motion-reduce:transition-none rtl:-scale-x-100", open && "rotate-90")} />
      </div>
      <div id={detailsId} hidden={!open} data-device-details={open ? device.id : undefined} className="ps-[60px] pe-4 pb-4 motion-safe:animate-fade-in">
        {open && <DeviceDetails device={device} onAction={onAction} now={now} pairing={opened.pairing}
          onPairing={(on, connected) => opened.onPairing(device, on, connected)} onRemoved={(text) => opened.onRemoved(text, device)} />}
      </div>
    </div>
  );
}

/** This place first: its row (open like any other). `titled: false` leaves out "You're here" where the map above already says it. */
export function HereSection({ device, mark, opened, onAction, now, more, titled = true }: {
  device: Device; mark: ReactNode; opened: Opened; onAction: (device: Device, action: DeviceAction) => void; now: number;
  /** more rows of this place's own, under it */
  more?: ReactNode;
  titled?: boolean;
}) {
  return (
    <SettingsGroup label={titled ? t("devicesPage.here.section") : undefined} block="here">
      <SettingsRows icons>
        <DeviceRow device={device} mark={mark} opened={opened} onAction={onAction} now={now} />
        {more}
      </SettingsRows>
    </SettingsGroup>
  );
}

/** What needs the person, by name, as one quiet row in its own card while anything does: each device's name opens its row. */
export function DevicesAttention({ needing, now, onOpen }: {
  needing: readonly Device[]; now: number; onOpen: (id: string) => void;
}) {
  const items = needing.map((device) => ({ key: device.id, name: device.name, status: statusText(device, now), open: () => onOpen(device.id) }));
  if (items.length === 0) return null;
  return (
    <section data-settings-block="attention" className="flex scroll-mt-4 flex-col">
      <SettingsRows>
        <div data-devices-attention="" className="flex min-h-11 items-start gap-2 px-4 py-3 text-[13px] leading-[18px] text-ink-secondary">
          <span className="flex h-[18px] shrink-0 items-center"><CircleAlert size={14} aria-hidden="true" className="text-warning" /></span>
          <ul className="flex min-w-0 flex-col gap-1">
            {items.map((item) => {
              const [before = "", after = ""] = t("devicesPage.attention.item", { status: item.status }).split("{name}");
              // A button is laid out as one box (Chromium): a name over two lines would leave the punctuation after it
              // alone at the line's end, so the punctuation goes inside it.
              const [, glue = "", rest = ""] = /^(\S*)([\s\S]*)$/.exec(after) ?? [];
              return <li key={item.key} data-attention-device={item.key}>
                {before}
                <button type="button" onClick={item.open}
                  className="cursor-pointer rounded-sm text-start font-medium text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                  {item.name}<span className="font-normal text-ink-secondary">{glue}</span>
                </button>
                {rest}
              </li>;
            })}
          </ul>
        </div>
      </SettingsRows>
    </section>
  );
}

/** What just happened to a device (removed, paired again), by the list it happened in, until it is closed or the page moves on. */
export function DevicesNotice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => { line.current?.scrollIntoView?.({ block: "nearest" }); }, [text]);
  return (
    <div ref={line} role="status" className="flex scroll-mt-4 items-center gap-3 rounded-[12px] bg-menu py-1.5 ps-4 pe-2 shadow-[inset_0_0_0_0.5px_var(--settings-edge)]">
      <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success"><Check size={12} strokeWidth={2.5} /></span>
      <span data-devices-notice="" className="min-w-0 flex-1 py-1 text-[13px] font-medium leading-[18px] text-ink">{text}</span>
      <button type="button" data-devices-notice-close="" aria-label={t("notice.dismiss")} title={t("notice.dismiss")} onClick={onDismiss} className="ui-icon-button size-7 shrink-0"><X size={14} aria-hidden="true" /></button>
    </div>
  );
}

/** One group of devices by what a person calls them, with its own Add and a line while it has none. `notes` sit under its
 * title; `lead` rows come before its devices in the same card. */
export function GroupSection({ group, devices, addLabel, onAdd, opened, onAction, now, block = `group-${group}`, notes, lead, notice }: {
  group: DeviceGroup; devices: readonly Device[]; addLabel: string | null; onAdd: () => void; opened: Opened;
  onAction: (device: Device, action: DeviceAction) => void; now: number; block?: string; notes?: ReactNode; lead?: ReactNode; notice?: ReactNode;
}) {
  return (
    <SettingsGroup label={groupLabel(group)} block={block}
      actions={addLabel && devices.length > 0 && <button type="button" data-add-group={group} onClick={onAdd} className="settings-quiet cursor-pointer">{addLabel}</button>}>
      {notes}
      {notice}
      <SettingsRows icons>
        {lead}
        {devices.length
          ? devices.map((device) => <DeviceRow key={device.id} device={device} opened={opened} onAction={onAction} now={now} />)
          : <SettingsEmptyRow>
            <span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <span data-devices-empty={group}>{t(EMPTY[group])}</span>
              {addLabel && <button type="button" data-add-empty={group} data-add-group={group} onClick={onAdd} className="settings-quiet -me-1.5 shrink-0 cursor-pointer">{addLabel}</button>}
            </span>
          </SettingsEmptyRow>}
      </SettingsRows>
    </SettingsGroup>
  );
}

const EMPTY = { phones: "devicesPage.empty.phones", computers: "devicesPage.empty.computers", servers: "devicesPage.empty.servers" } as const;
