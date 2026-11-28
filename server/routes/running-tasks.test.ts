import { describe, expect, it } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteContext } from "./table.ts";
import { createRunningTasksRoutes } from "./running-tasks.ts";

function callRoute(auth: RequestAuth, snapshot: Parameters<typeof createRunningTasksRoutes>[0]["snapshot"]) {
  const route = createRunningTasksRoutes({
    snapshot,
    visible: () => ({ bot: (botId) => botId !== "hidden-bot", thread: (threadId) => threadId !== "t-hidden" }),
  });
  const sent: { status?: number; body?: unknown } = {};
  return route({
    req: {} as never, res: {} as never, url: new URL("/api/running", "http://127.0.0.1"), path: "/api/running", method: "GET",
    auth, readBody: (async () => null) as RouteContext["readBody"],
    json: ((_res: never, status: number, value: unknown) => { sent.status = status; sent.body = value; }) as RouteContext["json"],
  }).then(() => sent);
}

const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;

describe("GET /api/running", () => {
  it("returns the collected rows and hides what the caller may not see", async () => {
    const sent = await callRoute(auth, () => ({
      turns: () => [
        { botId: "scout", threadId: "t-main", status: "running", text: "Triage", startedAt: 100, createdAt: 100 },
        { botId: "hidden-bot", threadId: "t-hidden", status: "running", createdAt: 90 },
        { botId: "scout", threadId: "t-hidden", status: "running", createdAt: 80 },
      ],
      routineRuns: () => [],
      tasks: () => [],
      batches: () => [],
      botName: () => "Scout",
      threadTitle: () => null,
    }));
    expect(sent.status).toBe(200);
    const body = sent.body as { now: number; rows: Array<{ id: string }> };
    expect(body.rows.map((row) => row.id)).toEqual(["turn:t-main"]);
  });

  it("passes any other path on", async () => {
    const route = createRunningTasksRoutes({
      snapshot: () => ({ turns: () => [], routineRuns: () => [], tasks: () => [], batches: () => [], botName: () => null, threadTitle: () => null }),
      visible: () => ({ bot: () => true, thread: () => true }),
    });
    const sent: { status?: number; body?: unknown } = {};
    const out = await route({
      req: {} as never, res: {} as never, url: new URL("/api/other", "http://127.0.0.1"), path: "/api/other", method: "GET",
      auth, readBody: (async () => null) as RouteContext["readBody"],
      json: ((_res: never, status: number, value: unknown) => { sent.status = status; sent.body = value; }) as RouteContext["json"],
    });
    expect(out).toBe(PASS);
    expect(sent.status).toBeUndefined();
  });
});
