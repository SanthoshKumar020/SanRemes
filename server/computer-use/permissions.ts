import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { PermissionState } from "./policy.ts";

export type GrantState = "granted" | "denied";

export interface PermissionGrant {
  origin: string;
  state: GrantState;
  app?: string;
  grantedAt: number;
  expiresAt?: number;
}

/** The origin an http(s) address belongs to, or null for anything else. */
export function siteOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function isExpired(grant: PermissionGrant, now: number): boolean {
  return grant.expiresAt !== undefined && grant.expiresAt <= now;
}

function isGrant(value: unknown): value is PermissionGrant {
  if (value === null || typeof value !== "object") return false;
  const grant = value as Record<string, unknown>;
  return (
    typeof grant.origin === "string" &&
    siteOrigin(grant.origin) === grant.origin &&
    (grant.state === "granted" || grant.state === "denied") &&
    typeof grant.grantedAt === "number" &&
    (grant.app === undefined || typeof grant.app === "string") &&
    (grant.expiresAt === undefined || typeof grant.expiresAt === "number")
  );
}

/** Per-site Computer Use permission: one grant per origin, granted or denied until revoked or expired.
 * A grant never covers a sensitive action; those always ask the person, through the action gate. */
export class ComputerUsePermissions {
  readonly #grants = new Map<string, PermissionGrant>();

  /** The stored state for an address's origin; an expired grant reads as never asked. */
  status(url: string, now: number = Date.now()): PermissionState {
    const origin = siteOrigin(url);
    if (origin === null) return "prompt";
    const grant = this.#grants.get(origin);
    if (!grant) return "prompt";
    if (isExpired(grant, now)) {
      this.#grants.delete(origin);
      return "prompt";
    }
    return grant.state;
  }

  grant(url: string, options: { app?: string; ttlMs?: number; now?: number } = {}): PermissionGrant | null {
    return this.#set(url, "granted", options);
  }

  deny(url: string, options: { app?: string; ttlMs?: number; now?: number } = {}): PermissionGrant | null {
    return this.#set(url, "denied", options);
  }

  #set(url: string, state: GrantState, options: { app?: string; ttlMs?: number; now?: number }): PermissionGrant | null {
    const origin = siteOrigin(url);
    if (origin === null) return null;
    const now = options.now ?? Date.now();
    const grant: PermissionGrant = {
      origin,
      state,
      ...(options.app !== undefined ? { app: options.app } : {}),
      grantedAt: now,
      ...(options.ttlMs !== undefined ? { expiresAt: now + options.ttlMs } : {}),
    };
    this.#grants.set(origin, grant);
    return grant;
  }

  /** Drops the grant for an address's origin, if one was stored. */
  revoke(url: string): boolean {
    const origin = siteOrigin(url);
    return origin === null ? false : this.#grants.delete(origin);
  }

  clear(): void {
    this.#grants.clear();
  }

  grants(now: number = Date.now()): PermissionGrant[] {
    return [...this.#grants.values()].filter((grant) => !isExpired(grant, now)).sort((a, b) => (a.origin < b.origin ? -1 : 1));
  }

  toJSON(): PermissionGrant[] {
    return this.grants();
  }

  static fromJSON(value: unknown): ComputerUsePermissions {
    const store = new ComputerUsePermissions();
    if (Array.isArray(value)) for (const entry of value) if (isGrant(entry)) store.#grants.set(entry.origin, entry);
    return store;
  }

  /** Writes the grants as JSON only the owner can read. */
  save(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(this.toJSON(), null, 2)}\n`, { mode: 0o600 });
  }

  /** Reads grants written by save; a missing file means no grants yet, a corrupt one is refused outright. */
  static load(file: string): ComputerUsePermissions {
    if (!existsSync(file)) return new ComputerUsePermissions();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`Computer Use permissions at ${file} are not valid JSON.`);
    }
    return ComputerUsePermissions.fromJSON(parsed);
  }
}
