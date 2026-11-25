import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { parseToolCall } from "./browser/tools.ts";
import {
  addNote,
  archiveNote,
  confirmNote,
  editNote,
  forgetNote,
  forgetSkill,
  isSecret,
  loadNotesDoc,
  MemoryNotesError,
  patchSkill,
  rememberFromMessage,
  restoreNote,
  saveNotesDoc,
  saveSkill,
  type AddNoteInput,
  type CitedMessage,
  type MemoryArchiveReason,
  type MemoryNotesDoc,
  type SaveSkillInput,
} from "./memory-notes.ts";
import { ownerOrAdmin, type RequestAuth } from "./request-auth.ts";

/** Trust layer for structured memory notes and learned skills: who may change them, and how a bot's
 * suggestion waits for the owner instead of applying itself.
 *
 * The policy is a table, not scattered conditionals: the owner applies their own changes at once; a
 * bot never writes a live note or skill directly — it stages a proposal in `memory/pending.json`, and
 * the owner approves or discards it from the Memory panel. Approval replays the same operation the
 * proposal was validated against, and refuses with 409 when the notes changed since the proposal was
 * staged, so an approval can never land on a document the owner has not seen.
 *
 * This mirrors Nod's shape — one server-side check before anything changes, approval bound to the
 * exact action, the Vault keeping secrets out of the model — re-implemented here for this codebase:
 * the check is `memoryActorForAuth`, the approval is the pending queue, and the Vault boundary is the
 * secret refusal in `memory-notes.ts`. What does not map: Nod's browser/computer trust checks belong
 * to Phase 3 (browser sandbox); there is no per-step website approval here, and no cost meter — a
 * note or skill write costs nothing. */

export type MemoryActor = "owner" | "agent";

export type MemoryWriteAction =
  | "add-note"
  | "edit-note"
  | "confirm-note"
  | "archive-note"
  | "restore-note"
  | "forget-note"
  | "remember"
  | "save-skill"
  | "patch-skill"
  | "forget-skill"
  | "maintain-notes";

export type MemoryWriteDecision = "auto" | "pending" | "never";

export interface MemoryTrustRule {
  actor: MemoryActor;
  action: MemoryWriteAction;
  decision: MemoryWriteDecision;
  reason: string;
}

/** A bot's words are not the owner's: every content change it suggests waits for review. Upkeep is
 * different — it archives and deletes by rule, so there is nothing to review and a bot never runs it. */
const CONTENT_ACTIONS: readonly MemoryWriteAction[] = [
  "add-note", "edit-note", "confirm-note", "archive-note", "restore-note", "forget-note", "remember",
  "save-skill", "patch-skill", "forget-skill",
];

export const MEMORY_TRUST_POLICY: readonly MemoryTrustRule[] = [
  ...CONTENT_ACTIONS.map((action): MemoryTrustRule => ({
    actor: "owner",
    action,
    decision: "auto",
    reason: "the owner said it, or is editing their own notes in the panel",
  })),
  ...CONTENT_ACTIONS.map((action): MemoryTrustRule => ({
    actor: "agent",
    action,
    decision: "pending",
    reason: "a bot's suggestion is not the owner's word — it waits in the review queue",
  })),
  {
    actor: "owner",
    action: "maintain-notes",
    decision: "auto",
    reason: "deterministic upkeep of the owner's own notes",
  },
  {
    actor: "agent",
    action: "maintain-notes",
    decision: "never",
    reason: "upkeep archives and deletes by rule — never on a bot's say-so, and there is nothing to review",
  },
];

export function decideMemoryWrite(actor: MemoryActor, action: MemoryWriteAction): MemoryWriteDecision {
  return MEMORY_TRUST_POLICY.find((rule) => rule.actor === actor && rule.action === action)?.decision ?? "pending";
}

