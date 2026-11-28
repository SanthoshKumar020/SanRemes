// The attention list as brief rows: Duet feeds the brief system without
// editing it, by producing the same row shapes the brief card builder takes.
import { briefCard, type BriefEmail, type BriefFacts, type BriefMeeting, type BriefRow, type BuiltCard, type NeedRow } from "../host/brief-cards.ts";
import type { DuetAttentionList, DuetItem } from "./attention.ts";

const clip = (value: string, max: number): string => {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

export interface DuetBriefRows {
  needs: NeedRow[];
  emails: BriefEmail[];
  routines: BriefRow[];
  meetings: BriefMeeting[];
}

export function duetBriefRows(list: DuetAttentionList): DuetBriefRows {
  const needs: NeedRow[] = [];
  const emails: BriefEmail[] = [];
  const routines: BriefRow[] = [];
  const meetings: BriefMeeting[] = [];
  for (const item of list.items) {
    if (item.kind === "email" && item.email) {
      emails.push({
        messageId: item.email.messageId,
        threadId: item.email.threadId,
        from: item.email.from,
        subject: item.email.subject,
        needsReply: item.email.needsReply,
        ...(item.email.app ? { app: item.email.app } : {}),
        ...(item.email.link ? { link: item.email.link } : {}),
        ...(item.detail ? { why: item.detail } : {}),
      });
      continue;
    }
    if (item.kind === "decision" || item.kind === "needs-you") {
      needs.push({
        key: `duet:${item.id}`,
        text: item.title,
        note: clip(item.detail, 140),
        ...(item.open ? { open: item.open } : {}),
      });
      continue;
    }
    if (item.kind === "task") {
      needs.push({
        key: `duet:${item.id}`,
        text: item.title,
        note: clip(item.detail, 140),
        ...(item.open ? { open: item.open } : {}),
      });
      continue;
    }
    meetings.push({ title: item.title, start: item.at });
  }
  return { needs, emails, routines, meetings };
}

export interface DuetBriefBase {
  now: number;
  timeZone?: string;
  language?: string;
  intro?: boolean;
  overnight?: string;
}

export function duetBriefFacts(list: DuetAttentionList, base: DuetBriefBase): BriefFacts {
  const rows = duetBriefRows(list);
  return {
    now: base.now,
    ...(base.timeZone ? { timeZone: base.timeZone } : {}),
    ...(base.language ? { language: base.language } : {}),
    intro: base.intro ?? false,
    ...(base.overnight ? { overnight: base.overnight } : {}),
    needs: rows.needs,
    meetings: rows.meetings,
    emails: rows.emails,
    routines: rows.routines,
  };
}

/** The attention list rendered as a brief card, through the brief's own builder. */
export function duetBriefCard(list: DuetAttentionList, base: DuetBriefBase): BuiltCard {
  return briefCard(duetBriefFacts(list, base));
}

export type { DuetItem };
