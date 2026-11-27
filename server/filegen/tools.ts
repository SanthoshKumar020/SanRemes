// File generation tools: real .pptx/.docx/.pdf files from structured content.
// Paths are confined to the bot's export roots by the same resolver data
// exports use; a generated file never leaves those folders.
import { statSync, writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

import { resolveExportPath } from "../data/tools.ts";
import { DataFailure } from "../data/types.ts";
import { compileToolSchema, schemaProblems } from "../mcp-schema-validator.ts";
import { generateDocument } from "./docx.ts";
import { generatePdf } from "./pdf.ts";
import { generatePresentation } from "./pptx.ts";
import {
  FILEGEN_LIMITS,
  FilegenFailure,
  validateDeck,
  validateDocument,
  type FilegenFormat,
  type FilegenOutput,
} from "./types.ts";

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) =>
  ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });

const CHART_SCHEMA = {
  type: "object",
  description: "A native chart drawn from categories and one series per row.",
  properties: {
    type: { type: "string", enum: ["bar", "line", "pie"] },
    title: { type: "string", maxLength: FILEGEN_LIMITS.titleMax },
    categories: { type: "array", items: { type: "string", maxLength: FILEGEN_LIMITS.textMax }, minItems: 1, maxItems: FILEGEN_LIMITS.chartCategoriesMax },
    series: {
      type: "array",
      minItems: 1,
      maxItems: FILEGEN_LIMITS.chartSeriesMax,
      items: {
        type: "object",
        properties: {
          name: { type: "string", maxLength: FILEGEN_LIMITS.textMax },
          values: { type: "array", items: { type: "number" }, minItems: 1, maxItems: FILEGEN_LIMITS.chartValuesMax },
        },
        required: ["name", "values"],
        additionalProperties: false,
      },
    },
  },
  required: ["type", "categories", "series"],
  additionalProperties: false,
};

const BLOCK_SCHEMA = {
  type: "object",
  description: "One block of a document: heading, paragraph, bullet list or table.",
  properties: {
    type: { type: "string", enum: ["heading", "paragraph", "bullets", "table"] },
    level: { type: "integer", enum: [1, 2, 3], description: "Heading level; only for type heading." },
    text: { type: "string", maxLength: FILEGEN_LIMITS.textMax },
    items: { type: "array", items: { type: "string", maxLength: FILEGEN_LIMITS.textMax }, maxItems: FILEGEN_LIMITS.bulletsMax },
    headers: { type: "array", items: { type: "string", maxLength: FILEGEN_LIMITS.textMax }, maxItems: FILEGEN_LIMITS.tableColumnsMax },
    rows: {
      type: "array",
      maxItems: FILEGEN_LIMITS.tableRowsMax,
      items: { type: "array", items: { type: "string", maxLength: FILEGEN_LIMITS.textMax }, maxItems: FILEGEN_LIMITS.tableColumnsMax },
    },
  },
  required: ["type"],
  additionalProperties: false,
};

const PATH_PROPERTY = { type: "string", minLength: 1, maxLength: 4000, description: "Where to write the file; inside the bot's working folder or the person's Downloads. Default: Downloads." };

export const FILEGEN_TOOLS = [
  tool(
    "filegen_presentation",
    "Build a real .pptx deck: a title slide, then one slide per entry with a title, optional body text and bullets, and an optional native bar, line or pie chart. Returns the file path, size and slide count.",
    {
      title: { type: "string", minLength: 1, maxLength: FILEGEN_LIMITS.titleMax },
      author: { type: "string", maxLength: FILEGEN_LIMITS.titleMax },
      slides: {
        type: "array",
        minItems: 1,
        maxItems: FILEGEN_LIMITS.slidesMax,
        items: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: FILEGEN_LIMITS.titleMax },
            body: { type: "string", maxLength: FILEGEN_LIMITS.textMax },
            bullets: { type: "array", items: { type: "string", maxLength: FILEGEN_LIMITS.textMax }, maxItems: FILEGEN_LIMITS.bulletsMax },
            chart: CHART_SCHEMA,
          },
          required: ["title"],
          additionalProperties: false,
        },
      },
      path: PATH_PROPERTY,
    },
    ["title", "slides"],
  ),
  tool(
    "filegen_document",
    "Build a real .docx document: a title, then blocks in order — headings, paragraphs, bullet lists and tables with a shaded header row. Returns the file path, size and block count.",
    {
      title: { type: "string", minLength: 1, maxLength: FILEGEN_LIMITS.titleMax },
      author: { type: "string", maxLength: FILEGEN_LIMITS.titleMax },
      blocks: { type: "array", minItems: 1, maxItems: FILEGEN_LIMITS.blocksMax, items: BLOCK_SCHEMA },
      path: PATH_PROPERTY,
    },
    ["title", "blocks"],
  ),
  tool(
    "filegen_pdf",
    "Build a real .pdf document: a title, then blocks in order — headings, paragraphs, bullet lists and ruled tables with a shaded header row — paginated on A4 with page numbers. Returns the file path, size and page count.",
    {
      title: { type: "string", minLength: 1, maxLength: FILEGEN_LIMITS.titleMax },
      author: { type: "string", maxLength: FILEGEN_LIMITS.titleMax },
      blocks: { type: "array", minItems: 1, maxItems: FILEGEN_LIMITS.blocksMax, items: BLOCK_SCHEMA },
      path: PATH_PROPERTY,
    },
    ["title", "blocks"],
  ),
];

