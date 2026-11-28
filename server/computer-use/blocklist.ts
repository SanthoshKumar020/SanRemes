/** High-risk destinations the agent browser never acts on, whatever a page asks. A bare domain covers its
 * subdomains, so `chase.com` also covers `login.chase.com`; an entry never covers a different registrable
 * domain, so `notchase.com` stays outside it. */
export type BlocklistCategory = "banking" | "finance" | "email-settings" | "password-manager" | "government-id";

export interface BlocklistEntry {
  domain: string;
  category: BlocklistCategory;
}

export const BLOCKED_CATEGORIES: readonly BlocklistCategory[] = ["banking", "finance", "email-settings", "password-manager", "government-id"];

export const DEFAULT_BLOCKLIST: readonly BlocklistEntry[] = [
  { domain: "chase.com", category: "banking" },
  { domain: "bankofamerica.com", category: "banking" },
  { domain: "wellsfargo.com", category: "banking" },
  { domain: "citi.com", category: "banking" },
  { domain: "citibank.com", category: "banking" },
  { domain: "usbank.com", category: "banking" },
  { domain: "capitalone.com", category: "banking" },
  { domain: "hsbc.com", category: "banking" },
  { domain: "barclays.com", category: "banking" },
  { domain: "barclays.co.uk", category: "banking" },
  { domain: "lloydsbank.com", category: "banking" },
  { domain: "natwest.com", category: "banking" },
  { domain: "santander.com", category: "banking" },
  { domain: "santander.co.uk", category: "banking" },
  { domain: "americanexpress.com", category: "banking" },
  { domain: "amex.com", category: "banking" },
  { domain: "discover.com", category: "banking" },
  { domain: "icicibank.com", category: "banking" },
  { domain: "hdfcbank.com", category: "banking" },
  { domain: "sbi.co.in", category: "banking" },
  { domain: "onlinesbi.com", category: "banking" },
  { domain: "axisbank.com", category: "banking" },
  { domain: "kotak.com", category: "banking" },
  { domain: "yesbank.in", category: "banking" },
  { domain: "pnb.co.in", category: "banking" },
  { domain: "fidelity.com", category: "finance" },
  { domain: "schwab.com", category: "finance" },
  { domain: "vanguard.com", category: "finance" },
  { domain: "robinhood.com", category: "finance" },
  { domain: "etrade.com", category: "finance" },
  { domain: "interactivebrokers.com", category: "finance" },
  { domain: "ibkr.com", category: "finance" },
  { domain: "coinbase.com", category: "finance" },
  { domain: "binance.com", category: "finance" },
  { domain: "kraken.com", category: "finance" },
  { domain: "paypal.com", category: "finance" },
  { domain: "stripe.com", category: "finance" },
  { domain: "wise.com", category: "finance" },
  { domain: "revolut.com", category: "finance" },
  { domain: "myaccount.google.com", category: "email-settings" },
  { domain: "account.google.com", category: "email-settings" },
  { domain: "myaccount.microsoft.com", category: "email-settings" },
  { domain: "account.microsoft.com", category: "email-settings" },
  { domain: "account.live.com", category: "email-settings" },
  { domain: "appleid.apple.com", category: "email-settings" },
  { domain: "account.yahoo.com", category: "email-settings" },
  { domain: "1password.com", category: "password-manager" },
  { domain: "lastpass.com", category: "password-manager" },
  { domain: "bitwarden.com", category: "password-manager" },
  { domain: "vault.bitwarden.com", category: "password-manager" },
  { domain: "dashlane.com", category: "password-manager" },
  { domain: "keeper.io", category: "password-manager" },
  { domain: "keepersecurity.com", category: "password-manager" },
  { domain: "nordpass.com", category: "password-manager" },
  { domain: "enpass.io", category: "password-manager" },
  { domain: "roboform.com", category: "password-manager" },
  { domain: "ssa.gov", category: "government-id" },
  { domain: "irs.gov", category: "government-id" },
  { domain: "login.gov", category: "government-id" },
  { domain: "id.me", category: "government-id" },
  { domain: "uidai.gov.in", category: "government-id" },
  { domain: "passportindia.gov.in", category: "government-id" },
  { domain: "incometax.gov.in", category: "government-id" },
  { domain: "my.gov.au", category: "government-id" },
  { domain: "sign-in.service.gov.uk", category: "government-id" },
];

/** Lowercase, no trailing dot, no leading `www.`; anything else is left as written. */
export function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase().replace(/\.+$/u, "");
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/** Whether `host` is `entry` or a subdomain of it. */
export function hostMatchesEntry(host: string, entry: string): boolean {
  const name = normalizeHost(host);
  const base = normalizeHost(entry).replace(/^\*\./u, "");
  return name === base || name.endsWith(`.${base}`);
}

/** The blocklist category `host` falls under, or null when it is not listed. */
export function blockedCategory(host: string, entries: readonly BlocklistEntry[] = DEFAULT_BLOCKLIST): BlocklistCategory | null {
  return entries.find((entry) => hostMatchesEntry(host, entry.domain))?.category ?? null;
}

export interface BlocklistMatch {
  category: BlocklistCategory;
  domain: string;
  host: string;
}

/** The blocklist entry an http(s) address falls under, or null. Other schemes and unparseable addresses match
 * nothing here; the policy refuses them on their own terms. */
export function blocklistMatch(url: string, entries: readonly BlocklistEntry[] = DEFAULT_BLOCKLIST): BlocklistMatch | null {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    host = parsed.hostname;
  } catch {
    return null;
  }
  const entry = entries.find((candidate) => hostMatchesEntry(host, candidate.domain));
  return entry ? { category: entry.category, domain: entry.domain, host: normalizeHost(host) } : null;
}
