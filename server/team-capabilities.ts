// Who may do what on the admin surface, over the three team roles the Admin assigns (server/cloud-team.ts): owner,
// admin, member. The roles themselves come from the Admin's pairing claim; this file only says what each one may do
// here, so a future role the Admin issues maps onto the same table instead of needing a new check per route.
import type { TeamRole } from "./cloud-team.ts";
import type { RequestAuth } from "./request-auth.ts";

/** Read the audit log. */
export type AdminCapability =
  | "audit.read"
  | "audit.export"
  | "retention.change"
  | "compliance.change"
  | "motion.change";

const OWNER: readonly AdminCapability[] = ["audit.read", "audit.export", "retention.change", "compliance.change", "motion.change"];
const ADMIN: readonly AdminCapability[] = ["audit.read", "audit.export"];

/** What each team role may do on the admin surface. Retention and compliance settings change what evidence is kept,
// so only the owner changes them; an admin reads and exports the audit log but cannot rewrite its keeping. */
export function teamCapabilities(role: TeamRole): readonly AdminCapability[] {
  if (role === "owner") return OWNER;
  if (role === "admin") return ADMIN;
  return [];
}

/** The caller's team role, or null for a caller with no team role: a service-trust loopback caller (a bot's shell) or
 * a guest. A session with no team role but the admin scope is the server's owner (a personal Cloud, a paired owner
 * device); a session without it is a member. */
export function roleOf(auth: RequestAuth): TeamRole | null {
  if (auth.kind === "loopback") return auth.trust === "service" ? null : "owner";
  if (auth.session.teamRole) return auth.session.teamRole;
  return auth.scopes.includes("admin") ? "owner" : "member";
}

export function may(auth: RequestAuth, capability: AdminCapability): boolean {
  const role = roleOf(auth);
  return role !== null && teamCapabilities(role).includes(capability);
}

/** Plain words for a caller who may not do this; null when they may. */
export function capabilityRefusal(auth: RequestAuth, capability: AdminCapability): string | null {
  if (may(auth, capability)) return null;
  const role = roleOf(auth);
  if (role === "member") return "Only the owner or an admin may do that.";
  if (role === "admin") return "Only the owner may do that.";
  return "Only the owner or an admin may do that.";
}
