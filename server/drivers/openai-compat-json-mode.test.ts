import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Serves `reply` as the streamed assistant text, records what each chat asked for. */
function server(reply: string) {
  const chats: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/models")) return json({ data: [] });
    if (path.endsWith("/chat/completions")) {
      chats.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return json({ error: "not found" }, 404);
  }));
  return chats;
}

async function turn(model: string, reply: string, jsonMode: boolean) {
  const chats = server(reply);
  const instance = await OpenAICompatDriver.create({
    instanceId: randomUUID(), displayName: undefined, enabled: true,
    config: OpenAICompatDriver.decodeConfig({ apiKeyEnv: "SANREMES_FIXTURE_KEY", url: "https://llm.example.test/v1", model }),
    environment: { SANREMES_FIXTURE_KEY: "fixture-key" },
  });
  const recorder = recordEvents(instance.adapter);
  const threadId = randomUUID();
  try {
    await instance.adapter.sendTurn({ threadId, text: "hi", model, jsonMode } as SendTurnInput);
    const completed = await recorder.until((event) => event.type === "turn.completed" && event.threadId === threadId);
    return { chats, completed, events: recorder.events };
  } finally {
    recorder.stop();
    await instance.dispose();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("JSON mode on an OpenAI-compatible driver", () => {
  it("asks for a JSON object and shows a JSON reply", async () => {
    const { chats, completed, events } = await turn("plain-model", '{"answer": 42}', true);
    expect(completed).toMatchObject({ ok: true });
    expect(chats[0]).toHaveProperty("response_format", { type: "json_object" });
    expect(events.filter((event): event is Extract<RuntimeEvent, { type: "content.delta" }> => event.type === "content.delta" && event.streamKind === "assistant_text")
      .map((event) => event.delta).join("")).toBe('{"answer": 42}');
    const completedText = events.find((event) => event.type === "item.completed" && event.itemType === "assistant_text");
    expect(completedText).toBeDefined();
    expect((completedText as any).text).toBe('{"answer": 42}');
  });

  it("fails a non-JSON reply in plain words, without showing it", async () => {
    const { chats, completed, events } = await turn("plain-model", "Here is your answer in words.", true);
    expect(completed).toMatchObject({ ok: false });
    expect(chats[0]).toHaveProperty("response_format", { type: "json_object" });
    expect(events.filter((event) => event.type === "content.delta" && event.streamKind === "assistant_text")).toHaveLength(0);
    const error = events.find((event) => event.type === "runtime.error");
    expect(error).toBeDefined();
    expect((error as any).message).toBe("The model didn't reply in JSON, so nothing was shown. Turn JSON mode off or try again.");
    expect(events.find((event) => event.type === "item.completed" && event.itemType === "assistant_text")).toBeUndefined();
  });

  it("leaves JSON mode off by default", async () => {
    const { chats, completed } = await turn("plain-model", "Here is your answer in words.", false);
    expect(completed).toMatchObject({ ok: true });
    expect(chats[0]).not.toHaveProperty("response_format");
  });
});
