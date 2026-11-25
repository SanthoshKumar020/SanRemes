import { z } from "zod";
import type { ServerResponse } from "node:http";

import { json } from "../harness/http.ts";
import {
  MEMORY_INDEX,
  MemoryStoreError,
  deleteMemoryDoc,
  memoryCapacity,
  memoryOverview,
  openMemoryLocation,
  parseMemoryPath,
  readMemoryDoc,
  threadNotesPath,
  writeMemoryDoc,
} from "../memory-store.ts";
import {
  addNote,
  archiveNote,
  confirmNote,
  editNote,
  forgetNote,
  forgetSkill,
  loadNotesDoc,
  maintainNotes,
  MemoryNotesError,
  patchSkill,
  rememberFromMessage,
  restoreNote,
  saveNotesDoc,
  saveSkill,
  type MemoryNotesDoc,
} from "../memory-notes.ts";
import {
  approveProposal,
  denyProposal,
  listProposals,
  memoryActorForAuth,
  stageProposal,
} from "../memory-trust.ts";
import { workspaceDir } from "../workspace.ts";
import {
  flushMemoryJournal,
  journalMemoryDelete,
  journalMemoryWrite,
  readMemoryJournal,
  revertMemoryChange,
  type MemoryJournalEntry,
} from "../memory-journal.ts";
import { upkeepEnabled, type MemoryUpkeep } from "../memory-upkeep.ts";
import { listLearnedFacts, removeLearned } from "../profile-learned.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BotMemoryRouteDeps {
  bot(id: string): { id: string; memoryUpkeep?: boolean } | null | undefined;
  taskByThread(botId: string, threadId: string): { title?: string } | undefined;
  upkeep: Pick<MemoryUpkeep, "status" | "tidy">;
  /** The caller's About me: the server's profile's, or on a Team Cloud the signed-in person's own. */
  aboutMe(auth: RequestAuth): string;
  saveAboutMe(text: string, auth: RequestAuth): void;
  /** Cloud home only. A review may come only from one of the owner's own devices (`owner`). */
  lendingReview?: {
    needed(botId: string): { token: string; changed: string[] } | null;
    accept(botId: string, token: string): boolean;
    owner(auth: RequestAuth): boolean;
  };
  ownersWrite?: <T>(auth: RequestAuth, botId: string, write: () => T) => T;
  /** Team Cloud only: the signed-in person's own layer of this bot's memory (`/memory/mine`); null for anyone else. */
  ownLayer?(auth: RequestAuth, botId: string): string | null;
  /** A conversation's own notes (`/memory/thread/<thread>`): `owns` when it is one of this bot's conversations, `scoped`
   * when its saves default to its notes. */
  threadNotes?: { owns(botId: string, threadId: string): boolean; scoped(botId: string, threadId: string): boolean };
}

/** A conversation's notes are kept out of the journal, which outlives a deleted conversation and travels in a move. */
function isThreadNotes(path: string): boolean {
  try {
    return parseMemoryPath(path).kind === "thread";
  } catch {
    return false;
  }
}

