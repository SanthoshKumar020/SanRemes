// Managed agents: a named definition (bot, instructions, schedule or trigger, allowed
// tools, spend caps) with run history, pause and resume, and plain-words failure
// reporting. The definition is executor-agnostic: a run executes through the executor
// the hand-off decision resolves, local today and a Cloud executor when one is attached.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { AgentExecutor } from "./executors.ts";
import type { Routine } from "./routines.ts";
import { readUsage, type UsageRow } from "./usage-ledger.ts";
import type {
  HandoffPreference, ManagedAgent, ManagedAgentOutcomes, ManagedAgentRun, ManagedAgentSchedule,
  ManagedAgentSummary,
} from "../shared/managed-agents.ts";

export const MANAGED_AGENTS_FILE = "managed-agents.json";
const MAX_RUNS = 2_000;
const MAX_RESULT_CHARS = 500;

const scheduleSchema = z.union([
  z.object({ type: z.literal("manual") }).strict(),
  z.object({ type: z.literal("daily"), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u), days: z.array(z.number().int().min(0).max(6)).min(1).optional() }).strict(),
  z.object({ type: z.literal("interval"), everyMinutes: z.number().int().min(5).max(1440) }).strict(),
  z.object({ type: z.literal("routine") }).strict(),
]);
const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  botId: z.string(),
  instructions: z.string(),
  schedule: scheduleSchema,
  routineId: z.string().optional(),
  allowedTools: z.array(z.string()),
  capUsd: z.number().positive().optional(),
  capTokens: z.number().int().positive().optional(),
  capPeriod: z.enum(["day", "month"]),
  project: z.string().min(1).max(100).optional(),
  afterRun: z.object({ agentId: z.string(), when: z.enum(["completed", "always"]) }).strict().optional(),
  pendingChain: z.array(z.string()).optional(),
  enabled: z.boolean(),
  executorPreference: z.enum(["auto", "local", "cloud"]),
  nextRunAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();
const runSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  status: z.enum(["completed", "failed", "stopped"]),
  executor: z.enum(["local", "cloud"]),
  manual: z.boolean(),
  startedAt: z.number(),
  finishedAt: z.number(),
  durationMs: z.number(),
  model: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().nullable().optional(),
  usageReported: z.boolean(),
  result: z.string().optional(),
  error: z.string().optional(),
}).strict();
const agentsFileSchema = z.object({ version: z.literal(1), agents: z.array(agentSchema), runs: z.array(runSchema) }).strict();

export interface ManagedAgentInput {
  name: string;
  botId: string;
  instructions: string;
  schedule?: ManagedAgentSchedule;
  routineId?: string;
  allowedTools?: string[];
  capUsd?: number;
  capTokens?: number;
  capPeriod?: "day" | "month";
  project?: string;
  afterRun?: { agentId: string; when: "completed" | "always" };
  enabled?: boolean;
  executorPreference?: HandoffPreference;
}

export interface ManagedAgentPatch {
  name?: string;
  instructions?: string;
  schedule?: ManagedAgentSchedule;
  allowedTools?: string[];
  capUsd?: number | null;
  capTokens?: number | null;
  capPeriod?: "day" | "month";
  project?: string | null;
  afterRun?: { agentId: string; when: "completed" | "always" } | null;
  enabled?: boolean;
  executorPreference?: HandoffPreference;
}

/** What an agent's runs add up to: counts, success rate, average duration and total cost. */
export function outcomeSummary(runs: readonly ManagedAgentRun[]): ManagedAgentOutcomes {
  const completed = runs.filter((run) => run.status === "completed").length;
  const failed = runs.filter((run) => run.status === "failed").length;
  const stopped = runs.filter((run) => run.status === "stopped").length;
  const ended = completed + failed + stopped;
  const cost = runs.reduce<number | null>((sum, run) => (typeof run.costUsd === "number" ? (sum ?? 0) + run.costUsd : sum), null);
  return {
    runs: runs.length,
    completed,
    failed,
    stopped,
    successRate: ended ? completed / ended : null,
    avgDurationMs: runs.length ? Math.round(runs.reduce((sum, run) => sum + run.durationMs, 0) / runs.length) : null,
    totalCostUsd: cost,
    totalInputTokens: runs.reduce((sum, run) => sum + (run.inputTokens ?? 0), 0),
    totalOutputTokens: runs.reduce((sum, run) => sum + (run.outputTokens ?? 0), 0),
  };
}

