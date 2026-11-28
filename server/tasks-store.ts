// tasks.json in the data dir: the ticketed-task queue. One process writes it, so a synchronous read-modify-write
// is the checkout: a claim only lands while the task is still queued, and only one bot ever holds the lock.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { tasksFileSchema, taskSchema, type Task, type TaskAttempt, type TasksData, type TaskState } from "../shared/tasks.ts";

import { writeFileAtomic } from "./atomic.ts";

export const TASKS_FILE = "tasks.json";

/** How long a claim holds before another bot may take the task over; a heartbeat may lengthen this later. */
export const TASK_LOCK_LEASE_MS = 30 * 60_000;

/** History entries the store itself writes; anything else in history is a bot's finish outcome. */
const SYSTEM_RESULTS = new Set(["claimed", "started", "lock expired", "requeued", "interrupted by restart"]);

/** How many times this task has failed: every finish outcome that is not one of the store's own entries. */
export function failedAttempts(task: Task): number {
  return task.history.filter((entry) => !SYSTEM_RESULTS.has(entry.result)).length;
}

function emptyData(): TasksData {
  return { version: 1, tasks: [] };
}

/** What POST /api/tasks accepts: a title, the goal in words, and optionally the bot it is meant for. */
export interface NewTaskInput {
  title: string;
  goal?: string;
  assigneeBotId?: string | null;
}

export class TasksStore {
  private readonly file: string;
  private readonly now: () => number;
  private cache: TasksData | null = null;
  private unreadableWarned = false;
  version = 0;

  constructor(options: { dataDir: string; now?: () => number }) {
    this.file = join(options.dataDir, TASKS_FILE);
    this.now = options.now ?? Date.now;
    this.reconcileAfterRestart();
  }

  /** A restart cut these tasks off mid-claim: no bot holds them any more, so they go back to the queue with the
   * interruption on the record, ready for the same bot — or another — to claim them again. Runs once, when the
   * store opens over a data directory left by a previous process. */
  reconcileAfterRestart(): Task[] {
    const at = this.now();
    const interrupted: Task[] = [];
    this.update((data) => {
      for (const task of data.tasks) {
        if (task.state !== "claimed" && task.state !== "running") continue;
        task.history.push({ at, result: "interrupted by restart", botId: task.lockedBy ?? undefined });
        task.history = task.history.slice(-100);
        task.state = "queued";
        task.lockedBy = null;
        task.lockedAt = null;
        task.updatedAt = at;
        interrupted.push(structuredClone(task));
      }
    });
    return interrupted;
  }

  private read(): TasksData {
    if (this.cache) return this.cache;
    let data = emptyData();
    if (existsSync(this.file)) {
      try {
        data = tasksFileSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
      } catch {
        if (!this.unreadableWarned) console.warn("tasks: tasks.json could not be read; it will be replaced on the next save");
        this.unreadableWarned = true;
        data = emptyData();
      }
    }
    this.cache = data;
    this.version++;
    return data;
  }

