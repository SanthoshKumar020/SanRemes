import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { extractAttachmentText } from "./attachment-text.ts";
import { type OcrEngine } from "./ocr.ts";

const fixtures = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

const fakeEngine = (): OcrEngine => ({
  recognize: async () => ({ text: "HELLO OCR\n", confidence: 90 }),
  close: async () => undefined,
});

describe("extractAttachmentText", () => {
  it("OCRs an image attachment", async () => {
    const result = await extractAttachmentText(fixtures("hello.png"), "image/png", { engine: () => Promise.resolve(fakeEngine()), langPath: "/nonexistent" });
    expect(result).toEqual({ ok: true, text: "HELLO OCR\n", confidence: 90 });
  });

  it("reads a PDF's text layer without OCR", async () => {
    const result = await extractAttachmentText(fixtures("hello.pdf"), "application/pdf");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain("HELLO PDF");
  });

  it("reports a scanned PDF instead of failing: its pages need a rasteriser first", async () => {
    const result = await extractAttachmentText(fixtures("blank.pdf"), "application/pdf");
    expect(result).toEqual({ ok: false, reason: "scanned-pdf" });
  });

  it("refuses an unsupported type and a missing file without throwing", async () => {
    expect(await extractAttachmentText(fixtures("hello.png"), "audio/mpeg")).toEqual({ ok: false, reason: "unsupported-type" });
    expect(await extractAttachmentText("/no/such/file.png", "image/png")).toEqual({ ok: false, reason: "read-failed" });
    expect(readFileSync(fixtures("hello.png")).byteLength).toBeGreaterThan(0);
  });
});
