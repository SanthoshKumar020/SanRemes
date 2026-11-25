import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

interface Reply {
  status: number;
  // SAFETY: test-only view of JSON bodies; every field read below is asserted first
  body: any;
}

describe("structured memory notes routes through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  let botId = "";
  const api = async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };

  beforeAll(async () => {
    fixture = await launchVerificationServer();
    const wrapper = join(fixture.info.dataDir, "notes-fixture.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    expect((await api("PATCH", "/api/instances/claude", { cli: wrapper })).status).toBe(200);
    const catalog = (await api("GET", "/api/instances")).body.instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
    const model = catalog.models.options[0].id;
    const created = await api("POST", "/api/bots", { name: "Scout", modelSelection: { instanceId: "claude", model } });
    expect(created.status).toBe(201);
    botId = created.body.bot.id;
  });

  afterAll(async () => {
    await fixture?.close();
  });

  const noteBody = {
    path: "preferences/short-replies",
    text: "Prefers short replies",
    sources: [{ chatId: "c1", messageId: "m1", quote: "I prefer short replies", at: "2026-11-25T10:00:00.000Z" }],
    sourceMessages: [{ id: "m1", text: "I prefer short replies and I live in India" }],
  };

  it("starts empty and adds a note only when its quote is in the cited message", async () => {
    const empty = await api("GET", `/api/bots/${botId}/memory/notes`);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ version: 0, notes: [], archive: [], skills: [] });
    const bad = await api("POST", `/api/bots/${botId}/memory/notes`, {
      ...noteBody, sources: [{ chatId: "c1", messageId: "m1", quote: "Lives in Mumbai", at: "2026-11-25T10:00:00.000Z" }],
    });
    expect(bad.status).toBe(400);
    const added = await api("POST", `/api/bots/${botId}/memory/notes`, noteBody);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ ok: true, version: 1 });
    expect(added.body.note).toMatchObject({ path: "preferences/short-replies", status: "stated" });
    const view = await api("GET", `/api/bots/${botId}/memory/notes`);
    expect(view.body.notes).toHaveLength(1);
  });

  it("refuses a stale save and runs the note lifecycle", async () => {
    const stale = await api("POST", `/api/bots/${botId}/memory/notes/confirm`, { path: "preferences/short-replies", expectedVersion: 99 });
    expect(stale.status).toBe(409);
    const view = await api("GET", `/api/bots/${botId}/memory/notes`);
    const version = view.body.version as number;
    const edited = await api("POST", `/api/bots/${botId}/memory/notes/edit`, { path: "preferences/short-replies", text: "Prefers short replies and no calls", expectedVersion: version });
    expect(edited.status).toBe(200);
    expect(edited.body.version).toBe(version + 1);
    const archived = await api("POST", `/api/bots/${botId}/memory/notes/archive`, { path: "preferences/short-replies", reason: "obsolete", expectedVersion: version + 1 });
    expect(archived.status).toBe(200);
    const afterArchive = await api("GET", `/api/bots/${botId}/memory/notes`);
    expect(afterArchive.body.notes).toHaveLength(0);
    // Two entries: the edit archived the earlier wording as superseded, then the archive action added the obsolete one.
    expect(afterArchive.body.archive).toHaveLength(2);
    expect(afterArchive.body.archive.map((entry: { reason: string }) => entry.reason)).toEqual(["superseded", "obsolete"]);
    const restored = await api("POST", `/api/bots/${botId}/memory/notes/restore`, { path: "preferences/short-replies", expectedVersion: version + 2 });
    expect(restored.status).toBe(200);
    const forgotten = await api("DELETE", `/api/bots/${botId}/memory/notes?path=preferences%2Fshort-replies&expectedVersion=${version + 3}`);
    expect(forgotten.status).toBe(200);
    const afterForget = await api("GET", `/api/bots/${botId}/memory/notes`);
    expect(afterForget.body.notes).toHaveLength(0);
    expect(afterForget.body.archive).toHaveLength(0);
  });

  it("saves an explicit remember request and refuses anything without one", async () => {
    const plain = await api("POST", `/api/bots/${botId}/memory/notes/remember`, {
      path: "about/diet", chatId: "c1", messageId: "m2", text: "What time is dinner?", at: "2026-11-25T12:00:00.000Z",
    });
    expect(plain.status).toBe(400);
    const remembered = await api("POST", `/api/bots/${botId}/memory/notes/remember`, {
      path: "about/diet", chatId: "c1", messageId: "m2", text: "Remember: I am vegetarian", at: "2026-11-25T12:00:00.000Z",
    });
    expect(remembered.status).toBe(200);
    expect(remembered.body.note).toMatchObject({ path: "about/diet", text: "I am vegetarian", status: "stated" });
  });

  it("maintains notes and manages learned skills", async () => {
    const maintained = await api("POST", `/api/bots/${botId}/memory/notes/maintain`, {});
    expect(maintained.status).toBe(200);
    expect(maintained.body.report).toMatchObject({ expired: 0, duplicates: 0, stale: 0 });
    const saved = await api("POST", `/api/bots/${botId}/memory/skills`, {
      name: "weekly-report", description: "Builds the weekly report.", body: "1. Open the sheet.\n2. Export CSV.", task: "weekly report",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.skill).toMatchObject({ name: "weekly-report" });
    const listed = await api("GET", `/api/bots/${botId}/memory/skills`);
    expect(listed.body.skills).toHaveLength(1);
    const patched = await api("POST", `/api/bots/${botId}/memory/skills/patch`, { name: "weekly-report", body: "1. Open the sheet.\n2. Export CSV.\n3. Send it." });
    expect(patched.status).toBe(200);
    expect(patched.body.skill.body).toContain("Send it.");
    const forgotten = await api("DELETE", `/api/bots/${botId}/memory/skills?name=weekly-report`);
    expect(forgotten.status).toBe(200);
    expect((await api("GET", `/api/bots/${botId}/memory/skills`)).body.skills).toHaveLength(0);
  });

  it("answers 404 for a bot that does not exist", async () => {
    expect((await api("GET", "/api/bots/no-such-bot/memory/notes")).status).toBe(404);
    expect((await api("GET", "/api/bots/no-such-bot/memory/skills")).status).toBe(404);
  });
});
