// A managed agent's nightly dream: once a day, each agent's runs since its last dream are consolidated into one
// digest — counts, cost, average duration and the last run's outcome in plain words. The raw run records stay; the
// digest is what the agent remembers of them. No model call: the digest is computed from the run records alone.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ManagedAgent, ManagedAgentRun } from "../shared/managed-agents.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { ManagedAgentStore } from "./managed-agents.ts";

const DIGESTS_FILE = "managed-agent-digests.json";
const DIGESTS_PER_AGENT = 30;
const DREAM_EVERY_MS = 24 * 60 * 60_000;

/** One day's consolidation of an agent's runs. */
export interface AgentDigest {
  agentId: string;
  agentName: string;
  at: number;
  windowStart: number;
  runs: number;
  completed: number;
  failed: number;
  stopped: number;
  totalCostUsd: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgDurationMs: number | null;
  lastResult: string | null;
  text: string;
}

export function buildAgentDigest(agent: ManagedAgent, runs: ManagedAgentRun[], at: number, since: number): AgentDigest {
  const window = [...runs].filter((run) => run.startedAt > since).sort((a, b) => a.startedAt - b.startedAt);
  const completed = window.filter((run) => run.status === "completed").length;
  const failed = window.filter((run) => run.status === "failed").length;
  const stopped = window.filter((run) => run.status === "stopped").length;
  const cost = window.reduce<number | null>((sum, run) => (typeof run.costUsd === "number" ? (sum ?? 0) + run.costUsd : sum), null);
  const last = window.at(-1);
  const lastResult = last ? (last.result ?? last.error ?? null) : null;
  const day = new Date(since).toISOString().slice(0, 10);
  const avgSeconds = window.length ? Math.round(window.reduce((sum, run) => sum + run.durationMs, 0) / window.length / 1000) : null;
  const text = `${agent.name} ran ${window.length} time${window.length === 1 ? "" : "s"} since ${day}: ${completed} completed, ${failed} failed, ${stopped} stopped.`
    + (avgSeconds === null ? "" : ` Average run ${avgSeconds}s.`)
    + (cost === null ? " No cost reported." : ` Total cost $${cost.toFixed(2)}.`)
    + (lastResult ? ` Last run: ${lastResult.slice(0, 200)}` : "");
  return {
    agentId: agent.id,
    agentName: agent.name,
    at,
    windowStart: since,
    runs: window.length,
    completed,
    failed,
    stopped,
    totalCostUsd: cost,
    totalInputTokens: window.reduce((sum, run) => sum + (run.inputTokens ?? 0), 0),
    totalOutputTokens: window.reduce((sum, run) => sum + (run.outputTokens ?? 0), 0),
    avgDurationMs: window.length ? Math.round(window.reduce((sum, run) => sum + run.durationMs, 0) / window.length) : null,
    lastResult: lastResult ? lastResult.slice(0, 200) : null,
    text,
  };
}

export class ManagedAgentDigestStore {
  private readonly file: string;
  private digests: AgentDigest[] = [];

  constructor(options: { dataDir: string }) {
    this.file = join(options.dataDir, DIGESTS_FILE);
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as { digests?: unknown[] };
      for (const raw of saved.digests ?? []) {
        const digest = raw as AgentDigest;
        if (typeof digest?.agentId === "string" && typeof digest?.at === "number" && typeof digest?.text === "string") {
          this.digests.push(digest);
        }
      }
    } catch {
      this.digests = [];
    }
  }

  private save(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify({ digests: this.digests }));
  }

  latest(agentId: string): AgentDigest | undefined {
    return this.digests.filter((digest) => digest.agentId === agentId).sort((a, b) => b.at - a.at)[0];
  }

  for(agentId: string): AgentDigest[] {
    return this.digests.filter((digest) => digest.agentId === agentId).sort((a, b) => b.at - a.at);
  }

  record(digest: AgentDigest): AgentDigest {
    this.digests.unshift(digest);
    const kept: AgentDigest[] = [];
    const counts = new Map<string, number>();
    for (const entry of this.digests) {
      const count = counts.get(entry.agentId) ?? 0;
      if (count >= DIGESTS_PER_AGENT) continue;
      counts.set(entry.agentId, count + 1);
      kept.push(entry);
    }
    this.digests = kept;
    this.save();
    return digest;
  }
}

/** Dreams every agent with runs since its last dream, at most once a day each. Returns the dreamed agent ids. */
export function dreamManagedAgents(deps: { store: ManagedAgentStore; digests: ManagedAgentDigestStore; now?: () => number }): string[] {
  const now = deps.now ?? Date.now;
  const at = now();
  const dreamed: string[] = [];
  for (const agent of deps.store.list()) {
    const latest = deps.digests.latest(agent.id);
    if (latest && at - latest.at < DREAM_EVERY_MS) continue;
    const runs = deps.store.runsFor(agent.id).filter((run) => run.startedAt > (latest?.at ?? 0));
    if (!runs.length) continue;
    deps.digests.record(buildAgentDigest(agent, runs, at, latest?.at ?? 0));
    dreamed.push(agent.id);
  }
  return dreamed;
}
