// Duet's scheduled run through the managed-agent runner: the local server
// is the offline-VM equivalent, so Duet runs as a managed agent on its daily
// schedule and the runner's own due-runner picks it up.
import type { AgentExecutor } from "../executors.ts";
import { runManagedAgent, type ManagedAgentInput, type ManagedAgentStore } from "../managed-agents.ts";
import type { ManagedAgent, ManagedAgentRun } from "../../shared/managed-agents.ts";

export const DUET_AGENT_NAME = "Duet";
export const DUET_DEFAULT_TIME = "07:30";

export const DUET_INSTRUCTIONS = [
  "Compose the morning attention list: emails waiting on a reply, decisions",
  "only the person can make, failed or missed routines, and today's meetings.",
  "Offer to act with the exact intended action shown first, and act only",
  "after the person explicitly approves. Never send a message, email or",
  "payment on your own.",
].join(" ");

/** The managed-agent definition for Duet's daily run. */
export function duetAgentInput(botId: string, time: string = DUET_DEFAULT_TIME): ManagedAgentInput {
  return {
    name: DUET_AGENT_NAME,
    botId,
    instructions: DUET_INSTRUCTIONS,
    schedule: { type: "daily", time },
    allowedTools: [],
    capPeriod: "day",
    executorPreference: "local",
  };
}

export interface DuetRunnerDeps {
  agentStore: ManagedAgentStore;
  dataDir: string;
  executor: AgentExecutor;
  now?: () => number;
}

/** Runs one Duet agent once through the managed-agent runner. */
export function runDuetAgent(deps: DuetRunnerDeps, agent: ManagedAgent): Promise<ManagedAgentRun> {
  return runManagedAgent(
    { store: deps.agentStore, dataDir: deps.dataDir, executor: deps.executor, ...(deps.now ? { now: deps.now } : {}) },
    agent,
    { manual: false },
  );
}
