import { describe, expect, it, vi } from "vitest";
import { MaskedDelta } from "./masked-delta.ts";

describe("MaskedDelta", () => {
  it("passes clean text through, masks whole secrets inline", () => {
    const emit = vi.fn();
    const masked = new MaskedDelta(["s3cr3t"], emit);
    masked.send("hello ", "assistant_text");
    masked.send("the s3cr3t is out", "assistant_text");
    expect(emit).toHaveBeenCalledWith("hello ", "assistant_text");
    expect(emit).toHaveBeenCalledWith("the [redacted] is out", "assistant_text");
  });

  it("holds a suffix that could be a secret's prefix, and releases it on flush", () => {
    const emit = vi.fn();
    const masked = new MaskedDelta(["s3cr3t"], emit);
    masked.send("abc s3c", "assistant_text");
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("abc ", "assistant_text");
    masked.send("r3t done", "assistant_text");
    expect(emit).toHaveBeenLastCalledWith("[redacted] done", "assistant_text");
    masked.send("tail s3", "assistant_text");
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit).toHaveBeenLastCalledWith("tail ", "assistant_text");
    masked.send("", "assistant_text", true);
    expect(emit).toHaveBeenCalledTimes(4);
    expect(emit).toHaveBeenLastCalledWith("s3", "assistant_text");
  });

  it("keeps assistant and reasoning text on separate holds", () => {
    const emit = vi.fn();
    const masked = new MaskedDelta(["key"], emit);
    masked.send("a ke", "assistant_text");
    masked.send("b ke", "reasoning_text");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith("a ", "assistant_text");
    expect(emit).toHaveBeenCalledWith("b ", "reasoning_text");
  });
});
