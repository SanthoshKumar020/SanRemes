import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PDFDocument } from "pdf-lib";
import { extractText } from "unpdf";

import { generatePdf, type FilegenDocument } from "../../server/filegen/index.ts";

export const SAMPLE_DOCUMENT: FilegenDocument = {
  title: "Quarterly Report",
  author: "SanRemes",
  blocks: [
    { type: "heading", level: 1, text: "Overview" },
    { type: "paragraph", text: "Revenue grew across all three quarters." },
    { type: "bullets", items: ["Revenue up 12%", "Churn down to 3%"] },
    {
      type: "table",
      headers: ["Quarter", "Revenue"],
      rows: [["Q1", "120"], ["Q2", "150"], ["Q3", "180"]],
    },
  ],
};

export interface SampleResult {
  path: string;
  bytes: number;
  pages: number;
  blocks: number;
}

export async function generateSample(outDir?: string): Promise<SampleResult> {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), "sanremes-pdf-sample-"));
  mkdirSync(dir, { recursive: true });
  const bytes = await generatePdf(SAMPLE_DOCUMENT);
  const path = join(dir, "quarterly-report.pdf");
  writeFileSync(path, bytes);

  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Generated file is not a .pdf (no %PDF- header).");
  const loaded = await PDFDocument.load(bytes);
  const pages = loaded.getPageCount();
  if (pages < 1) throw new Error("Generated PDF has no pages.");
  const { text } = await extractText(new Uint8Array(bytes));
  const joined = text.join("\n");
  for (const word of ["Quarterly Report", "Overview", "Revenue grew across all three quarters.", "Revenue up 12%", "Q1", "180"]) {
    if (!joined.includes(word)) throw new Error(`Generated PDF is missing ${JSON.stringify(word)}.`);
  }
  return { path, bytes: bytes.length, pages, blocks: SAMPLE_DOCUMENT.blocks.length };
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const outDir = process.argv[2];
  generateSample(outDir)
    .then((result) => {
      console.log(`Wrote ${result.path} (${result.bytes} bytes, ${result.pages} page(s), ${result.blocks} blocks; parsed back OK).`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
