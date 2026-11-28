// Meeting companion over HTTP: the owner starts one from a Google Meet link they
// join themselves, adds the transcript lines the browser can see, keeps structured
// notes and the questions asked in the call, and names the live Doc or Whiteboard.
import { z } from "zod";

import type { RequestAuth } from "../request-auth.ts";
import { companionNotesText, companionSummary, CompanionError, MeetingCompanionStore, openQuestionsFromTranscript } from "../meetings/companion.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface MeetingCompanionRouteDeps {
  store: MeetingCompanionStore;
  isOwner(auth: RequestAuth): boolean;
  botExists?(id: string): boolean;
}

const createBody = z.object({
  url: z.string().min(1).max(2_000),
  title: z.string().max(120).optional(),
  botId: z.string().min(1).max(128).optional(),
}).strict();
const startBody = z.object({ joined: z.boolean() }).strict();
const transcriptBody = z.object({
  speaker: z.string().max(80).optional(),
  text: z.string().trim().min(1).max(2_000),
}).strict();
const actionItemBody = z.object({
  owner: z.string().trim().max(80).optional(),
  item: z.string().trim().min(1).max(500),
  due: z.string().trim().max(80).optional(),
}).strict();
const notesBody = z.object({
  summary: z.string().trim().min(1).max(4_000),
  decisions: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  actionItems: z.array(actionItemBody).max(30).optional(),
  openQuestions: z.array(z.string().trim().min(1).max(500)).max(15).optional(),
}).strict();
const questionBody = z.object({
  text: z.string().trim().min(1).max(1_500),
  from: z.string().trim().max(80).optional(),
}).strict();
const answerBody = z.object({ text: z.string().trim().min(1).max(2_000) }).strict();
const artifactsBody = z.object({
  docTitle: z.string().trim().max(120).optional(),
  whiteboardTitle: z.string().trim().max(120).optional(),
}).strict();
const MEETING_PATH = /^\/api\/meetings\/([\w-]{1,128})(\/start|\/stop|\/transcript|\/notes|\/notes-text|\/questions|\/artifacts)?$/u;
const ANSWER_PATH = /^\/api\/meetings\/([\w-]{1,128})\/questions\/([\w-]{1,128})\/answer$/u;

const isJson = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
  String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";

export function createMeetingCompanionRoutes(deps: MeetingCompanionRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (!path.startsWith("/api/meetings")) return PASS;
    if (!deps.isOwner(auth)) return json(res, 403, { error: "Only the owner can use the meeting companion." });
    if (path === "/api/meetings") {
      if (method === "GET") return json(res, 200, { meetings: deps.store.list() });
      if (method !== "POST") return json(res, 405, { error: "Use GET or POST." });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = createBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send the Google Meet link for the meeting you are joining." });
      if (parsed.data.botId && deps.botExists && !deps.botExists(parsed.data.botId)) return json(res, 404, { error: "No such bot." });
      try {
        const meeting = deps.store.create(parsed.data);
        return json(res, 201, { meeting: companionSummary(meeting) });
      } catch (error) {
        if (error instanceof CompanionError) return json(res, 400, { error: error.message });
        throw error;
      }
    }
    const answer = ANSWER_PATH.exec(path);
    if (answer && method === "POST") {
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = answerBody.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send the answer." });
      try {
        return json(res, 200, { question: deps.store.answer(answer[1]!, answer[2]!, parsed.data.text) });
      } catch (error) {
        if (error instanceof CompanionError) return json(res, 404, { error: error.message });
        throw error;
      }
    }
    const single = MEETING_PATH.exec(path);
    if (!single) return PASS;
    const id = single[1]!;
    const action = single[2];
    try {
      if (method === "GET" && action === undefined) return json(res, 200, { meeting: deps.store.get(id) });
      if (method === "GET" && action === "/notes-text") {
        const meeting = deps.store.get(id);
        return json(res, 200, { text: companionNotesText(meeting), openQuestions: openQuestionsFromTranscript(meeting.transcript) });
      }
      if (method === "DELETE" && action === undefined) {
        deps.store.remove(id);
        return json(res, 200, { removed: true });
      }
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (action === "/stop") return json(res, 200, { meeting: companionSummary(deps.store.stop(id)) });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      if (action === "/start") {
        const parsed = startBody.safeParse(await readBody(req, 64_000));
        if (!parsed.success) return json(res, 400, { error: "Confirm you joined the meeting yourself: joined must be true or false." });
        if (!parsed.data.joined) return json(res, 400, { error: "Join the meeting yourself first, then start the companion." });
        return json(res, 200, { meeting: companionSummary(deps.store.start(id)) });
      }
      if (action === "/transcript") {
        const parsed = transcriptBody.safeParse(await readBody(req, 64_000));
        if (!parsed.success) return json(res, 400, { error: "Send the words that were said." });
        return json(res, 201, { line: deps.store.addTranscript(id, parsed.data) });
      }
      if (action === "/notes") {
        const parsed = notesBody.safeParse(await readBody(req, 64_000));
        if (!parsed.success) return json(res, 400, { error: "Send a summary, decisions, action items and open questions." });
        const meeting = deps.store.setNotes(id, {
          summary: parsed.data.summary,
          decisions: parsed.data.decisions ?? [],
          actionItems: parsed.data.actionItems ?? [],
          openQuestions: parsed.data.openQuestions ?? [],
        });
        return json(res, 200, { meeting: companionSummary(meeting) });
      }
      if (action === "/questions") {
        const parsed = questionBody.safeParse(await readBody(req, 64_000));
        if (!parsed.success) return json(res, 400, { error: "Send the question that was asked." });
        return json(res, 201, { question: deps.store.ask(id, parsed.data) });
      }
      if (action === "/artifacts") {
        const parsed = artifactsBody.safeParse(await readBody(req, 64_000));
        if (!parsed.success) return json(res, 400, { error: "Name the Doc or the Whiteboard the notes are going into." });
        return json(res, 200, { meeting: companionSummary(deps.store.setArtifacts(id, parsed.data)) });
      }
      return json(res, 405, { error: "method not allowed" });
    } catch (error) {
      if (error instanceof CompanionError) {
        const status = error.message.startsWith("There is no ") ? 404 : 409;
        return json(res, status, { error: error.message });
      }
      throw error;
    }
  };
}
