import { decideAction, type ComputerUseAction, type PolicyDecision } from "./policy.ts";
import { siteOrigin, type ComputerUsePermissions } from "./permissions.ts";

export interface ConfirmationRequest {
  id: string;
  action: ComputerUseAction;
  origin: string | null;
  reason: string;
  requestedAt: number;
}

/** Answers a confirmation request: true runs that one action only, never a standing approval. */
export type Confirmer = (request: ConfirmationRequest) => Promise<boolean>;

export interface GateOutcome {
  allowed: boolean;
  confirmed: boolean;
  reason: string;
  confirmationId?: string;
}

export interface GateRecord {
  at: number;
  kind: ComputerUseAction["kind"];
  url: string;
  decision: "allow" | "deny";
  confirmed: boolean;
  reason: string;
}

/** An unanswered confirmation stops asking after this long. */
export const PENDING_CONFIRMATION_TTL_MS = 5 * 60_000;

/** The most recent decisions kept, oldest dropped first. */
export const GATE_HISTORY_LIMIT = 100;

/**
 * The one place the browser driver asks before acting: it checks the policy, the stored site permission
 * and the blocklist, and a sensitive action only runs when the person confirms that exact action. With no
 * confirmer wired up, anything needing confirmation is denied rather than approved.
 */
export class ComputerUseGate {
  readonly #permissions: ComputerUsePermissions;
  #confirmer: Confirmer | null;
  readonly #pending = new Map<string, { request: ConfirmationRequest; resolve: (approved: boolean) => void }>();
  readonly #history: GateRecord[] = [];
  #counter = 0;

  constructor(permissions: ComputerUsePermissions, confirmer: Confirmer | null = null) {
    this.#permissions = permissions;
    this.#confirmer = confirmer;
  }

  setConfirmer(confirmer: Confirmer | null): void {
    this.#confirmer = confirmer;
  }

  /** The policy's answer for an action, without asking anyone. */
  check(action: ComputerUseAction): { decision: PolicyDecision; reason: string; origin: string | null } {
    const verdict = decideAction(action, this.#permissions.status(action.url));
    return { decision: verdict.decision, reason: verdict.reason, origin: siteOrigin(action.url) };
  }

  /** Asks the gate whether an action may run, confirming with the person when the policy says so. */
  async request(action: ComputerUseAction, now: number = Date.now()): Promise<GateOutcome> {
    const { decision, reason } = this.check(action);
    if (decision === "allow") {
      this.#record(action, "allow", false, reason, now);
      return { allowed: true, confirmed: false, reason };
    }
    if (decision === "deny") {
      this.#record(action, "deny", false, reason, now);
      return { allowed: false, confirmed: false, reason };
    }
    if (this.#confirmer === null) {
      const unanswered = "This action needs the person's confirmation, and no confirmation prompt is wired up.";
      this.#record(action, "deny", false, unanswered, now);
      return { allowed: false, confirmed: false, reason: unanswered };
    }
    const { request: confirmation, decided } = this.ask(action, reason, now);
    const confirmer = this.#confirmer;
    void Promise.resolve()
      .then(() => confirmer(confirmation))
      .then(
        (approved) => this.resolve(confirmation.id, approved),
        () => this.resolve(confirmation.id, false),
      );
    const approved = await decided;
    if (approved) {
      this.#record(action, "allow", true, reason, now);
      return { allowed: true, confirmed: true, reason, confirmationId: confirmation.id };
    }
    const declined = "The person declined this action.";
    this.#record(action, "deny", false, declined, now);
    return { allowed: false, confirmed: false, reason: declined, confirmationId: confirmation.id };
  }

  /** Opens a confirmation for the person to answer later; the returned promise settles on resolve. */
  ask(action: ComputerUseAction, reason: string, now: number = Date.now()): { request: ConfirmationRequest; decided: Promise<boolean> } {
    this.#counter += 1;
    const request: ConfirmationRequest = { id: `cu-${this.#counter}`, action, origin: siteOrigin(action.url), reason, requestedAt: now };
    let resolve!: (approved: boolean) => void;
    const decided = new Promise<boolean>((settle) => {
      resolve = settle;
    });
    this.#pending.set(request.id, { request, resolve });
    return { request, decided };
  }

  /** Answers an open confirmation; false when it is unknown or already expired. */
  resolve(id: string, approved: boolean, now: number = Date.now()): boolean {
    this.#prune(now);
    const entry = this.#pending.get(id);
    if (!entry) return false;
    this.#pending.delete(id);
    entry.resolve(approved);
    return true;
  }

  /** Open confirmations, oldest first; expired ones are settled as declined. */
  pending(now: number = Date.now()): ConfirmationRequest[] {
    this.#prune(now);
    return [...this.#pending.values()].map((entry) => entry.request).sort((a, b) => a.requestedAt - b.requestedAt);
  }

  history(): GateRecord[] {
    return [...this.#history];
  }

  #prune(now: number): void {
    for (const [id, entry] of this.#pending) {
      if (entry.request.requestedAt + PENDING_CONFIRMATION_TTL_MS <= now) {
        this.#pending.delete(id);
        entry.resolve(false);
      }
    }
  }

  #record(action: ComputerUseAction, decision: "allow" | "deny", confirmed: boolean, reason: string, now: number): void {
    this.#history.push({ at: now, kind: action.kind, url: action.url, decision, confirmed, reason });
    while (this.#history.length > GATE_HISTORY_LIMIT) this.#history.shift();
  }
}
