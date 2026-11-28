// Meeting companion: the owner joins a Google Meet themselves and the companion
// keeps the structured notes, the transcript lines visible in the browser, the
// questions asked in the call, and the live Doc or Whiteboard the notes go into.
import type { MeetingLine } from "./meetings.ts";

export type CompanionStatus = "waiting" | "live" | "ended";

export interface CompanionActionItem {
  owner?: string;
  item: string;
  due?: string;
}

export interface CompanionNotes {
  summary: string;
  decisions: string[];
  actionItems: CompanionActionItem[];
  openQuestions: string[];
}

export interface CompanionQuestion {
  id: string;
  from?: string;
  text: string;
  askedAt: number;
  answer?: string;
  answeredAt?: number;
}

export interface CompanionArtifacts {
  docTitle?: string;
  whiteboardTitle?: string;
}

export interface MeetingCompanion {
  id: string;
  title: string;
  url: string;
  botId?: string;
  status: CompanionStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  notes: CompanionNotes;
  transcript: MeetingLine[];
  questions: CompanionQuestion[];
  artifacts: CompanionArtifacts;
}

export type CompanionSummary = Omit<MeetingCompanion, "transcript" | "questions"> & {
  lines: number;
  questions: number;
  unanswered: number;
};

export const COMPANION_NOT_STARTED = "Join the meeting yourself first, then start the companion.";
export const COMPANION_NOT_LIVE = "The companion is not live in a meeting right now.";
export const COMPANION_NOT_MEET = "Only Google Meet links work here. Paste the meet.google.com link for the meeting you are joining.";
