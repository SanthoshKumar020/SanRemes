// The admin settings file: the compliance-mode toggle, the Motion paid toggle and the Bot API IP allowlist, kept in
// admin-settings.json (0600) beside the other per-server files. The toggles default off and an empty allowlist means
// no restriction; neither is a certification: the toggles are controls over what the server keeps and what paid work it
// will attempt, not an attestation of anything.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";

export const ADMIN_SETTINGS_FILE = "admin-settings.json";

const settingsSchema = z.object({
  version: z.literal(1),
  /** Evidence-preserving mode: retention can only go up, never down, while it is on. */
  auditStrict: z.boolean(),
  /** Motion's paid video generation is allowed at all; off means every attempt is refused before any provider is called. */
  motionPaid: z.boolean(),
  /** Addresses that may call the Bot API at all; empty means no restriction. Each entry is an IP address or an IPv4 CIDR range. */
  botApiAllowlist: z.array(z.string()).default([]),
}).strict();

export type AdminSettings = z.infer<typeof settingsSchema>;

export const DEFAULT_ADMIN_SETTINGS: AdminSettings = { version: 1, auditStrict: false, motionPaid: false, botApiAllowlist: [] };

export function createAdminSettingsStore(dataDir: string) {
  const file = join(dataDir, ADMIN_SETTINGS_FILE);
  const read = (): AdminSettings => {
    try {
      const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (parsed.success) return parsed.data;
      console.warn(`admin settings: ${file} is not a settings file; using defaults`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`admin settings: ${file} is unreadable; using defaults`);
    }
    return { ...DEFAULT_ADMIN_SETTINGS };
  };
  return {
    read,
    save(patch: Partial<Pick<AdminSettings, "auditStrict" | "motionPaid" | "botApiAllowlist">>): AdminSettings {
      const next = { ...read(), ...patch, version: 1 as const };
      writeFileAtomic(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      return next;
    },
  };
}

export type AdminSettingsStore = ReturnType<typeof createAdminSettingsStore>;
