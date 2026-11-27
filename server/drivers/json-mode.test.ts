import { describe, expect, it, vi } from "vitest";

import { jsonModeBody, JsonTextSink, parseJsonReply, turnJsonMode } from "./json-mode.ts";

describe("JSON mode", () => {
  it("asks for a JSON object", () => {
    expect(jsonModeBody()).toEqual({ response_format: { type: "json_object" } });
  });

  it("is off unless the turn says so", () => {
    expect(turnJsonMode({})).toBe(false);
    expect(turnJsonMode({ jsonMode: false })).toBe(false);
    expect(turnJsonMode({ jsonMode: true })).toBe(true);
  });

  it("parses a plain JSON reply", () => {
    expect(parseJsonReply('{"answer": 42}')).toEqual({ ok: true, value: { answer: 42 } });
    expect(parseJsonReply('\n  [1, 2]\n')).toEqual({ ok: true, value: [1, 2] });
  });

  it("parses a fenced JSON reply", () => {
    expect(parseJsonReply('```json\n{"answer": 42}\n```')).toEqual({ ok: true, value: { answer: 42 } });
    expect(parseJsonReply('```\n{"answer": 42}\n```')).toEqual({ ok: true, value: { answer: 42 } });
  });

  it("refuses a non-JSON reply in plain words", () => {
    const refused = parseJsonReply("Here is your answer in words.");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toBe("The model didn't reply in JSON, so nothing was shown. Turn JSON mode off or try again.");
    }
    expect(parseJsonReply("").ok).toBe(false);
    expect(parseJsonReply('{"answer": }').ok).toBe(false);
    expect(parseJsonReply("```json\nnot json\n```").ok).toBe(false);
  });
});

describe("JsonTextSink", () => {
  it("holds assistant text until release, passes reasoning text through", () => {
    const emit = vi.fn();
    const sink = new JsonTextSink(true);
    expect(sink.enabled).toBe(true);
    sink.show('{"a": 1}', "assistant_text", emit);
    sink.show("thinking", "reasoning_text", emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("thinking", "reasoning_text");
    sink.release(emit);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('{"a": 1}', "assistant_text");
    sink.release(emit);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("passes everything through when off", () => {
    const emit = vi.fn();
    const sink = new JsonTextSink(false);
    expect(sink.enabled).toBe(false);
    sink.show("hello", "assistant_text", emit);
    expect(emit).toHaveBeenCalledWith("hello", "assistant_text");
    sink.release(emit);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
