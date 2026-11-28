import { describe, expect, it } from "vitest";
import { approvalRow, inboxView, messageRow, questionRow } from "@/testing/inbox-fixture";
import type { NeedsYouItem } from "../../shared/today";
import type { AttentionThread } from "./SidebarBotActivity";
import { needsYouPageItems } from "./NeedsYouPage";

const fix: NeedsYouItem = { kind: "question", id: "fix-1", at: 100, botId: "eli", threadId: "thread-1", text: "Which page?" };
const attention = (threadId: string, title: string): AttentionThread => ({
  kind: "bot", botId: "eli", botName: "Eli",
  task: { threadId, title } as AttentionThread["task"],
});

describe("needsYouPageItems", () => {
  it("lists the needs-you rows newest first and leaves the other tabs out", () => {
    const { rows } = needsYouPageItems(inboxView([messageRow, questionRow, approvalRow]), [], []);
    expect(rows.map((row) => row.id)).toEqual([approvalRow.id, questionRow.id]);
  });

  it("keeps the fixes and drops an attention conversation the fixes already list", () => {
    const { fixes, attention: kept } = needsYouPageItems(
      inboxView([]),
      [fix],
      [attention("thread-1", "Pricing work"), attention("thread-2", "Launch work")],
    );
    expect(fixes).toEqual([fix]);
    expect(kept.map((entry) => entry.task.threadId)).toEqual(["thread-2"]);
  });

  it("is empty when every list is empty", () => {
    expect(needsYouPageItems(inboxView([]), [], [])).toEqual({ rows: [], fixes: [], attention: [] });
  });
});
