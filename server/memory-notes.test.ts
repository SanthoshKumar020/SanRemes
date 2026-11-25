import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  addNote,
  archiveNote,
  buildMemoryIndex,
  buildSkillsIndex,
  confirmNote,
  editNote,
  emptyNotesDoc,
  findNotes,
  forgetNote,
  forgetSkill,
  listNotes,
  listSkills,
  loadNotesDoc,
  maintainNotes,
  parseNotePath,
  patchSkill,
  quoteInSource,
  rememberFromMessage,
  restoreNote,
  saveNotesDoc,
  saveSkill,
  structuredNotesPromptBlock,
  MemoryNotesError,
  type CitedMessage,
  type MemoryNotesDoc,
} from "./memory-notes.ts";
import { ensureWorkspace, memoryNotesPrompt, workspaceDir } from "./workspace.ts";

const BOT = "bot-memory-notes-test";
const TODAY = "2026-11-25";

beforeEach(() => {
  rmSync(workspaceDir(BOT), { recursive: true, force: true });
});

function root(): string {
  return mkdtempSync(join(tmpdir(), "sanremes-notes-"));
}

function source(messageId = "m1", text = "I prefer short replies and I live in India"): CitedMessage {
  return { id: messageId, text };
}

function statedNote(doc: MemoryNotesDoc, path = "preferences/short-replies", text = "Prefers short replies"): MemoryNotesDoc {
  return addNote(doc, {
    path,
    text,
    sources: [{ chatId: "c1", messageId: "m1", quote: "I prefer short replies", at: "2026-11-25T10:00:00.000Z" }],
  }, [source()]);
}

describe("note paths", () => {
  it("accepts area/slug and rejects anything else", () => {
    expect(parseNotePath("people/anna")).toEqual({ area: "people", slug: "anna" });
    expect(() => parseNotePath("people")).toThrow(MemoryNotesError);
    expect(() => parseNotePath("nowhere/anna")).toThrow(MemoryNotesError);
    expect(() => parseNotePath("people/Anna Smith")).toThrow(MemoryNotesError);
    expect(() => parseNotePath("../people/anna")).toThrow(MemoryNotesError);
  });
});

