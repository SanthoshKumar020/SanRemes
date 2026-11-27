import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { extractText } from "unpdf";
import { PDFDocument } from "pdf-lib";
import mammoth from "mammoth";

import { generateDocument } from "./docx.ts";
import { generatePdf } from "./pdf.ts";
import { generatePresentation } from "./pptx.ts";
import { FILEGEN_TOOLS, filegenToolCallProblem, generateFile, runFilegenTool, type FilegenContext } from "./tools.ts";
import { filegenRpc } from "./rpc.ts";
import { FilegenFailure, validateChart, validateDeck, validateDocument } from "./types.ts";

/** Minimal ZIP reader: Office files are ZIPs; entries are stored or deflated. */
function unzip(buffer: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;
  while (true) {
    const at = buffer.indexOf(Buffer.from("PK\x03\x04"), offset);
    if (at < 0) break;
    const method = buffer.readUInt16LE(at + 8);
    const compressedSize = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26);
    const extraLength = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 30, at + 30 + nameLength).toString("utf8");
    const start = at + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, data.toString("utf8"));
    else if (method === 8) entries.set(name, inflateRawSync(data).toString("utf8"));
    offset = start + compressedSize;
  }
  return entries;
}

const DECK = {
  title: "Quarterly Review",
  author: "SanRemes",
  slides: [
    { title: "Highlights", bullets: ["Revenue up 12%", "Churn down to 3%"] },
    {
      title: "Revenue by quarter",
      bullets: ["Growth driven by renewals"],
      chart: { type: "bar" as const, title: "Revenue", categories: ["Q1", "Q2", "Q3"], series: [{ name: "Revenue", values: [120, 150, 180] }] },
    },
    {
      title: "Share",
      chart: { type: "pie" as const, categories: ["A", "B"], series: [{ name: "Share", values: [70, 30] }] },
    },
  ],
};

const DOC = {
  title: "Quarterly Report",
  author: "SanRemes",
  blocks: [
    { type: "heading" as const, level: 1 as const, text: "Overview" },
    { type: "paragraph" as const, text: "Revenue grew across all three quarters." },
    { type: "bullets" as const, items: ["Revenue up 12%", "Churn down to 3%"] },
    { type: "table" as const, headers: ["Quarter", "Revenue"], rows: [["Q1", "120"], ["Q2", "150"], ["Q3", "180"]] },
  ],
};

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function context(): { ctx: FilegenContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sanremes-filegen-"));
  dirs.push(dir);
  return { ctx: { exportRoots: () => [dir], signal: new AbortController().signal }, dir };
}

describe("generatePresentation", () => {
  it("writes a byte-valid .pptx with slides, bullets and a native chart", async () => {
    const bytes = await generatePresentation(DECK);
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK");
    const zip = unzip(bytes);
    expect(zip.get("[Content_Types].xml")).toContain("presentationml");
    const slides = [...zip.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slides).toHaveLength(4);
    const all = [...zip.values()].join("\n");
    expect(all).toContain("Quarterly Review");
    expect(all).toContain("Revenue up 12%");
    expect(all).toContain("Churn down to 3%");
    expect(zip.get("ppt/slides/slide2.xml")).toContain("buChar");
    const charts = [...zip.keys()].filter((name) => name.startsWith("ppt/charts/chart"));
    expect(charts.length).toBe(2);
    const chartXml = charts.map((name) => zip.get(name)!).join("\n");
    expect(chartXml).toContain("Revenue");
    expect(chartXml).toContain("Q1");
  });

  it("rejects a chart whose series do not match the categories", () => {
    expect(() =>
      validateDeck({
        title: "Bad",
        slides: [{ title: "S", chart: { type: "bar", categories: ["A", "B"], series: [{ name: "X", values: [1] }] } }],
      }),
    ).toThrow(FilegenFailure);
  });
});

describe("generateDocument", () => {
  it("writes a byte-valid .docx whose text reads back through mammoth", async () => {
    const bytes = await generateDocument(DOC);
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK");
    const zip = unzip(bytes);
    expect(zip.get("[Content_Types].xml")).toContain("wordprocessingml");
    expect(zip.get("word/document.xml")).toContain("Quarterly Report");
    const { value } = await mammoth.extractRawText({ buffer: bytes });
    expect(value).toContain("Overview");
    expect(value).toContain("Revenue grew across all three quarters.");
    expect(value).toContain("Revenue up 12%");
    expect(value).toContain("Q1");
    expect(value).toContain("180");
  });

  it("rejects a table row with the wrong cell count", () => {
    expect(() =>
      validateDocument({ title: "Bad", blocks: [{ type: "table", headers: ["A", "B"], rows: [["only-one"]] }] }),
    ).toThrow(FilegenFailure);
  });
});

