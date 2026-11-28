import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TasksStore } from "./tasks-store.ts";
import {
  closeParallelSession, createParallelSession, openParallelPr, ParallelSessionStore, refreshParallelSession,
  type CommandResult, type GhRunner, type GitRunner,
} from "./parallel-sessions.ts";

const REPO = "/home/person/work/demo";
let dir: string;
let store: ParallelSessionStore;
let tasks: TasksStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sanremes-parallel-"));
  store = new ParallelSessionStore({ dataDir: dir });
  tasks = new TasksStore({ dataDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fakeGit(overrides: Partial<Record<string, CommandResult>> = {}): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = async (_cwd: string, args: string[]): Promise<CommandResult> => {
    calls.push(args);
    const key = args.join(" ");
    if (overrides[key]) return overrides[key]!;
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: `${REPO}\n`, stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: "abc123\n", stderr: "" };
    if (args[0] === "show-ref") return { code: 1, stdout: "", stderr: "" };
    if (args[0] === "worktree") return { code: 0, stdout: "Preparing worktree\n", stderr: "" };
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "diff") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "branch") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

function fakeGh(runResult: CommandResult = { code: 0, stdout: "https://github.com/person/demo/pull/12\n", stderr: "" }): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return { find: () => "/usr/bin/gh", run: async (args) => { calls.push(args); return runResult; }, calls };
}

async function seeded() {
  const task = tasks.create({ title: "Fix the flaky test" });
  return task.id;
}

describe("createParallelSession", () => {
  it("makes a branch and worktree per task and claims the task", async () => {
    const taskId = await seeded();
    const git = fakeGit();
    const session = await createParallelSession(store, tasks, git, { repoDir: REPO, taskId, botId: "scout" });
    expect(session).toMatchObject({
      repoDir: REPO, baseBranch: "main", branch: `sanremes/${taskId}`, taskId, botId: "scout", state: "active", prUrl: null, conflictFiles: [],
    });
    expect(session.worktreeDir).toBe(join(dir, "parallel-worktrees", taskId));
    expect(tasks.get(taskId)).toMatchObject({ state: "claimed", lockedBy: "scout" });
    expect(git.calls).toContainEqual(["worktree", "add", session.worktreeDir, "-b", `sanremes/${taskId}`, "main"]);
    expect(store.list()).toHaveLength(1);
  });

  it("refuses a folder that is not a repo, a missing base branch, and a taken branch", async () => {
    const taskId = await seeded();
    const notRepo = fakeGit({ "rev-parse --show-toplevel": { code: 128, stdout: "", stderr: "fatal: not a git repository" } });
    await expect(createParallelSession(store, tasks, notRepo, { repoDir: REPO, taskId, botId: "scout" }))
      .rejects.toThrow("is not a git repo");
    const noBase = fakeGit({ "rev-parse --verify --quiet refs/heads/main": { code: 1, stdout: "", stderr: "" } });
    await expect(createParallelSession(store, tasks, noBase, { repoDir: REPO, taskId, botId: "scout" }))
      .rejects.toThrow("Branch main does not exist");
    const taken = fakeGit({ [`show-ref --verify --quiet refs/heads/sanremes/${taskId}`]: { code: 0, stdout: "abc\n", stderr: "" } });
    await expect(createParallelSession(store, tasks, taken, { repoDir: REPO, taskId, botId: "scout" }))
      .rejects.toThrow("already exists");
    expect(tasks.get(taskId)?.state).toBe("queued");
  });

  it("refuses a task that is not queued and leaves the queue alone", async () => {
    const taskId = await seeded();
    tasks.claim(taskId, "other-bot");
    const git = fakeGit();
    await expect(createParallelSession(store, tasks, git, { repoDir: REPO, taskId, botId: "scout" }))
      .rejects.toThrow("not queued");
    expect(store.list()).toEqual([]);
  });

  it("removes the worktree and branch again when the claim races away", async () => {
    const taskId = await seeded();
    tasks.claim(taskId, "other-bot");
    tasks.fail(taskId, "other-bot", "gave up");
    tasks.requeue(taskId);
    const git = fakeGit();
    const racing = { ...git, run: async (cwd: string, args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") tasks.claim(taskId, "other-bot");
      return git.run(cwd, args);
    } };
    await expect(createParallelSession(store, tasks, racing, { repoDir: REPO, taskId, botId: "scout" }))
      .rejects.toThrow("claimed by another bot");
    expect(git.calls).toContainEqual(["worktree", "remove", "--force", join(dir, "parallel-worktrees", taskId)]);
    expect(git.calls).toContainEqual(["branch", "-D", `sanremes/${taskId}`]);
    expect(store.list()).toEqual([]);
  });
});

