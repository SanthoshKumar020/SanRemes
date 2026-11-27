import { redactSecretsInText } from "../redact.ts";

/** Masks secrets in streamed text, holding a suffix that could be a secret's prefix. */
export class MaskedDelta {
  private pending = { assistant_text: "", reasoning_text: "" };
  private readonly secrets: readonly string[];
  private readonly emit: (visible: string, kind: "assistant_text" | "reasoning_text") => void;

  constructor(secrets: readonly string[], emit: (visible: string, kind: "assistant_text" | "reasoning_text") => void) {
    this.secrets = secrets;
    this.emit = emit;
  }

  send(text: string, kind: "assistant_text" | "reasoning_text", flush = false): void {
    let combined = this.pending[kind] + text;
    // Mask whole matches before holding a suffix, or "abab" could split at its own repeated prefix.
    for (const secret of this.secrets) if (secret) combined = combined.split(secret).join("[redacted]");
    let hold = 0;
    if (!flush) for (const secret of this.secrets) {
      for (let length = Math.min(secret.length - 1, combined.length); length > hold; length--) {
        if (combined.endsWith(secret.slice(0, length))) { hold = length; break; }
      }
    }
    this.pending[kind] = hold ? combined.slice(-hold) : "";
    const visible = redactSecretsInText(hold ? combined.slice(0, -hold) : combined);
    if (visible) this.emit(visible, kind);
  }
}
