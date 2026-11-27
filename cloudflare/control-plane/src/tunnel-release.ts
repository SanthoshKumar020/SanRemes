// Giving tunnels back at the version cutoff. Nothing here deletes a provider resource:
// a release only marks a ready row 'deleting', and the cleanup sweep removes
// it through the same ownership-verified path as an owner's DELETE. The row
// and its hostname stay, so a computer gets the same address back by provisioning again.
import { TUNNEL_CONNECTED_CODE } from "./cloudflare-api";
import type { ControlPlaneConfig } from "./config";
import { ACTED_ON_ENDPOINT_SQL, actedOnAccounts, appVersionAtLeast } from "./endpoint-accounts";
import type { JSONValue } from "./http";

const DAY_MS = 24 * 60 * 60 * 1_000;
const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$/;
/** A computer called the control plane this recently, so what is stored about
 * it is current: a desktop with remote access on checks in every few minutes. */
export const SEEN_FRESH_MS = 2 * DAY_MS;
/** Release marks per cron run, all reasons together: with the cleanup sweep's
 * 20 rows a run, a wave never outgrows what cleanup removes. */
export const RELEASE_MARK_LIMIT = 20;
/** A forced removal that met a tunnel still connected: by name, and as Cloudflare's own code from before it was named. */
const STILL_CONNECTED_CODES = JSON.stringify([TUNNEL_CONNECTED_CODE, "cf_api_1022"]);

export type ReleaseReason = "min_version";

export interface TunnelPolicy {
  /** TUNNEL_MIN_APP_VERSION: a desktop below it neither gets nor keeps a tunnel. */
  minAppVersion: string | null;
}

function version(value: unknown): string | null {
  return typeof value === "string" && VERSION.test(value.trim()) ? value.trim() : null;
}

/** Every switch is off unless set, and an invalid value reads as off. */
export function readTunnelPolicy(env: Env): TunnelPolicy {
  const vars = env as unknown as Partial<Record<string, unknown>>;
  return {
    minAppVersion: version(vars.TUNNEL_MIN_APP_VERSION),
  };
}

/** A missing or unreadable version is below every minimum. */
export function belowMinimum(policy: TunnelPolicy, appVersion: string | null): boolean {
  return policy.minAppVersion !== null && !appVersionAtLeast(appVersion, policy.minAppVersion);
}

// A ready tunnel of an active installation, in an account this Worker acts on.
const HELD_TUNNEL_SQL = `e.status = 'ready'
        AND e.tunnel_id IS NOT NULL
        AND i.revoked_at IS NULL
        AND ${ACTED_ON_ENDPOINT_SQL}`;

/** The stored release can be trusted as current: the computer called lately.
 * A computer that has been off is left to idle reclaim. */
const SEEN_LATELY_SQL = "i.last_seen_at IS NOT NULL AND i.last_seen_at >= ?";

interface VersionRow {
  /** Of `tunnels`, those whose computer called lately. */
  seen: number;
  tunnels: number;
  version: string;
}

/** Held tunnels by desktop version. Throws without migration 0016. */
async function heldByVersion(env: Env, config: ControlPlaneConfig, now: number): Promise<VersionRow[]> {
  const found = await env.DB.prepare(
    `SELECT COALESCE(i.app_version, '') AS version,
            COUNT(*) AS tunnels,
            COALESCE(SUM(CASE WHEN ${SEEN_LATELY_SQL} THEN 1 ELSE 0 END), 0) AS seen
       FROM installation_endpoints e
       JOIN installations i ON i.id = e.installation_id
      WHERE ${HELD_TUNNEL_SQL}
      GROUP BY 1`,
  ).bind(now - SEEN_FRESH_MS, actedOnAccounts(config)).all<VersionRow>();
  return found.results;
}

export interface ReleasePreview {
  /** Held tunnels of desktops seen in the last two days below
   * TUNNEL_MIN_APP_VERSION: what a version cutoff would clear. */
  belowMinVersion: number;
}

function preview(rows: readonly VersionRow[], policy: TunnelPolicy): ReleasePreview {
  const cutoff = policy.minAppVersion;
  const totals: ReleasePreview = { belowMinVersion: 0 };
  for (const row of rows) {
    if (cutoff !== null && !appVersionAtLeast(row.version, cutoff)) {
      totals.belowMinVersion += row.seen;
    }
  }
  return totals;
}

const HEALTH_MEMO_MS = 5 * 60 * 1_000;
let healthMemo: { at: number; value: JSONValue | null } | null = null;

/** Test-only. */
export function forgetTunnelRelease(): void {
  healthMemo = null;
}

/** Counts only, for /healthz: the switch as set, and what it would clear
 * now, so the numbers can be read before a switch is turned. Read at most
 * every five minutes per isolate; left out without migration 0016. */