  private write(data: TasksData): void {
    const parsed = tasksFileSchema.parse(data);
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`);
    this.cache = parsed;
    this.version++;
  }

  snapshot(): TasksData {
    return structuredClone(this.read());
  }

  update(mutator: (data: TasksData) => void): TasksData {
    const next = structuredClone(this.read());
    mutator(next);
    if (JSON.stringify(next) !== JSON.stringify(this.cache)) this.write(next);
    return structuredClone(this.cache!);
  }

  create(input: NewTaskInput): Task {
    const at = this.now();
    const task: Task = taskSchema.parse({
      ...input, id: randomUUID(), assigneeBotId: input.assigneeBotId ?? null,
      state: "queued", lockedBy: null, lockedAt: null, history: [], createdAt: at, updatedAt: at,
    });
    this.update((data) => { data.tasks.push(task); });
    return task;
  }

  /** A task handed off from another home: a fresh id, queued, with the other home's record kept and the hand-off
   * noted, so the work — not the live turn, which cannot move — continues where it left off. */
  importTask(input: { title: string; goal?: string; assigneeBotId?: string | null; history?: TaskAttempt[] }): Task {
    const at = this.now();
    const task: Task = taskSchema.parse({
      id: randomUUID(), title: input.title, goal: input.goal, assigneeBotId: input.assigneeBotId ?? null,
      state: "queued", lockedBy: null, lockedAt: null,
      history: [...(input.history ?? []).slice(-99), { at, result: "handed off from another home" }],
      createdAt: at, updatedAt: at,
    });
    this.update((data) => { data.tasks.push(task); });
    return task;
  }

  get(id: string): Task | null {
    const task = this.read().tasks.find((one) => one.id === id);
    return task ? structuredClone(task) : null;
  }

  list(state?: TaskState): Task[] {
    const tasks = this.read().tasks;
    return structuredClone(state === undefined ? tasks : tasks.filter((task) => task.state === state));
  }

  /** Checks a queued task out to one bot: the assignee, the lock and the history entry land together. */
  claim(id: string, botId: string): Task | null | "not-queued" {
    const at = this.now();
    let claimed: Task | null | "not-queued" = null;
    this.update((data) => {
      const task = data.tasks.find((one) => one.id === id);
      if (!task) return;
      if (task.state === "claimed" && task.lockedAt !== null && at - task.lockedAt > TASK_LOCK_LEASE_MS) {
        task.history.push({ at, result: "lock expired", botId: task.lockedBy ?? undefined });
        task.state = "queued";
        task.lockedBy = null;
        task.lockedAt = null;
      }
      if (task.state !== "queued") { claimed = "not-queued"; return; }
      task.state = "claimed";
      task.assigneeBotId = botId;
      task.lockedBy = botId;
      task.lockedAt = at;
      task.updatedAt = at;
      task.history.push({ at, result: "claimed", botId });
      claimed = structuredClone(task);
    });
    return claimed;
  }

  /** Moves a claimed task to running, only by the bot holding the lock. */
  start(id: string, botId: string): Task | null | "not-claimed" | "not-locked-by" {
    const at = this.now();
    let started: Task | null | "not-claimed" | "not-locked-by" = null;
    this.update((data) => {
      const task = data.tasks.find((one) => one.id === id);
      if (!task) return;
      if (task.state !== "claimed") { started = "not-claimed"; return; }
      if (task.lockedBy !== botId) { started = "not-locked-by"; return; }
      task.state = "running";
      task.updatedAt = at;
      task.history.push({ at, result: "started", botId });
      started = structuredClone(task);
    });
    return started;
  }

  /** Puts a failed task back in the queue, up to three failures; the person recreates it after that. */
  requeue(id: string): Task | null | "not-failed" | "retry-cap" {
    const at = this.now();
    let requeued: Task | null | "not-failed" | "retry-cap" = null;
    this.update((data) => {
      const task = data.tasks.find((one) => one.id === id);
      if (!task) return;
      if (task.state !== "failed") { requeued = "not-failed"; return; }
      if (failedAttempts(task) >= 3) { requeued = "retry-cap"; return; }
      task.state = "queued";
      task.assigneeBotId = null;
      task.lockedBy = null;
      task.lockedAt = null;
      task.updatedAt = at;
      task.history.push({ at, result: "requeued" });
      requeued = structuredClone(task);
    });
    return requeued;
  }

  /** Finishes a task a bot holds: the lock is released and the outcome joins the history. */
  complete(id: string, botId: string, result?: string): Task | null | "not-claimed" | "not-locked-by" {
    return this.finish(id, botId, "done", result ?? "completed");
  }

  /** Fails a task a bot holds: the lock is released, so the task can be picked up again. */
  fail(id: string, botId: string, result?: string): Task | null | "not-claimed" | "not-locked-by" {
    return this.finish(id, botId, "failed", result ?? "failed");
  }

  private finish(id: string, botId: string, state: Extract<TaskState, "done" | "failed">, result: string): Task | null | "not-claimed" | "not-locked-by" {
    const at = this.now();
    let finished: Task | null | "not-claimed" | "not-locked-by" = null;
    this.update((data) => {
      const task = data.tasks.find((one) => one.id === id);
      if (!task) return;
      if (task.state !== "claimed" && task.state !== "running") { finished = "not-claimed"; return; }
      if (task.lockedBy !== botId) { finished = "not-locked-by"; return; }
      task.state = state;
      task.lockedBy = null;
      task.lockedAt = null;
      task.updatedAt = at;
      task.history.push({ at, result, botId });
      finished = structuredClone(task);
    });
    return finished;
  }
}