describe("adding notes", () => {
  it("saves a stated note with its quoted source", () => {
    const doc = statedNote(emptyNotesDoc());
    expect(doc.notes).toHaveLength(1);
    expect(doc.notes[0]).toMatchObject({ path: "preferences/short-replies", area: "preferences", text: "Prefers short replies", status: "stated" });
    expect(doc.notes[0]!.sources).toHaveLength(1);
  });

  it("refuses a quote the cited message does not contain", () => {
    expect(() =>
      addNote(emptyNotesDoc(), {
        path: "about/home",
        text: "Lives in Mumbai",
        sources: [{ chatId: "c1", messageId: "m1", quote: "Lives in Mumbai", at: "2026-11-25T10:00:00.000Z" }],
      }, [source()]),
    ).toThrow(/quote must appear in the message it cites/);
  });

  it("matches a quote however it was typed: case, quotes and spacing aside", () => {
    expect(quoteInSource("“I prefer  short replies”", "i prefer short replies")).toBe(true);
    expect(quoteInSource("lives in Mumbai", "I live in India")).toBe(false);
  });

  it("refuses a note holding a secret", () => {
    expect(() =>
      addNote(emptyNotesDoc(), {
        path: "about/key",
        text: "My key is sk-ant-abcdefghijklmnop",
        sources: [{ chatId: "c1", messageId: "m1", quote: "My key is sk-ant-abcdefghijklmnop", at: "2026-11-25T10:00:00.000Z" }],
      }, [source("m1", "My key is sk-ant-abcdefghijklmnop")]),
    ).toThrow(/cannot hold a secret/);
  });

  it("refuses a second note at the same path and merges the same fact instead", () => {
    let doc = statedNote(emptyNotesDoc());
    expect(() =>
      addNote(doc, {
        path: "preferences/short-replies",
        text: "Something else entirely",
        sources: [{ chatId: "c1", messageId: "m2", quote: "Something else entirely", at: "2026-11-25T11:00:00.000Z" }],
      }, [source("m2", "Something else entirely")]),
    ).toThrow(/already exists/);
    doc = addNote(doc, {
      path: "preferences/short-replies-2",
      text: "Prefers short replies.",
      sources: [{ chatId: "c1", messageId: "m2", quote: "Prefers short replies", at: "2026-11-25T11:00:00.000Z" }],
    }, [source("m2", "Prefers short replies")]);
    expect(doc.notes).toHaveLength(1);
    expect(doc.notes[0]!.sources).toHaveLength(2);
  });

  it("refuses text over the limit and a bad expiry", () => {
    expect(() =>
      addNote(emptyNotesDoc(), { path: "about/x", text: "x".repeat(4001), sources: [{ chatId: "c1", messageId: "m1", quote: "x", at: "2026-11-25T10:00:00.000Z" }] }, [source("m1", "x")]),
    ).toThrow(/at most 4000/);
    expect(() =>
      addNote(emptyNotesDoc(), { path: "about/x", text: "Lives in Pune", expires: "next week", sources: [{ chatId: "c1", messageId: "m1", quote: "Lives in Pune", at: "2026-11-25T10:00:00.000Z" }] }, [source("m1", "Lives in Pune")]),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe("note lifecycle", () => {
  it("confirms, edits, archives, restores and forgets", () => {
    let doc = addNote(emptyNotesDoc(), {
      path: "people/anna",
      text: "Anna handles invoices",
      status: "tentative",
      sources: [{ chatId: "c1", messageId: "m1", quote: "Anna handles invoices", at: "2026-11-25T10:00:00.000Z" }],
    }, [source("m1", "Anna handles invoices")]);
    doc = confirmNote(doc, "people/anna");
    expect(doc.notes[0]!.status).toBe("stated");
    doc = editNote(doc, "people/anna", "Anna handles invoices and expenses");
    expect(doc.notes[0]).toMatchObject({ text: "Anna handles invoices and expenses", status: "stated", sources: [] });
    expect(doc.notes[0]!.edited).not.toBeNull();
    expect(doc.archive).toHaveLength(1);
    expect(doc.archive[0]).toMatchObject({ text: "Anna handles invoices", reason: "superseded" });
    doc = archiveNote(doc, "people/anna", "obsolete");
    expect(doc.notes).toHaveLength(0);
    expect(doc.archive).toHaveLength(2);
    doc = restoreNote(doc, "people/anna", TODAY);
    expect(doc.notes).toHaveLength(1);
    expect(doc.notes[0]!.status).toBe("stated");
    doc = forgetNote(doc, "people/anna");
    expect(doc.notes).toHaveLength(0);
    expect(doc.archive).toHaveLength(0);
  });

  it("refuses lifecycle steps for notes that are not there", () => {
    const doc = emptyNotesDoc();
    expect(() => confirmNote(doc, "about/nope")).toThrow(/no live note/);
    expect(() => archiveNote(doc, "about/nope", "manual")).toThrow(/no live note/);
    expect(() => restoreNote(doc, "about/nope", TODAY)).toThrow(/no archived note/);
    expect(() => forgetNote(doc, "about/nope")).toThrow(/no note at/);
    expect(() => archiveNote(statedNote(emptyNotesDoc()), "preferences/short-replies", "bogus" as never)).toThrow(/archive reason/);
  });
});

describe("recall", () => {
  it("lists confirmed notes first and marks tentative ones in the index", () => {
    let doc = statedNote(emptyNotesDoc());
    doc = addNote(doc, {
      path: "about/guess",
      text: "Maybe lives in Chennai",
      status: "tentative",
      sources: [{ chatId: "c1", messageId: "m2", quote: "Maybe lives in Chennai", at: "2026-11-25T11:00:00.000Z" }],
    }, [source("m2", "Maybe lives in Chennai")]);
    expect(listNotes(doc).map((n) => n.path)).toEqual(["preferences/short-replies", "about/guess"]);
    const index = buildMemoryIndex(doc, TODAY);
    expect(index).toContain("preferences/short-replies: Prefers short replies");
    expect(index).toContain("about/guess: Maybe lives in Chennai (tentative)");
  });

  it("finds notes by whole words in slug or text, and hides expired ones", () => {
    let doc = statedNote(emptyNotesDoc());
    doc = addNote(doc, {
      path: "about/dentist",
      text: "Dentist appointment on Friday",
      expires: "2026-11-20",
      sources: [{ chatId: "c1", messageId: "m2", quote: "Dentist appointment on Friday", at: "2026-11-25T11:00:00.000Z" }],
    }, [source("m2", "Dentist appointment on Friday")]);
    expect(findNotes(doc, "short replies", TODAY).map((n) => n.path)).toEqual(["preferences/short-replies"]);
    expect(findNotes(doc, "dentist", TODAY)).toEqual([]);
    expect(findNotes(doc, "ist", TODAY)).toEqual([]);
    expect(findNotes(doc, "", TODAY)).toEqual([]);
  });

  it("shows structured notes in the prompt beside MEMORY.md", () => {
    const dir = ensureWorkspace(BOT);
    const doc = saveNotesDoc(dir, statedNote(emptyNotesDoc()));
    const prompt = memoryNotesPrompt(BOT, { managedWrites: true });
    expect(prompt).toContain("preferences/short-replies: Prefers short replies");
    expect(prompt).toContain("structured memory notes");
    expect(doc.version).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows nothing structured when there are no notes", () => {
    const dir = ensureWorkspace(BOT);
    rmSync(join(dir, "memory"), { recursive: true, force: true });
    expect(memoryNotesPrompt(BOT, { managedWrites: true })).not.toContain("structured memory notes");
    expect(structuredNotesPromptBlock(emptyNotesDoc(), TODAY)).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("maintenance", () => {
  it("archives expired and stale inferred notes and merges exact duplicates", () => {
    let doc = emptyNotesDoc();
    doc = addNote(doc, {
      path: "routines/standup",
      text: "Standup moved to Friday",
      expires: "2026-11-20",
      sources: [{ chatId: "c1", messageId: "m1", quote: "Standup moved to Friday", at: "2026-11-01T10:00:00.000Z" }],
    }, [source("m1", "Standup moved to Friday")]);
    doc = addNote(doc, {
      path: "preferences/tea",
      text: "Likes tea",
      sources: [{ chatId: "c1", messageId: "m2", quote: "Likes tea", at: "2026-11-25T10:00:00.000Z" }],
    }, [source("m2", "Likes tea")]);
    // A duplicate can only reach the store outside addNote, which merges on the way in: hand-place it.
    doc.notes.push({ path: "preferences/tea-2", area: "preferences", text: "Likes tea.", status: "stated", updated: "2026-11-25T11:00:00.000Z", edited: null, expires: null, sources: [{ chatId: "c1", messageId: "m3", quote: "Likes tea", at: "2026-11-25T11:00:00.000Z" }] });
    const stale = addNote(emptyNotesDoc(), {
      path: "about/old-guess",
      text: "Might prefer mornings",
      status: "tentative",
      sources: [{ chatId: "c1", messageId: "m4", quote: "Might prefer mornings", at: "2026-08-01T10:00:00.000Z" }],
    }, [source("m4", "Might prefer mornings")]);
    doc.notes.push({ ...stale.notes[0]!, updated: "2026-08-01T10:00:00.000Z" });
    const { doc: kept, report } = maintainNotes(doc, TODAY);
    expect(report).toEqual({ expired: 1, duplicates: 1, stale: 1 });
    expect(kept.notes.map((n) => n.path)).toEqual(["preferences/tea"]);
    expect(kept.notes[0]!.sources).toHaveLength(2);
    expect(kept.archive.map((a) => a.reason)).toEqual(["expired", "duplicate", "stale"]);
  });
});

describe("learned skills", () => {
  it("saves, patches and forgets a procedure, and refuses to overwrite an owner edit", () => {
    let doc = emptyNotesDoc();
    doc = saveSkill(doc, { name: "weekly-report", description: "Builds the weekly report.", body: "1. Open the sheet.\n2. Export CSV.", task: "weekly report" });
    expect(listSkills(doc).map((s) => s.name)).toEqual(["weekly-report"]);
    expect(buildSkillsIndex(listSkills(doc))).toBe("weekly-report: Builds the weekly report.");
    doc = patchSkill(doc, "weekly-report", "1. Open the sheet.\n2. Export CSV.\n3. Send it.");
    expect(doc.skills[0]!.body).toContain("Send it.");
    doc.skills[0]!.edited = "2026-11-25T12:00:00.000Z";
    expect(() => patchSkill(doc, "weekly-report", "Something else")).toThrow(/owner edited/);
    expect(() => saveSkill(doc, { name: "weekly-report", description: "New.", body: "New body." })).toThrow(/owner edited/);
    doc = forgetSkill(doc, "weekly-report");
    expect(doc.skills).toHaveLength(0);
    expect(() => forgetSkill(doc, "weekly-report")).toThrow(/no learned skill/);
  });

  it("refuses bad names, long bodies and secrets", () => {
    expect(() => saveSkill(emptyNotesDoc(), { name: "Weekly Report", description: "x.", body: "Do it." })).toThrow(/lowercase-hyphenated/);
    expect(() => saveSkill(emptyNotesDoc(), { name: "ok", description: "x.", body: "x".repeat(6001) })).toThrow(/at most 6000/);
    expect(() => saveSkill(emptyNotesDoc(), { name: "ok", description: "x.", body: "Key is sk-ant-abcdefghijklmnop" })).toThrow(/cannot hold a secret/);
  });

  it("evicts the least recently used unedited skill past forty", () => {
    let doc = emptyNotesDoc();
    for (let i = 0; i < 40; i++) {
      doc = saveSkill(doc, { name: `skill-${String(i).padStart(2, "0")}`, description: `Skill ${i}.`, body: "Do it." });
      doc.skills.at(-1)!.updated = `2026-11-01T00:${String(i).padStart(2, "0")}:00.000Z`;
    }
    doc = saveSkill(doc, { name: "skill-40", description: "Skill 40.", body: "Do it." });
    expect(doc.skills).toHaveLength(40);
    expect(doc.skills.some((s) => s.name === "skill-00")).toBe(false);
    expect(doc.skills.some((s) => s.name === "skill-40")).toBe(true);
  });
});

describe("explicit remember requests", () => {
  it("pulls the fact out of a remember line, with the message as its quote", () => {
    const found = rememberFromMessage({ chatId: "c1", messageId: "m1", text: "Remember: I am vegetarian", at: "2026-11-25T10:00:00.000Z" });
    expect(found).toMatchObject({ text: "I am vegetarian", quote: "I am vegetarian" });
    expect(rememberFromMessage({ chatId: "c1", messageId: "m1", text: "Remember that the launch moved to Friday", at: "2026-11-25T10:00:00.000Z" })).toMatchObject({ text: "the launch moved to Friday" });
    expect(rememberFromMessage({ chatId: "c1", messageId: "m1", text: "What time is the meeting?", at: "2026-11-25T10:00:00.000Z" })).toBeNull();
    expect(rememberFromMessage({ chatId: "c1", messageId: "m1", text: "Remember:", at: "2026-11-25T10:00:00.000Z" })).toBeNull();
  });
});

describe("notes store", () => {
  it("round-trips through disk with versioned saves and refuses a stale save", () => {
    const dir = root();
    try {
      const saved = saveNotesDoc(dir, statedNote(emptyNotesDoc()));
      expect(saved.version).toBe(1);
      expect(loadNotesDoc(dir).notes).toHaveLength(1);
      expect(() => saveNotesDoc(dir, saved, 0)).toThrow(/changed since you opened them/);
      const again = saveNotesDoc(dir, saved, 1);
      expect(again.version).toBe(2);
      expect(loadNotesDoc(dir).version).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts empty for a fresh workspace and refuses a corrupt file", () => {
    const dir = root();
    try {
      expect(loadNotesDoc(dir)).toEqual(emptyNotesDoc());
      mkdirSync(join(dir, "memory"), { recursive: true });
      writeFileSync(join(dir, "memory", "notes.json"), "{not json");
      expect(() => loadNotesDoc(dir)).toThrow(/not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a document over the size cap", () => {
    const dir = root();
    try {
      let doc = emptyNotesDoc();
      for (let i = 0; i < 70; i++) {
        doc.notes.push({ path: `about/note-${i}`, area: "about", text: "x".repeat(4000), status: "stated", updated: "2026-11-25T10:00:00.000Z", edited: null, expires: null, sources: [] });
      }
      expect(() => saveNotesDoc(dir, doc)).toThrow(/notes are full/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the workspace dir from memoryNotesPrompt", () => {
    expect(workspaceDir(BOT)).toContain(BOT);
  });
});

describe("Vault boundary", () => {
  it("refuses a plain-prose password and accepts a plain mention of one", () => {
    expect(() =>
      addNote(emptyNotesDoc(), {
        path: "about/wifi",
        text: "my wifi password is hunter2",
        sources: [{ chatId: "c1", messageId: "m1", quote: "my wifi password is hunter2", at: "2026-11-25T10:00:00.000Z" }],
      }, [source("m1", "my wifi password is hunter2")]),
    ).toThrow(/cannot hold a secret/);
    const doc = addNote(emptyNotesDoc(), {
      path: "about/wifi",
      text: "the wifi password is on the fridge",
      sources: [{ chatId: "c1", messageId: "m1", quote: "the wifi password is on the fridge", at: "2026-11-25T10:00:00.000Z" }],
    }, [source("m1", "the wifi password is on the fridge")]);
    expect(doc.notes).toHaveLength(1);
  });

  it("refuses a secret hidden in a fact's entities", () => {
    expect(() =>
      addNote(emptyNotesDoc(), {
        path: "preferences/short-replies",
        text: "Prefers short replies",
        sources: [{ chatId: "c1", messageId: "m1", quote: "I prefer short replies", at: "2026-11-25T10:00:00.000Z" }],
        fact: { kind: "preference", entities: ["my password is hunter2"] },
      }, [source()]),
    ).toThrow(/cannot hold a secret/);
  });

  it("refuses a secret in a skill's task", () => {
    expect(() =>
      saveSkill(emptyNotesDoc(), { name: "weekly-report", description: "Builds the weekly report.", body: "1. Open the sheet.", task: "the password is hunter2" }),
    ).toThrow(/cannot hold a secret/);
  });

  it("masks a shaped secret in the prompt index even from a hand-edited file", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature-here";
    const doc: MemoryNotesDoc = {
      ...emptyNotesDoc(),
      notes: [{
        path: "about/key", area: "about", text: `token ${jwt}`, status: "stated",
        updated: "2026-11-25T10:00:00.000Z", edited: null, expires: null, sources: [],
      }],
    };
    const index = buildMemoryIndex(doc, TODAY);
    expect(index).toContain("about/key:");
    expect(index).not.toContain(jwt);
    expect(index).toContain("redacted");
    const skills = buildSkillsIndex([{ name: "deploy", description: `uses ${jwt}`, body: "x", learned: "2026-11-25T10:00:00.000Z", updated: "2026-11-25T10:00:00.000Z", edited: null, task: null }]);
    expect(skills).not.toContain(jwt);
  });
});
