import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { generatePresentation, type FilegenDeck } from "../../server/filegen/index.ts";

export const SAMPLE_DECK: FilegenDeck = {
  title: "Quarterly Review",
  author: "SanRemes",
  slides: [
    { title: "Highlights", bullets: ["Revenue up 12%", "Churn down to 3%"] },
    {
      title: "Revenue by quarter",
      body: "Growth driven by renewals.",
      bullets: ["Q3 was the strongest quarter"],
      chart: {
        type: "bar",
        title: "Revenue",
        categories: ["Q1", "Q2", "Q3"],
        series: [{ name: "Revenue", values: [120, 150, 180] }],
      },
    },
    {
      title: "Share",
      chart: { type: "pie", categories: ["A", "B"], series: [{ name: "Share", values: [70, 30] }] },
    },
  ],
};

/** ZIP reader over the central directory: scanning for local headers misfires on
 *  the same bytes inside compressed data. */
export function unzip(buffer: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("No ZIP end-of-central-directory record found.");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Bad ZIP central directory entry.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, data.toString("utf8"));
    else if (method === 8) entries.set(name, inflateRawSync(data).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export interface SampleResult {
  path: string;
  bytes: number;
  slides: number;
  charts: number;
}

export async function generateSample(outDir?: string): Promise<SampleResult> {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), "sanremes-powerpoint-sample-"));
  mkdirSync(dir, { recursive: true });
  const bytes = await generatePresentation(SAMPLE_DECK);
  const path = join(dir, "quarterly-review.pptx");
  writeFileSync(path, bytes);

  const zip = unzip(bytes);
  const contentTypes = zip.get("[Content_Types].xml") ?? "";
  if (!contentTypes.includes("presentationml")) throw new Error("Generated file is not a .pptx (no presentationml content type).");
  const slides = [...zip.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (slides.length !== SAMPLE_DECK.slides.length + 1) {
    throw new Error(`Expected ${SAMPLE_DECK.slides.length + 1} slides (title + content), found ${slides.length}.`);
  }
  const charts = [...zip.keys()].filter((name) => name.startsWith("ppt/charts/chart"));
  if (charts.length !== 2) throw new Error(`Expected 2 native charts, found ${charts.length}.`);
  const all = [...zip.values()].join("\n");
  for (const text of ["Quarterly Review", "Revenue up 12%", "Revenue by quarter", "Q1"]) {
    if (!all.includes(text)) throw new Error(`Generated deck is missing ${JSON.stringify(text)}.`);
  }
  return { path, bytes: bytes.length, slides: slides.length, charts: charts.length };
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const outDir = process.argv[2];
  generateSample(outDir)
    .then((result) => {
      console.log(`Wrote ${result.path} (${result.bytes} bytes, ${result.slides} slides, ${result.charts} native charts; parsed back OK).`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