/** The next local run of a daily schedule, or null when no day is allowed. */
export function nextDailyRun(time: string, days: number[] | undefined, from: number): number | null {
  const [hour, minute] = time.split(":").map(Number);
  const allowed = days === undefined ? new Set([0, 1, 2, 3, 4, 5, 6]) : new Set(days);
  for (let offset = 0; offset < 8; offset += 1) {
    const day = new Date(from + offset * 86_400_000);
    if (!allowed.has(day.getDay())) continue;
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0).getTime();
    if (at > from) return at;
  }
  return null;
}

export function nextManagedAgentRun(schedule: ManagedAgentSchedule, from: number): number | null {
  if (schedule.type === "daily") return nextDailyRun(schedule.time, schedule.days, from);
  if (schedule.type === "interval") return from + schedule.everyMinutes * 60_000;
  return null;
}

/** The agent schedule a routine's schedule maps to, or `routine` when the agent follows
 * the routine's own firing instead of keeping a schedule of its own. */
export function scheduleFromRoutine(routine: Pick<Routine, "schedule">): ManagedAgentSchedule {
  const schedule = routine.schedule;
  if (schedule.type === "daily") {
    const allDays = schedule.weekdays.length === 7;
    return { type: "daily", time: schedule.time, ...(allDays ? {} : { days: [...schedule.weekdays] }) };
  }
  if (schedule.type === "interval" && !schedule.window && schedule.endsAt === undefined) {
    return { type: "interval", everyMinutes: schedule.everyMinutes };
  }
  return { type: "routine" };
}

export class ManagedAgentStore {
  private readonly file: string;
  private readonly now: () => number;
  private cache: { agents: ManagedAgent[]; runs: ManagedAgentRun[] } | null = null;

  constructor(options: { dataDir: string; now?: () => number }) {
    this.file = join(options.dataDir, MANAGED_AGENTS_FILE);
    this.now = options.now ?? Date.now;
  }

  private read(): { agents: ManagedAgent[]; runs: ManagedAgentRun[] } {
    if (this.cache) return this.cache;
    let state = { agents: [] as ManagedAgent[], runs: [] as ManagedAgentRun[] };
    if (existsSync(this.file)) {
      try {
        const parsed = agentsFileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
        state = { agents: parsed.agents, runs: parsed.runs };
      } catch {
        console.warn("managed agents: managed-agents.json could not be read; past agents are not listed");
      }
    }
    this.cache = state;
    return state;
  }

