import { readFileSync } from "node:fs";

import { extractText } from "unpdf";

import { extractImageText, OCR_MAX_CHARS, type OcrOptions, type OcrResult } from "./ocr.ts";

export type AttachmentTextResult = OcrResult | { ok: false; reason: "unsupported-type" | "read-failed" | "scanned-pdf" };

export async function extractAttachmentText(path: string, mime: string, opts: OcrOptions = {}): Promise<AttachmentTextResult> {
  const normalized = mime.split(";")[0]!.trim().toLowerCase();
  try {
    if (normalized.startsWith("image/")) return extractImageText(readFileSync(path), normalized, opts);
    if (normalized === "application/pdf") {
      const parsed = await extractText(new Uint8Array(readFileSync(path)), { mergePages: true });
      const text = parsed.text.trim();
      if (!text) return { ok: false, reason: "scanned-pdf" };
      return { ok: true, text: text.slice(0, OCR_MAX_CHARS), confidence: 100 };
    }
    return { ok: false, reason: "unsupported-type" };
  } catch {
    return { ok: false, reason: "read-failed" };
  }
}
