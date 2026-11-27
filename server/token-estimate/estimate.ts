// A local token estimate for the message about to be sent, plus the thread
// context sent with it. Pure string counting: no network call, no model,
// no dependency. Calibrated to a cl100k-style byte-pair tokenizer; other
// tokenizers split words differently, so every figure it returns is an
// estimate and the composer labels it as one.
export type TokenModelFamily = "claude" | "gpt" | "other";

/** The tokenizer family a model id belongs to, for the per-model note. */
export function modelFamilyOf(model: string | undefined): TokenModelFamily {
  const id = (model ?? "").toLowerCase();
  if (id.includes("claude")) return "claude";
  if (id.includes("gpt") || id.includes("openai") || id.includes("chatgpt")) return "gpt";
  return "other";
}

/** How far the estimate can be trusted for this model, in plain words. */
export function tokenEstimateNote(model?: string): string {
  switch (modelFamilyOf(model)) {
    case "claude":
      return "Estimated for Claude. Claude splits some words differently from other models, so the provider's count can differ a little.";
    case "gpt":
      return "Estimated for a GPT-style tokenizer. The provider's count can differ a little.";
    default:
      return "Estimated. The provider's count can differ, and different models split words differently.";
  }
}

const WORD = /[\p{L}\p{M}]+(?:'(?:s|t|re|ve|ll|d|m))?/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const DIGITS = /\p{Nd}+/u;
const NEWLINES = /\n+/u;
const CAMEL_BOUNDARY = /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\p{Nd})|(?<=\p{Nd})(?=[A-Za-z])/u;
const CONTRACTION = /'(?:s|t|re|ve|ll|d|m)$/u;

/** A word's pieces, split where a tokenizer would: camelCase humps and letter/digit joins. */
function wordPieces(word: string): string[] {
  return word.split(CAMEL_BOUNDARY);
}

/** One piece's tokens: short words are one token; longer ones add about one token per five letters. */
function pieceTokens(piece: string): number {
  const length = [...piece].length;
  return Math.max(1, Math.round(length / 5));
}

function segmentTokens(segment: string): number {
  if (NEWLINES.test(segment)) return 1;
  if (CJK.test(segment)) return 1;
  if (PICTOGRAPHIC.test(segment)) return 2;
  if (DIGITS.test(segment)) return Math.ceil([...segment].length / 3);
  if (WORD.test(segment)) {
    const contraction = CONTRACTION.test(segment) ? 1 : 0;
    const base = segment.replace(CONTRACTION, "");
    return wordPieces(base).reduce((sum, piece) => sum + pieceTokens(piece), 0) + contraction;
  }
  if (/^\s+$/.test(segment)) return 0;
  if (segment === "\uFE0F" || segment === "\u200D") return 0;
  return 1;
}

const SEGMENTS = new RegExp(
  [NEWLINES.source, CJK.source, PICTOGRAPHIC.source, WORD.source, DIGITS.source, ".", ].join("|"),
  "gsu",
);

/** The estimated token count of `text`. Empty text is 0; spaces on their own are 0. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const match of text.matchAll(SEGMENTS)) total += segmentTokens(match[0]);
  return total;
}

export interface TokenEstimate {
  draftTokens: number;
  contextTokens: number;
  totalTokens: number;
  modelFamily: TokenModelFamily;
}

const sumTokens = (texts: readonly string[] | undefined): number =>
  (texts ?? []).reduce((sum, text) => sum + estimateTokens(text), 0);

/** The draft, its pasted attachments and the thread context, estimated separately and totalled. */
export function estimateSendTokens(input: {
  draft: string;
  context?: readonly string[];
  attachments?: readonly string[];
  model?: string;
}): TokenEstimate {
  const draftTokens = estimateTokens(input.draft) + sumTokens(input.attachments);
  const contextTokens = sumTokens(input.context);
  return { draftTokens, contextTokens, totalTokens: draftTokens + contextTokens, modelFamily: modelFamilyOf(input.model) };
}
