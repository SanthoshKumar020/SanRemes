// The admin surface for the enterprise tail: who may do what (server/team-capabilities.ts), retention policies,
// compliance-mode settings, the Bot API IP allowlist and the Motion paid toggle, plus one consolidated settings read
// and the compliance data (retention state, admin-action counts, Motion and allowlist state). Settings changes are
// owner-only; reading the audit posture is owner or admin. Retention changes are saved to config.json like every
// other setting; the decision-log and memory-journal prunes read the live config, so those two apply at the next
// restart, while usage retention is read fresh on each daily sweep.
import { z } from "zod";
import { join } from "node:path";

import { appendAdminAction, countAdminActions, type AdminActionRow } from "../admin-activity.ts";
import { createAdminSettingsStore, type AdminSettingsStore } from "../admin-settings.ts";
import { parseAllowlist } from "../bot-api-allowlist.ts";
import { DATA_DIR, loadConfig, saveConfig, threadEventLogRetentionDays, type AppConfig } from "../config.ts";
import { resolveRetentionDays, type DecisionActor } from "../decision-log.ts";
import { resolveMemoryJournalRetention } from "../memory-journal.ts";
import { generateMotion, createStubMotionProvider, motionStatus } from "../motion.ts";
import { createLocalMotionProvider, localMotionStatus } from "../motion-local.ts";
import type { RequestAuth } from "../request-auth.ts";
import { capabilityRefusal, may, roleOf, teamCapabilities } from "../team-capabilities.ts";
import { resolveUsageRetentionDays } from "../usage-ledger.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface AdminEnterpriseRouteDeps {
  dataDir: string;
  config(): AppConfig;
  save(patch: Parameters<typeof saveConfig>[0]): void;
  settings: AdminSettingsStore;
  env?: NodeJS.ProcessEnv;
}

const defaults = (): AdminEnterpriseRouteDeps => ({
  dataDir: DATA_DIR,
  config: loadConfig,
  save: (patch) => saveConfig(patch),
  settings: createAdminSettingsStore(DATA_DIR),
  env: process.env,
});

const retentionBody = z.object({
  decisionsDays: z.number().int().min(1).max(3650).nullable().optional(),
  memoryJournalDays: z.number().int().min(1).max(3650).nullable().optional(),
  usageDays: z.number().int().min(1).max(3650).nullable().optional(),
}).strict();
const complianceBody = z.object({ auditStrict: z.boolean() }).strict();
const allowlistBody = z.object({ allowlist: z.array(z.string()).max(1000) }).strict();
const motionBody = z.object({ paidEnabled: z.boolean() }).strict();
const generateBody = z.object({ prompt: z.string().min(1).max(20_000) }).strict();

const isJson = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
  String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";

function actorOf(auth: RequestAuth): DecisionActor {
  if (auth.kind === "loopback") return { kind: "loopback" };
  const session = auth.session;
  return { kind: "session", sessionId: session.id, label: session.label, ...(session.email ? { email: session.email } : {}) };
}

