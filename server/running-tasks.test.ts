import { describe, expect, it } from "vitest";

import { collectRunningTasks, type RunningTasksDeps } from "./running-tasks.ts";

const NOW = new Date("2026-11-28T11:00:00+05:30").getTime();

function deps(overrides: Partial<RunningTasksDeps> = {}): RunningTasksDeps {
  return {
    now: () => NOW,
    turns: () => [],
    routineRuns: () => [],
    tasks: () => [],
    batches: () => [],
    botName: (botId) => (botId === "scout" ? "Scout" : botId === "scribe" ? "Scribe" : null),
    threadTitle: (_botId, threadId) => (threadId === "t-main" ? "Main chat" : null),
    ...overrides,
  };
}

describe("collectRunningTasks", () => {
  it("lists live turns, routine runs, held tasks and unfinished batches, oldest first", () => {
    const rows = collectRunningTasks(deps({
      turns: () => [
        { botId: "scout", threadId: "t-main", status: "source", text: "Triage the inbox", startedAt: NOW - 5000, createdAt: NOW - 6000 },
        { botId: "scribe", threadId: "t-wait", status: "needs_input", text: "Needs an answer", startedAt: NOW - 9000, createdAt: NOW - 9000 },
        { botId: "scout", threadId: "t-done", status: "queued", createdAt: NOW - 1000 },
      ],
      routineRuns: () => [
        { id: "r1", routineName: "Morning brief", botId: "scribe", status: "running", startedAt: NOW - 3000, scheduledFor: NOW - 4000, threadId: "t-routine" },
        { id: "r2", routineName: "Done routine", botId: "scribe", status: "completed", startedAt: NOW - 2000, scheduledFor: NOW - 2000 },
      ],
      tasks: () => [
        { id: "task-1", title: "Draft the reply", state: "running", assigneeBotId: "scout", lockedBy: "scout", lockedAt: NOW - 7000, updatedAt: NOW - 7000 },
        { id: "task-2", title: "Still queued", state: "queued", assigneeBotId: null, lockedBy: null, lockedAt: null, updatedAt: NOW - 1000 },
      ],
      batches: () => [
        { id: "b1", botId: "scout", createdAt: NOW - 8000, prompts: ["a", "b", "c"], results: [{}, {}] },
        { id: "b2", botId: "scout", createdAt: NOW - 1000, prompts: ["a"], results: [{}] },
      ],
    }));
    expect(rows.map((row) => [row.kind, row.id, row.state])).toEqual([
      ["turn", "turn:t-wait", "waiting"],
      ["batch", "batch:b1", "running"],
      ["task", "task:task-1", "running"],
      ["turn", "turn:t-main", "running"],
      ["routine", "routine:r1", "running"],
    ]);
    expect(rows[0]).toMatchObject({ botName: "Scribe", detail: "Waiting for an answer", startedAt: NOW - 9000 });
    expect(rows[1]).toMatchObject({ title: "Batch of 3 prompts", detail: "2 of 3 done" });
    expect(rows[3]).toMatchObject({ title: "Main chat", botName: "Scout" });
    expect(rows[4]).toMatchObject({ title: "Morning brief", threadId: "t-routine" });
  });

  it("returns an empty list when nothing is working", () => {
    expect(collectRunningTasks(deps())).toEqual([]);
  });

  it("falls back to the turn's own words when its thread has no title", () => {
    const rows = collectRunningTasks(deps({
      turns: () => [{ botId: "scout", threadId: "t-x", status: "running", text: "  Check   the inbox  ", startedAt: NOW - 100, createdAt: NOW - 100 }],
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Check the inbox");
  });
});
