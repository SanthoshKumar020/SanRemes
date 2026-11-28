import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { MeetingCompanionStore } from "../meetings/companion.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { dispatchRoutes } from "./table.ts";
import { createMeetingCompanionRoutes } from "./meetings.ts";

const servers: Server[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

const MEET = "https://meet.google.com/abc-defg-hij";

async function serve(owner: boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-companion-routes-"));
  scratch.push(dataDir);
  const routes = [createMeetingCompanionRoutes({
    store: new MeetingCompanionStore({ dataDir }),
    isOwner: () => owner,
    botExists: (id) => id === "scout",
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const post = (path: string, body?: unknown) => call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { call, post };
}

describe("meeting companion routes", () => {
  it("runs the whole companion lifecycle", async () => {
    const { call, post } = await serve(true);
    const empty = await call("/api/meetings");
    expect(empty.status).toBe(200);
    expect(empty.body.meetings).toEqual([]);

    const created = await post("/api/meetings", { url: MEET, title: "Weekly sync", botId: "scout" });
    expect(created.status).toBe(201);
    const id = created.body.meeting.id as string;
    expect(created.body.meeting.status).toBe("waiting");

    const refused = await post(`/api/meetings/${id}/start`, { joined: false });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Join the meeting yourself first, then start the companion.");

    const started = await post(`/api/meetings/${id}/start`, { joined: true });
    expect(started.status).toBe(200);
    expect(started.body.meeting.status).toBe("live");

    const line = await post(`/api/meetings/${id}/transcript`, { speaker: "Ana", text: "We ship on Friday." });
    expect(line.status).toBe(201);
    expect(line.body.line.text).toBe("We ship on Friday.");

    const question = await post(`/api/meetings/${id}/questions`, { from: "Ben", text: "When do we ship?" });
    expect(question.status).toBe(201);
    const answered = await post(`/api/meetings/${id}/questions/${question.body.question.id}/answer`, { text: "On Friday." });
    expect(answered.status).toBe(200);
    expect(answered.body.question.answer).toBe("On Friday.");

    const notes = await post(`/api/meetings/${id}/notes`, {
      summary: "Agreed the launch date.",
      decisions: ["Launch on Friday."],
      actionItems: [{ owner: "Ana", item: "Send the release notes", due: "Thursday" }],
      openQuestions: ["Who owns the rollback?"],
    });
    expect(notes.status).toBe(200);
    expect(notes.body.meeting.notes.summary).toBe("Agreed the launch date.");

    const artifacts = await post(`/api/meetings/${id}/artifacts`, { docTitle: "Weekly sync notes" });
    expect(artifacts.status).toBe(200);
    expect(artifacts.body.meeting.artifacts.docTitle).toBe("Weekly sync notes");

    const text = await call(`/api/meetings/${id}/notes-text`);
    expect(text.status).toBe(200);
    expect(text.body.text).toContain("Agreed the launch date.");

    const stopped = await post(`/api/meetings/${id}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.meeting.status).toBe("ended");

    const late = await post(`/api/meetings/${id}/transcript`, { text: "Too late." });
    expect(late.status).toBe(409);

    const removed = await call(`/api/meetings/${id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect((await call("/api/meetings")).body.meetings).toEqual([]);
  });

  it("refuses non-Meet links and unknown bots", async () => {
    const { post } = await serve(true);
    const teams = await post("/api/meetings", { url: "https://teams.microsoft.com/l/meetup-join/abc" });
    expect(teams.status).toBe(400);
    expect(teams.body.error).toBe("Only Google Meet links work here. Paste the meet.google.com link for the meeting you are joining.");
    const ghost = await post("/api/meetings", { url: MEET, botId: "ghost" });
    expect(ghost.status).toBe(404);
  });

  it("answers 404 for an unknown companion", async () => {
    const { call } = await serve(true);
    const res = await call("/api/meetings/mc-nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("There is no meeting companion with that id.");
  });

  it("refuses everyone but the owner", async () => {
    const { call, post } = await serve(false);
    expect((await call("/api/meetings")).status).toBe(403);
    expect((await post("/api/meetings", { url: MEET })).status).toBe(403);
    expect((await call("/api/meetings/mc-nope")).status).toBe(403);
  });

  it("passes through unrelated paths", async () => {
    const { call } = await serve(true);
    expect((await call("/api/managed-agents")).status).toBe(404);
  });
});
