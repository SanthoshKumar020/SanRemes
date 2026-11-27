export const FILEGEN_LIMITS = {
  titleMax: 200,
  textMax: 5000,
  slidesMax: 100,
  bulletsMax: 50,
  blocksMax: 500,
  tableRowsMax: 500,
  tableColumnsMax: 20,
  chartCategoriesMax: 50,
  chartSeriesMax: 10,
  chartValuesMax: 500,
} as const;

export class FilegenFailure extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "FilegenFailure";
    this.code = code;
    this.hint = hint;
  }
}

export function fail(code: string, message: string, hint?: string): never {
  throw new FilegenFailure(code, message, hint);
}

export type FilegenBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

export type FilegenChartType = "bar" | "line" | "pie";

export interface FilegenChart {
  type: FilegenChartType;
  title?: string;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
}

export interface FilegenSlide {
  title: string;
  body?: string;
  bullets?: string[];
  chart?: FilegenChart;
}

export interface FilegenDeck {
  title: string;
  author?: string;
  slides: FilegenSlide[];
}

export interface FilegenDocument {
  title: string;
  author?: string;
  blocks: FilegenBlock[];
}

export type FilegenFormat = "pptx" | "docx" | "pdf";

export interface FilegenOutput {
  format: FilegenFormat;
  path: string;
  bytes: number;
  slides?: number;
  pages?: number;
  blocks?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function checkText(value: unknown, field: string): string {
  if (typeof value !== "string") fail("invalid_input", `${field} must be a string.`);
  if (!value.trim()) fail("invalid_input", `${field} must not be empty.`);
  if (value.length > FILEGEN_LIMITS.textMax) fail("invalid_input", `${field} is longer than ${FILEGEN_LIMITS.textMax} characters.`);
  return value;
}

function checkTitle(value: unknown, field: string): string {
  const text = checkText(value, field);
  if (text.length > FILEGEN_LIMITS.titleMax) fail("invalid_input", `${field} is longer than ${FILEGEN_LIMITS.titleMax} characters.`);
  return text;
}

function checkStringArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) fail("invalid_input", `${field} must be an array of strings.`);
  if (value.length > max) fail("invalid_input", `${field} has more than ${max} entries.`);
  return value.map((entry, i) => checkText(entry, `${field}[${i}]`));
}

export function validateChart(value: unknown): FilegenChart {
  if (!isRecord(value)) fail("invalid_input", "chart must be an object.");
  if (value.type !== "bar" && value.type !== "line" && value.type !== "pie") {
    fail("invalid_input", "chart.type must be bar, line or pie.");
  }
  const categories = checkStringArray(value.categories, "chart.categories", FILEGEN_LIMITS.chartCategoriesMax);
  if (!categories.length) fail("invalid_input", "chart.categories must not be empty.");
  if (!Array.isArray(value.series) || !value.series.length) fail("invalid_input", "chart.series must be a non-empty array.");
  if (value.series.length > FILEGEN_LIMITS.chartSeriesMax) fail("invalid_input", `chart.series has more than ${FILEGEN_LIMITS.chartSeriesMax} series.`);
  const series = value.series.map((entry, i) => {
    if (!isRecord(entry)) fail("invalid_input", `chart.series[${i}] must be an object.`);
    const name = checkText(entry.name, `chart.series[${i}].name`);
    if (!Array.isArray(entry.values)) fail("invalid_input", `chart.series[${i}].values must be an array of numbers.`);
    if (entry.values.length !== categories.length) {
      fail("invalid_input", `chart.series[${i}].values must have one value per category (${categories.length}).`);
    }
    if (entry.values.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
      fail("invalid_input", `chart.series[${i}].values must be finite numbers.`);
    }
    return { name, values: entry.values as number[] };
  });
  return {
    type: value.type,
    ...(value.title === undefined ? {} : { title: checkTitle(value.title, "chart.title") }),
    categories,
    series,
  };
}

export function validateSlide(value: unknown): FilegenSlide {
  if (!isRecord(value)) fail("invalid_input", "Each slide must be an object.");
  const title = checkTitle(value.title, "slide.title");
  const slide: FilegenSlide = { title };
  if (value.body !== undefined) slide.body = checkText(value.body, "slide.body");
  if (value.bullets !== undefined) slide.bullets = checkStringArray(value.bullets, "slide.bullets", FILEGEN_LIMITS.bulletsMax);
  if (value.chart !== undefined) slide.chart = validateChart(value.chart);
  return slide;
}

export function validateDeck(value: unknown): FilegenDeck {
  if (!isRecord(value)) fail("invalid_input", "A presentation needs a title and slides.");
  const title = checkTitle(value.title, "title");
  if (!Array.isArray(value.slides) || !value.slides.length) fail("invalid_input", "slides must be a non-empty array.");
  if (value.slides.length > FILEGEN_LIMITS.slidesMax) fail("invalid_input", `slides has more than ${FILEGEN_LIMITS.slidesMax} slides.`);
  return {
    title,
    ...(value.author === undefined ? {} : { author: checkTitle(value.author, "author") }),
    slides: value.slides.map(validateSlide),
  };
}

export function validateBlock(value: unknown, index: number): FilegenBlock {
  if (!isRecord(value)) fail("invalid_input", `blocks[${index}] must be an object.`);
  switch (value.type) {
    case "heading": {
      if (value.level !== 1 && value.level !== 2 && value.level !== 3) fail("invalid_input", `blocks[${index}].level must be 1, 2 or 3.`);
      return { type: "heading", level: value.level, text: checkText(value.text, `blocks[${index}].text`) };
    }
    case "paragraph":
      return { type: "paragraph", text: checkText(value.text, `blocks[${index}].text`) };
    case "bullets":
      return { type: "bullets", items: checkStringArray(value.items, `blocks[${index}].items`, FILEGEN_LIMITS.bulletsMax) };
    case "table": {
      const headers = checkStringArray(value.headers, `blocks[${index}].headers`, FILEGEN_LIMITS.tableColumnsMax);
      if (!headers.length) fail("invalid_input", `blocks[${index}].headers must not be empty.`);
      if (!Array.isArray(value.rows)) fail("invalid_input", `blocks[${index}].rows must be an array.`);
      if (value.rows.length > FILEGEN_LIMITS.tableRowsMax) fail("invalid_input", `blocks[${index}].rows has more than ${FILEGEN_LIMITS.tableRowsMax} rows.`);
      const rows = value.rows.map((row, r) => {
        if (!Array.isArray(row) || row.length !== headers.length) {
          fail("invalid_input", `blocks[${index}].rows[${r}] must have one cell per header (${headers.length}).`);
        }
        return row.map((cell, c) => checkText(cell, `blocks[${index}].rows[${r}][${c}]`));
      });
      return { type: "table", headers, rows };
    }
    default:
      return fail("invalid_input", `blocks[${index}].type must be heading, paragraph, bullets or table.`);
  }
}

export function validateDocument(value: unknown): FilegenDocument {
  if (!isRecord(value)) fail("invalid_input", "A document needs a title and blocks.");
  const title = checkTitle(value.title, "title");
  if (!Array.isArray(value.blocks) || !value.blocks.length) fail("invalid_input", "blocks must be a non-empty array.");
  if (value.blocks.length > FILEGEN_LIMITS.blocksMax) fail("invalid_input", `blocks has more than ${FILEGEN_LIMITS.blocksMax} blocks.`);
  return {
    title,
    ...(value.author === undefined ? {} : { author: checkTitle(value.author, "author") }),
    blocks: value.blocks.map((block, i) => validateBlock(block, i)),
  };
}
