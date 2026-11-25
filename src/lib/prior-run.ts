// Read before main.tsx's first-paint writes: applySkin stamps sanremes-skin on every boot.
const PRIOR_RUN_KEYS = ["sanremes-skin", "sanremes-installed", "sanremes-email-gate", "sanremes-drafts", "sanremes-show-threads"];

export function hasPriorRun(store: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return PRIOR_RUN_KEYS.some((key) => store?.getItem(key) != null);
  } catch {
    return false;
  }
}
