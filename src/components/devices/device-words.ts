import { Box, Cloud, Laptop, Monitor, Server, Smartphone, type LucideIcon } from "lucide-react";
import type { LocaleKey } from "@/locales";
import { t } from "@/lib/i18n";
import { lastSeen } from "@/lib/pairing-time";
import type { Device, DeviceGroup, DeviceKind, DeviceRoute } from "@/lib/devices";
import { productName } from "@/lib/brand";

export const KIND_ICON: Record<DeviceKind, LucideIcon> = { laptop: Laptop, desktop: Monitor, server: Server, cloud: Cloud, phone: Smartphone, vm: Box };

const KIND: Record<DeviceKind, LocaleKey> = {
  laptop: "devicesPage.kind.laptop", desktop: "devicesPage.kind.desktop", server: "devicesPage.kind.server", cloud: "devicesPage.kind.cloud",
  phone: "devicesPage.kind.phone", vm: "devicesPage.kind.cloudDesktop",
};
export const kindLabel = (kind: DeviceKind): string => t(KIND[kind]);

const ROUTE: Record<DeviceRoute, LocaleKey> = {
  here: "devicesPage.route.here", local: "devicesPage.route.sameWifi", tailscale: "devicesPage.route.tailscale", relay: "devicesPage.route.anywhere",
  cloud: "devicesPage.route.cloud", internet: "devicesPage.route.overInternet", paired: "devicesPage.route.pairedCode", ssh: "devicesPage.route.secureLogin",
};
export const routeLabel = (route: DeviceRoute): string => t(ROUTE[route], { app: productName() });

const ROUTE_INLINE: Partial<Record<DeviceRoute, LocaleKey>> = {
  local: "devicesPage.routeInline.sameWifi", tailscale: "devicesPage.routeInline.tailscale", relay: "devicesPage.routeInline.anywhere",
  internet: "devicesPage.routeInline.overInternet", paired: "devicesPage.routeInline.pairedCode", ssh: "devicesPage.routeInline.secureLogin",
};
/** "Same Wi-Fi, paired with a code": only the first way starts with a capital. */
export const routeList = (routes: readonly DeviceRoute[]): string =>
  routes.map((route, index) => (index > 0 && ROUTE_INLINE[route] ? t(ROUTE_INLINE[route], { app: productName() }) : routeLabel(route))).join(", ");

const GROUP: Record<DeviceGroup, LocaleKey> = { computers: "devicesPage.group.computers", servers: "devicesPage.group.servers", phones: "devicesPage.group.phonesTablets" };
export const groupLabel = (group: DeviceGroup): string => t(GROUP[group]);

/** One short line: how it is, or the one thing it needs. */
export function statusText(device: Device, now = Date.now()): string {
  if (device.here) return t("devicesPage.status.online");
  if (device.note === "update") return t("devicesPage.note.updateReady");
  if (device.note === "signed-out") return t("devicesPage.note.signedOut");
  if (device.note === "insecure") return t("devicesPage.note.insecure");
  if (device.note === "unreachable") return t("devicesPage.note.unreachable");
  if (device.note === "reconnecting") return t("devicesPage.note.reconnecting");
  if (device.kind === "vm") return device.desktop ? t(DESKTOP[device.desktop]) : "";
  if (device.status === "online") return t("devicesPage.status.online");
  if (device.status === "offline") return device.lastSeen ? t("devicesPage.status.seen", { when: lastSeen(device.lastSeen, now) }) : t("devicesPage.status.offline");
  if (device.route === "ssh") return t("devicesPage.status.checkedByBots");
  if (device.kind === "cloud") return t("devicesPage.status.checkedWhenOpened");
  return device.home ? t("servers.homeTag") : t("devicesPage.status.unknown");
}

const DESKTOP: Record<NonNullable<Device["desktop"]>, LocaleKey> = {
  ready: "devicesPage.desktop.ready", asleep: "devicesPage.desktop.asleep", starting: "devicesPage.desktop.starting", unreachable: "devicesPage.note.unreachable",
};

/** The Devices anchor that opens a named SSH server's row, from wherever else the server is listed. */
export const sshServerAnchor = (alias: string) => `ssh:${alias}`;
export const sshAliasOfAnchor = (anchor: string | null) => (anchor?.startsWith("ssh:") ? anchor.slice(4) || null : null);
