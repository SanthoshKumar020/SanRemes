// Duet's attention list: what needs the person, composed from the reads the
// server already makes. Pure: no store, no network, no sends. An offer names
// the exact intended action up front; the action kinds are the whole set Duet
// may offer, and there is no send, message or payment kind in it at all.
import type { CalendarEvent, EmailHeader } from "../connected-reads.ts";
import type { RoutineRun } from "../routines.ts";
import type { NeedsYouItem } from "../../shared/today.ts";

export type DuetItemKind = "email" | "decision" | "task" | "meeting" | "needs-you";
export type DuetActionKind = "draft" | "rerun" | "open";

export interface DuetActionOffer {
  id: string;
  itemId: string;
  kind: DuetActionKind;
  label: string;
  exactAction: string;
}

export interface DuetItem {
  id: string;
  kind: DuetItemKind;
  title: string;
  detail: string;
  at: number;
  source: string;
  open?: { botId: string; threadId: string };
  offer?: DuetActionOffer;
  /** The mail behind an email item, so the brief rows need no reparsing. */
  email?: { messageId: string; threadId: string; from: string; subject: string; needsReply: boolean; app?: "gmail" | "outlook"; link?: string };
}

export interface DuetAttentionList {
  composedAt: number;
  items: DuetItem[];
}

export interface DuetEmail {
  header: EmailHeader;
  needsReply: boolean;
  why?: string;
}

export interface DuetComposeInput {
  now: number;
  emails: DuetEmail[];
  routines: RoutineRun[];
  needsYou: NeedsYouItem[];
  meetings?: CalendarEvent[];
}

const MAX_ITEMS = 30;
const rank = (kind: DuetItemKind, needsReply: boolean): number => {
  if (kind === "decision") return 0;
  if (kind === "email") return needsReply ? 1 : 5;
  if (kind === "task") return 2;
  if (kind === "meeting") return 3;
  return 4;
};

const clip = (value: string, max: number): string => {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const senderName = (from: string): string => {
  const match = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/.exec(from);
  return (match?.[1]?.trim() || from).trim() || "Unknown sender";
};

const offerId = (itemId: string): string => `offer:${itemId}`;

function emailItem(email: DuetEmail): DuetItem {
  const { header } = email;
  const app = header.app === "outlook" ? "Outlook" : "Gmail";
  const id = `email:${header.id}`;
  const item: DuetItem = {
    id,
    kind: "email",
    title: `${senderName(header.from)}: ${clip(header.subject || "(no subject)", 80)}`,
    detail: clip(email.why ?? header.preview ?? "", 160) || (email.needsReply ? "Waiting on a reply." : "Marked important."),
    at: header.at,
    source: app,
    email: {
      messageId: header.id,
      threadId: header.threadId,
      from: header.from,
      subject: header.subject,
      needsReply: email.needsReply,
      ...(header.app ? { app: header.app } : {}),
      ...(header.link ? { link: header.link } : {}),
    },
  };
  if (email.needsReply) {
    item.offer = {
      id: offerId(id),
      itemId: id,
      kind: "draft",
      label: `Draft a reply to ${senderName(header.from)}`,
      exactAction: `Draft a ${app} reply in thread ${header.threadId} to ${header.from} about "${clip(header.subject || "(no subject)", 80)}". The draft is left unsent for the person to send.`,
    };
  }
  return item;
}

function routineItem(run: RoutineRun): DuetItem {
  const id = `routine:${run.id}`;
  const name = clip(run.routineName, 80);
  return {
    id,
    kind: "task",
    title: run.status === "missed" ? `Missed: ${name}` : `Failed: ${name}`,
    detail: clip(run.error ?? run.output ?? "", 160) || "It did not finish.",
    at: run.finishedAt ?? run.createdAt,
    source: "routine",
    ...(run.threadId ? { open: { botId: run.botId, threadId: run.threadId } } : {}),
    offer: {
      id: offerId(id),
      itemId: id,
      kind: "rerun",
      label: `Run ${name} again`,
      exactAction: `Run routine "${name}" again now, as the bot it belongs to.`,
    },
  };
}

function needsYouItem(item: NeedsYouItem): DuetItem | null {
  const at = item.at;
  switch (item.kind) {
    case "question":
      return {
        id: `decision:${item.id}`,
        kind: "decision",
        title: "A bot asked a question",
        detail: clip(item.text, 160),
        at,
        source: "bot",
        open: { botId: item.botId, threadId: item.threadId },
        offer: {
          id: offerId(`decision:${item.id}`),
          itemId: `decision:${item.id}`,
          kind: "open",
          label: "Open the question",
          exactAction: `Open the thread where the question was asked, so the person can answer it there.`,
        },
      };
    case "message":
      return {
        id: `decision:${item.id}`,
        kind: "decision",
        title: `${item.from} sent a message for you`,
        detail: clip(item.text, 160),
        at,
        source: "message",
        open: { botId: item.botId, threadId: item.threadId },
        offer: {
          id: offerId(`decision:${item.id}`),
          itemId: `decision:${item.id}`,
          kind: "open",
          label: "Open the message",
          exactAction: `Open the thread with ${item.from}, so the person can read and answer it there.`,
        },
      };
    case "signed-out":
      return { id: `needs-you:${item.id}`, kind: "needs-you", title: "An AI signed out", detail: "Sign in again to keep that bot working.", at, source: "engine" };
    case "usage-limit":
      return { id: `needs-you:${item.id}`, kind: "needs-you", title: "A usage limit was hit", detail: clip(item.text, 160), at, source: "engine" };
    case "out-of-credit":
      return { id: `needs-you:${item.id}`, kind: "needs-you", title: "Trial credit ran out", detail: "Top up the account to keep going.", at, source: "engine" };
    case "connection":
      return { id: `needs-you:${item.id}`, kind: "needs-you", title: `${item.app} needs reconnecting`, detail: clip(item.text, 160), at, source: item.app };
    case "place":
      return { id: `needs-you:${item.id}`, kind: "needs-you", title: "A place could not be reached", detail: "Choose another place.", at, source: "place" };
  }
}

function meetingItem(event: CalendarEvent): DuetItem {
  return {
    id: `meeting:${event.id}`,
    kind: "meeting",
    title: clip(event.title, 80),
    detail: event.location ? clip(event.location, 160) : "Upcoming today.",
    at: event.start,
    source: "calendar",
  };
}

export function composeAttention(input: DuetComposeInput): DuetAttentionList {
  const items: Array<{ item: DuetItem; order: number }> = [];
  for (const email of input.emails) {
    const item = emailItem(email);
    items.push({ item, order: rank("email", email.needsReply) });
  }
  for (const run of input.routines) {
    if (run.status !== "failed" && run.status !== "missed") continue;
    if (run.report?.state === "quiet") continue;
    items.push({ item: routineItem(run), order: rank("task", false) });
  }
  for (const need of input.needsYou) {
    const item = needsYouItem(need);
    if (item) items.push({ item, order: rank(item.kind, false) });
  }
  for (const event of input.meetings ?? []) {
    if (event.status === "cancelled" || event.selfDeclined || event.end <= input.now) continue;
    items.push({ item: meetingItem(event), order: rank("meeting", false) });
  }
  items.sort((a, b) => a.order - b.order || b.item.at - a.item.at);
  const seen = new Set<string>();
  const unique = items.filter(({ item }) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
  return { composedAt: input.now, items: unique.slice(0, MAX_ITEMS).map(({ item }) => item) };
}
