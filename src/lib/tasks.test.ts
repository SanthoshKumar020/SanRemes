import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

import { claimTask, completeTask, failTask, fetchTasks, requeueTask, startTask, type Task } from "./tasks";

const task = (over: Partial<Task> = {}): Task => ({
  id: "task-1",
  title: "Apply to Acme",
  assigneeBotId: null,
  state: "queued",
  lockedBy: null,
  lockedAt: null,
  history: [],
  createdAt: 100,
  updatedAt: 100,
  ...over,
});

describe("task queue endpoints", () => {
  const request = vi.fn();
  beforeEach(() => request.mockClear());

  it("lists all tasks, and narrows with ?state=", async () => {
    request.mockResolvedValueOnce({ version: 1, tasks: [task()] }).mockResolvedValueOnce({ version: 1, tasks: [] });
    expect(await fetchTasks(undefined, request)).toEqual({ version: 1, tasks: [task()] });
    expect(await fetchTasks("failed", request)).toEqual({ version: 1, tasks: [] });
    expect(request).toHaveBeenNthCalledWith(1, "/api/tasks");
    expect(request).toHaveBeenNthCalledWith(2, "/api/tasks?state=failed");
  });

  it("claims and starts a task for one bot", async () => {
    request.mockResolvedValueOnce({ task: task({ state: "claimed", assigneeBotId: "bot-1" }) })
      .mockResolvedValueOnce({ task: task({ state: "running", assigneeBotId: "bot-1" }) });
    expect((await claimTask("task-1", "bot-1", request)).task.state).toBe("claimed");
    expect((await startTask("task-1", "bot-1", request)).task.state).toBe("running");
    expect(request).toHaveBeenNthCalledWith(1, "/api/tasks/task-1/claim", { method: "POST", body: JSON.stringify({ botId: "bot-1" }) });
    expect(request).toHaveBeenNthCalledWith(2, "/api/tasks/task-1/start", { method: "POST", body: JSON.stringify({ botId: "bot-1" }) });
  });

  it("completes and fails with the bot id and the result text", async () => {
    request.mockResolvedValueOnce({ task: task({ state: "done" }), version: 2 })
      .mockResolvedValueOnce({ task: task({ state: "failed" }), version: 3 });
    expect((await completeTask("task-1", "bot-1", "Applied.", request)).task.state).toBe("done");
    expect((await failTask("task-1", "bot-1", "Sign-in needed.", request)).task.state).toBe("failed");
    expect(request).toHaveBeenNthCalledWith(1, "/api/tasks/task-1/complete", { method: "POST", body: JSON.stringify({ botId: "bot-1", result: "Applied." }) });
    expect(request).toHaveBeenNthCalledWith(2, "/api/tasks/task-1/fail", { method: "POST", body: JSON.stringify({ botId: "bot-1", result: "Sign-in needed." }) });
  });

  it("requeues a failed task with an empty body", async () => {
    request.mockResolvedValueOnce({ task: task({ state: "queued" }) });
    expect((await requeueTask("task-1", request)).task.state).toBe("queued");
    expect(request).toHaveBeenCalledWith("/api/tasks/task-1/requeue", { method: "POST", body: "{}" });
  });
});
