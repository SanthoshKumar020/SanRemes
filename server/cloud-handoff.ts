// Where work runs when it has a choice: this computer, the Cloud, or whichever is
// attached. The default is this computer until a cloud executor is attached; asking
// for the Cloud without one falls back to this computer and says so, never silently.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { ExecutorKind, HandoffPreference } from "../shared/managed-agents.ts";

export const HANDOFF_FILE = "cloud-handoff.json";

const handoffSchema = z.object({
  version: z.literal(1),
  preference: z.enum(["auto", "local", "cloud"]),
}).strict();

export interface HandoffDecision {
  executor: ExecutorKind;
  /** Plain words, when the preference could not be honoured. */
  note: string | null;
}

export function decideExecutor(preference: HandoffPreference, cloudAttached: boolean): HandoffDecision {
  if (preference === "local") return { executor: "local", note: null };
  if (preference === "cloud") {
    return cloudAttached
      ? { executor: "cloud", note: null }
      : {
        executor: "local",
        note: "No cloud executor is attached, so this runs on this computer instead. Attach SanRemes Cloud to run it there.",
      };
  }
  return cloudAttached ? { executor: "cloud", note: null } : { executor: "local", note: null };
}

export class HandoffStore {
  private readonly file: string;

  constructor(options: { dataDir: string }) {
    this.file = join(options.dataDir, HANDOFF_FILE);
  }

  preference(): HandoffPreference {
    if (!existsSync(this.file)) return "auto";
    try {
      return handoffSchema.parse(JSON.parse(readFileSync(this.file, "utf8"))).preference;
    } catch {
      return "auto";
    }
  }

  setPreference(preference: HandoffPreference): HandoffPreference {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(handoffSchema.parse({ version: 1, preference }), null, 2)}\n`);
    return preference;
  }

  decide(cloudAttached: boolean): HandoffDecision {
    return decideExecutor(this.preference(), cloudAttached);
  }
}
