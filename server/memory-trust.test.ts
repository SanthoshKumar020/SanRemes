import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadNotesDoc, MemoryNotesError, saveNotesDoc, type CitedMessage } from "./memory-notes.ts";
import {
  approveProposal,
  decideMemoryWrite,
  denyProposal,
  listProposals,
  loadPendingDoc,
  memoryActorForAuth,
  MEMORY_PENDING_MAX,
  MEMORY_TRUST_POLICY,
  stageProposal,
  type PendingProposalInput,
} from "./memory-trust.ts";
import type { RequestAuth } from "./request-auth.ts";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function root(): string {
  dir = mkdtempSync(join(tmpdir(), "sanremes-trust-"));
  return dir;
}

const messages: CitedMessage[] = [{ id: "m1", text: "I prefer short replies and I live in India" }];

function addNoteInput(path = "preferences/short-replies", text = "Prefers short replies"): PendingProposalInput {
  return {
    kind: "add-note",
    input: {
      path,
      text,
      sources: [{ chatId: "c1", messageId: "m1", quote: "I prefer short replies", at: "2026-11-25T10:00:00.000Z" }],
    },
    messages,
  };
}

const ownerLoopback: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const serviceLoopback: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
// The check reads only the session's scopes; the rest of the record is irrelevant here.
const adminSession = { kind: "session", session: { scopes: ["admin"] }, via: "bearer", scopes: ["admin"] } as unknown as RequestAuth;
const guestSession = { kind: "session", session: { scopes: [] }, via: "bearer", scopes: [] } as unknown as RequestAuth;

describe("confirmation policy", () => {
  it("lets the owner apply every content change at once and makes the bot wait", () => {
    for (const action of ["add-note", "edit-note", "confirm-note", "archive-note", "restore-note", "forget-note", "remember", "save-skill", "patch-skill", "forget-skill"] as const) {
      expect(decideMemoryWrite("owner", action)).toBe("auto");
      expect(decideMemoryWrite("agent", action)).toBe("pending");
    }
    expect(decideMemoryWrite("owner", "maintain-notes")).toBe("auto");
    expect(decideMemoryWrite("agent", "maintain-notes")).toBe("never");
  });

  it("covers every action exactly once per actor", () => {
    for (const actor of ["owner", "agent"] as const) {
      const rows = MEMORY_TRUST_POLICY.filter((rule) => rule.actor === actor);
      expect(new Set(rows.map((rule) => rule.action)).size).toBe(rows.length);
    }
    expect(MEMORY_TRUST_POLICY.length).toBe(22);
  });

  it("reads the actor off the caller's auth", () => {
    expect(memoryActorForAuth(ownerLoopback)).toBe("owner");
    expect(memoryActorForAuth(adminSession)).toBe("owner");
    expect(memoryActorForAuth(serviceLoopback)).toBe("agent");
    expect(memoryActorForAuth(guestSession)).toBe("agent");
  });
});