  private write(state: { agents: ManagedAgent[]; runs: ManagedAgentRun[] }): void {
    const parsed = agentsFileSchema.parse({ version: 1, ...state });
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`);
    this.cache = parsed;
  }

  list(): ManagedAgent[] {
    return structuredClone(this.read().agents);
  }

  get(id: string): ManagedAgent | null {
    const agent = this.read().agents.find((one) => one.id === id);
    return agent ? structuredClone(agent) : null;
  }

  summaries(): ManagedAgentSummary[] {
    const { agents, runs } = this.read();
    return agents.map((agent) => {
      const own = runs.filter((run) => run.agentId === agent.id);
      const lastRun = own.length ? structuredClone(own.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a))) : null;
      return {
        agent: structuredClone(agent),
        lastRun,
        runs: own.length,
        failures: own.filter((run) => run.status === "failed").length,
        outcomes: outcomeSummary(own),
      };
    });
  }

  /** Takes the chain a queued run belongs to, clearing it: the run consumes the chain it was queued by. */
  consumeChain(id: string): string[] {
    const state = this.read();
    const agent = state.agents.find((one) => one.id === id);
    if (!agent) return [];
    const chain = agent.pendingChain ?? [];
    if (agent.pendingChain !== undefined) {
      delete agent.pendingChain;
      this.write(state);
    }
    return chain;
  }

  /** Queues the target to run now as the next hop of a chain. False when the chain may not continue: no such agent,
   * a disabled one, the source itself, a repeat, or a sixth hop. */
  queueChained(sourceId: string, targetId: string, chain: readonly string[]): boolean {
    if (sourceId === targetId) return false;
    const next = [...chain, sourceId];
    if (next.length > 5 || next.includes(targetId)) return false;
    const state = this.read();
    const target = state.agents.find((one) => one.id === targetId);
    if (!target || !target.enabled) return false;
    target.nextRunAt = this.now();
    target.pendingChain = next;
    this.write(state);
    return true;
  }

  runsFor(agentId: string): ManagedAgentRun[] {
    return structuredClone(this.read().runs.filter((run) => run.agentId === agentId))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Every run of every agent, newest first: the usage report's run records. */
  allRuns(): ManagedAgentRun[] {
    return structuredClone(this.read().runs).sort((a, b) => b.startedAt - a.startedAt);
  }

  create(input: ManagedAgentInput): ManagedAgent {
    const name = input.name.trim();
    if (!name) throw new Error("Give the agent a name.");
    if (!input.botId.trim()) throw new Error("Choose the bot this agent runs as.");
    if (!input.instructions.trim()) throw new Error("Write what this agent should do.");
    const schedule = input.schedule ?? { type: "manual" as const };
    const at = this.now();
    const agent: ManagedAgent = {
      id: randomUUID(),
      name,
      botId: input.botId.trim(),
      instructions: input.instructions.trim(),
      schedule,
      ...(input.routineId ? { routineId: input.routineId } : {}),
      allowedTools: [...new Set((input.allowedTools ?? []).map((tool) => tool.trim()).filter(Boolean))],
      ...(input.capUsd !== undefined ? { capUsd: input.capUsd } : {}),
      ...(input.capTokens !== undefined ? { capTokens: input.capTokens } : {}),
      ...(input.project ? { project: input.project.trim() } : {}),
      ...(input.afterRun ? { afterRun: input.afterRun } : {}),
      capPeriod: input.capPeriod ?? "month",
      enabled: input.enabled ?? true,
      executorPreference: input.executorPreference ?? "auto",
      nextRunAt: schedule.type === "routine" ? null : nextManagedAgentRun(schedule, at),
      createdAt: at,
      updatedAt: at,
    };
    const state = this.read();
    state.agents.unshift(agent);
    this.write(state);
    return structuredClone(agent);
  }

  createFromRoutine(routine: Pick<Routine, "id" | "name" | "prompt" | "botId" | "schedule" | "enabled">): ManagedAgent {
    const schedule = scheduleFromRoutine(routine);
    return this.create({
      name: routine.name,
      botId: routine.botId,
      instructions: routine.prompt,
      schedule,
      routineId: routine.id,
      enabled: routine.enabled,
    });
  }

  update(id: string, patch: ManagedAgentPatch): ManagedAgent | null {
    const state = this.read();
    const agent = state.agents.find((one) => one.id === id);
    if (!agent) return null;
    const at = this.now();
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error("Give the agent a name.");
      agent.name = patch.name.trim();
    }
    if (patch.instructions !== undefined) {
      if (!patch.instructions.trim()) throw new Error("Write what this agent should do.");
      agent.instructions = patch.instructions.trim();
    }
    if (patch.schedule !== undefined) agent.schedule = patch.schedule;
    if (patch.allowedTools !== undefined) {
      agent.allowedTools = [...new Set(patch.allowedTools.map((tool) => tool.trim()).filter(Boolean))];
    }
    if (patch.capUsd !== undefined) {
      if (patch.capUsd === null) delete agent.capUsd;
      else agent.capUsd = patch.capUsd;
    }
    if (patch.capTokens !== undefined) {
      if (patch.capTokens === null) delete agent.capTokens;
      else agent.capTokens = patch.capTokens;
    }
    if (patch.capPeriod !== undefined) agent.capPeriod = patch.capPeriod;
    if (patch.project !== undefined) {
      if (patch.project === null) delete agent.project;
      else agent.project = patch.project.trim();
    }
    if (patch.afterRun !== undefined) {
      if (patch.afterRun === null) delete agent.afterRun;
      else agent.afterRun = patch.afterRun;
    }
    if (patch.enabled !== undefined) agent.enabled = patch.enabled;
    if (patch.executorPreference !== undefined) agent.executorPreference = patch.executorPreference;
    agent.nextRunAt = !agent.enabled || agent.schedule.type === "routine"
      ? null
      : nextManagedAgentRun(agent.schedule, at);
    agent.updatedAt = Math.max(at, agent.updatedAt + 1);
    this.write(state);
    return structuredClone(agent);
  }

  remove(id: string): boolean {
    const state = this.read();
    const at = state.agents.findIndex((one) => one.id === id);
    if (at === -1) return false;
    state.agents.splice(at, 1);
    state.runs = state.runs.filter((run) => run.agentId !== id);
    this.write(state);
    return true;
  }

  recordRun(run: ManagedAgentRun): ManagedAgentRun {
    const state = this.read();
    state.runs.push(run);
    if (state.runs.length > MAX_RUNS) {
      state.runs.sort((a, b) => a.startedAt - b.startedAt);
      state.runs.splice(0, state.runs.length - MAX_RUNS);
    }
    const agent = state.agents.find((one) => one.id === run.agentId);
    if (agent && agent.enabled && agent.schedule.type !== "routine") {
      agent.nextRunAt = nextManagedAgentRun(agent.schedule, run.finishedAt);
    }
    this.write(state);
    return structuredClone(run);
  }

  /** Agents whose own schedule is due, enabled and not already recorded as running now. */
  due(now = this.now()): ManagedAgent[] {
    return this.read().agents.filter(
      (agent) => agent.enabled && agent.schedule.type !== "routine" && agent.schedule.type !== "manual" &&
        agent.nextRunAt !== null && agent.nextRunAt <= now,
    );
  }
}

/** What one agent has spent in the ledger over a period, from the rows its runs booked. */
export function agentSpend(dataDir: string, agentId: string, period: "day" | "month", now = new Date()): { usd: number; tokens: number } {
  const start = period === "day"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = readUsage(dataDir, { from: start, to: now });
  let usd = 0;
  let tokens = 0;
  for (const row of rows) {
    if (row.trigger.kind !== "managed-agent" || row.trigger.agentId !== agentId) continue;
    usd += typeof row.costUsd === "number" ? row.costUsd : 0;
    tokens += Math.max(0, row.input - Math.min(row.cachedInput ?? 0, row.input)) + row.output;
  }
  return { usd, tokens };
}

export interface ManagedAgentRunnerDeps {
  store: ManagedAgentStore;
  dataDir: string;
  executor: AgentExecutor;
  now?: () => number;
  /** Books one ledger row; the runner books a row only when the executor reports usage, so a local turn's own row is never doubled. */
  bookUsage?: (row: Omit<UsageRow, "at">) => Promise<boolean>;
}

export function capStopReason(agent: ManagedAgent, spent: { usd: number; tokens: number }): string | null {
  if (agent.capUsd !== undefined && spent.usd >= agent.capUsd) {
    return `Stopped: this agent already spent $${spent.usd.toFixed(2)} this ${agent.capPeriod}, past its $${agent.capUsd.toFixed(2)} cap. Raise the cap or wait for the ${agent.capPeriod} to roll over.`;
  }
  if (agent.capTokens !== undefined && spent.tokens >= agent.capTokens) {
    return `Stopped: this agent already used ${spent.tokens.toLocaleString("en-US")} tokens this ${agent.capPeriod}, past its ${agent.capTokens.toLocaleString("en-US")}-token cap. Raise the cap or wait for the ${agent.capPeriod} to roll over.`;
  }
  return null;
}

/** Runs one agent once through its executor: a cap stop is recorded, never executed; a
 * failure is recorded in plain words; a success books its usage to the ledger. Throws
 * when the agent already has a run going. */
export async function runManagedAgent(
  deps: ManagedAgentRunnerDeps,
  agent: ManagedAgent,
  options: { manual: boolean },
): Promise<ManagedAgentRun> {
  if (runningAgents.has(agent.id)) throw new Error("This agent already has a run going. Wait for it to finish.");
  runningAgents.add(agent.id);
  const chain = deps.store.consumeChain(agent.id);
  try {
    const run = await runManagedAgentOnce(deps, agent, options);
    if (agent.afterRun && (agent.afterRun.when === "always" || run.status === "completed")) {
      deps.store.queueChained(agent.id, agent.afterRun.agentId, chain);
    }
    return run;
  } finally {
    runningAgents.delete(agent.id);
  }
}

const runningAgents = new Set<string>();

/** Whether the agent has a run going right now. */
export function managedAgentRunning(agentId: string): boolean {
  return runningAgents.has(agentId);
}

async function runManagedAgentOnce(
  deps: ManagedAgentRunnerDeps,
  agent: ManagedAgent,
  options: { manual: boolean },
): Promise<ManagedAgentRun> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const stop = capStopReason(agent, agentSpend(deps.dataDir, agent.id, agent.capPeriod, new Date(startedAt)));
  const finish = (partial: Omit<ManagedAgentRun, "id" | "agentId" | "startedAt">): ManagedAgentRun =>
    deps.store.recordRun({
      id: randomUUID(),
      agentId: agent.id,
      startedAt,
      ...partial,
    });
  if (stop) {
    return finish({
      status: "stopped", executor: deps.executor.kind, manual: options.manual,
      finishedAt: now(), durationMs: Math.max(0, now() - startedAt), usageReported: false, error: stop,
    });
  }
  try {
    const result = await deps.executor.runPrompt({ botId: agent.botId, prompt: agent.instructions });
    const reported = result.inputTokens !== undefined || result.outputTokens !== undefined || result.costUsd !== undefined;
    const run = finish({
      status: "completed", executor: deps.executor.kind, manual: options.manual,
      finishedAt: now(), durationMs: result.durationMs,
      ...(result.model ? { model: result.model } : {}),
      ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
      ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
      usageReported: reported,
      result: result.text.slice(0, MAX_RESULT_CHARS),
    });
    if (reported) {
      await deps.bookUsage?.({
        botId: agent.botId,
        botName: agent.name,
        threadId: "",
        instanceId: "",
        driverKind: deps.executor.kind,
        model: result.model ?? "unknown",
        input: result.inputTokens ?? 0,
        output: result.outputTokens ?? 0,
        costUsd: result.costUsd ?? null,
        trigger: { kind: "managed-agent", agentId: agent.id, agentName: agent.name, executor: deps.executor.kind, runId: run.id },
        ...(agent.project ? { project: agent.project } : {}),
      });
    }
    return run;
  } catch (error) {
    return finish({
      status: "failed", executor: deps.executor.kind, manual: options.manual,
      finishedAt: now(), durationMs: Math.max(0, now() - startedAt), usageReported: false,
      error: error instanceof Error ? error.message.slice(0, MAX_RESULT_CHARS) : "The run failed.",
    });
  }
}

/** Runs every due agent once, in name order; one agent's failure never stops the rest. */
export async function runDueManagedAgents(
  deps: ManagedAgentRunnerDeps,
  resolve: (agent: ManagedAgent) => AgentExecutor,
): Promise<ManagedAgentRun[]> {
  const due = deps.store.due().sort((a, b) => a.name.localeCompare(b.name));
  const runs: ManagedAgentRun[] = [];
  for (const agent of due) {
    try {
      runs.push(await runManagedAgent({ ...deps, executor: resolve(agent) }, agent, { manual: false }));
    } catch {
      continue;
    }
  }
  return runs;
}