/** The owner is the desktop app or an admin-scoped session (a paired owner device, the owner's Cloud
 * session). Everyone else — a bot's shell on a shared server, a guest, a team member — is the agent:
 * they may propose, never apply. On the desktop the bot's shell shares the owner's loopback trust, so
 * this check alone cannot tell them apart; the separation there is the surface — a turn's tools never
 * expose a direct note or skill write, only this proposal path. */
export function memoryActorForAuth(auth: RequestAuth): MemoryActor {
  return ownerOrAdmin(auth) ? "owner" : "agent";
}

/** A staged proposal: the exact input of the operation it asks for, plus the notes version it was
 * checked against. The operation is validated twice — once at staging, once at approval — against the
 * same pure functions the direct routes use, so a proposal can never smuggle in a note the direct
 * path would refuse (a quote nobody said, a secret, a duplicate path). */
export type PendingProposalInput =
  | { kind: "add-note"; input: AddNoteInput; messages: CitedMessage[] }
  | { kind: "edit-note"; path: string; text: string }
  | { kind: "confirm-note"; path: string }
  | { kind: "archive-note"; path: string; reason: MemoryArchiveReason }
  | { kind: "restore-note"; path: string }
  | { kind: "forget-note"; path: string }
  | { kind: "remember"; path: string; chatId: string; messageId: string; text: string; at: string }
  | { kind: "save-skill"; input: SaveSkillInput }
  | { kind: "patch-skill"; name: string; body: string }
  | { kind: "forget-skill"; name: string }
  | { kind: "browser-step"; step: BrowserStepInput; fingerprint: string };

/** A website step staged for approval: the parsed tool call, the page it was staged on, and a
 * human-readable label. The label is display-only; the fingerprint binds the exact tool and
 * arguments, so a changed action or argument is a different step and needs its own approval. */
export interface BrowserStepInput {
  tool: string;
  args: Record<string, unknown>;
  url: string | null;
  label: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

/** The approval binding: the exact tool and arguments, key order irrelevant. */
export function browserStepFingerprint(step: BrowserStepInput): string {
  return createHash("sha256").update(JSON.stringify(canonical({ tool: step.tool, args: step.args }))).digest("hex");
}

/** The text a step carries that could hold a credential: typed text, a script, a dialog answer, or
 * a URL with credentials embedded. A step that holds one is refused outright — it is never staged,
 * so the pending file never holds a secret. */
export function browserStepHasSecret(step: BrowserStepInput): boolean {
  const texts = [step.url ?? ""];
  for (const field of ["text", "expression", "promptText"]) {
    if (typeof step.args[field] === "string") texts.push(step.args[field] as string);
  }
  return texts.some((text) => isSecret(text));
}

export type PendingProposal = PendingProposalInput & {
  id: string;
  proposedBy: MemoryActor;
  /** Notes version at staging; approval refuses when the document has moved on. */
  baseVersion: number;
  createdAt: string;
};

export interface PendingDoc {
  version: 1;
  proposals: PendingProposal[];
}

export const MEMORY_PENDING_FILE = "memory/pending.json";
export const MEMORY_PENDING_MAX = 50;
const MEMORY_PENDING_MAX_BYTES = 64 * 1024;

function fail(code: "invalid" | "conflict" | "not-found" | "too-large" | "corrupt" | "path" | "secret", status: number, message: string): never {
  throw new MemoryNotesError(code, status, message);
}

export function emptyPendingDoc(): PendingDoc {
  return { version: 1, proposals: [] };
}

/** A memory file under the bot's workspace; a link in its place is not a memory file. */
export function resolveMemoryFile(root: string, file: string): string {
  const absolute = join(root, file);
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
    fail("path", 400, `the ${file} file escapes the workspace`);
  }
  try {
    if (lstatSync(absolute).isSymbolicLink()) fail("path", 400, `the ${file} file is a link, not a file`);
  } catch (error) {
    if (error instanceof MemoryNotesError) throw error;
  }
  return absolute;
}

