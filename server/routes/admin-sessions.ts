// Signing members out from the admin surface: revoke one session by id, or end every session a member holds. Revoking
// is immediate; the next call on that session is refused. Only the owner may do it.
import { appendAdminAction, type AdminActionRow } from "../admin-activity.ts";
import type { DecisionActor } from "../decision-log.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface AdminSessionRouteDeps {
  dataDir: string;
  sessions: {
    revoke(id: string): boolean;
    revokeMember(email: string): number;
  };
  isOwner(auth: RequestAuth): boolean;
}

const REVOKE = /^\/api\/admin\/sessions\/([\w-]+)\/revoke$/;
const SIGN_OUT = /^\/api\/admin\/members\/([^/]+)\/sign-out$/;

function actorOf(auth: RequestAuth): DecisionActor {
  if (auth.kind === "loopback") return { kind: "loopback" };
  const session = auth.session;
  return { kind: "session", sessionId: session.id, label: session.label, ...(session.email ? { email: session.email } : {}) };
}

export function createAdminSessionRoutes(deps: AdminSessionRouteDeps): RouteHandler {
  const record = (auth: RequestAuth, row: Omit<AdminActionRow, "at" | "actor">) =>
    appendAdminAction(deps.dataDir, { ...row, actor: actorOf(auth) });
  return async ({ res, path, method, auth, json }) => {
    const revoke = REVOKE.exec(path);
    const signOut = SIGN_OUT.exec(path);
    if (!revoke && !signOut) return PASS;
    if (method !== "POST") return json(res, 405, { error: "Use POST." });
    if (!deps.isOwner(auth)) return json(res, 403, { error: "Only the owner can sign members out." });
    if (revoke) {
      const revoked = deps.sessions.revoke(revoke[1]!);
      if (!revoked) return json(res, 404, { error: "No such session." });
      record(auth, { category: "session", action: "session.revoke", changed: [revoke[1]!] });
      return json(res, 200, { ok: true, revoked: true });
    }
    let email: string;
    try {
      email = decodeURIComponent(signOut![1]!);
    } catch {
      return json(res, 400, { error: "That member address is not valid." });
    }
    const revoked = deps.sessions.revokeMember(email);
    record(auth, { category: "session", action: "member.sign-out", changed: [email] });
    return json(res, 200, { ok: true, revoked });
  };
}
