// tasks.json as the server stores it and the Jobs page queue reads it: ticketed work one bot owns at a time, with
// the run history attached to the task. A bot id here is only an id; nothing about the bot is stored.
import { z } from "zod";

export const taskStateSchema = z.enum(["queued", "claimed", "running", "done", "failed"]);
export type TaskState = z.infer<typeof taskStateSchema>;

const idSchema = z.string().regex(/^[\w-]{1,128}$/u);
const textSchema = (max: number) => z.string().max(max);

/** One attempt at a task: when it happened, what came of it, and which bot did it. */
export const taskAttemptSchema = z.object({
  at: z.number(),
  result: textSchema(500),
  botId: z.string().max(128).optional(),
}).strict();
export type TaskAttempt = z.infer<typeof taskAttemptSchema>;

export const taskSchema = z.object({
  id: idSchema,
  title: textSchema(300).min(1),
  goal: textSchema(5000).optional(),
  /** Null until a bot claims the task; the claim sets this and the lock together. */
  assigneeBotId: z.string().max(128).nullable(),
  state: taskStateSchema,
  /** The bot holding the task, if any; null while queued or finished. */
  lockedBy: z.string().max(128).nullable(),
  lockedAt: z.number().nullable(),
  history: z.array(taskAttemptSchema).max(100).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();
export type Task = z.infer<typeof taskSchema>;

export const tasksFileSchema = z.object({
  version: z.literal(1),
  tasks: z.array(taskSchema),
}).strict();
export type TasksData = z.infer<typeof tasksFileSchema>;
