/** The Chat Completions request for JSON mode, and the check a JSON-mode reply must pass before it is shown. */

export function jsonModeBody(): Record<string, unknown> {
  return { response_format: { type: "json_object" } };
}

export function turnJsonMode(turn: { jsonMode?: boolean }): boolean {
  return turn.jsonMode === true;
}

export type DeltaKind = "assistant_text" | "reasoning_text";

/** Holds a JSON-mode reply's assistant text until the round's reply parses, then releases it. */
export class JsonTextSink {
  private held = "";
  private readonly active: boolean;

  constructor(active: boolean) {
    this.active = active;
  }

  get enabled(): boolean {
    return this.active;
  }

  show(text: string, kind: DeltaKind, emit: (text: string, kind: DeltaKind) => void): void {
    if (this.active && kind === "assistant_text") this.held += text;
    else emit(text, kind);
  }

  release(emit: (text: string, kind: DeltaKind) => void): void {
    if (this.held) {
      const held = this.held;
      this.held = "";
      emit(held, "assistant_text");
    }
  }
}

const JSON_FENCE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;

export function parseJsonReply(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  const candidates = [trimmed, JSON_FENCE.exec(trimmed)?.[1]?.trim()].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // Try the next shape below.
    }
  }
  return { ok: false, error: "The model didn't reply in JSON, so nothing was shown. Turn JSON mode off or try again." };
}
