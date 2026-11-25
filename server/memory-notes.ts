import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { factIdentity, foldForMatch, isMemoryDate, passageMatcher } from "./memory-entries.ts";
import { redactSecretsInText } from "./redact.ts";

/** Structured memory notes: Nod-shaped records (area, status, quoted sources, typed facts) and learned
 * procedures, kept in one JSON document per bot workspace beside the markdown memory files. */

export const MEMORY_NOTES_FILE = "memory/notes.json";
export const MEMORY_NOTE_MAX_CHARS = 4000;
export const MEMORY_NOTE_QUOTE_MAX_CHARS = 400;
export const MEMORY_NOTES_MAX_BYTES = 256 * 1024;
export const LEARNED_SKILLS_MAX = 40;
export const SKILL_BODY_MAX_CHARS = 6000;
export const SKILL_DESCRIPTION_MAX_CHARS = 200;
export const STALE_INFERRED_DAYS = 60;
export const MEMORY_NOTES_INDEX_MAX_CHARS = 6000;

export const MEMORY_AREAS = ["about", "preferences", "people", "routines", "lessons"] as const;
export type MemoryArea = (typeof MEMORY_AREAS)[number];

export type MemoryNoteStatus = "stated" | "observed" | "tentative";
export type MemoryFactKind = "fact" | "preference" | "plan" | "event" | "possession";
export type MemoryArchiveReason =
  | "superseded"
  | "merged"
  | "duplicate"
  | "expired"
  | "stale"
  | "obsolete"
  | "contradicted"
  | "manual";

export interface MemoryFact {
  kind: MemoryFactKind;
  entities: string[];
  occurredOn?: string;
  validFrom?: string;
  validTo?: string;
}

export interface MemoryNoteSource {
  chatId: string;
  messageId: string;
  quote: string;
  at: string;
}

/** One structured note: a single declarative fact with its area, how sure the bot is, and the owner's own words it rests on. */
export interface MemoryNote {
  path: string;
  area: MemoryArea;
  text: string;
  status: MemoryNoteStatus;
  updated: string;
  edited: string | null;
  expires: string | null;
  sources: MemoryNoteSource[];
  fact?: MemoryFact;
}

export interface MemoryArchived {
  path: string;
  area: MemoryArea;
  text: string;
  reason: MemoryArchiveReason;
  by: string | null;
  archived: string;
  sources: MemoryNoteSource[];
  fact?: MemoryFact;
}

/** A procedure learned from a completed task: one concrete flow, no personal data. */
export interface LearnedSkill {
  name: string;
  description: string;
  body: string;
  learned: string;
  updated: string;
  edited: string | null;
  task: string | null;
}

export interface MemoryNotesDoc {
  version: number;
  notes: MemoryNote[];
  archive: MemoryArchived[];
  skills: LearnedSkill[];
}

export type MemoryNotesErrorCode = "path" | "conflict" | "too-large" | "corrupt" | "invalid" | "secret" | "not-found";

export class MemoryNotesError extends Error {
  readonly status: number;
  readonly code: MemoryNotesErrorCode;
  constructor(code: MemoryNotesErrorCode, status: number, message: string) {
    super(message);
    this.name = "MemoryNotesError";
    this.code = code;
    this.status = status;
  }
}

function fail(code: MemoryNotesErrorCode, status: number, message: string): never {
  throw new MemoryNotesError(code, status, message);
}

