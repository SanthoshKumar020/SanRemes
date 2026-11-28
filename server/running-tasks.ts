// One list of everything working right now: live turns, routine runs, tasks a bot holds, batches still
// running. Each source stays the authority for its own rows; this only gathers and orders them, oldest first.
import type { RunningTaskRow } from "../shared/running-tasks.ts";

export interface RunningTurn {
  botId: string;
  threadId: string;
  /** A coordinator node's status: "source" is the host's own live turn, "needs_input" waits on an answer. */
  status: string;
  text?: string;
  startedAt?: number;
  createdAt: number;
}

export interface RunningRoutineRun {
  id: string;
  routineName: string;
  botId: string;
  status: string;
  startedAt?: number;
  scheduledFor: number;
  threadId?: string;
}

export interface RunningQueueTask {
  id: string;
  title: string;
  state: "queued" | "claimed" | "running" | "done" | "failed";
  assigneeBotId: string | null;
  lockedBy: string | null;
  lockedAt: number | null;
  updatedAt: number;
}

export interface RunningBatch {
  id: string;
  botId: string;
  createdAt: number;
  prompts: string[];
  results: unknown[];
}

export interface RunningTasksDeps {
  now?: () => number;
  turns: () => readonly RunningTurn[];
  routineRuns: () => readonly RunningRoutineRun[];
  tasks: () => readonly RunningQueueTask[];
  batches: () => readonly RunningBatch[];
  botName: (botId: string) => string | null;
  threadTitle: (botId: string, threadId: string) => string | null;
}

const TITLE_CHARS = 80;

function short(text: string | undefined, fallback: string): string {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > TITLE_CHARS ? `${cleaned.slice(0, TITLE_CHARS - 1)}…` : cleaned;
}

export function collectRunningTasks(deps: RunningTasksDeps): RunningTaskRow[] {
  const rows: RunningTaskRow[] = [];
  for (const turn of deps.turns()) {
    const state = turn.status === "waiting" || turn.status === "needs_input" ? "waiting" : turn.status === "running" || turn.status === "source" ? "running" : null;
    if (!state) continue;
    rows.push({
      kind: "turn",
      id: `turn:${turn.threadId}`,
      botId: turn.botId,
      botName: deps.botName(turn.botId),
      title: short(deps.threadTitle(turn.botId, turn.threadId) ?? undefined, short(turn.text, "Working")),
      detail: state === "waiting" ? "Waiting for an answer" : undefined,
      startedAt: turn.startedAt ?? turn.createdAt,
      state,
      threadId: turn.threadId,
    });
  }
  for (const run of deps.routineRuns()) {
    if (run.status !== "running" && run.status !== "waiting") continue;
    rows.push({
      kind: "routine",
      id: `routine:${run.id}`,
      botId: run.botId,
      botName: deps.botName(run.botId),
      title: run.routineName,
      detail: run.status === "waiting" ? "Waiting to run" : undefined,
      startedAt: run.startedAt ?? run.scheduledFor,
      state: run.status === "waiting" ? "waiting" : "running",
      ...(run.threadId ? { threadId: run.threadId } : {}),
    });
  }
  for (const task of deps.tasks()) {
    if (task.state !== "claimed" && task.state !== "running") continue;
    const botId = task.lockedBy ?? task.assigneeBotId;
    if (!botId) continue;
    rows.push({
      kind: "task",
      id: `task:${task.id}`,
      botId,
      botName: deps.botName(botId),
      title: task.title,
      startedAt: task.lockedAt ?? task.updatedAt,
      state: task.state === "running" ? "running" : "claimed",
    });
  }
  for (const batch of deps.batches()) {
    const done = batch.results.length;
    if (done >= batch.prompts.length) continue;
    rows.push({
      kind: "batch",
      id: `batch:${batch.id}`,
      botId: batch.botId,
      botName: deps.botName(batch.botId),
      title: `Batch of ${batch.prompts.length} prompts`,
      detail: `${done} of ${batch.prompts.length} done`,
      startedAt: batch.createdAt,
      state: "running",
    });
  }
  rows.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  return rows;
}

export function runningTasksPayload(deps: RunningTasksDeps): { now: number; rows: RunningTaskRow[] } {
  return { now: deps.now?.() ?? Date.now(), rows: collectRunningTasks(deps) };
}