describe("generatePdf", () => {
  it("writes a byte-valid .pdf whose text reads back", async () => {
    const bytes = await generatePdf(DOC);
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getTitle()).toBe("Quarterly Report");
    expect(loaded.getPageCount()).toBe(1);
    const { text, totalPages } = await extractText(bytes, { mergePages: true });
    expect(totalPages).toBe(1);
    expect(text).toContain("Quarterly Report");
    expect(text).toContain("Overview");
    expect(text).toContain("Revenue grew across all three quarters.");
    expect(text).toContain("Revenue up 12%");
    expect(text).toContain("Q1");
    expect(text).toContain("180");
  });

  it("paginates a long document", async () => {
    const long = { title: "Long", blocks: Array.from({ length: 60 }, (_, i) => ({ type: "paragraph" as const, text: `Paragraph ${i} `.repeat(40) })) };
    const bytes = await generatePdf(long);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThan(1);
  });

  it("rejects a chart with an unknown type", () => {
    expect(() => validateChart({ type: "radar", categories: ["A"], series: [{ name: "X", values: [1] }] })).toThrow(FilegenFailure);
  });
});

describe("runFilegenTool", () => {
  it("exposes three tools with the expected names", () => {
    expect(FILEGEN_TOOLS.map((entry) => entry.name)).toEqual(["filegen_presentation", "filegen_document", "filegen_pdf"]);
    expect(filegenToolCallProblem("filegen_pdf", { title: "T", blocks: [{ type: "paragraph", text: "x" }] })).toBeNull();
    expect(filegenToolCallProblem("filegen_pdf", { title: "T" })).toContain("input schema");
    expect(filegenToolCallProblem("filegen_nope", {})).toContain("Unknown");
  });

  it("writes each format into the export root and reports path, bytes and counts", async () => {
    const { ctx, dir } = context();
    const pptx = await runFilegenTool(ctx, "filegen_presentation", DECK);
    expect(pptx.isError).toBeUndefined();
    expect(pptx.structuredContent).toMatchObject({ format: "pptx", slides: 4 });
    const pptxPath = (pptx.structuredContent as { path: string }).path;
    expect(pptxPath.startsWith(dir)).toBe(true);
    expect(existsSync(pptxPath)).toBe(true);
    expect(readFileSync(pptxPath).subarray(0, 2).toString("ascii")).toBe("PK");

    const docx = await runFilegenTool(ctx, "filegen_document", DOC);
    expect(docx.structuredContent).toMatchObject({ format: "docx", blocks: 4 });

    const pdf = await runFilegenTool(ctx, "filegen_pdf", DOC);
    expect(pdf.structuredContent).toMatchObject({ format: "pdf", pages: 1, blocks: 4 });
    expect(readFileSync((pdf.structuredContent as { path: string }).path).subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("refuses a path outside the export roots", async () => {
    const { ctx } = context();
    const result = await runFilegenTool(ctx, "filegen_pdf", { ...DOC, path: "/etc/escape.pdf" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "invalid_input" });
  });

  it("returns an error result for invalid content instead of throwing", async () => {
    const { ctx } = context();
    const result = await runFilegenTool(ctx, "filegen_presentation", { title: "Empty", slides: [] });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "invalid_input" });
  });

  it("generateFile writes through the same path confinement", async () => {
    const { ctx, dir } = context();
    const out = await generateFile(ctx, "pdf", { ...DOC, path: "reports/q1.pdf" });
    expect(out.format).toBe("pdf");
    expect(out.path).toBe(join(dir, "reports", "q1.pdf"));
    expect(out.pages).toBe(1);
    expect(out.bytes).toBeGreaterThan(0);
  });
});

describe("filegenRpc", () => {
  it("lists tools and dispatches calls", async () => {
    const { ctx, dir } = context();
    const deps = { ...ctx, assertActive: () => {} };
    const listed = await filegenRpc({ method: "tools/list" }, deps);
    expect((listed as { tools: unknown[] }).tools).toHaveLength(3);
    const called = await filegenRpc(
      { method: "tools/call", params: { name: "filegen_document", arguments: DOC } },
      deps,
    );
    expect("tools" in called).toBe(false);
    if ("tools" in called) throw new Error("expected a tool result, got a tools list");
    expect(called.isError).toBeUndefined();
    expect((called.structuredContent as { path: string }).path.startsWith(dir)).toBe(true);
    await expect(filegenRpc({ method: "tools/call", params: { name: "filegen_nope", arguments: {} } }, deps)).resolves.toMatchObject({ isError: true });
    await expect(filegenRpc({ method: "bogus" }, deps)).rejects.toThrow("unsupported filegen method");
  });
});