export function emptyNotesDoc(): MemoryNotesDoc {
  return { version: 0, notes: [], archive: [], skills: [] };
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NOTE_PATH = /^([a-z]+)\/([a-z0-9][a-z0-9-]{0,127})$/;

export function isMemoryArea(value: unknown): value is MemoryArea {
  return typeof value === "string" && (MEMORY_AREAS as readonly string[]).includes(value);
}

export function parseNotePath(path: unknown): { area: MemoryArea; slug: string } {
  if (typeof path !== "string") fail("invalid", 400, "a note path must be an area and a slug, like preferences/short-replies");
  const match = NOTE_PATH.exec(path);
  if (!match || !isMemoryArea(match[1])) {
    fail("invalid", 400, `not a note path: ${JSON.stringify(path)} — use an area and a slug, like preferences/short-replies`);
  }
  return { area: match[1] as MemoryArea, slug: match[2]! };
}

function isNoteStatus(value: unknown): value is MemoryNoteStatus {
  return value === "stated" || value === "observed" || value === "tentative";
}

function isArchiveReason(value: unknown): value is MemoryArchiveReason {
  return (
    value === "superseded" || value === "merged" || value === "duplicate" || value === "expired" ||
    value === "stale" || value === "obsolete" || value === "contradicted" || value === "manual"
  );
}

function isFactKind(value: unknown): value is MemoryFactKind {
  return value === "fact" || value === "preference" || value === "plan" || value === "event" || value === "possession";
}

function todayString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** A shaped secret (a key, token or password the redactor recognises) or a plain-prose one — "my
 * password is hunter2" — where the word after "is" looks like a credential: it carries a digit or a
 * symbol, or it is long enough to be a passphrase. "The password is on the fridge" and "a token is
 * required" do not match: their values are short plain words. A secret with no shape and no
 * secret-word nearby still is not caught; that is the same limit Nod documents for its own detector. */
const SECRET_PROSE = /\b(password|passwd|api[-_ ]?key|secret|access[-_ ]?token|auth[-_ ]?token|private[-_ ]?key)\s*(?:is|=|:)\s*(\S+)/i;

function isSecret(text: string): boolean {
  if (redactSecretsInText(text) !== text) return true;
  const prose = SECRET_PROSE.exec(text);
  if (!prose) return false;
  const value = prose[2]!.replace(/[.,;:!?]+$/, "");
  return /[0-9!@#$%^&*_\-+=]/.test(value) || value.length >= 12;
}

/** The notes file lives under the bot's workspace; a link in its place is not a notes file. */
export function resolveNotesPath(root: string): string {
  const absolute = join(root, MEMORY_NOTES_FILE);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return absolute;
  }
  let ancestor = dirname(absolute);
  while (!existsSync(ancestor) && ancestor !== root) ancestor = dirname(ancestor);
  const realAncestor = realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) {
    fail("path", 400, "the notes file escapes the workspace");
  }
  try {
    if (lstatSync(absolute).isSymbolicLink()) fail("path", 400, "the notes file is a link, not a file");
  } catch (error) {
    if (error instanceof MemoryNotesError) throw error;
  }
  return absolute;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDoc(value: unknown): value is MemoryNotesDoc {
  return isRecord(value) && typeof value.version === "number" && Array.isArray(value.notes) && Array.isArray(value.archive) && Array.isArray(value.skills);
}

export function loadNotesDoc(root: string): MemoryNotesDoc {
  let raw: string;
  try {
    raw = readFileSync(resolveNotesPath(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyNotesDoc();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("corrupt", 500, "the notes file is not valid JSON — it needs a hand fix before memory notes can load");
  }
  if (!validDoc(parsed)) fail("corrupt", 500, "the notes file does not hold a notes document — it needs a hand fix before memory notes can load");
  return parsed;
}

/** Atomic, 0600; `expectedVersion` refuses a save over a write the caller has not seen. */
export function saveNotesDoc(root: string, doc: MemoryNotesDoc, expectedVersion?: number): MemoryNotesDoc {
  const current = loadNotesDoc(root);
  if (expectedVersion !== undefined && expectedVersion !== current.version) {
    fail("conflict", 409, "these notes changed since you opened them — reload to see the new version, then save again");
  }
  const next: MemoryNotesDoc = { ...doc, version: current.version + 1 };
  const text = JSON.stringify(next, null, 2);
  if (Buffer.byteLength(text, "utf8") > MEMORY_NOTES_MAX_BYTES) {
    fail("too-large", 413, "these notes are full — forget or archive notes before adding more");
  }
  mkdirSync(join(root, "memory"), { recursive: true, mode: 0o700 });
  writeFileAtomic(resolveNotesPath(root), text, { mode: 0o600 });
  return next;
}

function checkNoteText(text: unknown): string {
  if (typeof text !== "string" || !text.trim()) fail("invalid", 400, "a note needs text");
  const trimmed = text.trim();
  if (trimmed.length > MEMORY_NOTE_MAX_CHARS) fail("invalid", 400, `a note holds at most ${MEMORY_NOTE_MAX_CHARS} characters`);
  if (isSecret(trimmed)) fail("secret", 400, "a note cannot hold a secret — remove keys, tokens and passwords first");
  return trimmed;
}

function checkFact(fact: unknown): MemoryFact | undefined {
  if (fact === undefined) return undefined;
  if (!isRecord(fact) || !isFactKind(fact.kind) || !Array.isArray(fact.entities) || fact.entities.some((e) => typeof e !== "string" || !e.trim())) {
    fail("invalid", 400, "a fact needs a kind and a list of entities");
  }
  for (const field of ["occurredOn", "validFrom", "validTo"] as const) {
    if (fact[field] !== undefined && !isMemoryDate(fact[field])) fail("invalid", 400, `a fact date must be YYYY-MM-DD: ${String(fact[field])}`);
  }
  for (const entity of fact.entities) {
    if (typeof entity === "string" && isSecret(entity)) fail("secret", 400, "a fact cannot hold a secret — remove keys, tokens and passwords first");
  }
  return fact as unknown as MemoryFact;
}

function checkExpires(expires: unknown): string | null {
  if (expires === undefined || expires === null) return null;
  if (!isMemoryDate(expires)) fail("invalid", 400, "an expiry must be a YYYY-MM-DD date");
  return expires;
}

/** A quote counts only when the cited message really contains it, case, accents, quote marks and spacing aside. */
export function quoteInSource(quote: string, messageText: string): boolean {
  const strip = (text: string): string => foldForMatch(text).replace(/["'«»‹›]/g, "").replace(/\s+/g, " ").trim();
  const folded = strip(quote);
  return folded.length > 0 && strip(messageText).includes(folded);
}

export interface AddNoteInput {
  path: string;
  text: string;
  status?: MemoryNoteStatus;
  sources: MemoryNoteSource[];
  fact?: MemoryFact;
  expires?: string | null;
}

export interface CitedMessage {
  id: string;
  text: string;
}

function checkSources(sources: unknown, messages: CitedMessage[]): MemoryNoteSource[] {
  if (!Array.isArray(sources) || sources.length === 0) fail("invalid", 400, "a note needs at least one quoted source message");
  const byId = new Map(messages.map((m) => [m.id, m.text]));
  const checked: MemoryNoteSource[] = [];
  for (const source of sources) {
    if (!isRecord(source) || typeof source.chatId !== "string" || typeof source.messageId !== "string" || typeof source.quote !== "string" || typeof source.at !== "string") {
      fail("invalid", 400, "a source needs a chat id, a message id, a quote and a time");
    }
    const quote = source.quote.trim();
    if (!quote || quote.length > MEMORY_NOTE_QUOTE_MAX_CHARS) fail("invalid", 400, `a quote holds 1 to ${MEMORY_NOTE_QUOTE_MAX_CHARS} characters`);
    if (isSecret(quote)) fail("secret", 400, "a quote cannot hold a secret — remove keys, tokens and passwords first");
    const messageText = byId.get(source.messageId);
    if (messageText === undefined) fail("invalid", 400, `no cited message was supplied for ${JSON.stringify(source.messageId)}`);
    if (!quoteInSource(quote, messageText)) fail("invalid", 400, "a quote must appear in the message it cites");
    checked.push({ chatId: source.chatId, messageId: source.messageId, quote, at: source.at });
  }
  return checked;
}

function mergeSources(into: MemoryNoteSource[], from: MemoryNoteSource[]): MemoryNoteSource[] {
  const seen = new Set(into.map((s) => s.messageId));
  for (const source of from) if (!seen.has(source.messageId)) { seen.add(source.messageId); into.push(source); }
  return into;
}

function sortNotes(notes: MemoryNote[]): MemoryNote[] {
  const rank = (status: MemoryNoteStatus): number => (status === "stated" ? 0 : status === "observed" ? 1 : 2);
  return [...notes].sort((a, b) => rank(a.status) - rank(b.status) || b.updated.localeCompare(a.updated));
}

export function addNote(doc: MemoryNotesDoc, input: AddNoteInput, messages: CitedMessage[]): MemoryNotesDoc {
  const { area } = parseNotePath(input.path);
  const text = checkNoteText(input.text);
  if (input.status !== undefined && !isNoteStatus(input.status)) fail("invalid", 400, "a note status is stated, observed or tentative");
  const sources = checkSources(input.sources, messages);
  const fact = checkFact(input.fact);
  const expires = checkExpires(input.expires);
  const now = new Date().toISOString();
  const next = structuredClone(doc);
  const existing = next.notes.find((n) => n.path === input.path);
  if (existing) fail("conflict", 409, `a note already exists at ${input.path} — edit it instead`);
  const sameFact = next.notes.find((n) => factIdentity(n.text) === factIdentity(text));
  if (sameFact) {
    mergeSources(sameFact.sources, sources);
    if (sameFact.status === "tentative") sameFact.status = "observed";
    sameFact.updated = now;
    return next;
  }
  next.notes.push({ path: input.path, area, text, status: input.status ?? "stated", updated: now, edited: null, expires, sources, ...(fact ? { fact } : {}) });
  return next;
}

function findLiveNote(doc: MemoryNotesDoc, path: string): MemoryNote {
  const note = doc.notes.find((n) => n.path === path);
  if (!note) fail("not-found", 404, `no live note at ${path}`);
  return note;
}

export function confirmNote(doc: MemoryNotesDoc, path: string): MemoryNotesDoc {
  parseNotePath(path);
  const next = structuredClone(doc);
  findLiveNote(next, path).status = "stated";
  findLiveNote(next, path).updated = new Date().toISOString();
  return next;
}

/** Rewriting a note archives the previous text and clears its sources: the new words need new evidence. */
export function editNote(doc: MemoryNotesDoc, path: string, text: string): MemoryNotesDoc {
  parseNotePath(path);
  const checked = checkNoteText(text);
  const now = new Date().toISOString();
  const next = structuredClone(doc);
  const note = findLiveNote(next, path);
  next.archive.push({ path: note.path, area: note.area, text: note.text, reason: "superseded", by: null, archived: now, sources: note.sources, ...(note.fact ? { fact: note.fact } : {}) });
  note.text = checked;
  note.status = "stated";
  note.edited = now;
  note.updated = now;
  note.sources = [];
  delete note.fact;
  return next;
}

export function archiveNote(doc: MemoryNotesDoc, path: string, reason: MemoryArchiveReason, by: string | null = null): MemoryNotesDoc {
  parseNotePath(path);
  if (!isArchiveReason(reason)) fail("invalid", 400, "an archive reason is superseded, merged, duplicate, expired, stale, obsolete, contradicted or manual");
  const now = new Date().toISOString();
  const next = structuredClone(doc);
  const index = next.notes.findIndex((n) => n.path === path);
  if (index < 0) fail("not-found", 404, `no live note at ${path}`);
  const [note] = next.notes.splice(index, 1);
  next.archive.push({ path: note!.path, area: note!.area, text: note!.text, reason, by, archived: now, sources: note!.sources, ...(note!.fact ? { fact: note!.fact } : {}) });
  return next;
}

export function restoreNote(doc: MemoryNotesDoc, path: string, today: string = todayString()): MemoryNotesDoc {
  parseNotePath(path);
  const next = structuredClone(doc);
  const index = next.archive.findIndex((a) => a.path === path);
  if (index < 0) fail("not-found", 404, `no archived note at ${path}`);
  if (next.notes.some((n) => n.path === path)) fail("conflict", 409, `a live note already exists at ${path}`);
  const [archived] = next.archive.splice(index, 1);
  const now = new Date().toISOString();
  const validTo = archived!.fact?.validTo;
  next.notes.push({
    path: archived!.path, area: archived!.area, text: archived!.text, status: "stated", updated: now, edited: null,
    expires: validTo !== undefined && validTo >= today ? validTo : null,
    sources: archived!.sources, ...(archived!.fact ? { fact: archived!.fact } : {}),
  });
  return next;
}

export function forgetNote(doc: MemoryNotesDoc, path: string): MemoryNotesDoc {
  parseNotePath(path);
  const next = structuredClone(doc);
  const before = next.notes.length + next.archive.length;
  next.notes = next.notes.filter((n) => n.path !== path);
  next.archive = next.archive.filter((a) => a.path !== path);
  if (next.notes.length + next.archive.length === before) fail("not-found", 404, `no note at ${path}`);
  return next;
}

export function listNotes(doc: MemoryNotesDoc, area?: MemoryArea): MemoryNote[] {
  const notes = area === undefined ? doc.notes : doc.notes.filter((n) => n.area === area);
  return sortNotes(notes);
}

export function noteExpired(note: Pick<MemoryNote, "expires">, today: string): boolean {
  return note.expires !== null && note.expires < today;
}

/** Word search over slug and text, no model and no embeddings: every word must match as a whole word. */
export function findNotes(doc: MemoryNotesDoc, query: string, today: string = todayString()): MemoryNote[] {
  const words = foldForMatch(query).split(/[^a-z0-9]+/u).filter(Boolean);
  if (!words.length) return [];
  const matchers = words.map((word) => passageMatcher(word));
  if (matchers.some((m) => m === null)) return [];
  return listNotes(doc).filter((note) => {
    if (noteExpired(note, today)) return false;
    const haystack = `${note.path} ${note.text}`;
    return matchers.every((m) => m!(haystack));
  });
}

/** The index the agent reads: every live note in full, confirmed first, tentative marked as likely rather than certain.
 * Shaped secrets are masked here too: the save-time refusal is the enforcement point, but a hand-edited file on disk
 * bypasses it, and the prompt must never be the leak. */
export function buildMemoryIndex(doc: MemoryNotesDoc, today: string = todayString()): string {
  const lines = listNotes(doc)
    .filter((note) => !noteExpired(note, today))
    .map((note) => `${note.path}: ${redactSecretsInText(note.text)}${note.status === "tentative" ? " (tentative)" : ""}`);
  if (!lines.length) return "";
  let kept = lines;
  let omitted = 0;
  let length = 0;
  for (let i = 0; i < lines.length; i++) {
    const next = length + lines[i]!.length + (i === 0 ? 0 : 1);
    if (next > MEMORY_NOTES_INDEX_MAX_CHARS) { kept = lines.slice(0, i); omitted = lines.length - i; break; }
    length = next;
  }
  return kept.join("\n") + (omitted > 0 ? `\n… (${omitted} more note${omitted === 1 ? "" : "s"} not shown)` : "");
}

export function buildSkillsIndex(skills: LearnedSkill[]): string {
  return skills.map((skill) => `${skill.name}: ${redactSecretsInText(skill.description)}`).join("\n");
}

export function structuredNotesPromptBlock(doc: MemoryNotesDoc, today: string = todayString()): string {
  const index = buildMemoryIndex(doc, today);
  const skills = buildSkillsIndex(listSkills(doc));
  if (!index && !skills) return "";
  const notesPart = index
    ? `Your structured memory notes (area/slug: text; (tentative) means mentioned once, treat it as likely rather than certain):\n${index}`
    : "";
  const skillsPart = skills
    ? `Your learned procedures (name: what it covers; read the full procedure before a matching task):\n${skills}`
    : "";
  return `\n\n${[notesPart, skillsPart].filter(Boolean).join("\n\n")}`;
}

export interface MaintainReport {
  expired: number;
  duplicates: number;
  stale: number;
}

/** Deterministic upkeep, no model: archive what expired, merge exact duplicates, archive stale inferred notes. */
export function maintainNotes(doc: MemoryNotesDoc, today: string = todayString()): { doc: MemoryNotesDoc; report: MaintainReport } {
  const now = new Date().toISOString();
  const next = structuredClone(doc);
  const report: MaintainReport = { expired: 0, duplicates: 0, stale: 0 };
  const archive = (note: MemoryNote, reason: MemoryArchiveReason): void => {
    next.archive.push({ path: note.path, area: note.area, text: note.text, reason, by: null, archived: now, sources: note.sources, ...(note.fact ? { fact: note.fact } : {}) });
  };
  for (const note of next.notes) {
    if (noteExpired(note, today)) {
      next.notes = next.notes.filter((n) => n !== note);
      archive(note, "expired");
      report.expired += 1;
    }
  }
  const seen = new Map<string, MemoryNote>();
  for (const note of next.notes) {
    const identity = factIdentity(note.text);
    const keeper = seen.get(identity);
    if (!keeper) { seen.set(identity, note); continue; }
    mergeSources(keeper.sources, note.sources);
    if (keeper.updated < note.updated) keeper.updated = note.updated;
    next.notes = next.notes.filter((n) => n !== note);
    archive(note, "duplicate");
    report.duplicates += 1;
  }
  const staleBefore = new Date(today);
  staleBefore.setDate(staleBefore.getDate() - STALE_INFERRED_DAYS);
  const staleCutoff = staleBefore.toISOString().slice(0, 10);
  for (const note of next.notes) {
    if (note.status !== "stated" && note.sources.length === 1 && note.fact === undefined && note.updated.slice(0, 10) < staleCutoff) {
      next.notes = next.notes.filter((n) => n !== note);
      archive(note, "stale");
      report.stale += 1;
    }
  }
  return { doc: next, report };
}

function checkSkillName(name: unknown): string {
  if (typeof name !== "string" || !SKILL_NAME.test(name)) {
    fail("invalid", 400, "a skill name is lowercase-hyphenated, 1 to 64 characters, like weekly-report");
  }
  return name;
}

function checkSkillBody(body: unknown, field: string): string {
  if (typeof body !== "string" || !body.trim()) fail("invalid", 400, `a skill ${field} cannot be empty`);
  return body.trim();
}

export interface SaveSkillInput {
  name: string;
  description: string;
  body: string;
  task?: string | null;
}

/** A skill the owner edited is theirs: the agent can no longer save over it or patch it. */
export function saveSkill(doc: MemoryNotesDoc, input: SaveSkillInput): MemoryNotesDoc {
  const name = checkSkillName(input.name);
  const description = checkSkillBody(input.description, "description");
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) fail("invalid", 400, `a skill description holds at most ${SKILL_DESCRIPTION_MAX_CHARS} characters`);
  const body = checkSkillBody(input.body, "body");
  if (body.length > SKILL_BODY_MAX_CHARS) fail("invalid", 400, `a skill body holds at most ${SKILL_BODY_MAX_CHARS} characters`);
  if (isSecret(body) || isSecret(description)) fail("secret", 400, "a skill cannot hold a secret — remove keys, tokens and passwords first");
  if (typeof input.task === "string" && isSecret(input.task)) fail("secret", 400, "a skill cannot hold a secret — remove keys, tokens and passwords first");
  const now = new Date().toISOString();
  const next = structuredClone(doc);
  const existing = next.skills.find((s) => s.name === name);
  if (existing) {
    if (existing.edited !== null) fail("invalid", 400, `the owner edited ${name} — ask them before changing it`);
    existing.description = description;
    existing.body = body;
    existing.task = input.task ?? existing.task;
    existing.updated = now;
    return next;
  }
  if (next.skills.length >= LEARNED_SKILLS_MAX) {
    const evictable = next.skills.filter((s) => s.edited === null).sort((a, b) => a.updated.localeCompare(b.updated));
    const victim = evictable[0];
    if (!victim) fail("too-large", 413, `memory keeps at most ${LEARNED_SKILLS_MAX} learned skills — forget one first`);
    next.skills = next.skills.filter((s) => s !== victim);
  }
  next.skills.push({ name, description, body, learned: now, updated: now, edited: null, task: input.task ?? null });
  return next;
}

export function patchSkill(doc: MemoryNotesDoc, name: string, body: string): MemoryNotesDoc {
  const checked = checkSkillName(name);
  const text = checkSkillBody(body, "body");
  if (text.length > SKILL_BODY_MAX_CHARS) fail("invalid", 400, `a skill body holds at most ${SKILL_BODY_MAX_CHARS} characters`);
  if (isSecret(text)) fail("secret", 400, "a skill cannot hold a secret — remove keys, tokens and passwords first");
  const next = structuredClone(doc);
  const skill = next.skills.find((s) => s.name === checked);
  if (!skill) fail("not-found", 404, `no learned skill named ${checked}`);
  if (skill.edited !== null) fail("invalid", 400, `the owner edited ${checked} — ask them before changing it`);
  skill.body = text;
  skill.updated = new Date().toISOString();
  return next;
}

export function forgetSkill(doc: MemoryNotesDoc, name: string): MemoryNotesDoc {
  const checked = checkSkillName(name);
  const next = structuredClone(doc);
  const before = next.skills.length;
  next.skills = next.skills.filter((s) => s.name !== checked);
  if (next.skills.length === before) fail("not-found", 404, `no learned skill named ${checked}`);
  return next;
}

export function listSkills(doc: MemoryNotesDoc): LearnedSkill[] {
  return [...doc.skills].sort((a, b) => b.updated.localeCompare(a.updated));
}

const REMEMBER_COLON = /^\s*remember\s*[:\-–—]\s*([\s\S]+)$/im;
const REMEMBER_THAT = /remember that\s+([\s\S]+)$/i;

/** An explicit "remember: …" in the owner's own message, with the message itself as the quoted source.
 * Anything subtler stays with the existing capture pipeline, which judges it with a model. */
export function rememberFromMessage(message: { chatId: string; messageId: string; text: string; at: string }): { text: string; quote: string; chatId: string; messageId: string; at: string } | null {
  const match = REMEMBER_COLON.exec(message.text) ?? REMEMBER_THAT.exec(message.text);
  if (!match) return null;
  const text = match[1]!.trim();
  if (!text) return null;
  return { text, quote: text.length > MEMORY_NOTE_QUOTE_MAX_CHARS ? text.slice(0, MEMORY_NOTE_QUOTE_MAX_CHARS) : text, chatId: message.chatId, messageId: message.messageId, at: message.at };
}
