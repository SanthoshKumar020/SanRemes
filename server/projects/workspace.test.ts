import { describe, expect, it } from "vitest";

import type { BotProject as BotProjectRecord } from "../../shared/wire.ts";
import {
  applyProjectWorkspacePatch,
  PROJECT_FILES_MAX,
  PROJECT_FILE_TEXT_MAX,
  PROJECT_INSTRUCTIONS_MAX,
  projectContextText,
  readProjectWorkspace,
  resolveThreadModel,
  sanitizeProjectWorkspacePatch,
} from "./workspace.ts";

const botModel = { instanceId: "claude", model: "claude-sonnet-5" };
const projectModel = { instanceId: "codex", model: "gpt-5" };
const taskModel = { instanceId: "ollama", model: "llama-4" };
const file = { id: "f1", name: "notes.md", text: "Prefer short replies." };
const project = (extra: Record<string, unknown> = {}): BotProjectRecord =>
  ({ id: "p1", name: "Website", ...extra }) as BotProjectRecord;

describe("readProjectWorkspace", () => {
  it("returns nothing for a plain folder", () => {
    expect(readProjectWorkspace(undefined)).toEqual({});
    expect(readProjectWorkspace(project())).toEqual({});
    expect(readProjectWorkspace(project({ emoji: "📁" }))).toEqual({});
  });

  it("reads valid workspace fields", () => {
    expect(readProjectWorkspace(project({ instructions: "  Be concise. ", files: [file], model: projectModel }))).toEqual({
      instructions: "Be concise.", files: [file], model: projectModel,
    });
  });

  it("drops malformed fields instead of failing", () => {
    expect(readProjectWorkspace(project({
      instructions: 42, files: [file, { id: "bad" }, "nope"], model: { instanceId: "codex" },
    }))).toEqual({ files: [file] });
    expect(readProjectWorkspace(project({ instructions: "x".repeat(PROJECT_INSTRUCTIONS_MAX + 10) })).instructions).toHaveLength(PROJECT_INSTRUCTIONS_MAX);
  });
});

describe("sanitizeProjectWorkspacePatch", () => {
  it("passes a clean patch through and ignores folder fields", () => {
    expect(sanitizeProjectWorkspacePatch({ name: "Site", instructions: "Be concise.", files: [file], model: projectModel }))
      .toEqual({ instructions: "Be concise.", files: [file], model: projectModel });
    expect(sanitizeProjectWorkspacePatch({})).toEqual({});
    expect(sanitizeProjectWorkspacePatch({ instructions: null, files: null, model: null }))
      .toEqual({ instructions: null, files: null, model: null });
    expect(sanitizeProjectWorkspacePatch({ instructions: "   " })).toEqual({ instructions: null });
  });

  it("rejects malformed workspace fields", () => {
    expect(sanitizeProjectWorkspacePatch({ instructions: 42 })).toBeNull();
    expect(sanitizeProjectWorkspacePatch({ instructions: "x".repeat(PROJECT_INSTRUCTIONS_MAX + 1) })).toBeNull();
    expect(sanitizeProjectWorkspacePatch({ files: "notes.md" })).toBeNull();
    expect(sanitizeProjectWorkspacePatch({ files: [{ ...file, text: "x".repeat(PROJECT_FILE_TEXT_MAX + 1) }] })).toBeNull();
    expect(sanitizeProjectWorkspacePatch({ files: [file, { ...file, name: "other.md" }] })).toBeNull();
    expect(sanitizeProjectWorkspacePatch({ files: Array.from({ length: PROJECT_FILES_MAX + 1 }, (_, i) => ({ ...file, id: `f${i}` })) })).toBeNull();
    expect(sanitizeProjectWorkspacePatch({ model: { instanceId: "codex" } })).toBeNull();
    expect(sanitizeProjectWorkspacePatch({ model: { ...projectModel, effort: "turbo" } })).toBeNull();
    expect(sanitizeProjectWorkspacePatch({ model: "gpt-5" })).toBeNull();
    expect(sanitizeProjectWorkspacePatch(null)).toBeNull();
  });
});

describe("applyProjectWorkspacePatch", () => {
  it("sets fields and clears them on null, leaving the rest alone", () => {
    const record = project({ instructions: "Old.", model: projectModel });
    applyProjectWorkspacePatch(record, { files: [file] });
    expect(readProjectWorkspace(record)).toEqual({ instructions: "Old.", files: [file], model: projectModel });
    applyProjectWorkspacePatch(record, { instructions: null, model: null });
    expect(readProjectWorkspace(record)).toEqual({ files: [file] });
    expect(record).not.toHaveProperty("instructions");
    expect(record).not.toHaveProperty("model");
  });
});

describe("resolveThreadModel", () => {
  it("prefers the thread model, then the project model, then the bot default", () => {
    expect(resolveThreadModel(taskModel, projectModel, botModel)).toEqual(taskModel);
    expect(resolveThreadModel(undefined, projectModel, botModel)).toEqual(projectModel);
    expect(resolveThreadModel(undefined, undefined, botModel)).toEqual(botModel);
  });
});

describe("projectContextText", () => {
  it("is empty when nothing is set", () => {
    expect(projectContextText({})).toBe("");
  });

  it("prepends instructions and each file's contents", () => {
    const text = projectContextText({ instructions: "Be concise.", files: [file, { id: "f2", name: "style.md", text: "No exclamation marks." }] });
    expect(text).toContain("Be concise.");
    expect(text).toContain("--- File: notes.md ---\nPrefer short replies.");
    expect(text).toContain("--- File: style.md ---\nNo exclamation marks.");
    expect(text.indexOf("Be concise.")).toBeLessThan(text.indexOf("--- File:"));
  });
});