export function createBotMemoryRoutes(deps: BotMemoryRouteDeps): RouteHandler {
  /** 400 invalid, 404 no such note, 409 conflict, 413 too large, 500 corrupt; anything else goes to the catch-all. */
  function replyNotesError(res: ServerResponse, error: unknown) {
    if (!(error instanceof MemoryNotesError)) throw error;
    return json(res, error.status, { error: error.message, code: error.code });
  }

  function notesRoot(botId: string): string {
    return workspaceDir(botId);
  }

  function notesView(botId: string): MemoryNotesDoc {
    return loadNotesDoc(notesRoot(botId));
  }

  function saveNotes(botId: string, doc: MemoryNotesDoc, expectedVersion?: number): MemoryNotesDoc {
    return saveNotesDoc(notesRoot(botId), doc, expectedVersion);
  }

  /** 400 path, 409 conflict (with what is on disk now), 413 too large; anything else goes to the catch-all. */
  function replyMemoryError(res: ServerResponse, error: unknown) {
    if (!(error instanceof MemoryStoreError)) throw error;
    if (error.code === "conflict") {
      return json(res, error.status, { error: error.message, code: error.code, currentHash: error.currentHash, current: error.current });
    }
    return json(res, error.status, { error: error.message, code: error.code });
  }

  function journalEntryForClient(botId: string, entry: MemoryJournalEntry) {
    const { before: _before, ...visible } = entry;
    const threadTitle = entry.threadId ? deps.taskByThread(botId, entry.threadId)?.title : undefined;
    return threadTitle ? { ...visible, threadTitle } : visible;
  }

  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const write = <T>(botId: string, change: () => T): T => deps.ownersWrite ? deps.ownersWrite(auth, botId, change) : change();
    /** Direct note and skill writes are the owner's: a bot stages a proposal instead (see memory-trust.ts). */
    const ownerOnly = () =>
      memoryActorForAuth(auth) !== "owner"
        ? json(res, 403, { error: "only the owner can change structured notes directly — a bot stages a proposal for the owner to review instead", code: "owner-only" })
        : null;
    /** One memory file of `id`, a bot's own folder or a layer of it. */
    const serveFile = async (id: string, guarded: <T>(change: () => T) => T) => {
      if (isThreadNotes(url.searchParams.get("path") ?? "")) return json(res, 400, { error: "a conversation's notes are at /memory/thread/<thread id>", code: "path" });
      if (method === "GET") {
        try {
          return json(res, 200, readMemoryDoc(id, url.searchParams.get("path") ?? MEMORY_INDEX));
        } catch (error) {
          return replyMemoryError(res, error);
        }
      }
      if (method === "PUT") {
        const parsed = z
          .object({ path: z.string().default(MEMORY_INDEX), text: z.string(), expectedHash: z.string().optional() })
          .safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "text must be a string; path and expectedHash are optional strings" });
        if (isThreadNotes(parsed.data.path)) return json(res, 400, { error: "a conversation's notes are at /memory/thread/<thread id>", code: "path" });
        try {
          const { doc, entry } = guarded(() => journalMemoryWrite(id, parsed.data.path, parsed.data.text, {
            actor: "person",
            via: "ui",
            expectedHash: parsed.data.expectedHash,
          }));
          return json(res, 200, { ok: true, ...doc, entry: entry ? journalEntryForClient(id, entry) : null, overview: memoryOverview(id) });
        } catch (error) {
          return replyMemoryError(res, error);
        }
      }
      const file = url.searchParams.get("path") ?? "";
      try {
        const entry = guarded(() => journalMemoryDelete(id, file, { actor: "person", via: "ui" }));
        return json(res, 200, { ok: true, path: file, entry: entry ? journalEntryForClient(id, entry) : null, overview: memoryOverview(id) });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    };
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory$/);
    if (m && method === "GET") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      try {
        const overview = memoryOverview(m[1]);
        // `text` and `truncated` stay one release for clients of the old whole-file shape.
        const review = deps.lendingReview?.needed(m[1]);
        return json(res, 200, { ...overview, text: readMemoryDoc(m[1], MEMORY_INDEX).text, truncated: overview.index.truncated,
          ...(review ? { lendingReview: review } : {}) });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    if (m && method === "PUT") {
      // The old whole-file write, kept one release: no hash check, so it can overwrite a note the bot just wrote.
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "text must be a string" });
      try {
        const botId = m[1];
        const { doc } = write(botId, () => journalMemoryWrite(botId, MEMORY_INDEX, parsed.data.text, { actor: "person", via: "api" }));
        return json(res, 200, { ok: true, hash: doc.hash, truncated: memoryCapacity(doc.text).truncated });
      } catch (error) {
        // The old route answered 400 for an oversized body; its callers keep that.
        if (error instanceof MemoryStoreError && error.code === "too-large") return json(res, 400, { error: error.message });
        return replyMemoryError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/reviewed$/);
    if (m && method === "POST" && deps.lendingReview) {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      if (!deps.lendingReview.owner(auth)) {
        return json(res, 403, { error: "Only the owner of this Cloud can review this bot's memory, from one of their own devices." });
      }
      // Bound to what the owner was shown: anything changed since is shown again.
      const parsed = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "token is required: the lendingReview token the Memory panel was shown" });
      if (!deps.lendingReview.accept(m[1], parsed.data.token)) {
        return json(res, 409, { error: "This bot's memory changed since you looked. Review it again.", code: "changed",
          lendingReview: deps.lendingReview.needed(m[1]) });
      }
      return json(res, 200, { ok: true, lendingReview: false });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/file$/);
    if (m && ["GET", "PUT", "DELETE"].includes(method)) {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const botId = m[1];
      return serveFile(botId, (change) => write(botId, change));
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/mine(\/file)?$/);
    if (m && (method === "GET" || m[2])) {
      const layer = deps.bot(m[1]) ? deps.ownLayer?.(auth, m[1]) ?? null : null;
      if (!layer) return json(res, 404, { error: "no such bot" });
      if (!m[2]) return json(res, 200, memoryOverview(layer));
      if (!["GET", "PUT", "DELETE"].includes(method)) return PASS;
      return serveFile(layer, (change) => change());
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/thread\/([\w-]+)$/);
    if (m && ["GET", "PUT", "DELETE"].includes(method)) {
      const botId = m[1]!, threadId = m[2]!;
      if (!deps.bot(botId) || !deps.threadNotes?.owns(botId, threadId)) return json(res, 404, { error: "no such conversation" });
      const notesPath = threadNotesPath(threadId), scoped = deps.threadNotes.scoped(botId, threadId);
      try {
        if (method === "GET") return json(res, 200, { ...readMemoryDoc(botId, notesPath), scoped });
        if (method === "DELETE") {
          write(botId, () => deleteMemoryDoc(botId, notesPath));
          return json(res, 200, { ...readMemoryDoc(botId, notesPath), scoped });
        }
        const parsed = z.object({ text: z.string(), expectedHash: z.string().optional() }).safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "text must be a string; expectedHash is an optional string" });
        write(botId, () => writeMemoryDoc(botId, notesPath, parsed.data.text, { expectedHash: parsed.data.expectedHash }));
        return json(res, 200, { ok: true, ...readMemoryDoc(botId, notesPath), scoped });
      } catch (error) {
        return replyMemoryError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/journal$/);
    if (m && method === "GET") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      // A row a save queued a moment ago may not have reached disk yet.
      await flushMemoryJournal(m[1]);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const botId = m[1];
      return json(res, 200, { entries: readMemoryJournal(botId, limit).map((entry) => journalEntryForClient(botId, entry)) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/journal\/([\w-]+)\/revert$/);
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      await flushMemoryJournal(m[1]);
      const botId = m[1], changeId = m[2];
      const result = write(botId, () => revertMemoryChange(botId, changeId));
      if (!result.ok) return json(res, result.status, { error: result.error });
      return json(res, 200, { ok: true, ...result.doc, entry: result.entry ? journalEntryForClient(m[1], result.entry) : null, overview: memoryOverview(m[1]) });
    }
    if (method === "GET" && path === "/api/profile/learned") {
      return json(res, 200, { learned: listLearnedFacts() });
    }
    m = path.match(/^\/api\/profile\/learned\/([\w-]+)\/remove$/);
    if (m && method === "POST") {
      const removed = removeLearned(m[1], deps.aboutMe(auth), (text) => deps.saveAboutMe(text, auth));
      if (!removed) return json(res, 404, { error: "That fact was already removed." });
      return json(res, 200, { ok: true, aboutMe: deps.aboutMe(auth), learned: listLearnedFacts() });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/upkeep$/);
    if (m && method === "GET") {
      const bot = deps.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      return json(res, 200, { enabled: upkeepEnabled(bot), ...deps.upkeep.status(bot.id) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/tidy$/);
    if (m && method === "POST") {
      const bot = deps.bot(m[1]);
      if (!bot) return json(res, 404, { error: "no such bot" });
      if (!upkeepEnabled(bot)) return json(res, 409, { error: "Switch on Memory upkeep for this bot first." });
      const report = await deps.upkeep.tidy(bot.id);
      await flushMemoryJournal(bot.id);
      return json(res, 200, { report, overview: memoryOverview(bot.id) });
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/open$/);
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const parsed = z.object({ target: z.enum(["obsidian", "folder"]) }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "target must be obsidian or folder" });
      const workspacePath = memoryOverview(m[1]).workspacePath;
      if (auth.kind !== "loopback") {
        return json(res, 403, { error: `This only works on the computer running OpenMausBot. The memory folder there is ${workspacePath}`, workspacePath });
      }
      const opened = await openMemoryLocation(m[1], parsed.data.target);
      if (!opened.ok) return json(res, 500, { error: opened.error, workspacePath: opened.workspacePath });
      return json(res, 200, opened);
    }
    const noteSource = z.object({ chatId: z.string(), messageId: z.string(), quote: z.string(), at: z.string() });
    const noteFact = z.object({
      kind: z.enum(["fact", "preference", "plan", "event", "possession"]),
      entities: z.array(z.string()),
      occurredOn: z.string().optional(),
      validFrom: z.string().optional(),
      validTo: z.string().optional(),
    });
    const citedMessage = z.object({ id: z.string(), text: z.string() });
    const expectedVersion = z.number().int().nonnegative().optional();
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/notes$/);
    if (m && method === "GET") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      try {
        return json(res, 200, notesView(m[1]));
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const blocked = ownerOnly();
      if (blocked) return blocked;
      const parsed = z.object({
        path: z.string(), text: z.string(), status: z.enum(["stated", "observed", "tentative"]).optional(),
        sources: z.array(noteSource), sourceMessages: z.array(citedMessage), fact: noteFact.optional(),
        expires: z.string().nullable().optional(), expectedVersion,
      }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "a note needs a path, text, quoted sources and the cited messages" });
      try {
        const botId = m[1];
        const saved = write(botId, () => saveNotes(botId, addNote(notesView(botId), parsed.data, parsed.data.sourceMessages), parsed.data.expectedVersion));
        return json(res, 200, { ok: true, version: saved.version, note: saved.notes.find((n) => n.path === parsed.data.path) ?? null });
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    if (m && method === "DELETE") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const blocked = ownerOnly();
      if (blocked) return blocked;
      const notePath = url.searchParams.get("path") ?? "";
      const version = url.searchParams.get("expectedVersion");
      const expected = version === null || version === "" ? undefined : Number(version);
      try {
        const botId = m[1];
        const saved = write(botId, () => saveNotes(botId, forgetNote(notesView(botId), notePath), Number.isInteger(expected) ? expected : undefined));
        return json(res, 200, { ok: true, version: saved.version });
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/notes\/remember$/);
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const blocked = ownerOnly();
      if (blocked) return blocked;
      const parsed = z.object({ path: z.string(), chatId: z.string(), messageId: z.string(), text: z.string(), at: z.string(), expectedVersion }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "a remember needs a path and the owner's message" });
      const found = rememberFromMessage(parsed.data);
      if (!found) return json(res, 400, { error: "that message holds no remember request — start it with “remember: …”" });
      try {
        const botId = m[1];
        const saved = write(botId, () => saveNotes(botId, addNote(notesView(botId), {
          path: parsed.data.path, text: found.text, status: "stated",
          sources: [{ chatId: found.chatId, messageId: found.messageId, quote: found.quote, at: found.at }],
        }, [{ id: parsed.data.messageId, text: parsed.data.text }]), parsed.data.expectedVersion));
        return json(res, 200, { ok: true, version: saved.version, note: saved.notes.find((n) => n.path === parsed.data.path) ?? null });
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/notes\/(confirm|edit|archive|restore|maintain)$/);
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const blocked = ownerOnly();
      if (blocked) return blocked;
      const action = m[2]!;
      const parsed = z.object({
        path: z.string().optional(), text: z.string().optional(),
        reason: z.enum(["superseded", "merged", "duplicate", "expired", "stale", "obsolete", "contradicted", "manual"]).optional(),
        expectedVersion,
      }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "a note action needs a path" });
      try {
        const botId = m[1];
        const saved = write(botId, () => {
          const doc = notesView(botId);
          if (action === "maintain") {
            const { doc: kept, report } = maintainNotes(doc);
            const maintained = saveNotes(botId, kept, parsed.data.expectedVersion);
            return { saved: maintained, report };
          }
          if (!parsed.data.path) throw new MemoryNotesError("invalid", 400, "a note action needs a path");
          const next =
            action === "confirm" ? confirmNote(doc, parsed.data.path) :
            action === "edit" ? editNote(doc, parsed.data.path, parsed.data.text ?? "") :
            action === "archive" ? archiveNote(doc, parsed.data.path, parsed.data.reason ?? "manual") :
            restoreNote(doc, parsed.data.path);
          return { saved: saveNotes(botId, next, parsed.data.expectedVersion) };
        });
        return json(res, 200, { ok: true, version: saved.saved.version, ...(saved.report ? { report: saved.report } : {}) });
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/skills$/);
    if (m && method === "GET") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      try {
        const doc = notesView(m[1]);
        return json(res, 200, { version: doc.version, skills: doc.skills });
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const blocked = ownerOnly();
      if (blocked) return blocked;
      const parsed = z.object({ name: z.string(), description: z.string(), body: z.string(), task: z.string().nullable().optional(), expectedVersion }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "a skill needs a name, a description and a body" });
      try {
        const botId = m[1];
        const saved = write(botId, () => saveNotes(botId, saveSkill(notesView(botId), parsed.data), parsed.data.expectedVersion));
        return json(res, 200, { ok: true, version: saved.version, skill: saved.skills.find((s) => s.name === parsed.data.name) ?? null });
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    if (m && method === "DELETE") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const blocked = ownerOnly();
      if (blocked) return blocked;
      const name = url.searchParams.get("name") ?? "";
      const version = url.searchParams.get("expectedVersion");
      const expected = version === null || version === "" ? undefined : Number(version);
      try {
        const botId = m[1];
        const saved = write(botId, () => saveNotes(botId, forgetSkill(notesView(botId), name), Number.isInteger(expected) ? expected : undefined));
        return json(res, 200, { ok: true, version: saved.version });
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/skills\/patch$/);
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const blocked = ownerOnly();
      if (blocked) return blocked;
      const parsed = z.object({ name: z.string(), body: z.string(), expectedVersion }).safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "a skill patch needs a name and a body" });
      try {
        const botId = m[1];
        const saved = write(botId, () => saveNotes(botId, patchSkill(notesView(botId), parsed.data.name, parsed.data.body), parsed.data.expectedVersion));
        return json(res, 200, { ok: true, version: saved.version, skill: saved.skills.find((s) => s.name === parsed.data.name) ?? null });
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/pending$/);
    if (m && method === "GET") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      try {
        return json(res, 200, { version: 1, proposals: listProposals(notesRoot(m[1])) });
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    if (m && method === "POST") {
      // Staging is the agent's path in: it changes nothing live, and the proposal is validated here
      // against the same checks as a direct write, so it stays open to any authenticated caller.
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const pendingInput = z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("add-note"),
          input: z.object({
            path: z.string(), text: z.string(), status: z.enum(["stated", "observed", "tentative"]).optional(),
            sources: z.array(noteSource), fact: noteFact.optional(), expires: z.string().nullable().optional(),
          }),
          messages: z.array(citedMessage),
        }),
        z.object({ kind: z.literal("edit-note"), path: z.string(), text: z.string() }),
        z.object({ kind: z.literal("confirm-note"), path: z.string() }),
        z.object({
          kind: z.literal("archive-note"), path: z.string(),
          reason: z.enum(["superseded", "merged", "duplicate", "expired", "stale", "obsolete", "contradicted", "manual"]),
        }),
        z.object({ kind: z.literal("restore-note"), path: z.string() }),
        z.object({ kind: z.literal("forget-note"), path: z.string() }),
        z.object({ kind: z.literal("remember"), path: z.string(), chatId: z.string(), messageId: z.string(), text: z.string(), at: z.string() }),
        z.object({
          kind: z.literal("save-skill"),
          input: z.object({ name: z.string(), description: z.string(), body: z.string(), task: z.string().nullable().optional() }),
        }),
        z.object({ kind: z.literal("patch-skill"), name: z.string(), body: z.string() }),
        z.object({ kind: z.literal("forget-skill"), name: z.string() }),
      ]);
      const parsed = pendingInput.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "a proposal needs a kind and the change it asks for" });
      try {
        const proposal = stageProposal(notesRoot(m[1]), parsed.data, memoryActorForAuth(auth));
        return json(res, 200, { ok: true, proposal });
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    m = path.match(/^\/api\/bots\/([\w-]+)\/memory\/pending\/([\w-]+)\/(approve|deny)$/);
    if (m && method === "POST") {
      if (!deps.bot(m[1])) return json(res, 404, { error: "no such bot" });
      const blocked = ownerOnly();
      if (blocked) return blocked;
      try {
        const botId = m[1];
        const proposalId = m[2]!;
        if (m[3] === "approve") {
          // The notes save goes through the owner's write path, like every direct write; staging and
          // discarding touch only the queue itself, so they do not.
          const approved = write(botId, () => approveProposal(notesRoot(botId), proposalId));
          return json(res, 200, { ok: true, version: approved.doc.version, proposal: approved.proposal });
        }
        const denied = denyProposal(notesRoot(botId), proposalId);
        return json(res, 200, { ok: true, proposal: denied });
      } catch (error) {
        return replyNotesError(res, error);
      }
    }
    return PASS;
  };
}
