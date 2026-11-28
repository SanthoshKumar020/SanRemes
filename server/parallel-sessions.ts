// Parallel agent sessions sharing one repo: each session gets its own branch and its own worktree, claims
// one queued task, and opens a pull request when its work is done. Conflicts are reported in plain words
// and never resolved here: no merge, rebase or checkout ever runs against a session's work.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { augmentedPath, findCliCandidates } from "./env-path.ts";
import type { TasksStore } from "./tasks-store.ts";
import { personalGhEnv } from "./github/gh-cli.ts";

export const PARALLEL_SESSIONS_FILE = "parallel-sessions.json";
const SESSION_PREFIX = "sanremes";
const RUN_TIMEOUT_MS = 60_000;
const BASE_BRANCH = /^[\w./-]{1,128}$/u;

export type ParallelSessionState = "active" | "conflict" | "pr-open" | "closed";

export interface ParallelSession {
  id: string;
  repoDir: string;
  worktreeDir: string;
  baseBranch: string;
  branch: string;
  taskId: string;
  botId: string;
  state: ParallelSessionState;
  prUrl: string | null;
  conflictFiles: string[];
  createdAt: number;
  updatedAt: number;
}

const sessionSchema = z.object({
  id: z.string(),
  repoDir: z.string(),
  worktreeDir: z.string(),
  baseBranch: z.string(),
  branch: z.string(),
  taskId: z.string(),
  botId: z.string(),
  state: z.enum(["active", "conflict", "pr-open", "closed"]),
  prUrl: z.string().nullable(),
  conflictFiles: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();
const sessionsFileSchema = z.object({ version: z.literal(1), sessions: z.array(sessionSchema) }).strict();

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(cwd: string, args: string[]): Promise<CommandResult>;
}

export interface GhRunner {
  find(): string | null;
  run(args: string[], cwd: string): Promise<CommandResult>;
}

function runCommand(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout: RUN_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        const failed = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        resolve({ code: failed ? (typeof failed.code === "number" ? failed.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
  });
}

export const defaultGitRunner: GitRunner = {
  run: (cwd, args) => runCommand("git", args, cwd, process.env),
};

export const defaultGhRunner: GhRunner = {
  find: () => findCliCandidates("gh", augmentedPath())[0] ?? null,
  run: (args, cwd) => {
    const gh = findCliCandidates("gh", augmentedPath())[0];
    if (!gh) return Promise.resolve({ code: 1, stdout: "", stderr: "gh is not installed" });
    return runCommand(gh, args, cwd, personalGhEnv());
  },
};

export class ParallelSessionStore {
  private readonly file: string;
  private readonly worktreesDir: string;
  private readonly now: () => number;
  private cache: ParallelSession[] | null = null;

  constructor(options: { dataDir: string; now?: () => number }) {
    this.file = join(options.dataDir, PARALLEL_SESSIONS_FILE);
    this.worktreesDir = join(options.dataDir, "parallel-worktrees");
    this.now = options.now ?? Date.now;
  }

  worktreeDirFor(taskId: string): string {
    return join(this.worktreesDir, taskId);
  }

  private read(): ParallelSession[] {
    if (this.cache) return this.cache;
    let sessions: ParallelSession[] = [];
    if (existsSync(this.file)) {
      try {
        sessions = sessionsFileSchema.parse(JSON.parse(readFileSync(this.file, "utf8"))).sessions;
      } catch {
        console.warn("parallel sessions: parallel-sessions.json could not be read; past sessions are not listed");
      }
    }
    this.cache = sessions;
    return sessions;
  }

  private write(sessions: ParallelSession[]): void {
    const parsed = sessionsFileSchema.parse({ version: 1, sessions });
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, `${JSON.stringify(parsed, null, 2)}\n`);
    this.cache = parsed.sessions;
  }

  list(): ParallelSession[] {
    return structuredClone(this.read());
  }

  get(id: string): ParallelSession | null {
    const session = this.read().find((one) => one.id === id);
    return session ? structuredClone(session) : null;
  }

  insert(session: ParallelSession): ParallelSession {
    const sessions = [...this.read(), session];
    this.write(sessions);
    return structuredClone(session);
  }

  update(id: string, patch: Partial<ParallelSession>): ParallelSession | null {
    const sessions = this.read();
    const session = sessions.find((one) => one.id === id);
    if (!session) return null;
    Object.assign(session, patch, { updatedAt: this.now() });
    this.write(sessions);
    return structuredClone(session);
  }
}

export class ParallelSessionError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

function fail(message: string, status = 409): never {
  throw new ParallelSessionError(message, status);
}

function tail(stderr: string): string {
  const last = stderr.trim().split("\n").at(-1)?.trim() ?? "";
  return last ? `: ${last.slice(0, 300)}` : "";
}

export interface NewParallelSessionInput {
  repoDir: string;
  taskId: string;
  botId: string;
  baseBranch?: string;
}

/** Starts one session: its own branch and worktree off the base, holding one queued task. The git work
 * happens before the claim, so a failed start never leaves a task claimed with nowhere to work. */
export async function createParallelSession(
  store: ParallelSessionStore,
  tasks: TasksStore,
  git: GitRunner,
  input: NewParallelSessionInput,
): Promise<ParallelSession> {
  const { repoDir, taskId, botId } = input;
  const baseBranch = input.baseBranch ?? "main";
  if (!isAbsolute(repoDir)) fail("Send the repo as an absolute folder path.");
  if (!BASE_BRANCH.test(baseBranch) || baseBranch.includes("..")) fail("Send a plain branch name to start from.");
  const top = await git.run(repoDir, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) fail(`${repoDir} is not a git repo${tail(top.stderr)}.`);
  const topDir = top.stdout.trim().replaceAll("\\", "/");
  if (topDir !== repoDir.replaceAll("\\", "/")) fail(`${repoDir} is inside the ${topDir} repo. Start the session at the repo itself.`);
  const base = await git.run(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}`]);
  if (base.code !== 0) fail(`Branch ${baseBranch} does not exist in ${repoDir}.`);
  const branch = `${SESSION_PREFIX}/${taskId}`;
  const taken = await git.run(repoDir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (taken.code === 0) fail(`Branch ${branch} already exists. Delete it or pick another task.`);
  const task = tasks.get(taskId);
  if (!task) fail("No such task in the queue.");
  if (task.state !== "queued") fail(`That task is ${task.state}, not queued. Only a queued task can start a session.`);
  const worktreeDir = store.worktreeDirFor(taskId);
  const added = await git.run(repoDir, ["worktree", "add", worktreeDir, "-b", branch, baseBranch]);
  if (added.code !== 0) fail(`Could not make a worktree for ${branch}${tail(added.stderr)}.`);
  const claimed = tasks.claim(taskId, botId);
  if (claimed === null || claimed === "not-queued") {
    await git.run(repoDir, ["worktree", "remove", "--force", worktreeDir]);
    await git.run(repoDir, ["branch", "-D", branch]);
    fail("That task was claimed by another bot just now. The worktree was removed; try again.");
  }
  const at = Date.now();
  return store.insert({
    id: randomUUID(), repoDir, worktreeDir, baseBranch, branch, taskId, botId,
    state: "active", prUrl: null, conflictFiles: [], createdAt: at, updatedAt: at,
  });
}

/** Re-reads a session's worktree: which files conflict, if any. A conflict only ever changes the record;
 * nothing here merges, rebases or checks anything out. */
export async function refreshParallelSession(
  store: ParallelSessionStore,
  git: GitRunner,
  id: string,
): Promise<ParallelSession> {
  const session = store.get(id);
  if (!session) fail("No such session.", 404);
  if (session.state === "closed") return session;
  const status = await git.run(session.worktreeDir, ["status", "--porcelain=v1"]);
  if (status.code !== 0) fail(`Could not read the worktree at ${session.worktreeDir}${tail(status.stderr)}.`);
  const conflicts = await git.run(session.worktreeDir, ["diff", "--name-only", "--diff-filter=U"]);
  if (conflicts.code !== 0) fail(`Could not list conflicts in ${session.branch}${tail(conflicts.stderr)}.`);
  const conflictFiles = conflicts.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const state: ParallelSessionState = conflictFiles.length > 0 ? "conflict" : session.state === "conflict" ? "active" : session.state;
  return store.update(id, { conflictFiles, state })!;
}

/** Opens the session's branch as a pull request with the person's own GitHub CLI. */
export async function openParallelPr(
  store: ParallelSessionStore,
  gh: GhRunner,
  id: string,
  input: { title: string; body?: string },
): Promise<ParallelSession> {
  const session = store.get(id);
  if (!session) fail("No such session.", 404);
  if (session.state === "closed") fail("That session is closed. Start a new session for this work.");
  if (session.prUrl) return session;
  if (session.state === "conflict") {
    fail(`Resolve the conflicts in ${session.branch} first (${session.conflictFiles.join(", ") || "unknown files"}). SanRemes never resolves them for you.`);
  }
  if (!input.title.trim()) fail("Give the pull request a title.");
  const ghPath = gh.find();
  if (!ghPath) fail("GitHub CLI (gh) isn't installed on this computer, so no pull request can be opened. Install it and sign in with gh auth login, then try again.");
  const created = await gh.run(
    ["pr", "create", "--title", input.title.trim(), "--body", input.body?.trim() || "", "--head", session.branch, "--base", session.baseBranch],
    session.worktreeDir,
  );
  if (created.code !== 0) fail(`GitHub refused the pull request${tail(created.stderr)}. Check gh auth status on this computer.`);
  const url = created.stdout.match(/https:\/\/github\.com\/\S+\/pull\/\d+/u)?.[0] ?? null;
  if (!url) fail("GitHub accepted the pull request but gave no link back. Look for it under the repo's Pull requests.");
  return store.update(id, { prUrl: url, state: "pr-open" })!;
}

/** Closes a session's record. The worktree and branch stay where they are: removing them is the person's
 * call (`git worktree remove` and `git branch -d`), never an automatic side effect. */
export function closeParallelSession(store: ParallelSessionStore, id: string): ParallelSession {
  const session = store.get(id);
  if (!session) fail("No such session.", 404);
  if (session.state === "closed") return session;
  return store.update(id, { state: "closed" })!;
}
