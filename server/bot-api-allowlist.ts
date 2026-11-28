// The Bot API's IP allowlist: which addresses may call `POST /hooks/api/bots/<id>/messages` at all. An empty list means
// no restriction (the feature is off). Entries are single IPv4 or IPv6 addresses, or IPv4 CIDR ranges. The check runs
// before the bearer key is looked at, so a refused address learns nothing about any key.
import { isIP } from "node:net";

/** An IPv4-mapped IPv6 address (`::ffff:203.0.113.5`) is the same address as its IPv4 form. */
function normalizeIp(ip: string): string | null {
  let value = ip.trim().toLowerCase().replace(/%.*$/, "");
  if (value.startsWith("::ffff:")) value = value.slice("::ffff:".length);
  return isIP(value) === 0 ? null : value;
}

function ipv4Int(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255 || String(octet) !== part) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function matchesEntry(ip: string, entry: string): boolean {
  const normalizedEntry = entry.trim().toLowerCase();
  if (normalizedEntry.includes("/")) {
    const [base, prefixText] = normalizedEntry.split("/", 2);
    const prefix = Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    if (isIP(base!) !== 4) return false;
    const ipInt = ipv4Int(ip);
    const baseInt = ipv4Int(base!);
    if (ipInt === null || baseInt === null) return false;
    const mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  }
  const normalized = normalizeIp(normalizedEntry);
  return normalized !== null && normalized === ip;
}

export function isAllowedIp(ip: string | undefined | null, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  if (!ip) return false;
  const normalized = normalizeIp(ip);
  if (normalized === null) return false;
  return allowlist.some((entry) => matchesEntry(normalized, entry));
}

/** A cleaned allowlist, or null when any entry is not an IP address or an IPv4 CIDR range. */
export function parseAllowlist(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    if (trimmed.includes("/")) {
      const [base, prefixText] = trimmed.split("/", 2);
      const prefix = Number(prefixText);
      if (isIP(base!) !== 4 || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    } else if (isIP(trimmed) === 0) {
      return null;
    }
    if (!entries.includes(trimmed)) entries.push(trimmed);
  }
  return entries;
}
