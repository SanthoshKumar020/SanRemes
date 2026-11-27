import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Laptop } from "lucide-react";
import { deviceGroup, groupByKind, type Device, type DeviceAction, type DeviceGroup } from "@/lib/devices";
import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { canPairDevices } from "@/lib/pairing";
import { useDevices } from "@/lib/use-devices";
import { api } from "@/state/api";
import { useStoreDispatch, useStoreSelector } from "@/state/store-select";
import { AddDevicePanel, lastInputWasKeys, withinPage, type AddKind } from "../../devices/AddDevicePanel";
import { ComputerNameRow } from "../../ComputerNameRow";
import { DevicesAttention, DevicesNotice, GroupSection, HereSection, type Opened } from "../../devices/DeviceRows";
import { DeviceMap, deviceMapShown } from "../../devices/DeviceMap";
import { usePairAccess } from "../../devices/PairCodePanel";
import { needsFirst, needsPerson } from "../../devices/device-parts";
import { sshAliasOfAnchor } from "../../devices/device-words";
import { AlwaysOnHomeSection } from "../../AlwaysOnHomeSection";
import { SettingsMark } from "../../SettingsPrimitives";
import { PlaceBadge } from "../SettingsNav";
import { devicesPlaceKey, setDevicesSignal } from "../devices-signal";
import { useSettingsShell } from "../settings-shell";

const ADD_LABEL: Record<Exclude<DeviceGroup, "phones">, Parameters<typeof t>[0]> = { computers: "devicesPage.addGroup.computer", servers: "devicesPage.addGroup.cloudOrServer" };
/** Each group's Add opens its own steps; Clouds and your own servers opens the choice, which has both. */
const ADD_KIND: Record<Exclude<DeviceGroup, "phones">, AddKind | null> = { computers: "computer", servers: null };

type Adding = { start: AddKind | null; from: string; keys: boolean };