export const FILEGEN_TOOL_NAMES = FILEGEN_TOOLS.map((entry) => entry.name);

let validators: Map<string, ReturnType<typeof compileToolSchema>> | undefined;

export function filegenToolCallProblem(name: unknown, args: unknown): string | null {
  validators ??= new Map(FILEGEN_TOOLS.map((entry) => [entry.name, compileToolSchema(entry.inputSchema, { allErrors: true })]));
  const validate = typeof name === "string" ? validators.get(name) : undefined;
  if (!validate) return `Unknown file generation tool. Use one of ${FILEGEN_TOOL_NAMES.join(", ")}.`;
  if (!args || typeof args !== "object" || Array.isArray(args) || !validate(args)) {
    return `Tool arguments do not match the advertised input schema: ${schemaProblems(validate.errors).join("; ") || "use its required fields and types"}.`;
  }
  return null;
}

export interface FilegenContext {
  exportRoots: () => string[];
  signal: AbortSignal;
}

export type FilegenToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ok = (structured: Record<string, unknown>): FilegenToolResult =>
  ({ content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured });

const errorResult = (code: string, message: string, hint?: string): FilegenToolResult => {
  const error = { code, message, ...(hint ? { hint } : {}) };
  return { isError: true, content: [{ type: "text", text: `${code}: ${message}${hint ? ` Hint: ${hint}` : ""}` }], structuredContent: error };
};

function toFilegenError(error: unknown): FilegenToolResult {
  if (error instanceof FilegenFailure) return errorResult(error.code, error.message, error.hint);
  if (error instanceof DataFailure) return errorResult(error.error.code, error.error.message, error.error.hint);
  return errorResult("generation_failed", error instanceof Error ? error.message : String(error));
}

async function saveFile(
  ctx: FilegenContext,
  format: FilegenFormat,
  bytes: Buffer,
  stem: string,
  requestedPath: string | undefined,
): Promise<{ path: string; bytes: number }> {
  const path = resolveExportPath(ctx.exportRoots(), requestedPath, stem, format);
  writeFileSync(path, bytes);
  return { path, bytes: statSync(path).size };
}

export async function generateFile(
  ctx: FilegenContext,
  format: FilegenFormat,
  input: Record<string, unknown>,
): Promise<FilegenOutput> {
  ctx.signal.throwIfAborted();
  const requestedPath = typeof input.path === "string" ? input.path : undefined;
  if (format === "pptx") {
    const deck = validateDeck(input);
    const bytes = await generatePresentation(deck);
    const saved = await saveFile(ctx, format, bytes, deck.title, requestedPath);
    return { format, ...saved, slides: deck.slides.length + 1 };
  }
  const document = validateDocument(input);
  if (format === "docx") {
    const bytes = await generateDocument(document);
    const saved = await saveFile(ctx, format, bytes, document.title, requestedPath);
    return { format, ...saved, blocks: document.blocks.length };
  }
  const bytes = await generatePdf(document);
  const loaded = await PDFDocument.load(bytes);
  const saved = await saveFile(ctx, format, bytes, document.title, requestedPath);
  return { format, ...saved, pages: loaded.getPageCount(), blocks: document.blocks.length };
}

export async function runFilegenTool(ctx: FilegenContext, name: string, args: Record<string, unknown>): Promise<FilegenToolResult> {
  const problem = filegenToolCallProblem(name, args);
  if (problem) return errorResult("invalid_input", problem);
  try {
    ctx.signal.throwIfAborted();
    switch (name) {
      case "filegen_presentation": return ok({ ...(await generateFile(ctx, "pptx", args)) });
      case "filegen_document": return ok({ ...(await generateFile(ctx, "docx", args)) });
      case "filegen_pdf": return ok({ ...(await generateFile(ctx, "pdf", args)) });
      default: return errorResult("invalid_input", "Unknown file generation tool.");
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return errorResult("cancelled", "The generation was cancelled.");
    return toFilegenError(error);
  }
}
