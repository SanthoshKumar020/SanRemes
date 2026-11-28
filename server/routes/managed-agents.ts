// Managed agents over HTTP: create one from scratch or from a routine, list them with
// their last run, pause and resume, run one now, read an agent's outcomes and its latest
// nightly digest, and read or change where work runs.
import { z } from "zod";

import type { RequestAuth } from "../request-auth.ts";
import { HandoffStore, type HandoffDecision } from "../cloud-handoff.ts";
import type { ExecutorRegistry } from "../executors.ts";
import {
  ManagedAgentStore, managedAgentRunning, outcomeSummary, runManagedAgent, type ManagedAgentPatch,
} from "../managed-agents.ts";
import type { ManagedAgentDigestStore } from "../managed-agent-digests.ts";
import type { Routine } from "../routines.ts";
import type { UsageRow } from "../usage-ledger.ts";
import type { HandoffPreference, ManagedAgent, ManagedAgentRun, ManagedAgentSchedule } from "../../shared/managed-agents.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ManagedAgentRouteDeps {
  store: ManagedAgentStore;
  handoff: HandoffStore;
  registry: ExecutorRegistry;
  dataDir: string;
  routines(): Routine[];
  botExists?(id: string): boolean;
  visible(auth: RequestAuth): { bot(botId: string): boolean };
  bookUsage(row: Omit<UsageRow, "at">): Promise<boolean>;
  /** Runs one agent once; the default runs it through the executor its preference resolves to. */
  runAgent?(agent: ManagedAgent, manual: boolean): Promise<ManagedAgentRun>;
  /** The nightly digest store; absent, the digest read answers that none is available. */
  digests?: ManagedAgentDigestStore;
}

const scheduleSchema = z.union([
  z.object({ type: z.literal("manual") }).strict(),
  z.object({ type: z.literal("daily"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u), days: z.array(z.number().int().min(0).max(6)).min(1).optional() }).strict(),
  z.object({ type: z.literal("interval"), everyMinutes: z.number().int().min(5).max(1440) }).strict(),
  z.object({ type: z.literal("routine") }).strict(),
]);
const createBody = z.object({
  name: z.string().min(1).max(200),
  botId: z.string().min(1).max(128),
  instructions: z.string().min(1).max(20_000),
  schedule: scheduleSchema.optional(),
  routineId: z.string().max(128).optional(),
  allowedTools: z.array(z.string().max(128)).max(100).optional(),
  capUsd: z.number().positive().max(1_000_000).optional(),
  capTokens: z.number().int().positive().max(1_000_000_000).optional(),
  capPeriod: z.enum(["day", "month"]).optional(),
  project: z.string().min(1).max(100).optional(),
  afterRun: z.object({ agentId: z.string().min(1).max(128), when: z.enum(["completed", "always"]) }).strict().optional(),
  enabled: z.boolean().optional(),
  executorPreference: z.enum(["auto", "local", "cloud"]).optional(),
}).strict();
const patchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  instructions: z.string().min(1).max(20_000).optional(),
  schedule: scheduleSchema.optional(),
  allowedTools: z.array(z.string().max(128)).max(100).optional(),
  capUsd: z.number().positive().max(1_000_000).nullable().optional(),
  capTokens: z.number().int().positive().max(1_000_000_000).nullable().optional(),
  capPeriod: z.enum(["day", "month"]).optional(),
  project: z.string().min(1).max(100).nullable().optional(),
  afterRun: z.object({ agentId: z.string().min(1).max(128), when: z.enum(["completed", "always"]) }).strict().nullable().optional(),
  enabled: z.boolean().optional(),
  executorPreference: z.enum(["auto", "local", "cloud"]).optional(),
}).strict();
const fromRoutineBody = z.object({ routineId: z.string().min(1).max(128) }).strict();
const handoffBody = z.object({ preference: z.enum(["auto", "local", "cloud"]) }).strict();
const AGENT_PATH = /^\/api\/managed-agents\/([\w-]{1,128})(\/run|\/pause|\/resume)?$/u;

const isJson = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
  String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";

