import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TasksStore } from "./tasks-store.ts";
import {
  CloudExecutorError, createCloudExecutorStub, createExecutorRegistry, createLocalExecutor,
  type AgentExecutor,
} from "./executors.ts";
import { ParallelSessionStore, type GhRunner, type GitRunner } from "./parallel-sessions.ts";

let dir: string;
let tasks: TasksStore;
let sessions: ParallelSessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sanremes-executors-"));
  tasks = new TasksStore({ dataDir: dir });
  sessions = new ParallelSessionStore({ dataDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const REPO = "/home/person/work/demo";

function fakeGit(): GitRunner {
  return {
    run: async (_cwd, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { code: 0, stdout: `${REPO}\n`, stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--verify") return { code: 0, stdout: "abc\n", stderr: "" };
      if (args[0] === "show-ref") return { code: 1, stdout: "", stderr: "" };
      if (args[0] === "worktree") return { code: 0, stdout: "Preparing worktree\n", stderr: "" };
      if (args[0] === "status" || args[0] === "diff") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function fakeGh(): GhRunner {
  return { find: () => "/usr/bin/gh", run: async () => ({ code: 0, stdout: "https://github.com/person/demo/pull/12\n", stderr: "" }) };
}

function localExecutor(): AgentExecutor {
  return createLocalExecutor({
    sessions, tasks, git: fakeGit(), gh: fakeGh(),
    runPrompt: async (_botId, prompt) => `reply to ${prompt}`,
    botExists: (id) => id === "scout",
  });
}

describe("createCloudExecutorStub", () => {
  it("is never attached and refuses every call in plain words", async () => {
    const stub = createCloudExecutorStub();
    expect(stub.attached()).toBe(false);
    expect(stub.kind).toBe("cloud");
    for (const call of [
      () => stub.runPrompt({ botId: "scout", prompt: "hi" }),
      () => stub.startSession({ repoDir: REPO, taskId: "task-1", botId: "scout" }),
      () => stub.refreshSession("session-1"),
      () => stub.openSessionPr("session-1", { title: "x" }),
      () => stub.closeSession("session-1"),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(CloudExecutorError);
      await expect(call()).rejects.toThrowError("No cloud executor is attached");
    }
  });
});

describe("createLocalExecutor", () => {
  it("runs a prompt through the injected turn and reports no token counts", async () => {
    const executor = localExecutor();
    expect(executor.attached()).toBe(true);
    const result = await executor.runPrompt({ botId: "scout", prompt: "hello" });
    expect(result.text).toBe("reply to hello");
    expect(result.inputTokens).toBeUndefined();
  });

  it("refuses an unknown bot", async () => {
    const executor = localExecutor();
    await expect(executor.runPrompt({ botId: "ghost", prompt: "hi" })).rejects.toThrowError("No such bot.");
  });

  it("starts a session on its own branch and opens its pull request", async () => {
    const executor = localExecutor();
    const task = tasks.create({ title: "fix it", goal: "fix it", assigneeBotId: "scout" });
    const session = await executor.startSession({ repoDir: REPO, taskId: task.id, botId: "scout" });
    expect(session.branch).toBe(`sanremes/${task.id}`);
    expect(session.state).toBe("active");
    const opened = await executor.openSessionPr(session.id, { title: "Fix it" });
    expect(opened.state).toBe("pr-open");
    expect(opened.prUrl).toContain("/pull/12");
    const closed = await executor.closeSession(session.id);
    expect(closed.state).toBe("closed");
  });
});

describe("createExecutorRegistry", () => {
  it("resolves auto to local while no cloud executor is attached", () => {
    const registry = createExecutorRegistry({ local: localExecutor() });
    expect(registry.cloudAttached()).toBe(false);
    const auto = registry.resolve("auto");
    expect(auto.executor.kind).toBe("local");
    expect(auto.note).toBeNull();
    const local = registry.resolve("local");
    expect(local.executor.kind).toBe("local");
    expect(local.note).toBeNull();
  });

  it("falls back to local with a plain-words note when cloud is asked for but not attached", () => {
    const registry = createExecutorRegistry({ local: localExecutor() });
    const cloud = registry.resolve("cloud");
    expect(cloud.executor.kind).toBe("local");
    expect(cloud.note).toContain("No cloud executor is attached");
  });

  it("resolves to the cloud executor once one is attached", () => {
    const cloud = createLocalExecutor({
      sessions, tasks, git: fakeGit(), gh: fakeGh(), runPrompt: async () => "cloud reply",
    });
    const registry = createExecutorRegistry({ local: localExecutor(), cloud });
    expect(registry.cloudAttached()).toBe(true);
    expect(registry.resolve("auto").executor).toBe(cloud);
    expect(registry.resolve("cloud").note).toBeNull();
  });
});
