import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentExecutor, ExecutorPromptResult } from "./executors.ts";
import {
  agentSpend, capStopReason, ManagedAgentStore, nextDailyRun, nextManagedAgentRun, outcomeSummary,
  runDueManagedAgents, runManagedAgent, scheduleFromRoutine,
} from "./managed-agents.ts";
import type { Routine } from "./routines.ts";
import { appendUsage, flushUsageLedger, readUsage } from "./usage-ledger.ts";
import type { ManagedAgent } from "../shared/managed-agents.ts";

let dir: string;
let store: ManagedAgentStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sanremes-managed-agents-"));
  store = new ManagedAgentStore({ dataDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeExecutor(result: Partial<ExecutorPromptResult> = {}): AgentExecutor {
  const refuse = async (): Promise<never> => {
    throw new Error("no session here");
  };
  return {
    kind: "local",
    label: "Fake",
    attached: () => true,
    runPrompt: async () => ({ text: "done", durationMs: 5, ...result }),
    startSession: refuse,
    refreshSession: refuse,
    openSessionPr: refuse,
    closeSession: refuse,
  };
}

function fakeRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    name: "Morning brief",
    prompt: "Summarise the news.",
    target: "bot",
    botId: "scout",
    runOn: "sanremes",
    enabled: true,
    schedule: { type: "daily", time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
    durationMinutes: 10,
    nextRunAt: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Routine;
}

describe("nextDailyRun", () => {
  it("picks today when the time is still ahead and tomorrow when it passed", () => {
    const morning = new Date(2026, 10, 28, 7, 0, 0).getTime();
    expect(nextDailyRun("08:00", undefined, morning)).toBe(new Date(2026, 10, 28, 8, 0, 0).getTime());
    const evening = new Date(2026, 10, 28, 9, 0, 0).getTime();
    expect(nextDailyRun("08:00", undefined, evening)).toBe(new Date(2026, 10, 29, 8, 0, 0).getTime());
  });

  it("skips days the schedule does not allow", () => {
    const saturday = new Date(2026, 10, 28, 9, 0, 0).getTime();
    expect(nextDailyRun("08:00", [1], saturday)).toBe(new Date(2026, 10, 30, 8, 0, 0).getTime());
  });

  it("returns null when no day is allowed", () => {
    expect(nextDailyRun("08:00", [], Date.now())).toBeNull();
  });
});

describe("nextManagedAgentRun", () => {
  it("counts an interval from now and never schedules a manual agent", () => {
    const from = 1_000_000;
    expect(nextManagedAgentRun({ type: "interval", everyMinutes: 30 }, from)).toBe(from + 30 * 60_000);
    expect(nextManagedAgentRun({ type: "manual" }, from)).toBeNull();
    expect(nextManagedAgentRun({ type: "routine" }, from)).toBeNull();
  });
});

describe("scheduleFromRoutine", () => {
  it("maps daily and plain interval schedules and follows anything else", () => {
    expect(scheduleFromRoutine(fakeRoutine())).toEqual({ type: "daily", time: "08:00" });
    expect(scheduleFromRoutine(fakeRoutine({ schedule: { type: "daily", time: "09:30", weekdays: [1, 2, 3] } })))
      .toEqual({ type: "daily", time: "09:30", days: [1, 2, 3] });
    expect(scheduleFromRoutine(fakeRoutine({ schedule: { type: "interval", everyMinutes: 60, anchorAt: 0 } })))
      .toEqual({ type: "interval", everyMinutes: 60 });
    expect(scheduleFromRoutine(fakeRoutine({ schedule: { type: "once", at: 123 } }))).toEqual({ type: "routine" });
  });
});

describe("ManagedAgentStore", () => {
  it("creates, lists, updates and removes an agent with its runs", () => {
    const agent = store.create({
      name: "Briefing bot", botId: "scout", instructions: "Write the morning brief.",
      schedule: { type: "daily", time: "08:00" }, allowedTools: ["search", "search"], capUsd: 5,
    });
    expect(agent.allowedTools).toEqual(["search"]);
    expect(agent.nextRunAt).not.toBeNull();
    expect(store.list()).toHaveLength(1);
    expect(store.get(agent.id)?.name).toBe("Briefing bot");
    const paused = store.update(agent.id, { enabled: false });
    expect(paused?.enabled).toBe(false);
    expect(paused?.nextRunAt).toBeNull();
    const resumed = store.update(agent.id, { enabled: true });
    expect(resumed?.enabled).toBe(true);
    expect(resumed?.nextRunAt).not.toBeNull();
    expect(store.remove(agent.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("refuses an agent with no name, bot or instructions", () => {
    expect(() => store.create({ name: " ", botId: "scout", instructions: "Do it." })).toThrowError("Give the agent a name.");
    expect(() => store.create({ name: "A", botId: " ", instructions: "Do it." })).toThrowError("Choose the bot");
    expect(() => store.create({ name: "A", botId: "scout", instructions: " " })).toThrowError("Write what this agent should do.");
  });

  it("creates an agent from a routine and links it", () => {
    const agent = store.createFromRoutine(fakeRoutine());
    expect(agent.routineId).toBe("routine-1");
    expect(agent.schedule).toEqual({ type: "daily", time: "08:00" });
    expect(agent.instructions).toBe("Summarise the news.");
  });

  it("lists due agents by their own schedule only", () => {
    const fixed = new Date(2026, 10, 28, 7, 0, 0).getTime();
    const early = new ManagedAgentStore({ dataDir: dir, now: () => fixed });
    early.create({ name: "Due", botId: "scout", instructions: "Go.", schedule: { type: "interval", everyMinutes: 5 } });
    early.create({ name: "Manual", botId: "scout", instructions: "Go.", schedule: { type: "manual" } });
    early.create({ name: "Routine", botId: "scout", instructions: "Go.", schedule: { type: "routine" }, routineId: "routine-1" });
    const later = new ManagedAgentStore({ dataDir: dir, now: () => fixed + 6 * 60_000 });
    expect(later.due().map((agent) => agent.name)).toEqual(["Due"]);
  });

  it("persists across instances", () => {
    const agent = store.create({ name: "Kept", botId: "scout", instructions: "Go." });
    expect(new ManagedAgentStore({ dataDir: dir }).get(agent.id)?.name).toBe("Kept");
  });
});

describe("capStopReason", () => {
  const agent = {
    capUsd: 5, capTokens: 1000, capPeriod: "month",
  } as ManagedAgent;

  it("stops on a reached dollar or token cap and passes below them", () => {
    expect(capStopReason(agent, { usd: 0, tokens: 0 })).toBeNull();
    expect(capStopReason(agent, { usd: 5, tokens: 0 })).toContain("past its $5.00 cap");
    expect(capStopReason(agent, { usd: 0, tokens: 1000 })).toContain("past its 1,000-token cap");
  });
});

describe("runManagedAgent", () => {
  const bookUsage = async (row: Parameters<typeof appendUsage>[1]) => appendUsage(dir, row);

  it("records a completed run and books its reported usage to the ledger", async () => {
    const agent = store.create({ name: "Reporter", botId: "scout", instructions: "Go." });
    const run = await runManagedAgent(
      { store, dataDir: dir, executor: fakeExecutor({ inputTokens: 100, outputTokens: 50, costUsd: 0.01, model: "sonnet" }), bookUsage },
      agent, { manual: true },
    );
    expect(run.status).toBe("completed");
    expect(run.manual).toBe(true);
    expect(run.usageReported).toBe(true);
    expect(run.result).toBe("done");
    await flushUsageLedger(dir);
    const rows = readUsage(dir, { from: new Date(0), to: new Date() });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.trigger).toEqual({ kind: "managed-agent", agentId: agent.id, agentName: "Reporter", executor: "local", runId: run.id });
    expect(agentSpend(dir, agent.id, "month")).toEqual({ usd: 0.01, tokens: 150 });
    expect(store.runsFor(agent.id)).toHaveLength(1);
    expect(store.summaries()[0]?.lastRun?.id).toBe(run.id);
  });

  it("books nothing when the executor reports no usage", async () => {
    const agent = store.create({ name: "Quiet", botId: "scout", instructions: "Go." });
    const run = await runManagedAgent({ store, dataDir: dir, executor: fakeExecutor(), bookUsage }, agent, { manual: true });
    expect(run.status).toBe("completed");
    expect(run.usageReported).toBe(false);
    await flushUsageLedger(dir);
    expect(readUsage(dir, { from: new Date(0), to: new Date() })).toHaveLength(0);
  });

  it("stops in plain words when the cap is hit and never executes", async () => {
    const agent = store.create({ name: "Capped", botId: "scout", instructions: "Go.", capUsd: 1 });
    const failing = fakeExecutor({ costUsd: 2, inputTokens: 10, outputTokens: 10 });
    await runManagedAgent({ store, dataDir: dir, executor: failing, bookUsage }, agent, { manual: true });
    await flushUsageLedger(dir);
    let calls = 0;
    const counting = fakeExecutor({ costUsd: 2 });
    counting.runPrompt = async () => {
      calls += 1;
      return { text: "done", durationMs: 1, costUsd: 2 };
    };
    const stopped = await runManagedAgent({ store, dataDir: dir, executor: counting, bookUsage }, agent, { manual: true });
    expect(stopped.status).toBe("stopped");
    expect(stopped.error).toContain("past its $1.00 cap");
    expect(calls).toBe(0);
  });

  it("records a failed run in plain words", async () => {
    const agent = store.create({ name: "Failing", botId: "scout", instructions: "Go." });
    const broken: AgentExecutor = {
      ...fakeExecutor(),
      runPrompt: async () => {
        throw new Error("The bot could not be reached.");
      },
    };
    const run = await runManagedAgent({ store, dataDir: dir, executor: broken, bookUsage }, agent, { manual: true });
    expect(run.status).toBe("failed");
    expect(run.error).toBe("The bot could not be reached.");
  });

  it("refuses a second run while one is going", async () => {
    const agent = store.create({ name: "Busy", botId: "scout", instructions: "Go." });
    let release!: () => void;
    const slow: AgentExecutor = {
      ...fakeExecutor(),
      runPrompt: () => new Promise((resolve) => {
        release = () => resolve({ text: "done", durationMs: 1 });
      }),
    };
    const first = runManagedAgent({ store, dataDir: dir, executor: slow, bookUsage }, agent, { manual: true });
    await expect(runManagedAgent({ store, dataDir: dir, executor: slow, bookUsage }, agent, { manual: true }))
      .rejects.toThrowError("already has a run going");
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });
});

describe("runDueManagedAgents", () => {
  it("runs only the due agents and keeps going after a failure", async () => {
    const fixed = new Date(2026, 10, 28, 7, 0, 0).getTime();
    const early = new ManagedAgentStore({ dataDir: dir, now: () => fixed });
    const due = early.create({ name: "Due", botId: "scout", instructions: "Go.", schedule: { type: "interval", everyMinutes: 5 } });
    const failing = early.create({ name: "Failing", botId: "scout", instructions: "Go.", schedule: { type: "interval", everyMinutes: 5 } });
    early.create({ name: "Manual", botId: "scout", instructions: "Go.", schedule: { type: "manual" } });
    const later = new ManagedAgentStore({ dataDir: dir, now: () => fixed + 6 * 60_000 });
    const broken: AgentExecutor = {
      ...fakeExecutor(),
      runPrompt: async (input) => {
        if (input.botId === "scout" && input.prompt === "Go.") throw new Error("boom");
        return { text: "done", durationMs: 1 };
      },
    };
    const runs = await runDueManagedAgents(
      { store: later, dataDir: dir, executor: fakeExecutor(), bookUsage: async () => true },
      (agent) => (agent.id === failing.id ? broken : fakeExecutor()),
    );
    expect(runs.map((run) => run.agentId).sort()).toEqual([due.id, failing.id].sort());
    expect(runs.find((run) => run.agentId === failing.id)?.status).toBe("failed");
    expect(runs.find((run) => run.agentId === due.id)?.status).toBe("completed");
  });
});

describe("outcomeSummary", () => {
  it("adds up counts, rates, durations and costs", () => {
    const summary = outcomeSummary([
      { id: "r1", agentId: "a", status: "completed", executor: "local", manual: false, startedAt: 0, finishedAt: 1000, durationMs: 1000, inputTokens: 10, outputTokens: 5, costUsd: 0.01, usageReported: true },
      { id: "r2", agentId: "a", status: "failed", executor: "local", manual: false, startedAt: 0, finishedAt: 2000, durationMs: 2000, usageReported: false },
      { id: "r3", agentId: "a", status: "stopped", executor: "local", manual: false, startedAt: 0, finishedAt: 500, durationMs: 500, usageReported: false },
    ]);
    expect(summary).toEqual({
      runs: 3, completed: 1, failed: 1, stopped: 1, successRate: 1 / 3,
      avgDurationMs: 1167, totalCostUsd: 0.01, totalInputTokens: 10, totalOutputTokens: 5,
    });
  });

  it("reports null rates with no runs", () => {
    expect(outcomeSummary([])).toMatchObject({ runs: 0, successRate: null, avgDurationMs: null, totalCostUsd: null });
  });

  it("surfaces outcomes in the agent summaries", () => {
    const agent = store.create({ name: "Tracked", botId: "scout", instructions: "Go." });
    store.recordRun({ id: "r1", agentId: agent.id, status: "completed", executor: "local", manual: true, startedAt: 0, finishedAt: 100, durationMs: 100, usageReported: true });
    expect(store.summaries()[0]?.outcomes).toMatchObject({ runs: 1, completed: 1, successRate: 1 });
  });
});

describe("agent chaining", () => {
  const bookUsage = async (row: Parameters<typeof appendUsage>[1]) => appendUsage(dir, row);

  it("queues the next agent when a run ends, and only when its condition matches", async () => {
    const first = store.create({ name: "First", botId: "scout", instructions: "Go." });
    const second = store.create({ name: "Second", botId: "scout", instructions: "Go.", afterRun: undefined });
    const chained = store.create({ name: "Chained", botId: "scout", instructions: "Go.", afterRun: { agentId: second.id, when: "completed" } });
    await runManagedAgent({ store, dataDir: dir, executor: fakeExecutor(), bookUsage }, chained, { manual: true });
    expect(store.get(second.id)?.nextRunAt).not.toBeNull();
    expect(store.get(second.id)?.pendingChain).toEqual([chained.id]);

    const failing = store.create({ name: "Failing", botId: "scout", instructions: "Go.", afterRun: { agentId: first.id, when: "completed" } });
    const broken: AgentExecutor = { ...fakeExecutor(), runPrompt: async () => { throw new Error("Down."); } };
    await runManagedAgent({ store, dataDir: dir, executor: broken, bookUsage }, failing, { manual: true });
    expect(store.get(first.id)?.nextRunAt).toBeNull();

    const always = store.create({ name: "Always", botId: "scout", instructions: "Go.", afterRun: { agentId: first.id, when: "always" } });
    await runManagedAgent({ store, dataDir: dir, executor: broken, bookUsage }, always, { manual: true });
    expect(store.get(first.id)?.nextRunAt).not.toBeNull();
    void first;
  });

  it("refuses chains that repeat an agent, point at the source, or pass five hops", () => {
    const a = store.create({ name: "A", botId: "scout", instructions: "Go." });
    const b = store.create({ name: "B", botId: "scout", instructions: "Go." });
    const c = store.create({ name: "C", botId: "scout", instructions: "Go." });
    const off = store.create({ name: "Off", botId: "scout", instructions: "Go.", enabled: false });
    expect(store.queueChained(a.id, b.id, [])).toBe(true);
    expect(store.queueChained(a.id, a.id, [])).toBe(false);
    expect(store.queueChained(a.id, "missing", [])).toBe(false);
    expect(store.queueChained(a.id, off.id, [])).toBe(false);
    expect(store.queueChained(b.id, a.id, [a.id])).toBe(false);
    expect(store.queueChained(b.id, c.id, [a.id])).toBe(true);
    expect(store.queueChained(c.id, a.id, [a.id, b.id, c.id, "d", "e"])).toBe(false);
    expect(store.consumeChain(b.id)).toEqual([a.id]);
    expect(store.consumeChain(b.id)).toEqual([]);
  });
});
