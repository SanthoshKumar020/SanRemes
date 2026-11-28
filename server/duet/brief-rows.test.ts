import { describe, expect, it } from "vitest";
import { composeAttention } from "./attention.ts";
import { duetBriefCard, duetBriefFacts, duetBriefRows } from "./brief-rows.ts";

const now = 1_800_000_000_000;
const list = composeAttention({
  now,
  emails: [{
    header: { id: "m1", threadId: "t1", at: now - 1000, from: "Ada <ada@example.com>", subject: "Q3 numbers", preview: "Please review", app: "gmail" },
    needsReply: true, why: "Needs your answer",
  }],
  routines: [],
  needsYou: [{ kind: "question", id: "q1", at: now - 500, botId: "b1", threadId: "th1", text: "Which date?" }],
  meetings: [{ id: "e1", title: "Standup", start: now + 3600_000, end: now + 3900_000, allDay: false, status: "confirmed", selfDeclined: false, attendees: [] }],
});

describe("duetBriefRows", () => {
  it("maps the email to a brief email row with its own ids and app", () => {
    const rows = duetBriefRows(list);
    expect(rows.emails).toEqual([{
      messageId: "m1", threadId: "t1", from: "Ada <ada@example.com>", subject: "Q3 numbers",
      needsReply: true, app: "gmail", why: "Needs your answer",
    }]);
  });

  it("maps a decision to a need row keyed by its duet id with its open target", () => {
    const rows = duetBriefRows(list);
    expect(rows.needs).toEqual([{
      key: "duet:decision:q1", text: "A bot asked a question", note: "Which date?",
      open: { botId: "b1", threadId: "th1" },
    }]);
  });

  it("maps a meeting to a brief meeting", () => {
    expect(duetBriefRows(list).meetings).toEqual([{ title: "Standup", start: now + 3600_000 }]);
  });

  it("builds brief facts and a card through the brief's own builder", () => {
    const facts = duetBriefFacts(list, { now });
    expect(facts.emails).toHaveLength(1);
    expect(facts.needs).toHaveLength(1);
    const card = duetBriefCard(list, { now });
    expect(card.card.type).toBe("Card");
    expect(card.summary.length).toBeGreaterThan(0);
    expect(JSON.stringify(card.card)).toContain("Q3 numbers");
  });
});
