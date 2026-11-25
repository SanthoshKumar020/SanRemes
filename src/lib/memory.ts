import type { MemoryModelStatus } from "../../shared/memory-model";
import { ApiError, api } from "@/state/store";
import { intlLocale, t } from "@/lib/i18n";
import { serverErrorText } from "@/lib/server-error";
import { serverFetch } from "./relay-server";

export const MEMORY_INDEX = "MEMORY.md";
export const SOUL_PATH = "SOUL.md";

export interface MemoryCapacity {
  lines: number;
  bytes: number;
  maxLines: number;
  maxBytes: number;
  loadedLines: number;
  loadedBytes: number;
  truncated: boolean;
  hash: string;
}

export interface MemoryFileInfo {
  path: string;
  name: string;
  bytes: number;
  modifiedAt: number;
}

export interface MemoryOverview {
  lendingReview?: LendingReview;
  botId: string;
  workspacePath: string;
  index: MemoryCapacity;
  topics: MemoryFileInfo[];
  logs: MemoryFileInfo[];
}

export interface MemoryDoc {
  path: string;
  text: string;
  hash: string;
  exists: boolean;
}

export type MemoryActor = "bot" | "person" | "import" | "upkeep";

export interface MemoryJournalRow {
  id: string;
  at: number;
  botId: string;
  path: string;
  actor: MemoryActor;
  via: string;
  threadId?: string;
  threadTitle?: string;
  kind: "created" | "edited" | "deleted";
  beforeHash: string | null;
  afterHash: string | null;
  diff: string;
  added: number;
  removed: number;
  canRevert: boolean;
  revertUnavailableReason?: string;
}

export type SaveResult =
  | { ok: true; doc: MemoryDoc; overview: MemoryOverview }
  | { ok: false; conflict: true; current: string; currentHash: string };

/** `mine`: on a Team Cloud, the signed-in person's own layer of the bot's memory rather than the team's. */
const memoryRoute = (botId: string, mine: boolean) => `/api/bots/${botId}/memory${mine ? "/mine" : ""}`;

export function fetchMemoryOverview(botId: string, mine = false): Promise<MemoryOverview> {
  return api(memoryRoute(botId, mine));
}

export function fetchMemoryDoc(botId: string, path: string, mine = false): Promise<MemoryDoc> {
  return api(`${memoryRoute(botId, mine)}/file?path=${encodeURIComponent(path)}`);
}