export async function tunnelReleaseHealth(env: Env, config: ControlPlaneConfig, now = Date.now()): Promise<JSONValue | null> {
  if (healthMemo && now - healthMemo.at < HEALTH_MEMO_MS) return healthMemo.value;
  const policy = readTunnelPolicy(env);
  const value = await heldByVersion(env, config, now).then((rows): JSONValue => {
    const counts = preview(rows, policy);
    return {
      minAppVersion: { on: policy.minAppVersion !== null, eligible: counts.belowMinVersion },
    };
  }, () => null);
  healthMemo = { at: now, value };
  return value;
}

interface Candidate {
  installation_id: string;
}

export interface ReleaseSummary {
  marked: Record<ReleaseReason, number>;
  preview: ReleasePreview;
}

/** `guard` is re-checked inside the UPDATE, so a report that lands between
 * the read and the write (the desktop updates) wins. */
async function mark(env: Env, config: ControlPlaneConfig, installationId: string, guard: string, bindings: unknown[], now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE installation_endpoints
        SET status = 'deleting',
            delete_requested_at = ?,
            reclaim_requested_at = NULL,
            cleanup_attempts = 0,
            last_cleanup_attempt_at = NULL,
            last_error_code = NULL,
            updated_at = ?
      WHERE installation_id = ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND EXISTS (
          SELECT 1
            FROM installation_endpoints e
            JOIN installations i ON i.id = e.installation_id
           WHERE e.installation_id = installation_endpoints.installation_id
             AND ${HELD_TUNNEL_SQL}
             AND ${guard}
        )`,
  ).bind(now, now, installationId, now, actedOnAccounts(config), ...bindings).run();
  return result.meta.changes > 0;
}

const VERSION_IN_SQL = "COALESCE(i.app_version, '') IN (SELECT value FROM json_each(?))";

/**
 * One bounded step, before the cleanup sweep: desktops below the minimum
 * version. With the switch off it only reads the counts it logs.
 */
export async function releaseTunnels(
  env: Env,
  config: ControlPlaneConfig,
  requestId: string,
  now = Date.now(),
): Promise<ReleaseSummary | null> {
  const policy = readTunnelPolicy(env);
  let rows: VersionRow[];
  try {
    rows = await heldByVersion(env, config, now);
  } catch {
    // Migration 0016 is not applied yet: nothing is released.
    return null;
  }
  const summary: ReleaseSummary = {
    marked: { min_version: 0 },
    preview: preview(rows, policy),
  };
  // Never more waiting for cleanup than one sweep removes: while the sweep is
  // failing or rate-limited its queue stays full and nothing more is marked,
  // so no owner is left with a row it cannot take back. A forced removal
  // whose tunnel was still connected after its cleanup rounds is not a failing
  // sweep: it backs off and retries on its own, and does not hold the queue.
  const queued = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM installation_endpoints e
      WHERE e.status = 'deleting' AND ${ACTED_ON_ENDPOINT_SQL}
        AND NOT (e.reclaim_requested_at IS NULL AND COALESCE(e.last_error_code, '') IN (SELECT value FROM json_each(?)))`,
  ).bind(actedOnAccounts(config), STILL_CONNECTED_CODES).first<{ count: number }>();
  let budget = Math.max(0, Math.min(RELEASE_MARK_LIMIT, config.capacity.cleanupSweepLimit) - (queued?.count ?? 0));
  const versions = rows.map((row) => row.version);
  const below = JSON.stringify(versions.filter((each) => belowMinimum(policy, each)));

  const run = async (reason: ReleaseReason, guard: string, bindings: unknown[]) => {
    if (budget <= 0) return;
    const found = await env.DB.prepare(
      `SELECT e.installation_id
         FROM installation_endpoints e
         JOIN installations i ON i.id = e.installation_id
        WHERE ${HELD_TUNNEL_SQL}
          AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= ?)
          AND ${guard}
        ORDER BY e.updated_at ASC, e.installation_id ASC
        LIMIT ?`,
    ).bind(actedOnAccounts(config), now, ...bindings, budget)
      .all<Candidate>();
    for (const row of found.results) {
      if (budget <= 0) break;
      if (await mark(env, config, row.installation_id, guard, bindings, now)) {
        budget -= 1;
        summary.marked[reason] += 1;
      }
    }
  };

  if (policy.minAppVersion !== null) {
    await run("min_version", `${VERSION_IN_SQL} AND ${SEEN_LATELY_SQL}`, [below, now - SEEN_FRESH_MS]);
  }

  console.log(JSON.stringify({
    message: "managed endpoint tunnel release",
    requestId,
    minAppVersion: policy.minAppVersion !== null,
    marked: summary.marked,
    eligible: summary.preview,
  }));
  return summary;
}
