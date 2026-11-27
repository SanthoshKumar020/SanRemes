import { isOwnerOrAdmin, type SessionState } from "./session";

export interface PairingOffer {
  id: string;
  code: string;
  expiresAt: number;
  url: string | null;
  hint: string | null;
}

/**
 * Security: only the owner on its own machine or an admin session may pair; a chat-only session must not even see the
 * offer.
 */
export function canPairDevices(state: SessionState | null): boolean {
  return isOwnerOrAdmin(state);
}

export function pairingBlockedReason(state: SessionState | null): "chat-only" | null {
  return state?.kind === "session" && !state.scopes.includes("admin") ? "chat-only" : null;
}

/** The link another computer pastes into Connect to another computer, and the address it names: the server's own link, else one made from the shared address. */
export function computerLink(offer: Pick<PairingOffer, "url" | "code">, address: string | null): { link: string; address: string } | null {
  const link = offer.url ?? (address ? `${address}/pair#code=${offer.code}` : null);
  if (!link) return null;
  try {
    return { link, address: new URL(link).origin };
  } catch {
    return null;
  }
}