export async function saveMemoryDoc(botId: string, path: string, text: string, expectedHash: string | undefined, mine = false): Promise<SaveResult> {
  const response = await serverFetch(`${memoryRoute(botId, mine)}/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, text, expectedHash }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 409 && typeof body.current === "string" && typeof body.currentHash === "string") {
    return { ok: false, conflict: true, current: body.current, currentHash: body.currentHash };
  }
  if (!response.ok) throw new ApiError(serverErrorText(body, typeof body.error === "string" ? body.error : `${response.status} ${response.statusText}`), response.status);
  const saved = body as unknown as MemoryDoc & { overview: MemoryOverview };
  return { ok: true, doc: { path: saved.path, text: saved.text, hash: saved.hash, exists: saved.exists }, overview: saved.overview };
}

/** One conversation's own notes; `scoped` when the bot saves that conversation's matters there rather than in MEMORY.md. */
export interface ThreadNotesDoc extends MemoryDoc {
  scoped: boolean;
}

export type TextSaveResult<D extends MemoryDoc> = { ok: true; doc: D } | { ok: false; conflict: true; current: string; currentHash: string };

const threadNotesRoute = (botId: string, threadId: string) => `/api/bots/${encodeURIComponent(botId)}/memory/thread/${encodeURIComponent(threadId)}`;

export function fetchThreadNotes(botId: string, threadId: string): Promise<ThreadNotesDoc> {
  return api(threadNotesRoute(botId, threadId));
}

export async function saveThreadNotes(botId: string, threadId: string, text: string, expectedHash: string | undefined): Promise<TextSaveResult<ThreadNotesDoc>> {
  const response = await serverFetch(threadNotesRoute(botId, threadId), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, expectedHash }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 409 && typeof body.current === "string" && typeof body.currentHash === "string") {
    return { ok: false, conflict: true, current: body.current, currentHash: body.currentHash };
  }
  if (!response.ok) throw new ApiError(serverErrorText(body, typeof body.error === "string" ? body.error : `${response.status} ${response.statusText}`), response.status);
  return { ok: true, doc: body as unknown as ThreadNotesDoc };
}

export function deleteMemoryDoc(botId: string, path: string, mine = false): Promise<{ overview: MemoryOverview }> {
  return api(`${memoryRoute(botId, mine)}/file?path=${encodeURIComponent(path)}`, { method: "DELETE" });
}

export async function fetchMemoryJournal(botId: string, limit = 50): Promise<MemoryJournalRow[]> {
  const result: { entries: MemoryJournalRow[] } = await api(`/api/bots/${botId}/memory/journal?limit=${limit}`);
  return result.entries;
}

export function revertMemoryChange(botId: string, entryId: string): Promise<MemoryDoc & { overview: MemoryOverview }> {
  return api(`/api/bots/${botId}/memory/journal/${encodeURIComponent(entryId)}/revert`, { method: "POST" });
}

export function fetchSoulChanges(botId: string): Promise<{ rows: MemoryJournalRow[]; revision: string }> {
  return api(`/api/bots/${botId}/history?view=changes&limit=20`);
}

export function undoSoulChange(botId: string, id: string, expectedRevision: string): Promise<unknown> {
  return api(`/api/bots/${botId}/history/rollback`, { method: "POST", body: JSON.stringify({ id, expectedRevision }) });
}

export interface TidyReport {
  at: number;
  expired: number;
  duplicates: number;
  superseded: number;
  deferred: number;
  organized?: number;
  contradictionsChecked: boolean;
  note?: string;
}

export interface CaptureReport {
  at: number;
  added: number;
  topics?: number;
  aboutMe?: number;
  note?: string;
}

export interface UpkeepStatus {
  enabled: boolean;
  modelSteps: boolean;
  memoryModel?: MemoryModelStatus;
  lastTidy?: TidyReport;
  lastCapture?: CaptureReport;
}

export function noticedCount(report: CaptureReport | undefined): number {
  return report ? report.added + (report.topics ?? 0) : 0;
}

export function fetchUpkeepStatus(botId: string, signal?: AbortSignal): Promise<UpkeepStatus> {
  return api(`/api/bots/${botId}/memory/upkeep`, { signal });
}

export interface LendingReview {
  token: string;
  changed: string[];
}

export function markMemoryReviewed(botId: string, token: string): Promise<{ ok: true; lendingReview: false }> {
  return api(`/api/bots/${botId}/memory/reviewed`, { method: "POST", body: JSON.stringify({ token }) });
}

/** Structured notes: one fact per note, each with the words it came from. */
export type StructuredNoteStatus = "stated" | "observed" | "tentative";

export interface StructuredNoteSource {
  chatId: string;
  messageId: string;
  quote: string;
  at: string;
}

export interface StructuredNoteFact {
  kind: "fact" | "preference" | "plan" | "event" | "possession";
  entities: string[];
  occurredOn?: string;
  validFrom?: string;
  validTo?: string;
}

export interface StructuredNote {
  path: string;
  area: string;
  text: string;
  status: StructuredNoteStatus;
  updated: string;
  edited: string | null;
  expires: string | null;
  sources: StructuredNoteSource[];
  fact?: StructuredNoteFact;
}

export interface ArchivedStructuredNote {
  path: string;
  area: string;
  text: string;
  reason: string;
  by: string | null;
  archived: string;
  sources: StructuredNoteSource[];
  fact?: StructuredNoteFact;
}

export interface LearnedSkill {
  name: string;
  description: string;
  body: string;
  learned: string;
  updated: string;
  edited: string | null;
  task: string | null;
}

export interface StructuredNotesDoc {
  version: number;
  notes: StructuredNote[];
  archive: ArchivedStructuredNote[];
  skills: LearnedSkill[];
}

interface PendingProposalBase {
  id: string;
  proposedBy: "agent" | "owner";
  baseVersion: number;
  createdAt: string;
}

/** A staged proposal: the exact change it asks for, plus who asked and the notes version it was checked against. */
export type PendingProposal = PendingProposalBase & (
  | { kind: "add-note"; input: { path: string; text: string; status?: StructuredNoteStatus; sources: StructuredNoteSource[]; fact?: StructuredNoteFact; expires?: string | null }; messages: { id: string; text: string }[] }
  | { kind: "edit-note"; path: string; text: string }
  | { kind: "confirm-note"; path: string }
  | { kind: "archive-note"; path: string; reason: string }
  | { kind: "restore-note"; path: string }
  | { kind: "forget-note"; path: string }
  | { kind: "remember"; path: string; chatId: string; messageId: string; text: string; at: string }
  | { kind: "save-skill"; input: { name: string; description: string; body: string; task?: string | null } }
  | { kind: "patch-skill"; name: string; body: string }
  | { kind: "forget-skill"; name: string }
);

export function proposalSummary(proposal: PendingProposal): string {
  switch (proposal.kind) {
    case "add-note": return `Add note ${proposal.input.path}: “${proposal.input.text}”`;
    case "edit-note": return `Change note ${proposal.path} to “${proposal.text}”`;
    case "confirm-note": return `Confirm note ${proposal.path}`;
    case "archive-note": return `Archive note ${proposal.path}`;
    case "restore-note": return `Restore note ${proposal.path}`;
    case "forget-note": return `Forget note ${proposal.path}`;
    case "remember": return `Remember “${proposal.text}” as ${proposal.path}`;
    case "save-skill": return `Learn skill ${proposal.input.name}: ${proposal.input.description}`;
    case "patch-skill": return `Update skill ${proposal.name}`;
    case "forget-skill": return `Forget skill ${proposal.name}`;
  }
}

const structuredNotesRoute = (botId: string) => `/api/bots/${botId}/memory`;

export function fetchStructuredNotes(botId: string): Promise<StructuredNotesDoc> {
  return api(`${structuredNotesRoute(botId)}/notes`);
}

export async function fetchPendingProposals(botId: string): Promise<PendingProposal[]> {
  const result: { proposals: PendingProposal[] } = await api(`${structuredNotesRoute(botId)}/pending`);
  return result.proposals;
}

export function approveProposal(botId: string, id: string): Promise<{ ok: true; version: number }> {
  return api(`${structuredNotesRoute(botId)}/pending/${encodeURIComponent(id)}/approve`, { method: "POST" });
}

export function denyProposal(botId: string, id: string): Promise<{ ok: true }> {
  return api(`${structuredNotesRoute(botId)}/pending/${encodeURIComponent(id)}/deny`, { method: "POST" });
}

export type StructuredNoteActionKind = "confirm" | "edit" | "archive" | "restore";

export function structuredNoteAction(
  botId: string,
  action: StructuredNoteActionKind,
  options: { path: string; text?: string; reason?: string; expectedVersion?: number },
): Promise<{ ok: true; version: number }> {
  return api(`${structuredNotesRoute(botId)}/notes/${action}`, {
    method: "POST",
    body: JSON.stringify({
      path: options.path,
      ...(options.text !== undefined ? { text: options.text } : {}),
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
      ...(options.expectedVersion !== undefined ? { expectedVersion: options.expectedVersion } : {}),
    }),
  });
}

export function forgetStructuredNote(botId: string, path: string, expectedVersion?: number): Promise<{ ok: true; version: number }> {
  const query = expectedVersion === undefined ? "" : `&expectedVersion=${expectedVersion}`;
  return api(`${structuredNotesRoute(botId)}/notes?path=${encodeURIComponent(path)}${query}`, { method: "DELETE" });
}

export function forgetLearnedSkill(botId: string, name: string, expectedVersion?: number): Promise<{ ok: true; version: number }> {
  const query = expectedVersion === undefined ? "" : `&expectedVersion=${expectedVersion}`;
  return api(`${structuredNotesRoute(botId)}/skills?name=${encodeURIComponent(name)}${query}`, { method: "DELETE" });
}

export interface StructuredMaintainReport {
  expired: number;
  duplicates: number;
  stale: number;
}

export function maintainStructuredNotes(botId: string, expectedVersion?: number): Promise<{ report: StructuredMaintainReport }> {
  return api(`${structuredNotesRoute(botId)}/notes/maintain`, {
    method: "POST",
    body: JSON.stringify(expectedVersion === undefined ? {} : { expectedVersion }),
  });
}

export function tidyMemoryNow(botId: string): Promise<{ report: TidyReport; overview: MemoryOverview }> {
  return api(`/api/bots/${botId}/memory/tidy`, { method: "POST" });
}

export function tidySummary(report: TidyReport): string {
  const parts: string[] = [];
  if (report.expired) parts.push(`archived ${report.expired} expired note${report.expired === 1 ? "" : "s"}`);
  if (report.duplicates) parts.push(`merged ${report.duplicates} duplicate${report.duplicates === 1 ? "" : "s"}`);
  if (report.superseded) parts.push(`crossed out ${report.superseded} contradicted note${report.superseded === 1 ? "" : "s"}`);
  if (report.organized) parts.push(`filed ${report.organized} note${report.organized === 1 ? "" : "s"} into topics`);
  const head = parts.length ? parts.join(", ") : "nothing to tidy";
  return head.charAt(0).toUpperCase() + head.slice(1);
}

export type MemoryOpenTarget = "obsidian" | "folder";

export function openMemoryLocation(botId: string, target: MemoryOpenTarget): Promise<{ ok: boolean; workspacePath: string }> {
  return api(`/api/bots/${botId}/memory/open`, { method: "POST", body: JSON.stringify({ target }) });
}


export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${new Intl.NumberFormat(intlLocale(), { useGrouping: false }).format(Math.round(bytes / 102.4) / 10)} KB`;
}

export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return t("remote.time.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("remote.time.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  if (days === 1) return t("time.yesterday");
  if (days < 7) return t("time.daysAgo", { count: days });
  return new Date(at).toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

export type CapacityLevel = "ok" | "near" | "over";

export interface CapacityStatus {
  level: CapacityLevel;
  lineShare: number;
  byteShare: number;
  sentence: string;
  warning: string | null;
}

export function capacityStatus(index: MemoryCapacity): CapacityStatus {
  const lineShare = index.maxLines ? index.lines / index.maxLines : 0;
  const byteShare = index.maxBytes ? index.bytes / index.maxBytes : 0;
  const level: CapacityLevel = index.truncated ? "over" : Math.max(lineShare, byteShare) >= 0.8 ? "near" : "ok";
  const sentence = `${index.lines} of ${index.maxLines} lines · ${formatBytes(index.bytes)} of ${formatBytes(index.maxBytes)}. Only the first ${index.maxLines} lines load each turn.`;
  let warning: string | null = null;
  if (index.truncated) {
    const missingLines = index.lines - index.loadedLines;
    warning = missingLines > 0
      ? t(missingLines === 1 ? "memory.capacity.overLinesOne" : "memory.capacity.overLinesMany", { lines: index.lines, loaded: index.loadedLines, missing: missingLines })
      : t("memory.capacity.overBytes", { bytes: formatBytes(index.bytes), loaded: formatBytes(index.loadedBytes) });
  }
  return { level, lineShare, byteShare, sentence, warning };
}

export function fileLabel(path: string): string {
  if (path === MEMORY_INDEX) return "MEMORY.md";
  if (path.startsWith("memory/log/")) return path.slice("memory/log/".length).replace(/\.md$/, "");
  return path.replace(/^memory\//, "").replace(/\.md$/, "");
}

export function journalSummary(row: MemoryJournalRow, botName: string): string {
  const who = row.actor === "bot" ? botName : row.actor === "import" ? "An import" : row.actor === "upkeep" ? "Memory upkeep" : "You";
  const file = fileLabel(row.path);
  const isIndex = row.path === MEMORY_INDEX;
  const topic = isIndex ? file : row.path.startsWith("memory/log/") ? `the ${file} log` : `the ${file} topic`;
  if (row.kind === "created") return `${who} created ${topic}${row.added ? ` with ${plural(row.added, "line")}` : ""}`;
  if (row.kind === "deleted") return `${who} deleted ${topic}`;
  if (row.added && !row.removed) return `${who} added ${plural(row.added, "line")} to ${topic}`;
  if (row.removed && !row.added) return `${who} removed ${plural(row.removed, "line")} from ${topic}`;
  return `${who} rewrote ${plural(Math.max(row.added, row.removed), "line")} in ${topic}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function journalSource(row: MemoryJournalRow): string | null {
  if (row.via === "revert") return "undo";
  if (row.via === "disk") return "changed outside the app";
  if (row.via === "tidy") return "tidy-up";
  if (row.via === "organize") return "filed into topics";
  if (row.via === "capture") return row.threadTitle ? `noticed in chat “${row.threadTitle}”` : "noticed in a chat";
  if (row.threadTitle) return `from chat “${row.threadTitle}”`;
  if (row.actor === "bot") return "during a task";
  if (row.via === "ui") return "in Settings";
  if (row.via === "api") return "through the API";
  return null;
}

export function journalSourceKey(row: MemoryJournalRow): "memory.source.undo" | "memory.source.disk" | "memory.source.tidy" | "memory.source.organize" | "memory.source.capture" | "memory.source.captureWithTitle" | "memory.source.chat" | "memory.source.task" | "memory.source.settings" | "memory.source.api" | null {
  if (row.via === "revert") return "memory.source.undo";
  if (row.via === "disk") return "memory.source.disk";
  if (row.via === "tidy") return "memory.source.tidy";
  if (row.via === "organize") return "memory.source.organize";
  if (row.via === "capture") return row.threadTitle ? "memory.source.captureWithTitle" : "memory.source.capture";
  if (row.threadTitle) return "memory.source.chat";
  if (row.actor === "bot") return "memory.source.task";
  if (row.via === "ui") return "memory.source.settings";
  if (row.via === "api") return "memory.source.api";
  return null;
}

export function fileManagerLabel(platform: string | undefined): string {
  if (platform === "darwin") return "Show in Finder";
  if (platform === "win32") return "Show in Explorer";
  return "Show in file manager";
}

export function topicFileName(input: string): string | null {
  const stem = input.trim().replace(/\.md$/i, "").replace(/[^\w .-]+/g, "-").replace(/^[^\w]+/, "").trim();
  if (!stem) return null;
  return `${stem}.md`;
}
