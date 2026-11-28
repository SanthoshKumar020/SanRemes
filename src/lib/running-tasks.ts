import { api } from "@/state/store";
import type { RunningTasksPayload } from "../../shared/running-tasks";

export type { RunningTaskRow, RunningTasksPayload } from "../../shared/running-tasks";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** Everything working right now, oldest first. */
export async function fetchRunning(request: Request = api): Promise<RunningTasksPayload> {
  return request<RunningTasksPayload>("/api/running");
}

/** Stops a bot's work now, without pausing it. */
export async function stopBotWork(botId: string, request: Request = api): Promise<{ botIds: string[]; stopped: number }> {
  return request<{ botIds: string[]; stopped: number }>("/api/turns/stop", {
    method: "POST",
    body: JSON.stringify({ botIds: [botId] }),
  });
}

/** Pauses a bot, which also stops the work it is doing now. */
export async function pauseBot(botId: string, request: Request = api): Promise<unknown> {
  return request("/api/paused", {
    method: "POST",
    body: JSON.stringify({ kind: "bot", id: botId, paused: true }),
  });
}
