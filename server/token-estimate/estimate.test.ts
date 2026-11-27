import { describe, expect, it } from "vitest";
import { estimateSendTokens, estimateTokens, modelFamilyOf, tokenEstimateNote } from "./estimate.ts";

// Reference counts are hand-counted cl100k-style tokenizations: one token
// per short word, punctuation on its own, three digits per token.
const EXACT: Array<[string, number]> = [
  ["", 0],
  ["Hello world", 2],
  ["The quick brown fox jumps over the lazy dog", 9],
  ["Hello, world!", 4],
  ["I love programming.", 5],
  ["123456789", 3],
  ["1234", 2],
  ["one two three four five", 5],
  ["a", 1],
  ["I", 1],
  ["你好世界", 4],
  ["don't stop", 3],
  ["2026", 2],
  ["hello\n\nworld", 3],
  ["   ", 0],
  ["👋", 2],
  ["understanding", 3],
  ["computer", 2],
];

describe("estimateTokens", () => {
  it.each(EXACT)("counts %j as %d tokens", (text, expected) => {
    expect(estimateTokens(text)).toBe(expected);
  });

  it("stays within one token on sentences with a long common word", () => {
    expect(estimateTokens("To be, or not to be, that is the question.")).toBeGreaterThanOrEqual(13);
    expect(estimateTokens("To be, or not to be, that is the question.")).toBeLessThanOrEqual(14);
    expect(estimateTokens("function add(a, b) { return a + b; }")).toBeGreaterThanOrEqual(14);
    expect(estimateTokens("function add(a, b) { return a + b; }")).toBeLessThanOrEqual(15);
  });

  it("stays within a fifth on a long word", () => {
    expect(estimateTokens("internationalization")).toBeGreaterThanOrEqual(4);
    expect(estimateTokens("internationalization")).toBeLessThanOrEqual(6);
  });

  it("stays within a quarter on prose paragraphs", () => {
    const paragraphs: Array<[string, number]> = [
      [
        "Data engineers build the pipelines that move information from raw sources into warehouses where analysts can query it. A good pipeline is reliable first and fast second: it retries transient failures, quarantines bad rows instead of dropping them silently, and leaves a clear record of what ran, when, and what changed.",
        74,
      ],
      [
        "The committee announced on Tuesday that interest rates would remain unchanged, citing cooling inflation and a labour market that, while still tight, no longer threatens to overheat the broader economy.",
        42,
      ],
    ];
    for (const [text, reference] of paragraphs) {
      const got = estimateTokens(text);
      expect(got).toBeGreaterThanOrEqual(Math.floor(reference * 0.75));
      expect(got).toBeLessThanOrEqual(Math.ceil(reference * 1.25));
    }
  });

  it("counts camelCase humps and digits separately", () => {
    expect(estimateTokens("myVariableName")).toBeGreaterThanOrEqual(3);
    expect(estimateTokens("myVariableName")).toBeLessThanOrEqual(4);
    expect(estimateTokens("abc123")).toBe(2);
  });
});

describe("estimateSendTokens", () => {
  it("splits the draft from the thread context and totals both", () => {
    const estimate = estimateSendTokens({
      draft: "Hello world",
      context: ["The quick brown fox jumps over the lazy dog"],
      model: "claude-sonnet-5",
    });
    expect(estimate).toEqual({ draftTokens: 2, contextTokens: 9, totalTokens: 11, modelFamily: "claude" });
  });

  it("counts pasted attachments as draft tokens", () => {
    const estimate = estimateSendTokens({ draft: "Hello world", attachments: ["one two three"] });
    expect(estimate.draftTokens).toBe(5);
    expect(estimate.totalTokens).toBe(5);
  });

  it("is zero with no draft, context or attachments", () => {
    expect(estimateSendTokens({ draft: "" })).toEqual({
      draftTokens: 0,
      contextTokens: 0,
      totalTokens: 0,
      modelFamily: "other",
    });
  });
});

describe("modelFamilyOf", () => {
  it.each([
    ["claude-sonnet-5", "claude"],
    ["claude-opus-4-1", "claude"],
    ["gpt-5", "gpt"],
    ["openai/gpt-oss-120b", "gpt"],
    ["llama-3.1-8b", "other"],
    [undefined, "other"],
  ] as const)("maps %j to %s", (model, family) => {
    expect(modelFamilyOf(model)).toBe(family);
  });
});

describe("tokenEstimateNote", () => {
  it("says estimated for every family, and names Claude's splitter for Claude", () => {
    for (const model of ["claude-sonnet-5", "gpt-5", "llama-3.1-8b", undefined]) {
      expect(tokenEstimateNote(model)).toMatch(/Estimated/);
    }
    expect(tokenEstimateNote("claude-sonnet-5")).toMatch(/Claude/);
  });
});
