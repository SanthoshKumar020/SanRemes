import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DATA_ROOT = mkdtempSync(join(tmpdir(), "sanremes-attachments-ocr-"));
process.env.SANREMES_DATA_DIR = join(DATA_ROOT, "data");
delete process.env.SANREMES_OCR_LANG_PATH;

const { ocrAttachmentText, saveFile, saveImage } = await import("./attachments.ts");

const fixture = (name: string) => new URL(`./ocr/fixtures/${name}`, import.meta.url).pathname;

describe("ocrAttachmentText", () => {
  it("never breaks the pipeline when no OCR language data is installed", async () => {
    const saved = saveImage(readFileSync(fixture("hello.png")), "image/png");
    await expect(ocrAttachmentText(saved.path, saved.mime)).resolves.toEqual({ ok: false, reason: "no-ocr-data" });
  });

  it("reads a PDF's text layer through the attachment pipeline", async () => {
    const saved = await saveFile((async function* () { yield readFileSync(fixture("hello.pdf")); })(), "hello.pdf", "application/pdf");
    const result = await ocrAttachmentText(saved.path, saved.mime);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain("HELLO PDF");
  });
});
