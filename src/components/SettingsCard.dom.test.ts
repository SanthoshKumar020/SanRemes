// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {} }, dispatch: () => {} }), api: async () => ({}) }));

const { RichMessageRow, richRowKind } = await import("./RichMessageRow");

const TEXT = "Your other computers: this is turned on in SanRemes on the computer itself, in Settings → Devices, with the switch on the Private network row.";
const message = { id: "m1", role: "bot", kind: "text", text: TEXT, settingsCard: { id: "ai-sign-in" } } as unknown as Message;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

async function show(row: Message = message) {
  flushSync(() => root.render(createElement(RichMessageRow, { botId: "kiwi", botName: "Kiwi", threadId: "t-kiwi", message: row })));
  await vi.waitFor(() => expect(host.querySelector("[data-settings-card], p")).not.toBeNull());
  return host;
}

describe("a settings card in chat", () => {
  it("is drawn as a card row, not as the bot's text", () => {
    expect(richRowKind(message)).toBe("widget");
  });

  it("falls back to the row's own words for a card this version does not know", async () => {
    const chat = await show({ ...message, settingsCard: { id: "phone-pairing" } } as unknown as Message);
    expect(chat.textContent).toBe(TEXT);
    expect(chat.querySelector('[role="switch"]')).toBeNull();
  });
});
