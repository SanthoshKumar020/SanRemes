import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PendingProposal, StructuredNotesDoc } from "@/lib/memory";
import { StructuredNotesCard } from "./StructuredNotesCard";

// renderToStaticMarkup HTML-escapes quotes and apostrophes; decode before comparing against plain-text fixtures.
function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(element).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}

const now = new Date().toISOString();

const doc: StructuredNotesDoc = {
  version: 3,
  notes: [{
    path: "preferences/short-replies",
    area: "preferences",
    text: "Prefers short replies",
    status: "tentative",
    updated: now,
    edited: null,
    expires: null,
    sources: [{ chatId: "c1", messageId: "m1", quote: "I prefer short replies", at: now }],
  }],
  archive: [{
    path: "about/old-diet",
    area: "about",
    text: "Used to eat meat",
    reason: "obsolete",
    by: null,
    archived: now,
    sources: [],
  }],
  skills: [{
    name: "weekly-report",
    description: "Builds the weekly report.",
    body: "1. Open the sheet.",
    learned: now,
    updated: now,
    edited: now,
    task: "weekly report",
  }],
};

const pending: PendingProposal[] = [{
  id: "p1",
  kind: "add-note",
  proposedBy: "agent",
  baseVersion: 3,
  createdAt: now,
  input: {
    path: "about/diet",
    text: "Is vegetarian",
    sources: [{ chatId: "c1", messageId: "m2", quote: "I am vegetarian", at: now }],
  },
  messages: [{ id: "m2", text: "I am vegetarian" }],
}];

describe("StructuredNotesCard", () => {
  it("says Loading… until the notes and the queue arrive", () => {
    const markup = render(createElement(StructuredNotesCard, { doc: null, pending: null, busy: false, onAction: vi.fn() }));
    expect(markup).toContain("Structured notes");
    expect(markup).toContain("Loading…");
    expect(markup).not.toContain("Waiting for your review");
  });

  it("shows a pending proposal with its summary and Approve/Discard", () => {
    const markup = render(createElement(StructuredNotesCard, { doc, pending, busy: false, onAction: vi.fn() }));
    expect(markup).toContain("Waiting for your review");
    expect(markup).toContain("Add note about/diet: “Is vegetarian”");
    expect(markup).toContain("suggested by the bot");
    expect(markup).toContain(">Approve<");
    expect(markup).toContain(">Discard<");
  });

  it("lists notes with status and sources, archived notes with Restore, and skills with the owner-edited mark", () => {
    const markup = render(createElement(StructuredNotesCard, { doc, pending: [], busy: false, onAction: vi.fn() }));
    expect(markup).toContain("preferences/short-replies");
    expect(markup).toContain("Prefers short replies");
    expect(markup).toContain("tentative");
    expect(markup).toContain("1 source");
    expect(markup).toContain(">Confirm<");
    expect(markup).toContain(">Edit<");
    expect(markup).toContain(">Archive<");
    expect(markup).toContain(">Forget<");
    expect(markup).toContain("Used to eat meat");
    expect(markup).toContain(">Restore<");
    expect(markup).toContain("weekly-report");
    expect(markup).toContain("Builds the weekly report.");
    expect(markup).toContain("Edited by you");
    expect(markup).toContain("Tidy structured notes");
  });

  it("says None yet in the empty states", () => {
    const empty: StructuredNotesDoc = { version: 0, notes: [], archive: [], skills: [] };
    const markup = render(createElement(StructuredNotesCard, { doc: empty, pending: [], busy: false, onAction: vi.fn() }));
    expect(markup).toContain("No structured notes yet.");
    expect(markup).toContain("No learned skills yet.");
    expect(markup).not.toContain("Archived notes");
  });
});
