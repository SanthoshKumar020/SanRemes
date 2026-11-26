import { api } from "@/state/store";
import type { Task, TaskState } from "../../shared/tasks";

export type { Task, TaskState } from "../../shared/tasks";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Lists the ticketed-task queue, newest first; `state` narrows to one state. */
export async function fetchTasks(state?: TaskState, request: Request = api): Promise<{ version: number; tasks: Task[] }> {
  const path = state === undefined ? "/api/tasks" : `/api/tasks?state=${encodeURIComponent(state)}`;
  return request<{ version: number; tasks: Task[] }>(path);
}

/** Checks a queued task out to one bot; refused when the task is not queued. */
export async function claimTask(id: string, botId: string, request: Request = api): Promise<{ task: Task }> {
  return request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}/claim`, {
    method: "POST",
    body: JSON.stringify({ botId }),
  });
}

/** Moves a claimed task to running; only the bot holding the lock may start it. */
export async function startTask(id: string, botId: string, request: Request = api): Promise<{ task: Task }> {
  return request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}/start`, {
    method: "POST",
    body: JSON.stringify({ botId }),
  });
}

/** Marks a claimed or running task done and records the outcome. */
export async function completeTask(id: string, botId: string, result?: string, request: Request = api): Promise<{ task: Task; version: number }> {
  return request<{ task: Task; version: number }>(`/api/tasks/${encodeURIComponent(id)}/complete`, {
    method: "POST",
    body: JSON.stringify(result === undefined ? { botId } : { botId, result }),
  });
}

/** Marks a claimed or running task failed and records the plain reason. */
export async function failTask(id: string, botId: string, result?: string, request: Request = api): Promise<{ task: Task; version: number }> {
  return request<{ task: Task; version: number }>(`/api/tasks/${encodeURIComponent(id)}/fail`, {
    method: "POST",
    body: JSON.stringify(result === undefined ? { botId } : { botId, result }),
  });
}

/** Puts a failed task back in the queue for another try. */
export async function requeueTask(id: string, request: Request = api): Promise<{ task: Task }> {
  return request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}/requeue`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
