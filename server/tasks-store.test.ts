import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { tasksFileSchema } from "../shared/tasks.ts";
import { failedAttempts, TasksStore } from "./tasks-store.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const START = new Date("2026-11-26T10:00:00+05:30").getTime();

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

function makeStore(now: () => number = () => START) {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-tasks-store-"));
  scratch.push(dataDir);
  return { dataDir, store: new TasksStore({ dataDir, now }) };
}

describe("tasks.json", () => {
  it("starts empty", () => {
    const { store } = makeStore();
    expect(store.snapshot()).toEqual({ version: 1, tasks: [] });
    expect(store.list()).toEqual([]);
    expect(store.get("missing")).toBeNull();
  });

  it("replaces an unreadable file with defaults instead of refusing every save", () => {
    const { dataDir, store } = makeStore();
    writeFileSync(join(dataDir, "tasks.json"), "{not json");
    expect(store.snapshot().tasks).toEqual([]);
    const task = store.create({ title: "Triage the inbox" });
    expect(JSON.parse(readFileSync(join(dataDir, "tasks.json"), "utf8")).tasks[0].id).toBe(task.id);
  });

  it("replaces a wrongly shaped file with defaults", () => {
    const { dataDir, store } = makeStore();
    writeFileSync(join(dataDir, "tasks.json"), JSON.stringify({ version: 1, tasks: "not a list" }));
    expect(store.snapshot()).toMatchObject({ tasks: [] });
  });

  it("writes whole valid JSON atomically and bumps the version only on a change", () => {
    const { dataDir, store } = makeStore();
    const before = store.version;
    store.create({ title: "Triage the inbox", goal: "Clear every unread message." });
    expect(store.version).toBeGreaterThan(before);
    const text = readFileSync(join(dataDir, "tasks.json"), "utf8");
    expect(tasksFileSchema.parse(JSON.parse(text)).tasks[0]?.title).toBe("Triage the inbox");
    expect(readdirSync(dataDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(join(dataDir, "tasks.json"))).toBe(true);
    const version = store.version;
    store.update(() => {});
    expect(store.version).toBe(version);
  });

  it("creates a task queued, unlocked, with no history", () => {
    const { store } = makeStore();
    const task = store.create({ title: "Triage the inbox", goal: "Clear every unread message.", assigneeBotId: "job-bot" });
    expect(task).toMatchObject({
      title: "Triage the inbox", goal: "Clear every unread message.", assigneeBotId: "job-bot",
      state: "queued", lockedBy: null, lockedAt: null, history: [], createdAt: START, updatedAt: START,
    });
    expect(task.id).toMatch(/^[\w-]{1,128}$/u);
    expect(store.create({ title: "No assignee" }).assigneeBotId).toBeNull();
  });

  it("claims only a queued task, and only once", () => {
    const { store } = makeStore();
    const task = store.create({ title: "Triage the inbox" });
    const claimed = store.claim(task.id, "job-bot");
    expect(claimed).toMatchObject({ state: "claimed", assigneeBotId: "job-bot", lockedBy: "job-bot", lockedAt: START });
    expect(claimed !== "not-queued" && claimed !== null ? claimed.history : []).toEqual([{ at: START, result: "claimed", botId: "job-bot" }]);
    expect(store.claim(task.id, "qa-bot")).toBe("not-queued");
    expect(store.claim("missing", "job-bot")).toBeNull();
    expect(store.get(task.id)?.lockedBy).toBe("job-bot");
  });

  it("completing releases the lock and records the outcome", () => {
    const { store } = makeStore();
    const task = store.create({ title: "Triage the inbox" });
    store.claim(task.id, "job-bot");
    const done = store.complete(task.id, "job-bot", "Inbox cleared, 3 replies drafted.");
    expect(done).toMatchObject({ state: "done", lockedBy: null, lockedAt: null });
    expect(done !== "not-claimed" && done !== "not-locked-by" && done !== null ? done.history : []).toEqual([
      { at: START, result: "claimed", botId: "job-bot" },
      { at: START, result: "Inbox cleared, 3 replies drafted.", botId: "job-bot" },
    ]);
    expect(store.complete(task.id, "job-bot")).toBe("not-claimed");
  });

  it("failing releases the lock so the task can be picked up again", () => {
    const { store } = makeStore();
    const task = store.create({ title: "Triage the inbox" });
    store.claim(task.id, "job-bot");
    const failed = store.fail(task.id, "job-bot", "Inbox API refused the sign-in.");
    expect(failed).toMatchObject({ state: "failed", lockedBy: null, lockedAt: null });
    expect(store.claim(task.id, "qa-bot")).toBe("not-queued");
  });

  it("refuses to finish a task that is not claimed, or is held by another bot", () => {
    const { store } = makeStore();
    const queued = store.create({ title: "Still queued" });
    expect(store.complete(queued.id, "job-bot")).toBe("not-claimed");
    expect(store.fail(queued.id, "job-bot")).toBe("not-claimed");
    const held = store.create({ title: "Held" });
    store.claim(held.id, "job-bot");
    expect(store.complete(held.id, "qa-bot")).toBe("not-locked-by");
    expect(store.fail(held.id, "qa-bot")).toBe("not-locked-by");
    expect(store.get(held.id)).toMatchObject({ state: "claimed", lockedBy: "job-bot" });
    expect(store.complete("missing", "job-bot")).toBeNull();
  });

  it("lists by state and round-trips through the file", () => {
    const { dataDir, store } = makeStore();
    const first = store.create({ title: "First" });
    const second = store.create({ title: "Second" });
    store.claim(first.id, "job-bot");
    store.complete(first.id, "job-bot");
    expect(store.list("done").map((task) => task.id)).toEqual([first.id]);
    expect(store.list("queued").map((task) => task.id)).toEqual([second.id]);
    expect(store.list().map((task) => task.id)).toEqual([first.id, second.id]);
    const disk = tasksFileSchema.parse(JSON.parse(readFileSync(join(dataDir, "tasks.json"), "utf8")));
    expect(disk.tasks.map((task) => task.state)).toEqual(["done", "queued"]);
  });

  it("moves a claimed task to running, only by the bot holding the lock", () => {
    const { store } = makeStore();
    const queued = store.create({ title: "Still queued" });
    expect(store.start(queued.id, "job-bot")).toBe("not-claimed");
    const task = store.create({ title: "Held" });
    store.claim(task.id, "job-bot");
    expect(store.start(task.id, "qa-bot")).toBe("not-locked-by");
    const started = store.start(task.id, "job-bot");
    expect(started).toMatchObject({ state: "running", lockedBy: "job-bot" });
    expect(started !== "not-claimed" && started !== "not-locked-by" && started !== null ? started.history : []).toEqual([
      { at: START, result: "claimed", botId: "job-bot" },
      { at: START, result: "started", botId: "job-bot" },
    ]);
    expect(store.start("missing", "job-bot")).toBeNull();
    expect(store.complete(task.id, "job-bot", "Done from running.")).toMatchObject({ state: "done" });
  });

  it("lets another bot reclaim a claim whose 30-minute lease expired", () => {
    let now = START;
    const { store } = makeStore(() => now);
    const task = store.create({ title: "Stale claim" });
    store.claim(task.id, "job-bot");
    expect(store.claim(task.id, "qa-bot")).toBe("not-queued");
    now = START + 30 * 60_000;
    expect(store.claim(task.id, "qa-bot")).toBe("not-queued");
    now = START + 30 * 60_000 + 1;
    const reclaimed = store.claim(task.id, "qa-bot");
    expect(reclaimed).toMatchObject({ state: "claimed", lockedBy: "qa-bot", lockedAt: now });
    expect(reclaimed !== "not-queued" && reclaimed !== null ? reclaimed.history : []).toEqual([
      { at: START, result: "claimed", botId: "job-bot" },
      { at: now, result: "lock expired", botId: "job-bot" },
      { at: now, result: "claimed", botId: "qa-bot" },
    ]);
  });

  it("requeues a failed task, and refuses after three failures", () => {
    const { store } = makeStore();
    const task = store.create({ title: "Flaky" });
    expect(store.requeue(task.id)).toBe("not-failed");
    for (let attempt = 1; attempt <= 3; attempt++) {
      store.claim(task.id, "job-bot");
      store.fail(task.id, "job-bot", `Attempt ${attempt} failed.`);
      if (attempt < 3) {
        const requeued = store.requeue(task.id);
        expect(requeued).toMatchObject({ state: "queued", assigneeBotId: null, lockedBy: null, lockedAt: null });
        expect(requeued !== "not-failed" && requeued !== "retry-cap" && requeued !== null
          ? requeued.history[requeued.history.length - 1] : {}).toMatchObject({ result: "requeued" });
      }
    }
    expect(store.requeue(task.id)).toBe("retry-cap");
    expect(store.get(task.id)).toMatchObject({ state: "failed" });
    expect(store.requeue("missing")).toBeNull();
  });

  it("returns tasks a restart cut off to the queue, with the interruption on the record", () => {
    const { dataDir, store } = makeStore();
    const running = store.create({ title: "Running when the server stopped" });
    const claimed = store.create({ title: "Claimed when the server stopped" });
    const queued = store.create({ title: "Still queued" });
    const done = store.create({ title: "Already done" });
    store.claim(running.id, "job-bot");
    store.start(running.id, "job-bot");
    store.claim(claimed.id, "job-bot");
    store.claim(done.id, "job-bot");
    store.complete(done.id, "job-bot", "completed");
    const reopened = new TasksStore({ dataDir, now: () => START + 60_000 });
    expect(reopened.get(running.id)).toMatchObject({ state: "queued", lockedBy: null, lockedAt: null, assigneeBotId: "job-bot" });
    expect(reopened.get(running.id)?.history).toEqual([
      { at: START, result: "claimed", botId: "job-bot" },
      { at: START, result: "started", botId: "job-bot" },
      { at: START + 60_000, result: "interrupted by restart", botId: "job-bot" },
    ]);
    expect(reopened.get(claimed.id)).toMatchObject({ state: "queued", lockedBy: null, lockedAt: null });
    expect(reopened.get(queued.id)).toMatchObject({ state: "queued" });
    expect(reopened.get(done.id)).toMatchObject({ state: "done" });
    expect(failedAttempts(reopened.get(running.id)!)).toBe(0);
    const again = reopened.claim(running.id, "job-bot");
    expect(again).toMatchObject({ state: "claimed", lockedBy: "job-bot" });
  });
});
