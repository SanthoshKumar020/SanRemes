import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import {
  companionNotesText, companionSummary, CompanionError, MeetingCompanionStore, openQuestionsFromTranscript,
} from "./companion.ts";

const scratch: string[] = [];
afterEach(async () => {
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

function store() {
  const dataDir = mkdtempSync(join(tmpdir(), "sanremes-companion-"));
  scratch.push(dataDir);
  return new MeetingCompanionStore({ dataDir, now: () => 1_700_000_000_000 });
}

const MEET = "https://meet.google.com/abc-defg-hij";

describe("MeetingCompanionStore", () => {
  it("creates a waiting companion from a Meet link and persists it", () => {
    const first = store();
    const created = first.create({ url: MEET, title: "Weekly sync", botId: "scout" });
    expect(created.status).toBe("waiting");
    expect(created.url).toBe(MEET);
    expect(created.notes).toEqual({ summary: "", decisions: [], actionItems: [], openQuestions: [] });
    const reopened = new MeetingCompanionStore({ dataDir: scratch[0]!, now: () => 1_700_000_000_000 });
    expect(reopened.get(created.id).title).toBe("Weekly sync");
    expect(reopened.list()).toHaveLength(1);
  });

  it("refuses non-Meet links in plain words", () => {
    const s = store();
    expect(() => s.create({ url: "https://teams.microsoft.com/l/meetup-join/abc" })).toThrow(CompanionError);
    expect(() => s.create({ url: "https://example.com" })).toThrow("That doesn't look like a Google Meet, Microsoft Teams or Jitsi meeting link.");
    expect(() => s.create({ url: "https://meet.google.com/abc-defg-hij" })).not.toThrow();
  });

  it("starts, takes transcript only while live, and stops", () => {
    const s = store();
    const created = s.create({ url: MEET });
    expect(() => s.addTranscript(created.id, { text: "Hello" })).toThrow("The companion is not live in a meeting right now.");
    expect(() => s.start(created.id)).not.toThrow();
    expect(() => s.start(created.id)).toThrow("The companion is already live.");
    const line = s.addTranscript(created.id, { speaker: "Ana", text: "We ship on Friday." });
    expect(line.speaker).toBe("Ana");
    expect(s.get(created.id).transcript).toHaveLength(1);
    const stopped = s.stop(created.id);
    expect(stopped.status).toBe("ended");
    expect(() => s.stop(created.id)).toThrow("That meeting has already ended.");
    expect(() => s.addTranscript(created.id, { text: "Late" })).toThrow("The companion is not live in a meeting right now.");
  });

  it("keeps structured notes and renders them as Markdown", () => {
    const s = store();
    const created = s.create({ url: MEET, title: "Planning" });
    s.start(created.id);
    s.setNotes(created.id, {
      summary: "Agreed the launch date.",
      decisions: ["Launch on Friday."],
      actionItems: [{ owner: "Ana", item: "Send the release notes", due: "Thursday" }],
      openQuestions: ["Who owns the rollback?"],
    });
    const text = companionNotesText(s.get(created.id));
    expect(text).toContain("# Planning");
    expect(text).toContain("Agreed the launch date.");
    expect(text).toContain("- Launch on Friday.");
    expect(text).toContain("- Send the release notes (Ana) — due Thursday");
    expect(text).toContain("- Who owns the rollback?");
  });

  it("records questions in the call and their answers", () => {
    const s = store();
    const created = s.create({ url: MEET });
    expect(() => s.ask(created.id, { text: "When?" })).toThrow("The companion is not live in a meeting right now.");
    s.start(created.id);
    const question = s.ask(created.id, { from: "Ben", text: "When do we ship?" });
    expect(companionSummary(s.get(created.id)).unanswered).toBe(1);
    const answered = s.answer(created.id, question.id, "On Friday.");
    expect(answered.answer).toBe("On Friday.");
    expect(companionSummary(s.get(created.id)).unanswered).toBe(0);
    expect(() => s.answer(created.id, "q-nope", "x")).toThrow("There is no question with that id in this meeting.");
  });

  it("names the live Doc and Whiteboard and keeps both", () => {
    const s = store();
    const created = s.create({ url: MEET });
    expect(() => s.setArtifacts(created.id, {})).toThrow("Name the Doc or the Whiteboard the notes are going into.");
    s.setArtifacts(created.id, { docTitle: "Weekly sync notes" });
    const updated = s.setArtifacts(created.id, { whiteboardTitle: "Launch board" });
    expect(updated.artifacts).toEqual({ docTitle: "Weekly sync notes", whiteboardTitle: "Launch board" });
  });

  it("removes a companion and reports an unknown id in plain words", () => {
    const s = store();
    const created = s.create({ url: MEET });
    s.remove(created.id);
    expect(s.list()).toHaveLength(0);
    expect(() => s.get(created.id)).toThrow("There is no meeting companion with that id.");
    expect(() => s.remove(created.id)).toThrow("There is no meeting companion with that id.");
  });
});

describe("openQuestionsFromTranscript", () => {
  it("returns each question once, in order", () => {
    const found = openQuestionsFromTranscript([
      { speaker: "Ana", text: "What is the deadline?", start: 0, end: 1 },
      { speaker: "Ben", text: "Friday works.", start: 1, end: 2 },
      { speaker: "Ana", text: "What is the deadline?", start: 2, end: 3 },
      { speaker: null, text: "Who reviews it?", start: 3, end: 4 },
    ]);
    expect(found).toEqual(["What is the deadline?", "Who reviews it?"]);
  });
});
