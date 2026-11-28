// GET /api/running: everything working right now, in one list — a bot's live turn, a routine run, a queued
// task a bot holds, a batch still running. The person sees what is running, since when, and what can stop it.
import { z } from "zod";

export const runningTaskKindSchema = z.enum(["turn", "routine", "task", "batch"]);
export type RunningTaskKind = z.infer<typeof runningTaskKindSchema>;

export const runningTaskStateSchema = z.enum(["running", "waiting", "claimed"]);
export type RunningTaskState = z.infer<typeof runningTaskStateSchema>;

export const runningTaskRowSchema = z.object({
  kind: runningTaskKindSchema,
  id: z.string(),
  botId: z.string(),
  botName: z.string().nullable(),
  title: z.string(),
  detail: z.string().optional(),
  startedAt: z.number(),
  state: runningTaskStateSchema,
  threadId: z.string().optional(),
}).strict();
export type RunningTaskRow = z.infer<typeof runningTaskRowSchema>;

export const runningTasksPayloadSchema = z.object({
  now: z.number(),
  rows: z.array(runningTaskRowSchema),
}).strict();
export type RunningTasksPayload = z.infer<typeof runningTasksPayloadSchema>;