describe("refreshParallelSession", () => {
  it("marks a session conflicted when files conflict, and active again when they clear", async () => {
    const taskId = await seeded();
    const git = fakeGit();
    const session = await createParallelSession(store, tasks, git, { repoDir: REPO, taskId, botId: "scout" });
    const conflicted = fakeGit({ "diff --name-only --diff-filter=U": { code: 0, stdout: "src/app.ts\nsrc/util.ts\n", stderr: "" } });
    const marked = await refreshParallelSession(store, conflicted, session.id);
    expect(marked).toMatchObject({ state: "conflict", conflictFiles: ["src/app.ts", "src/util.ts"] });
    const cleared = await refreshParallelSession(store, fakeGit(), session.id);
    expect(cleared).toMatchObject({ state: "active", conflictFiles: [] });
    expect(git.calls.flat()).not.toContain("merge");
    expect(git.calls.flat()).not.toContain("rebase");
  });
});

describe("openParallelPr", () => {
  it("opens a pull request with the person's gh and records its link", async () => {
    const taskId = await seeded();
    const session = await createParallelSession(store, tasks, fakeGit(), { repoDir: REPO, taskId, botId: "scout" });
    const gh = fakeGh();
    const opened = await openParallelPr(store, gh, session.id, { title: "Fix the flaky test" });
    expect(opened).toMatchObject({ state: "pr-open", prUrl: "https://github.com/person/demo/pull/12" });
    expect(gh.calls[0]).toContain("pr");
    expect(gh.calls[0]).toContain(`sanremes/${taskId}`);
    const again = await openParallelPr(store, gh, session.id, { title: "Fix the flaky test" });
    expect(gh.calls).toHaveLength(1);
    expect(again.prUrl).toBe("https://github.com/person/demo/pull/12");
  });

  it("refuses a conflicted session and a missing gh in plain words", async () => {
    const taskId = await seeded();
    const session = await createParallelSession(store, tasks, fakeGit(), { repoDir: REPO, taskId, botId: "scout" });
    await refreshParallelSession(store, fakeGit({ "diff --name-only --diff-filter=U": { code: 0, stdout: "src/app.ts\n", stderr: "" } }), session.id);
    await expect(openParallelPr(store, fakeGh(), session.id, { title: "Fix it" }))
      .rejects.toThrow("Resolve the conflicts in sanremes/" + taskId + " first (src/app.ts). SanRemes never resolves them for you.");
    const noGh: GhRunner = { find: () => null, run: async () => ({ code: 1, stdout: "", stderr: "" }) };
    const freshId = (await createParallelSession(store, tasks, fakeGit(), { repoDir: REPO, taskId: (await seeded()), botId: "scout" })).id;
    await expect(openParallelPr(store, noGh, freshId, { title: "Fix it" })).rejects.toThrow("GitHub CLI (gh) isn't installed");
  });

  it("closes a session without removing its worktree or branch", async () => {
    const taskId = await seeded();
    const git = fakeGit();
    const session = await createParallelSession(store, tasks, git, { repoDir: REPO, taskId, botId: "scout" });
    const closed = closeParallelSession(store, session.id);
    expect(closed.state).toBe("closed");
    expect(git.calls.flat()).not.toContain("remove");
    expect(await refreshParallelSession(store, git, session.id)).toMatchObject({ state: "closed" });
  });
});
