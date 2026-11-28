import { describe, expect, it } from "vitest";
import { composeAttention, type DuetComposeInput } from "./attention.ts";
import type { EmailHeader } from "../connected-reads.ts";
import type { RoutineRun } from "../routines.ts";

const now = 1_800_000_000_000;
const header = (over: Partial<EmailHeader> = {}): EmailHeader => ({
  id: "m1", threadId: "t1", at: now - 1000, from: "Ada <ada@example.com>", subject: "Q3 numbers", preview: "Please review", ...over,
});
const run = (over: Partial<RoutineRun> = {}): RoutineRun => ({
  id: "r1", routineId: "rt1", routineName: "Nightly watch", botId: "b1", runOn: "sanremes",
  scheduledFor: now - 2000, status: "failed", manual: false, target: "bot", createdAt: now - 2000, ...over,
} as unknown as RoutineRun);

const input = (over: Partial<DuetComposeInput> = {}): DuetComposeInput => ({
  now,
  emails: [{ header: header(), needsReply: true, why: "Needs your answer" }],
  routines: [run()],
  needsYou: [{ kind: "question", id: "q1", at: now - 500, botId: "b1", threadId: "th1", text: "Which date?" }],
  meetings: [{ id: "e1", title: "Standup", start: now + 3600_000, end: now + 3900_000, allDay: false, status: "confirmed", selfDeclined: false, attendees: [] }],
  ...over,
});

describe("composeAttention", () => {
  it("orders decisions first, then replies, then failed routines, then meetings", () => {
    const list = composeAttention(input());
    expect(list.items.map((item) => item.kind)).toEqual(["decision", "email", "task", "meeting"]);
  });

  it("offers a draft with the exact action for an email waiting on a reply, and sends nothing", () => {
    const list = composeAttention(input());
    const email = list.items.find((item) => item.kind === "email")!;
    expect(email.offer?.kind).toBe("draft");
    expect(email.offer?.exactAction).toContain("Draft a Gmail reply in thread t1");
    expect(email.offer?.exactAction).toContain("left unsent");
  });

  it("never offers a send, message or payment action", () => {
    const list = composeAttention(input({
      needsYou: [
        { kind: "message", id: "m9", at: now, botId: "b1", threadId: "th9", from: "Bob", text: "Hi" },
        { kind: "signed-out", id: "s1", at: now, instanceId: "i1", botIds: ["b1"] },
        { kind: "connection", id: "c1", at: now, app: "gmail", botIds: ["b1"], threadId: "th1", text: "signed out" },
      ],
    }));
    for (const item of list.items) {
      expect(item.offer?.kind === undefined || ["draft", "rerun", "open"].includes(item.offer.kind)).toBe(true);
    }
  });

  it("leaves an important email with no reply needed without an offer", () => {
    const list = composeAttention(input({ emails: [{ header: header(), needsReply: false }] }));
    expect(list.items.find((item) => item.kind === "email")?.offer).toBeUndefined();
  });

  it("skips quiet and finished routine runs, cancelled and past meetings", () => {
    const list = composeAttention(input({
      routines: [
        run({ id: "r2", status: "failed", report: { state: "quiet" } }),
        run({ id: "r3", status: "completed" }),
      ],
      meetings: [
        { id: "e2", title: "Old", start: now - 3600_000, end: now - 1000, allDay: false, status: "confirmed", selfDeclined: false, attendees: [] },
        { id: "e3", title: "Gone", start: now + 3600_000, end: now + 3900_000, allDay: false, status: "cancelled", selfDeclined: false, attendees: [] },
      ],
    }));
    expect(list.items.some((item) => item.kind === "task")).toBe(false);
    expect(list.items.some((item) => item.kind === "meeting")).toBe(false);
  });

  it("caps the list at 30 items", () => {
    const emails = Array.from({ length: 40 }, (_, i) => ({ header: header({ id: `m${i}`, threadId: `t${i}` }), needsReply: false }));
    const list = composeAttention(input({ emails, routines: [], needsYou: [], meetings: [] }));
    expect(list.items).toHaveLength(30);
  });
});
