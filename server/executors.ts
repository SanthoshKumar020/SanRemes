// The executor contract: one interface for running a prompt, a parallel session, or a
// batch, implemented once by this computer and once by the Cloud. A managed agent, a
// cloud session and a hosted batch are defined against this interface, never against
// a machine, so the same definition runs identically wherever its executor lives.
import type { ExecutorKind, HandoffPreference } from "../shared/managed-agents.ts";
import {
  closeParallelSession, createParallelSession, defaultGhRunner, defaultGitRunner, openParallelPr,
  refreshParallelSession,
  type GhRunner, type GitRunner, type ParallelSession, type ParallelSessionStore,
} from "./parallel-sessions.ts";
import type { TasksStore } from "./tasks-store.ts";

export const NO_CLOUD_EXECUTOR =
  "No cloud executor is attached, so this runs on this computer instead. Attach SanRemes Cloud to run it there.";
export const CLOUD_EXECUTOR_MISSING =
  "No cloud executor is attached. Attach SanRemes Cloud first, or run it on this computer.";

export class CloudExecutorError extends Error {
  readonly status = 503;
  constructor(message: string = CLOUD_EXECUTOR_MISSING) {
    super(message);
  }
}

export interface ExecutorPromptInput {
  botId: string;
  prompt: string;
  taskId?: string;
}

export interface ExecutorPromptResult {
  text: string;
  model?: string;
  /** Absent when the executor reports no token counts, as a bot turn does not. */
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  durationMs: number;
}

export interface ExecutorSessionInput {
  repoDir: string;
  taskId: string;
  botId: string;
  baseBranch?: string;
}

export interface AgentExecutor {
  readonly kind: ExecutorKind;
  readonly label: string;
  attached(): boolean;
  runPrompt(input: ExecutorPromptInput): Promise<ExecutorPromptResult>;
  startSession(input: ExecutorSessionInput): Promise<ParallelSession>;
  refreshSession(id: string): Promise<ParallelSession>;
  openSessionPr(id: string, input: { title: string; body?: string }): Promise<ParallelSession>;
  closeSession(id: string): Promise<ParallelSession>;
}

export interface LocalExecutorDeps {
  sessions: ParallelSessionStore;
  tasks: TasksStore;
  git?: GitRunner;
  gh?: GhRunner;
  /** Runs one prompt as its own turn of the bot and resolves with the reply. */
  runPrompt(botId: string, prompt: string): Promise<string>;
  botExists?(id: string): boolean;
}

export function createLocalExecutor(deps: LocalExecutorDeps): AgentExecutor {
  return {
    kind: "local",
    label: "This computer",
    attached: () => true,
    async runPrompt(input) {
      if (deps.botExists && !deps.botExists(input.botId)) throw new Error("No such bot.");
      const started = Date.now();
      const text = await deps.runPrompt(input.botId, input.prompt);
      return { text, durationMs: Date.now() - started };
    },
    async startSession(input) {
      if (deps.botExists && !deps.botExists(input.botId)) throw new Error("No such bot.");
      return createParallelSession(deps.sessions, deps.tasks, deps.git ?? defaultGitRunner, input);
    },
    async refreshSession(id) {
      return refreshParallelSession(deps.sessions, deps.git ?? defaultGitRunner, id);
    },
    async openSessionPr(id, input) {
      return openParallelPr(deps.sessions, deps.gh ?? defaultGhRunner, id, input);
    },
    async closeSession(id) {
      return closeParallelSession(deps.sessions, id);
    },
  };
}

/** The Cloud side until a real Cloud executor is attached: every call refuses in plain
 * words, so nothing ever pretends a hosted run happened. */
export function createCloudExecutorStub(): AgentExecutor {
  const refuse = (): never => {
    throw new CloudExecutorError();
  };
  return {
    kind: "cloud",
    label: "SanRemes Cloud",
    attached: () => false,
    runPrompt: async () => refuse(),
    startSession: async () => refuse(),
    refreshSession: async () => refuse(),
    openSessionPr: async () => refuse(),
    closeSession: async () => refuse(),
  };
}

export interface ExecutorRegistry {
  local: AgentExecutor;
  cloud: AgentExecutor;
  /** The executor a preference resolves to, with the plain-words note when it fell back. */
  resolve(preference: HandoffPreference): { executor: AgentExecutor; note: string | null };
  /** True once a real Cloud executor has been attached to this registry. */
  cloudAttached(): boolean;
}

export function createExecutorRegistry(options: { local: AgentExecutor; cloud?: AgentExecutor }): ExecutorRegistry {
  const cloud = options.cloud ?? createCloudExecutorStub();
  return {
    local: options.local,
    cloud,
    cloudAttached: () => cloud.attached(),
    resolve(preference) {
      if (preference === "local") return { executor: options.local, note: null };
      if (preference === "cloud") {
        if (cloud.attached()) return { executor: cloud, note: null };
        return { executor: options.local, note: NO_CLOUD_EXECUTOR };
      }
      if (cloud.attached()) return { executor: cloud, note: null };
      return { executor: options.local, note: null };
    },
  };
}
