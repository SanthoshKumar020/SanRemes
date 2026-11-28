// Duet's offers and their decisions, persisted in duet.json. Approving an
// offer records the approval and returns the exact action; it never sends,
// messages or pays anything itself — the caller carries the approved action
// out through the existing approval-gated surfaces.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import type { DuetActionOffer, DuetAttentionList } from "./attention.ts";

export const DUET_FILE = "duet.json";
export const OFFER_TTL_MS = 24 * 60 * 60_000;

const offerSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  kind: z.enum(["draft", "rerun", "open"]),
  label: z.string(),
  exactAction: z.string(),
  status: z.enum(["pending", "approved", "declined", "expired"]),
  createdAt: z.number(),
  decidedAt: z.number().optional(),
  decidedBy: z.string().optional(),
}).strict();
const storeSchema = z.object({
  version: z.literal(1),
  offers: z.array(offerSchema),
  lastComposedAt: z.number().optional(),
}).strict();

export type DuetOfferRecord = z.infer<typeof offerSchema>;
export type DuetDecisionResult =
  | { ok: true; offer: DuetOfferRecord }
  | { ok: false; reason: "not-found" | "already-decided" | "expired" };

export class DuetStore {
  private readonly file: string;
  private readonly now: () => number;
  private cache: z.infer<typeof storeSchema> | null = null;

  constructor(options: { dataDir: string; now?: () => number }) {
    this.file = join(options.dataDir, DUET_FILE);
    this.now = options.now ?? Date.now;
  }

  private read(): z.infer<typeof storeSchema> {
    if (this.cache) return this.cache;
    let state: z.infer<typeof storeSchema> = { version: 1, offers: [] };
    if (existsSync(this.file)) {
      try {
        state = storeSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      } catch {
        console.warn("duet: duet.json could not be read; past offers are not listed");
      }
    }
    this.cache = state;
    return state;
  }

  private write(state: z.infer<typeof storeSchema>): void {
    const parsed = storeSchema.parse(state);
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    this.cache = parsed;
  }

  /** Stores the list's offers as pending, keeping any decision already made on the same offer id. */
  saveList(list: DuetAttentionList): DuetOfferRecord[] {
    const state = this.read();
    const at = this.now();
    const fresh: DuetActionOffer[] = list.items.flatMap((item) => (item.offer ? [item.offer] : []));
    for (const offer of fresh) {
      if (state.offers.some((one) => one.id === offer.id)) continue;
      state.offers.push({ ...offer, status: "pending", createdAt: at });
    }
    state.lastComposedAt = list.composedAt;
    this.write(state);
    return this.offers();
  }

  offers(): DuetOfferRecord[] {
    return structuredClone(this.read().offers).sort((a, b) => b.createdAt - a.createdAt);
  }

  pending(): DuetOfferRecord[] {
    const at = this.now();
    return this.offers().filter((offer) => offer.status === "pending" && at - offer.createdAt <= OFFER_TTL_MS);
  }

  get(id: string): DuetOfferRecord | null {
    const offer = this.read().offers.find((one) => one.id === id);
    return offer ? structuredClone(offer) : null;
  }

  approve(id: string, decidedBy: string): DuetDecisionResult {
    return this.decide(id, "approved", decidedBy);
  }

  decline(id: string, decidedBy: string): DuetDecisionResult {
    return this.decide(id, "declined", decidedBy);
  }

  private decide(id: string, status: "approved" | "declined", decidedBy: string): DuetDecisionResult {
    const state = this.read();
    const offer = state.offers.find((one) => one.id === id);
    if (!offer) return { ok: false, reason: "not-found" };
    if (offer.status !== "pending") return { ok: false, reason: "already-decided" };
    if (this.now() - offer.createdAt > OFFER_TTL_MS) {
      offer.status = "expired";
      this.write(state);
      return { ok: false, reason: "expired" };
    }
    offer.status = status;
    offer.decidedAt = this.now();
    offer.decidedBy = decidedBy;
    this.write(state);
    return { ok: true, offer: structuredClone(offer) };
  }
}