function ComputerNameMore() {
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api<{ computerName?: unknown }>("/api/config").then((config) => { if (alive) setSaved(typeof config?.computerName === "string" ? config.computerName : ""); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (saved === null) return null;
  return <div data-settings-block="computer-name"><ComputerNameRow saved={saved} onSaved={setSaved} className="px-4 py-3" /></div>;
}

export function DevicesPage() {
  const { ctx, place, go, setSub, setHeaderAction, anchor } = useSettingsShell();
  const dispatch = useStoreDispatch();
  const config = useStoreSelector((state) => state.config);
  const { devices, loaded, refresh } = useDevices({ here: ctx.here, client: ctx.client, name: place.name, kind: place.kind });
  const access = usePairAccess();
  const [open, setOpen] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [adding, setAdding] = useState<Adding | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; group: DeviceGroup | null } | null>(null);

  const policy = config?.managedPolicy?.remoteAccess === false ? config.managedPolicy.organizationName : null;
  const blocked = policy ? t("policy.managedBy", { organization: policy }) : null;

  const focusNode = (id: string) => window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-device-node="${CSS.escape(id)}"]`)?.focus());
  const startAdding = useCallback((start: AddKind | null, from: string) => { setNotice(null); setFailure(null); setAdding({ start, from, keys: lastInputWasKeys() }); }, []);

  // Another section asked for while Add is open: back to the list first, so the section is there to scroll to.
  const lastAnchor = useRef(anchor);
  useLayoutEffect(() => {
    if (lastAnchor.current === anchor) return;
    lastAnchor.current = anchor;
    if (anchor) setAdding(null);
  }, [anchor]);
  const openRow = (id: string) => {
    setNotice(null);
    setPairing(false);
    setOpen(id);
    window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-device-row="${CSS.escape(id)}"]`);
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      row?.scrollIntoView?.({ block: "start", behavior: still ? "auto" : "smooth" });
      row?.querySelector<HTMLElement>("[data-device-node]")?.focus({ preventScroll: true });
    });
  };
  // A named server's row asked for from another page (its link on AI) opens once, when the server is listed.
  const openedFor = useRef<string | null>(null);
  const openRowNow = useRef(openRow);
  openRowNow.current = openRow;
  useEffect(() => {
    const alias = sshAliasOfAnchor(anchor);
    if (!alias) { openedFor.current = null; return; }
    if (openedFor.current === anchor) return;
    const server = devices.find((device) => device.sources.some((source) => source.type === "vps" && source.id === alias));
    if (!server) return;
    openedFor.current = anchor;
    openRowNow.current(server.id);
  }, [anchor, devices]);
  const groups = groupByKind(devices, { all: true }).map((entry) => ({ ...entry, devices: needsFirst(entry.devices) }));
  const needing = groups.flatMap((entry) => entry.devices.filter(needsPerson));
  const signalPlace = devicesPlaceKey(place);
  const needsYou = needing.length > 0;
  useEffect(() => { if (loaded) setDevicesSignal({ place: signalPlace, needsYou }); }, [loaded, signalPlace, needsYou]);

  const isAdding = adding !== null;
  const addButton = useMemo(() => <span data-settings-block="add" className="flex scroll-mt-4">
    <button type="button" data-add-device="" onClick={() => startAdding(null, "[data-add-device]")} className="ui-button ui-button-primary ui-button-sm shrink-0">{t("devicesPage.add")}</button>
  </span>, [startAdding]);
  useLayoutEffect(() => {
    if (!setHeaderAction) return;
    setHeaderAction(isAdding ? null : addButton);
    return () => setHeaderAction(null);
  }, [setHeaderAction, isAdding, addButton]);

  const environments = ctx.here ? window.ogb?.environments : undefined;
  const workspaces = ctx.here ? window.ogb?.workspaces : undefined;

  const act = async (device: Device, action: DeviceAction) => {
    setFailure(null);
    try {
      switch (action.type) {
        case "switch": await environments?.switch(action.placeId); return;
        case "retry": await environments?.retry?.(action.placeId); break;
        case "pair-again": setOpen(device.id); setPairing(true); return;
        case "copy-address": await copyText(action.address); return;
        case "copy-update": setOpen(device.id); setPairing(false); return;
        case "manage": go(action.page, action.anchor); return;
        case "remove": {
          for (const source of [action.source]) {
            if (source.type === "place") await environments?.forget(source.id);
            else if (source.type === "session") await api(`/api/auth/sessions/${encodeURIComponent(source.id)}`, { method: "DELETE" });
          }
          if (open === device.id) setOpen(null);
          setNotice({ text: t("devicesPage.removed", { name: device.name }), group: deviceGroup(device) });
          break;
        }
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
    refresh();
  };

  const close = () => {
    const id = open;
    setOpen(null);
    setPairing(false);
    if (id) focusNode(id === "here" ? "here" : id);
  };
  // Escape closes the open details wherever focus is in the page (or nowhere, after Pair again closed), never Settings.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open || adding) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || !withinPage(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, adding]);
  const opened: Opened = {
    id: open, pairing,
    toggle: (id) => { setNotice(null); setPairing(false); setOpen((now) => (now === id ? null : id)); },
    close,
    onPairing: (device, on, connected) => { setPairing(on); if (connected) { setNotice({ text: t("devicesPage.pairedAgain", { name: device.name }), group: deviceGroup(device) }); refresh(); } },
    onRemoved: (text, device) => { setOpen(null); setNotice(text ? { text, group: deviceGroup(device) } : null); refresh(); },
  };

  if (adding) {
    const leave = (id?: string) => {
      const from = adding.from;
      setAdding(null);
      refresh();
      if (id) { setOpen(id); focusNode(id); }
      else window.requestAnimationFrame(() => document.querySelector<HTMLElement>(from)?.focus());
    };
    return <AddDevicePanel here={ctx.here} cloud={ctx.cloud} devices={devices} loaded={loaded} start={adding.start} viaKeys={adding.keys} onBack={leave} onConnected={refresh}
      setSub={setSub}
      canConnectServer={Boolean(workspaces?.add)} onGetCloud={workspaces?.add ? () => { setAdding(null); dispatch({ type: "toggleAppSettings", open: false }); void workspaces.add?.("cloud"); } : null} />;
  }

  const here = devices.find((device) => device.here)!;
  const mark = place.kind === "computer" ? <SettingsMark><Laptop /></SettingsMark> : <PlaceBadge place={place} size={28} />;
  const now = Date.now();
  const onAction = (device: Device, action: DeviceAction) => void act(device, action);
  const error = failure;
  const noticeLine = notice && <DevicesNotice text={notice.text} onDismiss={() => setNotice(null)} />;
  const mapShown = deviceMapShown();
  return <>
    {error && <p role="alert" className="px-4 text-[13px] leading-[18px] text-danger">{error}</p>}
    {notice && !notice.group && noticeLine}
    {!setHeaderAction && addButton}
    <DevicesAttention needing={needing} now={now} onOpen={openRow} />
    {mapShown && <DeviceMap devices={devices} mark={mark} loaded={loaded} onOpen={openRow} now={now} />}
    <HereSection device={here} mark={mark} opened={opened} onAction={onAction} now={now} titled={!mapShown}
      more={!ctx.here && ctx.advanced && !ctx.cloud && access.pairingCodes === true && canPairDevices(access.session) ? <ComputerNameMore /> : null} />
    {groups.map((entry) => {
      const add = entry.group === "phones" ? null : { label: t(ADD_LABEL[entry.group]), kind: ADD_KIND[entry.group] };
      return <div key={entry.group} className="contents">
        <GroupSection group={entry.group} devices={entry.devices} opened={opened} onAction={onAction} now={now}
          notice={notice?.group === entry.group ? noticeLine : undefined}
          addLabel={add ? add.label : null}
          onAdd={() => { if (add) startAdding(add.kind, `[data-add-group="${entry.group}"]`); }} />
      </div>;
    })}
    {ctx.here && <AlwaysOnHomeSection blocked={blocked}
      onAddComputer={() => startAdding("computer", "[data-always-on-add-computer]")} onConnect={() => startAdding("server", "[data-always-on-connect]")} />}
  </>;
}
