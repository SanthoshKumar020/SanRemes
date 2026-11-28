// Duet's routes, registered in server/index.ts. Owner or admin only. Approving an offer records the
// approval and returns the exact action; Duet itself sends, messages and pays
// nothing, so the approved action is carried out by the caller through the
// existing approval-gated surfaces. The attention list here is composed from
// failed or missed routine runs and the items needing the person; emails and
// calendar meetings join it once the brief watch cache is exposed as a read
// (the Duet managed agent already composes the full list in its own turn).
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import type { DuetAttentionList } from "../duet/attention.ts";
import type { DuetStore } from "../duet/store.ts";
import { PASS, type RouteHandler } from "./table.ts";

const OFFER_PATH = /^\/api\/duet\/offers\/([\w:.-]{1,256})\/(approve|decline)$/u;

export interface DuetRouteDeps {
  attention(): DuetAttentionList;
  store: DuetStore;
}

const actorOf = (auth: RequestAuth): string =>
  auth.kind === "session" ? (auth.session.email ?? auth.session.label) : "owner";

export function createDuetRoutes(deps: DuetRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (path === "/api/duet/attention") {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner or an admin can read the attention list." });
      const list = deps.attention();
      deps.store.saveList(list);
      return json(res, 200, { composedAt: list.composedAt, items: list.items, offers: deps.store.pending() });
    }
    const match = OFFER_PATH.exec(path);
    if (!match) return PASS;
    if (method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!ownerOrAdmin(auth)) return json(res, 403, { error: "Only the owner or an admin can decide an offer." });
    const id = match[1]!;
    const decided = match[2] === "approve" ? deps.store.approve(id, actorOf(auth)) : deps.store.decline(id, actorOf(auth));
    if (!decided.ok) {
      const status = decided.reason === "not-found" ? 404 : decided.reason === "expired" ? 410 : 409;
      const message = decided.reason === "not-found"
        ? "No such offer."
        : decided.reason === "expired"
          ? "That offer expired. Ask Duet to compose a fresh attention list."
          : "That offer was already decided.";
      return json(res, status, { error: message });
    }
    return json(res, 200, {
      offer: decided.offer,
      ...(decided.offer.status === "approved"
        ? { approvedAction: decided.offer.exactAction, note: "Approved. Duet does not send, message or pay; carry out exactly this action through the approval-gated surface." }
        : {}),
    });
  };
}
