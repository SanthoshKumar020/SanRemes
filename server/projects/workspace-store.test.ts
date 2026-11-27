import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { Store } from "../store.ts";
import { projectContextText, readProjectWorkspace } from "./workspace.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const projectModel: ModelSelection = { instanceId: "codex", model: "gpt-5" };
const file = { id: "f1", name: "notes.md", text: "Prefer short replies." };

describe("project workspaces in the store", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("stores instructions, files and a model on a project and keeps them across a reload", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Drafter" });
    const created = store.createProject(bot.id, "Website", "📁")!;
    const patched = store.patchProject(bot.id, created.id, {
      instructions: "Be concise.", files: [file], model: projectModel,
    });
    expect(patched).not.toBeNull();
    expect(readProjectWorkspace(patched!)).toEqual({ instructions: "Be concise.", files: [file], model: projectModel });
    const reloaded = new Store(selection);
    expect(readProjectWorkspace(reloaded.project(bot.id, created.id))).toEqual({
      instructions: "Be concise.", files: [file], model: projectModel,
    });
    const persisted = (JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as any[])
      .find((row) => row.id === bot.id).projects[0];
    expect(persisted.instructions).toBe("Be concise.");
    expect(persisted.files).toEqual([file]);
    expect(persisted.model).toEqual(projectModel);
  });

  it("clears workspace fields on null and leaves the folder itself alone", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Drafter" });
    const created = store.createProject(bot.id, "Website", "📁")!;
    store.patchProject(bot.id, created.id, { instructions: "Be concise.", files: [file], model: projectModel });
    const cleared = store.patchProject(bot.id, created.id, { instructions: null, files: null, model: null });
    expect(readProjectWorkspace(cleared!)).toEqual({});
    expect(cleared).toMatchObject({ id: created.id, name: "Website", emoji: "📁" });
    const persisted = (JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as any[])
      .find((row) => row.id === bot.id).projects[0];
    expect(persisted).not.toHaveProperty("instructions");
    expect(persisted).not.toHaveProperty("files");
    expect(persisted).not.toHaveProperty("model");
  });

  it("rejects a malformed workspace patch without changing the project", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Drafter" });
    const created = store.createProject(bot.id, "Website")!;
    expect(store.patchProject(bot.id, created.id, { model: { instanceId: "codex" } as ModelSelection })).toBeNull();
    expect(store.patchProject(bot.id, created.id, { files: [{ ...file, text: "x".repeat(32_001) }] })).toBeNull();
    expect(store.patchProject(bot.id, created.id, { instructions: "Be concise." })?.name).toBe("Website");
    expect(readProjectWorkspace(store.project(bot.id, created.id))).toEqual({ instructions: "Be concise." });
  });

  it("resolves a thread's model from its project, under its own model and over the bot default", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Drafter" });
    const plain = store.createProject(bot.id, "Plain")!;
    const modelled = store.createProject(bot.id, "Modelled")!;
    store.patchProject(bot.id, modelled.id, { model: projectModel });
    const inPlain = store.createTask(bot.id, "In plain", true, plain.id)!;
    const inModelled = store.createTask(bot.id, "In modelled", true, modelled.id)!;
    const pinned = store.createTask(bot.id, "Pinned", true, modelled.id)!;
    store.patchTask(bot.id, pinned.threadId, { modelSelection: { instanceId: "ollama", model: "llama-4" } });
    const ungrouped = store.createTask(bot.id, "Ungrouped")!;
    expect(store.projectBotForTask(bot.id, inPlain.threadId)?.modelSelection).toEqual(selection());
    expect(store.projectBotForTask(bot.id, inModelled.threadId)?.modelSelection).toEqual(projectModel);
    expect(store.projectBotForTask(bot.id, pinned.threadId)?.modelSelection).toEqual({ instanceId: "ollama", model: "llama-4" });
    expect(store.projectBotForTask(bot.id, ungrouped.threadId)?.modelSelection).toEqual(selection());
  });

  it("flows a project's instructions and files into a thread's context, and unset fields change nothing", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Drafter" });
    const plain = store.createProject(bot.id, "Plain")!;
    const task = store.createTask(bot.id, "Thread", true, plain.id)!;
    expect(projectContextText(readProjectWorkspace(store.project(bot.id, task.projectId!)))).toBe("");
    expect(store.projectBotForTask(bot.id, task.threadId)?.modelSelection).toEqual(selection());
    store.patchProject(bot.id, plain.id, { instructions: "Be concise.", files: [file] });
    const text = projectContextText(readProjectWorkspace(store.project(bot.id, task.projectId!)));
    expect(text).toContain("Be concise.");
    expect(text).toContain("--- File: notes.md ---\nPrefer short replies.");
    expect(store.projectBotForTask(bot.id, task.threadId)?.modelSelection).toEqual(selection());
  });
});