export function createManagedAgentRoutes(deps: ManagedAgentRouteDeps): RouteHandler {
  const runAgent = deps.runAgent ?? ((agent: ManagedAgent, manual: boolean) =>
    runManagedAgent(
      { store: deps.store, dataDir: deps.dataDir, executor: deps.registry.resolve(agent.executorPreference).executor, bookUsage: deps.bookUsage },
      agent, { manual },
    ));
  const handoffState = (): HandoffDecision & { preference: HandoffPreference; cloudAttached: boolean } => {
    const preference = deps.handoff.preference();
    const decided = deps.handoff.decide(deps.registry.cloudAttached());
    return { preference, cloudAttached: deps.registry.cloudAttached(), ...decided };
  };
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === "/api/cloud-handoff") {
      if (method === "GET") return json(res, 200, handoffState());
      if (method !== "PUT") return json(res, 405, { error: "Use GET or PUT." });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = handoffBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Choose where work runs: auto, local, or cloud." });
      deps.handoff.setPreference(parsed.data.preference);
      return json(res, 200, handoffState());
    }
    if (path === "/api/managed-agents") {
      if (method === "GET") {
        const seen = deps.visible(auth);
        const agents = deps.store.summaries().filter((summary) => seen.bot(summary.agent.botId));
        return json(res, 200, { agents, handoff: handoffState() });
      }
      if (method !== "POST") return json(res, 405, { error: "Use GET or POST." });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = createBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send a name, a bot, and what the agent should do." });
      if (deps.botExists && !deps.botExists(parsed.data.botId)) return json(res, 404, { error: "No such bot." });
      try {
        const agent = deps.store.create(parsed.data as { name: string; botId: string; instructions: string; schedule?: ManagedAgentSchedule; routineId?: string; allowedTools?: string[]; capUsd?: number; capTokens?: number; capPeriod?: "day" | "month"; project?: string; afterRun?: { agentId: string; when: "completed" | "always" }; enabled?: boolean; executorPreference?: HandoffPreference });
        return json(res, 201, { agent });
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Could not create that agent." });
      }
    }
    if (path === "/api/managed-agents/from-routine" && method === "POST") {
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = fromRoutineBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send a routine id." });
      const routine = deps.routines().find((one) => one.id === parsed.data.routineId);
      if (!routine) return json(res, 404, { error: "No such routine." });
      if (!deps.visible(auth).bot(routine.botId)) return json(res, 404, { error: "No such routine." });
      if (deps.store.list().some((agent) => agent.routineId === routine.id)) {
        return json(res, 409, { error: "That routine already has a managed agent." });
      }
      return json(res, 201, { agent: deps.store.createFromRoutine(routine) });
    }
    const single = AGENT_PATH.exec(path);
    const outcomes = /^\/api\/managed-agents\/([\w-]{1,128})\/outcomes$/.exec(path);
    const digestPath = /^\/api\/managed-agents\/([\w-]{1,128})\/digest$/.exec(path);
    if (outcomes || digestPath) {
      const id = (outcomes ?? digestPath)![1]!;
      const agent = deps.store.get(id);
      if (!agent) return json(res, 404, { error: "No such managed agent." });
      if (!deps.visible(auth).bot(agent.botId)) return json(res, 404, { error: "No such managed agent." });
      if (method !== "GET") return json(res, 405, { error: "Use GET." });
      if (outcomes) {
        return json(res, 200, { agent, outcomes: outcomeSummary(deps.store.runsFor(id)), recent: deps.store.runsFor(id).slice(0, 10) });
      }
      const digest = deps.digests?.latest(id);
      if (!digest) return json(res, 404, { error: "No digest for this agent yet." });
      return json(res, 200, { digest });
    }
    if (!single) return PASS;
    const id = single[1]!;
    const agent = deps.store.get(id);
    if (!agent) return json(res, 404, { error: "No such managed agent." });
    if (!deps.visible(auth).bot(agent.botId)) return json(res, 404, { error: "No such managed agent." });
    if (method === "GET" && single[2] === undefined) {
      const routine = agent.routineId ? deps.routines().find((one) => one.id === agent.routineId) : undefined;
      return json(res, 200, {
        agent: routine && agent.schedule.type === "routine" ? { ...agent, nextRunAt: routine.nextRunAt } : agent,
        runs: deps.store.runsFor(id),
      });
    }
    if (method === "DELETE" && single[2] === undefined) {
      deps.store.remove(id);
      return json(res, 200, { removed: true });
    }
    if (method === "PATCH" && single[2] === undefined) {
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = patchBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "That change is not valid." });
      try {
        const updated = deps.store.update(id, parsed.data as ManagedAgentPatch);
        return json(res, 200, { agent: updated });
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : "Could not change that agent." });
      }
    }
    if (method === "POST" && single[2] === "/run") {
      if (!agent.enabled) return json(res, 409, { error: "That agent is paused. Resume it before running it." });
      if (managedAgentRunning(agent.id)) return json(res, 409, { error: "This agent already has a run going. Wait for it to finish." });
      void runAgent(agent, true).catch(() => {});
      return json(res, 202, { started: true, agentId: agent.id });
    }
    if (method === "POST" && (single[2] === "/pause" || single[2] === "/resume")) {
      const updated = deps.store.update(id, { enabled: single[2] === "/resume" });
      return json(res, 200, { agent: updated });
    }
    return json(res, 405, { error: "method not allowed" });
  };
}