describe("pending proposals", () => {
  it("stages without touching the live notes, then approves into them", () => {
    const rootDir = root();
    const proposal = stageProposal(rootDir, addNoteInput(), "agent");
    expect(proposal).toMatchObject({ kind: "add-note", proposedBy: "agent", baseVersion: 0 });
    expect(proposal.id).toBeTruthy();
    expect(loadNotesDoc(rootDir).notes).toHaveLength(0);
    expect(listProposals(rootDir)).toHaveLength(1);
    const approved = approveProposal(rootDir, proposal.id);
    expect(approved.doc.notes).toHaveLength(1);
    expect(approved.doc.notes[0]).toMatchObject({ path: "preferences/short-replies", text: "Prefers short replies" });
    expect(approved.doc.version).toBe(1);
    expect(listProposals(rootDir)).toHaveLength(0);
    expect(() => approveProposal(rootDir, proposal.id)).toThrow(MemoryNotesError);
  });

  it("discards a proposal without changing anything live", () => {
    const rootDir = root();
    const proposal = stageProposal(rootDir, addNoteInput(), "agent");
    expect(denyProposal(rootDir, proposal.id).id).toBe(proposal.id);
    expect(listProposals(rootDir)).toHaveLength(0);
    expect(loadNotesDoc(rootDir).notes).toHaveLength(0);
    expect(() => denyProposal(rootDir, proposal.id)).toThrow(MemoryNotesError);
  });

  it("refuses approval when the notes moved on since staging, and keeps the proposal queued", () => {
    const rootDir = root();
    const proposal = stageProposal(rootDir, addNoteInput(), "agent");
    saveNotesDoc(rootDir, loadNotesDoc(rootDir));
    expect(() => approveProposal(rootDir, proposal.id)).toThrow(MemoryNotesError);
    expect(listProposals(rootDir)).toHaveLength(1);
  });

  it("refuses to stage a quote nobody said, a secret, or a duplicate path", () => {
    const rootDir = root();
    const unquoted: PendingProposalInput = {
      kind: "add-note",
      input: {
        path: "about/home",
        text: "Lives in Mumbai",
        sources: [{ chatId: "c1", messageId: "m1", quote: "Lives in Mumbai", at: "2026-11-25T10:00:00.000Z" }],
      },
      messages,
    };
    expect(() => stageProposal(rootDir, unquoted, "agent")).toThrow(MemoryNotesError);
    const proseSecret = addNoteInput("about/password", "my password is hunter2");
    expect(() => stageProposal(rootDir, proseSecret, "agent")).toThrow(MemoryNotesError);
    const shapedSecret = addNoteInput("about/key", "the key is sk-ant-api03-abcdefghijklmnopqrst");
    expect(() => stageProposal(rootDir, shapedSecret, "agent")).toThrow(MemoryNotesError);
    const factSecret: PendingProposalInput = {
      kind: "add-note",
      input: {
        path: "preferences/short-replies",
        text: "Prefers short replies",
        sources: [{ chatId: "c1", messageId: "m1", quote: "I prefer short replies", at: "2026-11-25T10:00:00.000Z" }],
        fact: { kind: "preference", entities: ["my password is hunter2"] },
      },
      messages,
    };
    expect(() => stageProposal(rootDir, factSecret, "agent")).toThrow(MemoryNotesError);
    stageProposal(rootDir, addNoteInput(), "agent");
    expect(() => stageProposal(rootDir, addNoteInput(), "agent")).toThrow(MemoryNotesError);
    expect(listProposals(rootDir)).toHaveLength(1);
  });

  it("refuses to stage a skill whose task holds a secret", () => {
    const rootDir = root();
    const skill: PendingProposalInput = {
      kind: "save-skill",
      input: { name: "weekly-report", description: "Builds the weekly report.", body: "1. Open the sheet.", task: "my password is hunter2" },
    };
    expect(() => stageProposal(rootDir, skill, "agent")).toThrow(MemoryNotesError);
    expect(listProposals(rootDir)).toHaveLength(0);
  });

  it("stages and approves a remember request", () => {
    const rootDir = root();
    const proposal = stageProposal(rootDir, {
      kind: "remember", path: "about/diet", chatId: "c1", messageId: "m2",
      text: "Remember: I am vegetarian", at: "2026-11-25T12:00:00.000Z",
    }, "agent");
    const approved = approveProposal(rootDir, proposal.id);
    expect(approved.doc.notes[0]).toMatchObject({ path: "about/diet", text: "I am vegetarian", status: "stated" });
  });

  it("refuses a remember proposal when the message holds no remember request", () => {
    const rootDir = root();
    expect(() => stageProposal(rootDir, {
      kind: "remember", path: "about/diet", chatId: "c1", messageId: "m2",
      text: "What time is dinner?", at: "2026-11-25T12:00:00.000Z",
    }, "agent")).toThrow(MemoryNotesError);
  });

  it("caps the queue and reports a corrupt pending file", () => {
    const rootDir = root();
    for (let i = 0; i < MEMORY_PENDING_MAX; i++) {
      stageProposal(rootDir, addNoteInput(`preferences/note-${i}`, "Prefers short replies"), "agent");
    }
    expect(() => stageProposal(rootDir, addNoteInput("preferences/one-more", "Prefers short replies"), "agent")).toThrow(MemoryNotesError);
    writeFileSync(join(rootDir, "memory", "pending.json"), "{not json", "utf8");
    expect(() => loadPendingDoc(rootDir)).toThrow(MemoryNotesError);
  });
});