/** The pending file lives under the bot's workspace; a link in its place is not a pending file. */
export function resolvePendingPath(root: string): string {
  return resolveMemoryFile(root, MEMORY_PENDING_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPendingDoc(value: unknown): value is PendingDoc {
  return isRecord(value) && value.version === 1 && Array.isArray(value.proposals);
}

export function loadPendingDoc(root: string): PendingDoc {
  let raw: string;
  try {
    raw = readFileSync(resolvePendingPath(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPendingDoc();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("corrupt", 500, "the pending file is not valid JSON — it needs a hand fix before proposals can load");
  }
  if (!validPendingDoc(parsed)) fail("corrupt", 500, "the pending file does not hold a proposals document — it needs a hand fix before proposals can load");
  return parsed;
}

function savePendingDoc(root: string, doc: PendingDoc): PendingDoc {
  const text = JSON.stringify(doc, null, 2);
  if (Buffer.byteLength(text, "utf8") > MEMORY_PENDING_MAX_BYTES) {
    fail("too-large", 413, "too many pending proposals — review some first");
  }
  mkdirSync(join(root, "memory"), { recursive: true, mode: 0o700 });
  writeFileAtomic(resolvePendingPath(root), text, { mode: 0o600 });
  return doc;
}

export function listProposals(root: string): PendingProposal[] {
  return loadPendingDoc(root).proposals;
}

/** The thing a proposal changes: one proposal per note path or skill name, so the owner reviews one
 * change at a time instead of two proposals racing for the same note. */
function proposalTarget(input: PendingProposalInput): string {
  switch (input.kind) {
    case "add-note":
      return `note:${input.input.path}`;
    case "edit-note":
    case "confirm-note":
    case "archive-note":
    case "restore-note":
    case "forget-note":
    case "remember":
      return `note:${input.path}`;
    case "save-skill":
      return `skill:${input.input.name}`;
    case "patch-skill":
    case "forget-skill":
      return `skill:${input.name}`;
    case "browser-step":
      return `browser:${input.fingerprint}`;
  }
}

/** Run the proposed operation against a document and discard the result: the validation, nothing applied. */function dryRun(doc: MemoryNotesDoc, input: PendingProposalInput): void {
  switch (input.kind) {
    case "add-note":
      addNote(doc, input.input, input.messages);
      return;
    case "edit-note":
      editNote(doc, input.path, input.text);
      return;
    case "confirm-note":
      confirmNote(doc, input.path);
      return;
    case "archive-note":
      archiveNote(doc, input.path, input.reason);
      return;
    case "restore-note":
      restoreNote(doc, input.path);
      return;
    case "forget-note":
      forgetNote(doc, input.path);
      return;
    case "remember": {
      const found = rememberFromMessage({ chatId: input.chatId, messageId: input.messageId, text: input.text, at: input.at });
      if (!found) fail("invalid", 400, "that message holds no remember request — start it with “remember: …”");
      addNote(doc, {
        path: input.path, text: found.text, status: "stated",
        sources: [{ chatId: found.chatId, messageId: found.messageId, quote: found.quote, at: found.at }],
      }, [{ id: input.messageId, text: input.text }]);
      return;
    }
    case "save-skill":
      saveSkill(doc, input.input);
      return;
    case "patch-skill":
      patchSkill(doc, input.name, input.body);
      return;
    case "forget-skill":
      forgetSkill(doc, input.name);
      return;
    case "browser-step": {
      const parsed = parseToolCall(input.step.tool, input.step.args);
      if (!parsed.ok) fail("invalid", 400, `that browser step cannot run: ${parsed.error}`);
      if (browserStepFingerprint(input.step) !== input.fingerprint) {
        fail("invalid", 400, "that browser step does not match its approval fingerprint");
      }
      if (browserStepHasSecret(input.step)) {
        fail("secret", 400, "a browser step cannot carry a password, key or code — sign in with the saved login instead");
      }
      return;
    }
  }
}

/** Run the proposed operation for real. The caller saves the result with the proposal's base version. */
function applyProposal(doc: MemoryNotesDoc, input: PendingProposalInput): MemoryNotesDoc {
  switch (input.kind) {
    case "add-note":
      return addNote(doc, input.input, input.messages);
    case "edit-note":
      return editNote(doc, input.path, input.text);
    case "confirm-note":
      return confirmNote(doc, input.path);
    case "archive-note":
      return archiveNote(doc, input.path, input.reason);
    case "restore-note":
      return restoreNote(doc, input.path);
    case "forget-note":
      return forgetNote(doc, input.path);
    case "remember": {
      const found = rememberFromMessage({ chatId: input.chatId, messageId: input.messageId, text: input.text, at: input.at });
      if (!found) fail("invalid", 400, "that message holds no remember request — start it with “remember: …”");
      return addNote(doc, {
        path: input.path, text: found.text, status: "stated",
        sources: [{ chatId: found.chatId, messageId: found.messageId, quote: found.quote, at: found.at }],
      }, [{ id: input.messageId, text: input.text }]);
    }
    case "save-skill":
      return saveSkill(doc, input.input);
    case "patch-skill":
      return patchSkill(doc, input.name, input.body);
    case "forget-skill":
      return forgetSkill(doc, input.name);
    case "browser-step":
      fail("invalid", 400, "a browser step is approved by running it, not by applying it to notes");
  }
}

/** Stage a proposal: validate it against the notes as they stand now, then queue it. Nothing live changes. */
export function stageProposal(root: string, input: PendingProposalInput, proposedBy: MemoryActor): PendingProposal {
  const doc = loadNotesDoc(root);
  const pending = loadPendingDoc(root);
  if (pending.proposals.length >= MEMORY_PENDING_MAX) {
    fail("too-large", 413, "too many pending proposals — review some first");
  }
  const target = proposalTarget(input);
  if (pending.proposals.some((p) => proposalTarget(p) === target)) {
    fail("conflict", 409, `a proposal for ${target.slice(target.indexOf(":") + 1)} is already waiting for review`);
  }
  dryRun(doc, input);
  const proposal: PendingProposal = {
    ...input,
    id: randomUUID(),
    proposedBy,
    baseVersion: doc.version,
    createdAt: new Date().toISOString(),
  };
  savePendingDoc(root, { ...pending, proposals: [...pending.proposals, proposal] });
  return proposal;
}

/** Approve a proposal: replay its operation and save it only when the notes are still the version it
 * was staged against. The proposal stays queued when the save refuses, so the owner can review and retry. */
export function approveProposal(root: string, id: string): { doc: MemoryNotesDoc; proposal: PendingProposal } {
  const pending = loadPendingDoc(root);
  const proposal = pending.proposals.find((p) => p.id === id);
  if (!proposal) fail("not-found", 404, `no pending proposal ${JSON.stringify(id)}`);
  const doc = loadNotesDoc(root);
  const saved = saveNotesDoc(root, applyProposal(doc, proposal), proposal.baseVersion);
  savePendingDoc(root, { ...pending, proposals: pending.proposals.filter((p) => p.id !== id) });
  return { doc: saved, proposal };
}

/** Discard a proposal: the queue entry goes, nothing live changes. */
export function denyProposal(root: string, id: string): PendingProposal {
  return takeProposal(root, id);
}

/** Take a proposal out of the queue and return it; the caller owns what happens next. */
export function takeProposal(root: string, id: string): PendingProposal {
  const pending = loadPendingDoc(root);
  const proposal = pending.proposals.find((p) => p.id === id);
  if (!proposal) fail("not-found", 404, `no pending proposal ${JSON.stringify(id)}`);
  savePendingDoc(root, { ...pending, proposals: pending.proposals.filter((p) => p.id !== id) });
  return proposal;
}
