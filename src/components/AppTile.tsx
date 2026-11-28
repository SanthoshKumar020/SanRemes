import { memo, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { connectorDescription } from "@/lib/app-catalog";
import { reusableConnectionUrl, type PendingAuthorization } from "@/lib/connector-oauth";
import {
  accountToReconnect,
  connectorActionLabel,
  hasActiveConnection,
  needsReconnect,
  type ConnectorAccount,
  type ConnectorInventoryPhase,
  type ConnectorStatus,
} from "@/lib/connector-status";
import type { AppState, Bot } from "@/state/store";
import { managedConnectorUnavailableReason } from "../../shared/connector-availability";
import { BotAvatar } from "./Avatar";
import { BotSwitch } from "./bot-panel/rows";
import { ServiceIcon, type ToolkitCard } from "./ServiceIcon";

export const USED_BY_AVATAR_SIZE = 16;

export interface AppTileActions {
  connect(slug: string, alias?: string, replacing?: ConnectorAccount): void;
  openUrl(url: string): void;
  /** Opens the app's account-name form, or closes it when it is the one open. */
  toggleAlias(slug: string): void;
  setAliasDraft(value: string): void;
  aliasRequired(): void;
  changeBots(slug: string): void;
  /** The bots the tile's install-time picker grants this app to, chosen before the connection exists. */
  grantSelection(slug: string, bots: ReadonlySet<string>): void;
  disconnect(target: { slug: string; label: string; account: ConnectorAccount }): void;
  openBotApps(botId: string): void;
}

export interface AppTileProps {
  card: ToolkitCard;
  serviceStatus: ConnectorStatus | undefined;
  pendingUrl: PendingAuthorization | undefined;
  /** The account name being typed for this app; null while its form is closed. */
  aliasDraft: string | null;
  busy: boolean;
  configured: boolean;
  inventoryPhase: ConnectorInventoryPhase;
  mode: "managed" | "self-hosted" | "unavailable";
  policy: NonNullable<AppState["config"]>["managedPolicy"] | undefined;
  usedBy: readonly Bot[];
  /** The bots that may use only some of this app's tools. */
  limited: readonly Bot[];
  canChangeBots: boolean;
  /** The bots the install-time picker may grant; empty while this tile's form is closed, so untouched tiles keep
   * their props and are not rendered again. */
  grantBots: readonly Bot[];
  /** The picker's current choice for this app; null means every grantable bot. */
  grantSelection: ReadonlySet<string> | null;
  actions: AppTileActions;
}

export function tileStanding(card: ToolkitCard, serviceStatus: ConnectorStatus | undefined) {
  const failed = Boolean(serviceStatus?.status && /^(expired|failed)$/i.test(serviceStatus.status));
  const pending = Boolean(serviceStatus?.pending && !failed);
  const accounts = serviceStatus?.accounts ?? [];
  const included = card.noAuth === true
    || (serviceStatus?.connected === true && !accounts.length && !pending && !failed);
  return { failed, pending, accounts, included, connected: hasActiveConnection(serviceStatus) };
}

/** Actions that stay the same objects from render to render, each calling the newest one given, so a tile is not rendered
 * again for a handler that was only made anew. */
export function useTileActions(actions: AppTileActions): AppTileActions {
  const latest = useRef(actions);
  latest.current = actions;
  return useMemo<AppTileActions>(() => ({
    connect: (slug, alias, replacing) => latest.current.connect(slug, alias, replacing),
    openUrl: (url) => latest.current.openUrl(url),
    toggleAlias: (slug) => latest.current.toggleAlias(slug),
    setAliasDraft: (value) => latest.current.setAliasDraft(value),
    aliasRequired: () => latest.current.aliasRequired(),
    changeBots: (slug) => latest.current.changeBots(slug),
    grantSelection: (slug, bots) => latest.current.grantSelection(slug, bots),
    disconnect: (target) => latest.current.disconnect(target),
    openBotApps: (botId) => latest.current.openBotApps(botId),
  }), []);
}

/** The tool list a tile fetches on demand. Kept in a child so the tile above stays a plain render with no hooks. */
function AppTileTools({ slug, toolCountText }: { slug: string; toolCountText: string }) {
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<readonly { name: string; description?: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    const opening = !open;
    setOpen(opening);
    if (opening && tools === null && !loading) {
      setLoading(true);
      setError(null);
      api<{ tools?: Array<{ name: string; description?: string }> }>(`/api/connectors/${encodeURIComponent(slug)}/tools`)
        .then((r) => setTools(r.tools ?? []))
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    }
  };
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="-ms-1 inline-flex items-center gap-1 rounded-full px-1 font-medium text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink"
      >
        {toolCountText}
        <ChevronDown size={12} aria-hidden="true" className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      {open && (
        <div className="mt-1">
          {loading ? (
            <div className="flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" />
              {t("apps.tools.loading")}
            </div>
          ) : error ? (
            <div className="text-danger">{error}</div>
          ) : tools !== null && (
            <div className="space-y-0.5">
              {tools.length === 0 ? (
                <div>{t("apps.tools.empty")}</div>
              ) : (
                <>
                  {tools.slice(0, 8).map((tool) => (
                    <div key={tool.name} className="truncate" title={tool.description ?? tool.name}>
                      <span className="font-mono text-ink">{tool.name}</span>
                      {tool.description ? <span> — {tool.description}</span> : null}
                    </div>
                  ))}
                  {tools.length > 8 && <div>{t("apps.tools.more", { count: tools.length - 8 })}</div>}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** One app in the Apps panel. Everything it shows comes in as props, and the tool preview lives in a child component so
 * this tile stays a plain render with no hooks of its own. */
export function AppTileView({ card, serviceStatus, pendingUrl, aliasDraft, busy, configured, inventoryPhase, mode, policy, usedBy, limited, canChangeBots, grantBots, grantSelection, actions }: AppTileProps) {
  const { failed, pending, accounts, included, connected } = tileStanding(card, serviceStatus);
  const pendingAuthorization = pending && !failed ? pendingUrl : undefined;
  const authorizationUrl = reusableConnectionUrl(pendingAuthorization);
  const reconnect = pending ? undefined : accountToReconnect(serviceStatus);
  const addingAccount = aliasDraft !== null && !included;
  const unavailableReason = policy?.apps && !policy.apps.allowAll && !policy.apps.allowlist.includes(card.slug) ? t("policy.managedBy", { organization: policy.organizationName })
    : managedConnectorUnavailableReason(mode, card.slug) ? t("connectors.selfHostOnlyReason") : null;
  const usedByLabel = t("apps.usedBy", { names: usedBy.map((candidate) => candidate.name).join(", ") });
  const description = unavailableReason ?? (
    pending
      ? authorizationUrl
        ? t("connectors.finishSetup")
        : t("connectors.finishSetupOrDisconnect")
      : reconnect
        ? t("connectors.signedOut")
        : failed && !accounts.length
          ? t("connectors.authExpired")
          : connectorDescription(card)
  );
  const toolCountText = card.toolCount === undefined ? null : [
    card.toolCount === 1 ? t("apps.toolsCountOne") : t("apps.toolsCount", { count: card.toolCount }),
    ...(card.triggerCount !== undefined
      ? [card.triggerCount === 1 ? t("apps.triggersCountOne") : t("apps.triggersCount", { count: card.triggerCount })]
      : []),
  ].join(" · ");
  const effectiveGrants = grantSelection ?? new Set(grantBots.map((bot) => bot.id));
  const toggleGrant = (botId: string) => {
    const next = new Set(effectiveGrants);
    if (!next.delete(botId)) next.add(botId);
    actions.grantSelection(card.slug, next);
  };
  return (
    <div
      data-app-tile={card.slug}
      className="flex min-w-0 flex-col rounded-xl px-2 py-2 transition-colors hover:bg-raised/40"
    >
      <div className="flex items-center gap-3">
        <ServiceIcon card={card} className="size-10 shrink-0 rounded-[8px]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold leading-5 text-ink">{card.label}</span>
            {connected && !pending && (
              <Check size={13} strokeWidth={2.5} className="shrink-0 text-success" aria-label={t("apps.connected")} />
            )}
            {usedBy.length > 0 && (
              <span
                className="ms-1 flex shrink-0 -space-x-1.5 rtl:space-x-reverse"
                title={usedByLabel}
                aria-label={usedByLabel}
                role="img"
              >
                {usedBy.slice(0, 3).map((candidate) => (
                  <span
                    key={candidate.id}
                    data-used-by-avatar={candidate.id}
                    className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-menu ring-2 ring-menu"
                  >
                    <BotAvatar bot={candidate} size={USED_BY_AVATAR_SIZE} animated={false} />
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="truncate text-[13px] leading-[18px] text-ink-secondary" title={description}>
            {description}
          </div>
        </div>
        <button
          type="button"
          disabled={!configured || inventoryPhase !== "ready" || busy || included || Boolean(unavailableReason)}
          title={unavailableReason ?? undefined}
          onClick={() => {
            if (pending && !failed) {
              const url = reusableConnectionUrl(pendingAuthorization);
              if (url) {
                actions.openUrl(url);
              } else {
                actions.connect(card.slug);
              }
            } else if (reconnect) {
              actions.connect(card.slug, reconnect.alias, reconnect);
            } else {
              actions.toggleAlias(card.slug);
            }
          }}
          className="inline-flex h-7 min-w-[64px] shrink-0 items-center justify-center gap-2 rounded-full bg-control/80 px-3 text-[13px] font-medium leading-5 text-ink transition-colors hover:bg-raised-hover disabled:opacity-40"
        >
          {unavailableReason ? (
            t("connectors.selfHostOnly")
          ) : busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            connectorActionLabel(inventoryPhase, {
              busy,
              included,
              canContinue: Boolean(pendingAuthorization),
              pending,
              reconnect: Boolean(reconnect),
              hasAccounts: accounts.length > 0,
              failed: Boolean(failed),
            })
          )}
        </button>
      </div>
      <div className="ps-[52px]">
        {toolCountText !== null && (
          <div className="mt-1.5 text-[12px] leading-5 text-ink-secondary">
            {mode === "self-hosted" ? <AppTileTools slug={card.slug} toolCountText={toolCountText} /> : <span>{toolCountText}</span>}
          </div>
        )}
        {authorizationUrl && (
          <a href={authorizationUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => {
            if (!reusableConnectionUrl(pendingAuthorization)) {
              event.preventDefault();
              actions.connect(card.slug);
            }
          }} className="mt-1.5 inline-block text-[12px] text-accent-text underline underline-offset-2">
            {t("connectors.openAuthorizationPage")}
          </a>
        )}
        {connected && !pending && (
          <div data-app-bots={card.slug} className="mt-1.5 flex min-w-0 items-center gap-2 text-[12px] leading-5 text-ink-secondary">
            <span className="min-w-0 truncate" title={usedBy.length ? usedByLabel : undefined}>
              {usedBy.length ? usedByLabel : t("apps.usedByNone")}
            </span>
            {canChangeBots && (
              <button
                type="button"
                onClick={() => actions.changeBots(card.slug)}
                aria-label={t("apps.whichBots", { app: card.label })}
                className="ms-auto shrink-0 rounded-full px-2 text-[12px] font-medium leading-5 text-accent-text transition-colors hover:bg-raised-hover"
              >
                {t("apps.usedByChange")}
              </button>
            )}
          </div>
        )}
        {accounts.length > 0 && (
          <div className="mt-1.5 space-y-0.5">
            {accounts.map((account) => {
              const active = /^active$/i.test(account.status);
              const reconnectable = needsReconnect(account) && account.id !== reconnect?.id;
              return (
                <div key={account.id} className="flex min-w-0 items-center gap-2 text-[12px] leading-5">
                  {active ? <Check size={12} className="shrink-0 text-success" /> : <span className="size-3 shrink-0" />}
                  <span className="min-w-0 truncate text-ink" title={`${account.alias ? `${account.id} · ` : ""}${account.status.toLowerCase()}`}>
                    {account.alias || account.id}
                    <span className="text-ink-secondary"> · {account.status.toLowerCase()}</span>
                  </span>
                  {reconnectable && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => actions.connect(card.slug, account.alias, account)}
                      className="ms-auto shrink-0 rounded-full px-2 text-[12px] font-medium leading-5 text-accent-text transition-colors hover:bg-raised-hover disabled:opacity-40"
                      aria-label={t("connectors.reconnectAria", { account: account.alias || account.id, service: card.label })}
                    >
                      {t("connectors.action.reconnect")}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => actions.disconnect({ slug: card.slug, label: card.label, account })}
                    className={cn("shrink-0 rounded-full px-2 text-[12px] font-medium leading-5 text-ink-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40", !reconnectable && "ms-auto")}
                    aria-label={t("connectors.disconnectAria", {
                      account: account.alias || account.id,
                      service: card.label,
                    })}
                  >
                    {t("connectors.disconnect")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {(serviceStatus?.connected || included) && (() => {
          if (!limited.length) return null;
          const names = limited.slice(0, 4).map((candidate, index) => (
            <span key={candidate.id}>
              {index > 0 && ", "}
              <button
                type="button"
                onClick={() => actions.openBotApps(candidate.id)}
                className="font-medium text-ink underline underline-offset-2 hover:text-accent-text"
              >
                {candidate.name}
              </button>
            </span>
          ));
          return (
            <div className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
              <span>{t("connectors.grants.limited", { count: limited.length })}</span>{" "}
              {names}
              {limited.length > 4 && <span>{t("connectors.grants.more", { count: limited.length - 4 })}</span>}
            </div>
          );
        })()}
        {addingAccount && (
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const alias = (aliasDraft ?? "").trim();
              if (!alias) {
                actions.aliasRequired();
                return;
              }
              actions.connect(card.slug, alias);
            }}
          >
            <input
              autoFocus
              value={aliasDraft ?? ""}
              maxLength={64}
              onChange={(event) => actions.setAliasDraft(event.target.value)}
              placeholder={t("connectors.aliasPlaceholder")}
              aria-label={accounts.length > 0
                ? t("connectors.aliasAriaAnother", { service: card.label })
                : t("connectors.aliasAriaNew", { service: card.label })}
              className="h-8 min-w-0 flex-1 rounded-full bg-inset px-3 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={busy || !(aliasDraft ?? "").trim()}
              className="inline-flex h-7 shrink-0 items-center rounded-full bg-accent px-3 text-[13px] font-medium leading-5 text-accent-ink disabled:opacity-40"
            >
              {t("connectors.action.continue")}
            </button>
          </form>
        )}
        {addingAccount && accounts.length === 0 && canChangeBots && grantBots.length > 0 && (
          <div className="mt-3">
            <div className="text-[12px] font-medium leading-5 text-ink-secondary">{t("apps.whichBots", { app: card.label })}</div>
            <div className="mt-1">
              {grantBots.map((bot) => (
                <div key={bot.id} className="flex min-h-11 items-center gap-2.5">
                  <BotAvatar bot={bot} size={24} animated={false} />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{bot.name}</span>
                  <BotSwitch
                    color={bot.color}
                    checked={effectiveGrants.has(bot.id)}
                    aria-label={t("botSettings.simple.appToggle", { name: bot.name, app: card.label })}
                    onClick={() => toggleGrant(bot.id)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export const AppTile = memo(AppTileView);
