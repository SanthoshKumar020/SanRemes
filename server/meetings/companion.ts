import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { COMPANION_NOT_LIVE, COMPANION_NOT_MEET, type CompanionNotes, type CompanionQuestion, type CompanionSummary, type MeetingCompanion } from "../../shared/meeting-companion.ts";
import { parseMeetingLink, type MeetingLine } from "../../shared/meetings.ts";
import { writeFileAtomic } from "../atomic.ts";

export const COMPANION_FILE = "companions.json";
const MAX_TRANSCRIPT_LINES = 5_000;
const MAX_QUESTIONS = 200;

const actionItemSchema = z.object({
  owner: z.string().trim().max(80).optional(),
  item: z.string().trim().min(1).max(500),
  due: z.string().trim().max(80).optional(),
}).strict();
const notesSchema = z.object({
  summary: z.string().trim().max(4_000),
  decisions: z.array(z.string().trim().min(1).max(500)).max(20),
  actionItems: z.array(actionItemSchema).max(30),
  openQuestions: z.array(z.string().trim().min(1).max(500)).max(15),
}).strict();
const lineSchema = z.object({
  speaker: z.string().nullable(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
}).strict();
const questionSchema = z.object({
  id: z.string(),
  from: z.string().optional(),
  text: z.string(),
  askedAt: z.number(),
  answer: z.string().optional(),
  answeredAt: z.number().optional(),
}).strict();
const companionSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  botId: z.string().optional(),
  status: z.enum(["waiting", "live", "ended"]),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  notes: notesSchema,
  transcript: z.array(lineSchema),
  questions: z.array(questionSchema),
  artifacts: z.object({ docTitle: z.string().optional(), whiteboardTitle: z.string().optional() }).strict(),
}).strict();

export class CompanionError extends Error {}

const emptyNotes = (): CompanionNotes => ({ summary: "", decisions: [], actionItems: [], openQuestions: [] });

export function companionSummary(companion: MeetingCompanion): CompanionSummary {
  const { transcript, questions, ...rest } = companion;
  return {
    ...rest,
    lines: transcript.length,
    questions: questions.length,
    unanswered: questions.filter((question) => !question.answer).length,
  };
}

