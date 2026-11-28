import { api } from "@/state/store";
import type {
  CompanionActionItem, CompanionNotes, CompanionQuestion, CompanionSummary, MeetingCompanion,
} from "../../shared/meeting-companion.ts";
import type { MeetingLine } from "../../shared/meetings.ts";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

export async function fetchMeetingCompanions(request: Request = api): Promise<{ meetings: CompanionSummary[] }> {
  return request<{ meetings: CompanionSummary[] }>("/api/meetings");
}

export async function fetchMeetingCompanion(id: string, request: Request = api): Promise<{ meeting: MeetingCompanion }> {
  return request<{ meeting: MeetingCompanion }>(`/api/meetings/${id}`);
}

export async function createMeetingCompanion(input: { url: string; title?: string; botId?: string }, request: Request = api): Promise<{ meeting: CompanionSummary }> {
  return request<{ meeting: CompanionSummary }>("/api/meetings", { method: "POST", body: JSON.stringify(input) });
}

export async function deleteMeetingCompanion(id: string, request: Request = api): Promise<{ removed: boolean }> {
  return request<{ removed: boolean }>(`/api/meetings/${id}`, { method: "DELETE" });
}

export async function startMeetingCompanion(id: string, request: Request = api): Promise<{ meeting: CompanionSummary }> {
  return request<{ meeting: CompanionSummary }>(`/api/meetings/${id}/start`, { method: "POST", body: JSON.stringify({ joined: true }) });
}

export async function stopMeetingCompanion(id: string, request: Request = api): Promise<{ meeting: CompanionSummary }> {
  return request<{ meeting: CompanionSummary }>(`/api/meetings/${id}/stop`, { method: "POST" });
}

export async function addCompanionTranscript(id: string, line: { speaker?: string; text: string }, request: Request = api): Promise<{ line: MeetingLine }> {
  return request<{ line: MeetingLine }>(`/api/meetings/${id}/transcript`, { method: "POST", body: JSON.stringify(line) });
}

export async function saveCompanionNotes(id: string, notes: CompanionNotes, request: Request = api): Promise<{ meeting: CompanionSummary }> {
  return request<{ meeting: CompanionSummary }>(`/api/meetings/${id}/notes`, { method: "POST", body: JSON.stringify(notes) });
}

export async function askCompanionQuestion(id: string, input: { text: string; from?: string }, request: Request = api): Promise<{ question: CompanionQuestion }> {
  return request<{ question: CompanionQuestion }>(`/api/meetings/${id}/questions`, { method: "POST", body: JSON.stringify(input) });
}

export async function answerCompanionQuestion(id: string, questionId: string, text: string, request: Request = api): Promise<{ question: CompanionQuestion }> {
  return request<{ question: CompanionQuestion }>(`/api/meetings/${id}/questions/${questionId}/answer`, { method: "POST", body: JSON.stringify({ text }) });
}

export async function setCompanionArtifacts(id: string, artifacts: { docTitle?: string; whiteboardTitle?: string }, request: Request = api): Promise<{ meeting: CompanionSummary }> {
  return request<{ meeting: CompanionSummary }>(`/api/meetings/${id}/artifacts`, { method: "POST", body: JSON.stringify(artifacts) });
}

export async function fetchCompanionNotesText(id: string, request: Request = api): Promise<{ text: string; openQuestions: string[] }> {
  return request<{ text: string; openQuestions: string[] }>(`/api/meetings/${id}/notes-text`);
}

export type { CompanionActionItem, CompanionNotes, CompanionQuestion, CompanionSummary, MeetingCompanion };
