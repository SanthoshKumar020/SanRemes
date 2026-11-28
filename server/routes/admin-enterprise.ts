// The admin surface for the enterprise tail: who may do what (server/team-capabilities.ts), retention policies,
// compliance-mode settings and the Motion paid toggle. Settings changes are owner-only; reading the audit posture is
// owner or admin. Retention changes are saved to config.json like every other setting; the decision-log and
// memory-journal prunes read the live config, so those two apply at the next restart, while usage retention is read
// fresh on each daily sweep.
import { z } from "zod";

import { appendAdminAction, type AdminActionRow } from "../admin-activity.ts";
import { createAdminSettingsStore, type AdminSettingsStore } from "../admin-settings.ts";
import { DATA_DIR, loadConfig, saveConfig, threadEventLogRetentionDays, type AppConfig } from "../config.ts";
import { resolveRetentionDays, type DecisionActor } from "../decision-log.ts";
import { resolveMemoryJournalRetention } from "../memory-journal.ts";
import { generateMotion, motionStatus } from "../motion.ts";
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
        return json(res, 200, { auditStrict: deps.settings.read().auditStrict });
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
    if (path === "/api/admin/motion") {
      if (method === "GET") {
        if (!may(auth, "audit.read")) return json(res, 403, { error: capabilityRefusal(auth, "audit.read") });
        return json(res, 200, motionStatus(deps.settings.read()));
      }
      if (method !== "PUT") return json(res, 405, { error: "Use GET or PUT." });
      if (!may(auth, "motion.change")) return json(res, 403, { error: capabilityRefusal(auth, "motion.change") });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = motionBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send {\"paidEnabled\": true | false}." });
      const saved = deps.settings.save({ motionPaid: parsed.data.paidEnabled });
      record(auth, { category: "config", action: "motion.update", changed: ["motionPaid"], after: { motionPaid: saved.motionPaid } });
      return json(res, 200, motionStatus(saved));
    }
    if (path === "/api/admin/motion/generate") {
      if (method !== "POST") return json(res, 405, { error: "Use POST." });
      if (!may(auth, "motion.change")) return json(res, 403, { error: capabilityRefusal(auth, "motion.change") });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = generateBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send {\"prompt\": \"…\"}." });
      const settings = deps.settings.read();
      const result = await generateMotion(settings, parsed.data.prompt);
      if (!settings.motionPaid) return json(res, 409, { error: result.reason });
      return json(res, 501, { error: result.reason });
    }
    return PASS;
  };
}