/** Lines that read as open questions: the transcript lines that end with a question mark. */
export function openQuestionsFromTranscript(lines: readonly MeetingLine[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text.endsWith("?") || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.slice(0, 15);
}

/** The notes as Markdown, ready to paste into a Doc or onto a Whiteboard. */
export function companionNotesText(companion: MeetingCompanion): string {
  const parts = [`# ${companion.title}`, "", `Google Meet · ${new Date(companion.startedAt ?? companion.createdAt).toLocaleString()}${companion.endedAt ? ` – ${new Date(companion.endedAt).toLocaleString()}` : ""}`, ""];
  if (companion.notes.summary) parts.push(companion.notes.summary, "");
  if (companion.notes.decisions.length) parts.push("## Decisions", ...companion.notes.decisions.map((decision) => `- ${decision}`), "");
  if (companion.notes.actionItems.length) {
    parts.push("## Action items");
    for (const action of companion.notes.actionItems) parts.push(`- ${action.item}${action.owner ? ` (${action.owner})` : ""}${action.due ? ` — due ${action.due}` : ""}`);
    parts.push("");
  }
  if (companion.notes.openQuestions.length) parts.push("## Open questions", ...companion.notes.openQuestions.map((question) => `- ${question}`), "");
  return parts.join("\n").trimEnd();
}

export class MeetingCompanionStore {
  private readonly file: string;
  private readonly companions = new Map<string, MeetingCompanion>();
  private readonly now: () => number;

  constructor(deps: { dataDir: string; now?: () => number }) {
    const folder = join(deps.dataDir, "meetings");
    mkdirSync(folder, { recursive: true });
    this.file = join(folder, COMPANION_FILE);
    this.now = deps.now ?? Date.now;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as { companions?: unknown[] };
      for (const raw of saved.companions ?? []) {
        const parsed = companionSchema.safeParse(raw);
        if (parsed.success) this.companions.set(parsed.data.id, parsed.data);
      }
    } catch { /* first start */ }
  }

  private save(): void {
    const all = [...this.companions.values()].sort((a, b) => a.createdAt - b.createdAt);
    writeFileAtomic(this.file, JSON.stringify({ companions: all }));
  }

  create(input: { url: string; title?: string; botId?: string }): MeetingCompanion {
    const link = parseMeetingLink(input.url);
    if (!link.ok || link.platform !== "meet") throw new CompanionError(link.ok ? COMPANION_NOT_MEET : link.error);
    const companion: MeetingCompanion = {
      id: `mc-${randomUUID()}`,
      title: input.title?.trim().slice(0, 120) || "Meeting notes",
      url: link.url,
      ...(input.botId?.trim() ? { botId: input.botId.trim().slice(0, 128) } : {}),
      status: "waiting",
      createdAt: this.now(),
      notes: emptyNotes(),
      transcript: [],
      questions: [],
      artifacts: {},
    };
    this.companions.set(companion.id, companion);
    this.save();
    return companion;
  }

  list(): CompanionSummary[] {
    return [...this.companions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(companionSummary);
  }

  get(id: string): MeetingCompanion {
    const companion = this.companions.get(id);
    if (!companion) throw new CompanionError("There is no meeting companion with that id.");
    return companion;
  }

  remove(id: string): void {
    if (!this.companions.delete(id)) throw new CompanionError("There is no meeting companion with that id.");
    this.save();
  }

  start(id: string): MeetingCompanion {
    const companion = this.get(id);
    if (companion.status !== "waiting") throw new CompanionError(companion.status === "live" ? "The companion is already live." : "That meeting has ended.");
    companion.status = "live";
    companion.startedAt = this.now();
    this.save();
    return companion;
  }

  stop(id: string): MeetingCompanion {
    const companion = this.get(id);
    if (companion.status === "ended") throw new CompanionError("That meeting has already ended.");
    companion.status = "ended";
    companion.endedAt = this.now();
    this.save();
    return companion;
  }

  addTranscript(id: string, line: { speaker?: string | null; text: string }): MeetingLine {
    const companion = this.get(id);
    if (companion.status !== "live") throw new CompanionError(COMPANION_NOT_LIVE);
    const text = line.text.trim();
    if (!text) throw new CompanionError("Send the words that were said.");
    const entry: MeetingLine = { speaker: line.speaker?.trim().slice(0, 80) || null, text: text.slice(0, 2_000), start: this.now(), end: this.now() };
    companion.transcript.push(entry);
    if (companion.transcript.length > MAX_TRANSCRIPT_LINES) companion.transcript.splice(0, companion.transcript.length - MAX_TRANSCRIPT_LINES);
    this.save();
    return entry;
  }

  setNotes(id: string, notes: CompanionNotes): MeetingCompanion {
    const companion = this.get(id);
    if (!notes.summary.trim()) throw new CompanionError("Send a summary, decisions, action items and open questions.");
    const parsed = notesSchema.safeParse(notes);
    if (!parsed.success) throw new CompanionError("Send a summary, decisions, action items and open questions.");
    companion.notes = parsed.data;
    this.save();
    return companion;
  }

  ask(id: string, input: { text: string; from?: string }): CompanionQuestion {
    const companion = this.get(id);
    if (companion.status !== "live") throw new CompanionError(COMPANION_NOT_LIVE);
    const text = input.text.trim();
    if (!text) throw new CompanionError("Send the question that was asked.");
    if (companion.questions.length >= MAX_QUESTIONS) throw new CompanionError("This meeting already has 200 questions; answer some before asking more.");
    const question: CompanionQuestion = {
      id: `q-${randomUUID().slice(0, 8)}`,
      ...(input.from?.trim() ? { from: input.from.trim().slice(0, 80) } : {}),
      text: text.slice(0, 1_500),
      askedAt: this.now(),
    };
    companion.questions.push(question);
    this.save();
    return question;
  }

  answer(id: string, questionId: string, text: string): CompanionQuestion {
    const companion = this.get(id);
    const question = companion.questions.find((one) => one.id === questionId);
    if (!question) throw new CompanionError("There is no question with that id in this meeting.");
    const trimmed = text.trim();
    if (!trimmed) throw new CompanionError("Send the answer.");
    question.answer = trimmed.slice(0, 2_000);
    question.answeredAt = this.now();
    this.save();
    return question;
  }

  setArtifacts(id: string, artifacts: { docTitle?: string; whiteboardTitle?: string }): MeetingCompanion {
    const companion = this.get(id);
    const docTitle = artifacts.docTitle?.trim().slice(0, 120);
    const whiteboardTitle = artifacts.whiteboardTitle?.trim().slice(0, 120);
    if (!docTitle && !whiteboardTitle) throw new CompanionError("Name the Doc or the Whiteboard the notes are going into.");
    companion.artifacts = {
      ...companion.artifacts,
      ...(docTitle ? { docTitle } : {}),
      ...(whiteboardTitle ? { whiteboardTitle } : {}),
    };
    this.save();
    return companion;
  }
}
