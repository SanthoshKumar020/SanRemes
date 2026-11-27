import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { extractImageText, resolveOcrLangPath, type OcrEngine } from "./ocr.ts";

const FIXTURE = new URL("./fixtures/hello.png", import.meta.url);

const fakeEngine = (text: string): OcrEngine => ({
  recognize: async () => ({ text, confidence: 90 }),
  close: async () => undefined,
});

describe("extractImageText", () => {
  it("reads text from the fixture image through the engine", async () => {
    const image = readFileSync(FIXTURE);
    const result = await extractImageText(image, "image/png", { engine: () => Promise.resolve(fakeEngine("HELLO OCR\n")), langPath: "/nonexistent" });
    expect(result).toEqual({ ok: true, text: "HELLO OCR\n", confidence: 90 });
  });

  it("refuses a non-image mime without touching the engine", async () => {
    let called = false;
    const result = await extractImageText(Buffer.from("x"), "application/pdf", {
      engine: () => { called = true; return Promise.resolve(fakeEngine("x")); },
      langPath: "/nonexistent",
    });
    expect(result).toEqual({ ok: false, reason: "unsupported-type" });
    expect(called).toBe(false);
  });

  it("reports no OCR data instead of failing when no traineddata is present", async () => {
    const empty = mkdtempSync(join(tmpdir(), "sanremes-ocr-empty-"));
    const result = await extractImageText(readFileSync(FIXTURE), "image/png", { langPath: null });
    expect(result).toEqual({ ok: false, reason: "no-ocr-data" });
    expect(resolveOcrLangPath({}, empty)).toBeNull();
  });

  it("reports an engine failure instead of throwing", async () => {
    const result = await extractImageText(readFileSync(FIXTURE), "image/png", {
      engine: () => Promise.reject(new Error("worker died")),
      langPath: "/nonexistent",
    });
    expect(result).toEqual({ ok: false, reason: "ocr-failed" });
  });

  it("reads the fixture image with the real engine when language data is installed", { timeout: 60_000 }, async () => {
    const langPath = resolveOcrLangPath();
    if (!langPath) {
      const result = await extractImageText(readFileSync(FIXTURE), "image/png");
      expect(result).toEqual({ ok: false, reason: "no-ocr-data" });
      return;
    }
    expect(existsSync(join(langPath, "eng.traineddata.gz"))).toBe(true);
    const result = await extractImageText(readFileSync(FIXTURE), "image/png", { langPath });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain("HELLO OCR");
      expect(result.confidence).toBeGreaterThan(50);
    }
  });
});