export function createAdminEnterpriseRoutes(deps: AdminEnterpriseRouteDeps = defaults()): RouteHandler {
  const env = deps.env ?? process.env;
  const retentionState = () => {
    const cfg = deps.config();
    return {
      decisions: resolveRetentionDays(cfg.decisions?.retentionDays, "SANREMES_DECISION_RETENTION_DAYS", env),
      memoryJournal: resolveMemoryJournalRetention(cfg.memoryJournal?.retentionDays, env),
      usage: resolveUsageRetentionDays(cfg.usage?.retentionDays, env),
      threadEventLogs: { days: threadEventLogRetentionDays(cfg), source: "config" as const },
      strict: deps.settings.read().auditStrict,
    };
  };
  const record = (auth: RequestAuth, row: Omit<AdminActionRow, "at" | "actor">) =>
    appendAdminAction(deps.dataDir, { ...row, actor: actorOf(auth) });
  const motionState = (settings: ReturnType<typeof deps.settings.read>) =>
    motionStatus(settings, localMotionStatus().available
      ? createLocalMotionProvider({ outDir: join(deps.dataDir, "motion") })
      : createStubMotionProvider());
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === "/api/admin/capabilities") {
      if (method !== "GET") return json(res, 405, { error: "Use GET." });
      const role = roleOf(auth);
      return json(res, 200, { role, capabilities: role === null ? [] : teamCapabilities(role) });
    }
    if (path === "/api/admin/retention") {
      if (method === "GET") {
        if (!may(auth, "audit.read")) return json(res, 403, { error: capabilityRefusal(auth, "audit.read") });
        const state = retentionState();
        return json(res, 200, { ...state, restartNeededFor: ["decisions", "memoryJournal"] });
      }
      if (method !== "PUT") return json(res, 405, { error: "Use GET or PUT." });
      if (!may(auth, "retention.change")) return json(res, 403, { error: capabilityRefusal(auth, "retention.change") });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = retentionBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send retention days (1–3650) or null to clear each one." });
      const body = parsed.data;
      if (body.decisionsDays === undefined && body.memoryJournalDays === undefined && body.usageDays === undefined) {
        return json(res, 400, { error: "Nothing to change." });
      }
      const state = retentionState();
      const changed: string[] = [];
      const patch: { decisions?: { retentionDays: number | null }; memoryJournal?: { retentionDays: number | null }; usage?: { retentionDays: number | null } } = {};
      const checks: Array<{ key: "decisionsDays" | "memoryJournalDays" | "usageDays"; section: "decisions" | "memoryJournal" | "usage"; current: number | null; source: string }> = [
        { key: "decisionsDays", section: "decisions", current: state.decisions.days, source: state.decisions.source },
        { key: "memoryJournalDays", section: "memoryJournal", current: state.memoryJournal.days, source: state.memoryJournal.source },
        { key: "usageDays", section: "usage", current: state.usage.days, source: state.usage.source },
      ];
      for (const check of checks) {
        const next = body[check.key];
        if (next === undefined) continue;
        if (check.source === "env") {
          const name = { decisions: "SANREMES_DECISION_RETENTION_DAYS", memoryJournal: "SANREMES_MEMORY_JOURNAL_RETENTION_DAYS", usage: "SANREMES_USAGE_RETENTION_DAYS" }[check.section];
          return json(res, 400, { error: `${name} is set in the environment; change it there.` });
        }
        if (next !== null && state.strict && next < (check.current ?? Number.POSITIVE_INFINITY)) {
          return json(res, 400, { error: "Strict mode is on: retention can only go up, never down. Switch strict mode off first." });
        }
        if (next === check.current) continue;
        patch[check.section] = { retentionDays: next };
        changed.push(check.section);
      }
      if (!changed.length) return json(res, 200, { ...retentionState(), restartNeededFor: ["decisions", "memoryJournal"], changed: [] });
      deps.save(patch as Parameters<typeof saveConfig>[0]);
      record(auth, { category: "config", action: "retention.update", changed });
      const restartNeededFor = changed.filter((section) => section === "decisions" || section === "memoryJournal");
      return json(res, 200, { ...retentionState(), restartNeededFor, changed });
    }
    if (path === "/api/admin/compliance") {
      if (method === "GET") {
        if (!may(auth, "audit.read")) return json(res, 403, { error: capabilityRefusal(auth, "audit.read") });
        const settings = deps.settings.read();
        return json(res, 200, {
          auditStrict: settings.auditStrict,
          retention: retentionState(),
          adminActionsThisMonth: countAdminActions(deps.dataDir),
          motion: motionState(settings),
          botApiAllowlistCount: settings.botApiAllowlist.length,
        });
      }
      if (method !== "PUT") return json(res, 405, { error: "Use GET or PUT." });
      if (!may(auth, "compliance.change")) return json(res, 403, { error: capabilityRefusal(auth, "compliance.change") });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = complianceBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send {\"auditStrict\": true | false}." });
      const saved = deps.settings.save({ auditStrict: parsed.data.auditStrict });
      record(auth, { category: "config", action: "compliance.update", changed: ["auditStrict"], after: { auditStrict: saved.auditStrict } });
      return json(res, 200, { auditStrict: saved.auditStrict });
    }
    if (path === "/api/admin/bot-api-allowlist") {
      if (method === "GET") {
        if (!may(auth, "audit.read")) return json(res, 403, { error: capabilityRefusal(auth, "audit.read") });
        return json(res, 200, { allowlist: deps.settings.read().botApiAllowlist });
      }
      if (method !== "PUT") return json(res, 405, { error: "Use GET or PUT." });
      if (!may(auth, "compliance.change")) return json(res, 403, { error: capabilityRefusal(auth, "compliance.change") });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = allowlistBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send {\"allowlist\": [\"203.0.113.5\", \"198.51.100.0/24\"]}." });
      const allowlist = parseAllowlist(parsed.data.allowlist);
      if (allowlist === null) return json(res, 400, { error: "Every entry must be an IP address or an IPv4 CIDR range." });
      const saved = deps.settings.save({ botApiAllowlist: allowlist });
      record(auth, { category: "bot-api", action: "bot-api.update", changed: ["botApiAllowlist"], after: { botApiAllowlist: saved.botApiAllowlist } });
      return json(res, 200, { allowlist: saved.botApiAllowlist });
    }
    if (path === "/api/admin/settings") {
      if (method !== "GET") return json(res, 405, { error: "Use GET." });
      if (!may(auth, "audit.read")) return json(res, 403, { error: capabilityRefusal(auth, "audit.read") });
      const role = roleOf(auth);
      const settings = deps.settings.read();
      return json(res, 200, {
        role,
        capabilities: role === null ? [] : teamCapabilities(role),
        retention: retentionState(),
        auditStrict: settings.auditStrict,
        motion: motionState(settings),
        botApiAllowlist: settings.botApiAllowlist,
      });
    }
    if (path === "/api/admin/motion") {
      if (method === "GET") {
        if (!may(auth, "audit.read")) return json(res, 403, { error: capabilityRefusal(auth, "audit.read") });
        const settings = deps.settings.read();
        return json(res, 200, motionState(settings));
      }
      if (method !== "PUT") return json(res, 405, { error: "Use GET or PUT." });
      if (!may(auth, "motion.change")) return json(res, 403, { error: capabilityRefusal(auth, "motion.change") });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = motionBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send {\"paidEnabled\": true | false}." });
      const saved = deps.settings.save({ motionPaid: parsed.data.paidEnabled });
      record(auth, { category: "config", action: "motion.update", changed: ["motionPaid"], after: { motionPaid: saved.motionPaid } });
      return json(res, 200, motionState(saved));
    }
    if (path === "/api/admin/motion/generate") {
      if (method !== "POST") return json(res, 405, { error: "Use POST." });
      if (!may(auth, "motion.change")) return json(res, 403, { error: capabilityRefusal(auth, "motion.change") });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = generateBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send {\"prompt\": \"…\"}." });
      const settings = deps.settings.read();
      if (localMotionStatus().available) {
        const result = await generateMotion(settings, parsed.data.prompt, createLocalMotionProvider({ outDir: join(deps.dataDir, "motion") }));
        if (result.ok) return json(res, 200, { file: result.file, provider: "local" });
        return json(res, 500, { error: result.reason });
      }
      const result = await generateMotion(settings, parsed.data.prompt);
      if (!settings.motionPaid) return json(res, 409, { error: result.reason });
      return json(res, 501, { error: result.reason });
    }
    return PASS;
  };
}
