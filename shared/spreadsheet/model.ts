// Workbook model: tabs, sparse cells, formatting, evaluation and JSON.
// Mutations return a new workbook; user-facing validation is a plain-words
// error, never a throw.

import {
  columnLabel,
  evaluateFormulaText,
  formatCellRef,
  formulaError,
  isFormulaError,
  rangeCellCount,
  shortNumber,
  MAX_FORMULA_LENGTH,
  MAX_RANGE_CELLS,
  type CellRange,
  type CellRef,
  type ComputedValue,
  type FormulaResolver,
} from "./formula.ts";

export type NumberFormat = "general" | "number" | "currency" | "percent" | "date";

export const NUMBER_FORMATS: readonly NumberFormat[] = ["general", "number", "currency", "percent", "date"];

export interface SheetCell {
  raw: string | number | boolean | null;
  bold?: boolean;
  format?: NumberFormat;
}

export interface SheetTab {
  id: string;
  name: string;
  cells: Record<string, SheetCell>;
  columnWidths: Record<string, number>;
  rows: number;
  cols: number;
}

export interface Workbook {
  version: 1;
  title: string;
  tabs: SheetTab[];
}

export const DEFAULT_ROWS = 100;
export const DEFAULT_COLS = 26;
export const MAX_ROWS = 500;
export const MAX_COLS = 52;
export const MAX_TABS = 50;
export const MAX_CELLS_PER_TAB = 10_000;
export const MAX_TEXT_LENGTH = 10_000;
const MIN_COLUMN_WIDTH = 24;
const MAX_COLUMN_WIDTH = 800;
const TAB_NAME_FORBIDDEN = /[[\]:*?/\\]/;

export type Result<T> = { ok: true; workbook: Workbook; value?: T } | { ok: false; error: string };

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function parseCellKey(key: string): { row: number; col: number } | null {
  const match = /^(\d+):(\d+)$/.exec(key);
  if (!match) return null;
  return { row: Number(match[1]), col: Number(match[2]) };
}

export function createTab(name: string): SheetTab {
  return {
    id: `tab-${Math.random().toString(36).slice(2, 10)}`,
    name,
    cells: {},
    columnWidths: {},
    rows: DEFAULT_ROWS,
    cols: DEFAULT_COLS,
  };
}

export function createWorkbook(title = "Untitled sheet"): Workbook {
  return { version: 1, title, tabs: [createTab("Sheet1")] };
}

export function tabById(workbook: Workbook, tabId: string): SheetTab | undefined {
  return workbook.tabs.find((tab) => tab.id === tabId);
}

export function tabByName(workbook: Workbook, name: string): SheetTab | undefined {
  const folded = name.toLowerCase();
  return workbook.tabs.find((tab) => tab.name.toLowerCase() === folded);
}

function nextTabName(workbook: Workbook): string {
  for (let n = 1; ; n++) {
    const name = `Sheet${n}`;
    if (!tabByName(workbook, name)) return name;
  }
}

export function validateTabName(workbook: Workbook, name: string, exceptId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A tab needs a name.";
  if (trimmed.length > 31) return "A tab name can be at most 31 characters.";
  if (TAB_NAME_FORBIDDEN.test(trimmed)) return "A tab name cannot contain [ ] : * ? / or \\.";
  const clash = workbook.tabs.find((tab) => tab.id !== exceptId && tab.name.toLowerCase() === trimmed.toLowerCase());
  if (clash) return `There is already a tab named "${clash.name}".`;
  return null;
}

function updateTab(workbook: Workbook, tabId: string, update: (tab: SheetTab) => SheetTab): Result<SheetTab> {
  const tab = tabById(workbook, tabId);
  if (!tab) return { ok: false, error: "That tab is gone." };
  const next = update(tab);
  return {
    ok: true,
    workbook: { ...workbook, tabs: workbook.tabs.map((entry) => (entry.id === tabId ? next : entry)) },
    value: next,
  };
}

export function addTab(workbook: Workbook, name?: string): Result<SheetTab> {
  if (workbook.tabs.length >= MAX_TABS) return { ok: false, error: `A spreadsheet holds at most ${MAX_TABS} tabs.` };
  const wanted = name?.trim() || nextTabName(workbook);
  const problem = validateTabName(workbook, wanted);
  if (problem) return { ok: false, error: problem };
  const tab = createTab(wanted);
  return { ok: true, workbook: { ...workbook, tabs: [...workbook.tabs, tab] }, value: tab };
}

export function renameTab(workbook: Workbook, tabId: string, name: string): Result<SheetTab> {
  const tab = tabById(workbook, tabId);
  if (!tab) return { ok: false, error: "That tab is gone." };
  const problem = validateTabName(workbook, name, tabId);
  if (problem) return { ok: false, error: problem };
  return updateTab(workbook, tabId, (entry) => ({ ...entry, name: name.trim() }));
}

/** Typing into a cell: numbers and TRUE/FALSE become values, = starts a formula. */
export function coerceTypedInput(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    const value = Number(trimmed);
    if (Number.isFinite(value)) return value;
  }
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  return raw;
}

export function setCell(workbook: Workbook, tabId: string, row: number, col: number, raw: string | number | boolean | null): Result<void> {
  const tab = tabById(workbook, tabId);
  if (!tab) return { ok: false, error: "That tab is gone." };
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) {
    return { ok: false, error: "That cell does not exist." };
  }
  if (row >= MAX_ROWS || col >= MAX_COLS) {
    return { ok: false, error: `This sheet has room for ${MAX_ROWS} rows and ${MAX_COLS} columns (${columnLabel(MAX_COLS - 1)}).` };
  }
  let stored: string | number | boolean | null = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") stored = null;
    else if (raw.startsWith("=") && raw.length - 1 > MAX_FORMULA_LENGTH) {
      return { ok: false, error: `The formula is too long (over ${MAX_FORMULA_LENGTH} characters).` };
    } else if (raw.length > MAX_TEXT_LENGTH) {
      return { ok: false, error: `A cell holds at most ${MAX_TEXT_LENGTH} characters.` };
    } else if (!raw.startsWith("=")) stored = coerceTypedInput(raw);
  }
  if (typeof stored === "number" && !Number.isFinite(stored)) return { ok: false, error: "That number is too large." };
  const key = cellKey(row, col);
  if (stored !== null && !(key in tab.cells) && Object.keys(tab.cells).length >= MAX_CELLS_PER_TAB) {
    return { ok: false, error: `A tab holds at most ${MAX_CELLS_PER_TAB.toLocaleString("en-US")} filled cells.` };
  }
  const result = updateTab(workbook, tabId, (entry) => {
    const cells = { ...entry.cells };
    if (stored === null) delete cells[key];
    else cells[key] = { ...(cells[key] ?? { raw: null }), raw: stored };
    return { ...entry, cells, rows: Math.max(entry.rows, row + 1), cols: Math.max(entry.cols, col + 1) };
  });
  if (!result.ok) return result;
  return { ok: true, workbook: result.workbook };
}

export function setCellStyle(workbook: Workbook, tabId: string, row: number, col: number, style: { bold?: boolean; format?: NumberFormat }): Result<void> {
  const tab = tabById(workbook, tabId);
  if (!tab) return { ok: false, error: "That tab is gone." };
  const key = cellKey(row, col);
  const result = updateTab(workbook, tabId, (entry) => {
    const cells = { ...entry.cells };
    const current = cells[key] ?? { raw: null };
    cells[key] = {
      ...current,
      ...(style.bold === undefined ? {} : style.bold ? { bold: true } : { bold: undefined }),
      ...(style.format === undefined ? {} : { format: style.format }),
    };
    if (cells[key]!.raw === null && cells[key]!.bold === undefined && cells[key]!.format === undefined) delete cells[key];
    return { ...entry, cells };
  });
  return result.ok ? { ok: true, workbook: result.workbook } : result;
}

export function setColumnWidth(workbook: Workbook, tabId: string, col: number, width: number): Result<void> {
  const tab = tabById(workbook, tabId);
  if (!tab) return { ok: false, error: "That tab is gone." };
  const clamped = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
  const result = updateTab(workbook, tabId, (entry) => ({
    ...entry,
    columnWidths: { ...entry.columnWidths, [col]: clamped },
  }));
  return result.ok ? { ok: true, workbook: result.workbook } : result;
}

export function getCell(tab: SheetTab, row: number, col: number): SheetCell | undefined {
  return tab.cells[cellKey(row, col)];
}

/** The raw content as text for the formula bar: a formula as typed, TRUE/FALSE for booleans. */
export function rawToText(raw: string | number | boolean | null): string {
  if (raw === null) return "";
  if (typeof raw === "boolean") return raw ? "TRUE" : "FALSE";
  if (typeof raw === "number") return shortNumber(raw);
  return raw;
}

/** The used rectangle, trimmed of trailing empty rows and columns. */
export function usedRange(tab: SheetTab): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const key of Object.keys(tab.cells)) {
    const parsed = parseCellKey(key);
    if (!parsed) continue;
    rows = Math.max(rows, parsed.row + 1);
    cols = Math.max(cols, parsed.col + 1);
  }
  return { rows, cols };
}

export function evaluateTab(workbook: Workbook, tabId: string): ComputedValue[][] {
  const tab = tabById(workbook, tabId);
  if (!tab) throw new Error("That tab is gone.");
  const memo = new Map<string, ComputedValue>();
  const visiting = new Set<string>();
  const evaluateCell = (current: SheetTab, row: number, col: number): ComputedValue => {
    const key = `${current.id}:${row}:${col}`;
    const memoized = memo.get(key);
    if (memoized !== undefined) return memoized;
    if (visiting.has(key)) {
      return formulaError(`Circular reference at ${formatCellRef({ sheet: current.name, row, col })}.`);
    }
    const cell = current.cells[cellKey(row, col)];
    if (!cell || cell.raw === null) return null;
    if (typeof cell.raw !== "string" || !cell.raw.startsWith("=")) return cell.raw;
    visiting.add(key);
    const value = evaluateFormulaText(cell.raw, resolverFor(current));
    visiting.delete(key);
    memo.set(key, value);
    return value;
  };
  const resolverFor = (current: SheetTab): FormulaResolver => ({
    sheetName: current.name,
    cell: (ref: CellRef) => {
      const target = ref.sheet ? tabByName(workbook, ref.sheet) : current;
      if (!target) return formulaError(`There is no tab named "${ref.sheet}".`);
      if (ref.row >= target.rows || ref.col >= target.cols) return null;
      return evaluateCell(target, ref.row, ref.col);
    },
    range: (range: CellRange) => {
      const target = range.sheet ? tabByName(workbook, range.sheet) : current;
      if (!target) return formulaError(`There is no tab named "${range.sheet}".`);
      if (rangeCellCount(range) > MAX_RANGE_CELLS) {
        return formulaError(`That range is too large (over ${MAX_RANGE_CELLS.toLocaleString("en-US")} cells).`);
      }
      const values: ComputedValue[] = [];
      for (let row = range.startRow; row <= range.endRow; row++) {
        for (let col = range.startCol; col <= range.endCol; col++) {
          values.push(row >= target.rows || col >= target.cols ? null : evaluateCell(target, row, col));
        }
      }
      return values;
    },
  });
  const grid: ComputedValue[][] = [];
  for (let row = 0; row < tab.rows; row++) {
    const line: ComputedValue[] = [];
    for (let col = 0; col < tab.cols; col++) line.push(evaluateCell(tab, row, col));
    grid.push(line);
  }
  return grid;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function formatDate(date: Date, locale: string): string {
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

/** A number in a date cell is an Excel serial day (days since 30 Dec 1899). */
function serialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return null;
  return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
}

export function formatDisplayValue(
  value: ComputedValue,
  format: NumberFormat,
  options: { locale?: string; currency?: string } = {},
): string {
  if (isFormulaError(value)) return value.message;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const locale = options.locale ?? "en-US";
  if (typeof value === "string") {
    if (format === "date") {
      const match = ISO_DATE.exec(value);
      if (match) {
        const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
        if (!Number.isNaN(date.getTime())) return formatDate(date, locale);
      }
    }
    return value;
  }
  switch (format) {
    case "number":
      return value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "currency":
      return value.toLocaleString(locale, { style: "currency", currency: options.currency ?? "USD" });
    case "percent":
      return value.toLocaleString(locale, { style: "percent", minimumFractionDigits: 0, maximumFractionDigits: 2 });
    case "date": {
      const date = serialToDate(value);
      return date ? formatDate(date, locale) : shortNumber(value);
    }
    default:
      return shortNumber(value);
  }
}

export function workbookToJson(workbook: Workbook): string {
  return JSON.stringify(workbook);
}

export function workbookFromJson(text: string): { ok: true; workbook: Workbook } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "The spreadsheet could not be read." };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "The spreadsheet could not be read." };
  const input = parsed as Partial<Workbook>;
  if (input.version !== 1) return { ok: false, error: "This spreadsheet was made by a newer version." };
  if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 200) {
    return { ok: false, error: "A spreadsheet needs a title of at most 200 characters." };
  }
  if (!Array.isArray(input.tabs) || !input.tabs.length || input.tabs.length > MAX_TABS) {
    return { ok: false, error: `A spreadsheet needs 1 to ${MAX_TABS} tabs.` };
  }
  const tabs: SheetTab[] = [];
  const seen = new Set<string>();
  for (const entry of input.tabs) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "A tab is missing." };
    const tab = entry as Partial<SheetTab>;
    if (typeof tab.id !== "string" || !tab.id) return { ok: false, error: "A tab is missing its id." };
    if (typeof tab.name !== "string") return { ok: false, error: "A tab is missing its name." };
    const nameProblem = validateTabName({ version: 1, title: input.title, tabs }, tab.name);
    if (nameProblem) return { ok: false, error: nameProblem };
    if (seen.has(tab.name.toLowerCase())) return { ok: false, error: `Two tabs are named "${tab.name}".` };
    seen.add(tab.name.toLowerCase());
    if (!tab.cells || typeof tab.cells !== "object" || Array.isArray(tab.cells)) {
      return { ok: false, error: `The tab "${tab.name}" has no cells.` };
    }
    const cells: Record<string, SheetCell> = {};
    for (const [key, cell] of Object.entries(tab.cells)) {
      const parsedKey = parseCellKey(key);
      if (!parsedKey || parsedKey.row >= MAX_ROWS || parsedKey.col >= MAX_COLS) {
        return { ok: false, error: `The tab "${tab.name}" has a cell outside the sheet.` };
      }
      if (!cell || typeof cell !== "object" || !("raw" in (cell as unknown as Record<string, unknown>))) {
        return { ok: false, error: `The tab "${tab.name}" has a damaged cell.` };
      }
      const raw = (cell as SheetCell).raw;
      if (raw !== null && typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
        return { ok: false, error: `The tab "${tab.name}" has a damaged cell.` };
      }
      if (typeof raw === "string" && raw.length > MAX_TEXT_LENGTH) {
        return { ok: false, error: `A cell in "${tab.name}" is too long.` };
      }
      if (typeof raw === "number" && !Number.isFinite(raw)) {
        return { ok: false, error: `The tab "${tab.name}" has a number that is too large.` };
      }
      const format = (cell as SheetCell).format;
      if (format !== undefined && !NUMBER_FORMATS.includes(format)) {
        return { ok: false, error: `The tab "${tab.name}" has an unknown number format.` };
      }
      cells[key] = {
        raw,
        ...((cell as SheetCell).bold ? { bold: true } : {}),
        ...(format ? { format } : {}),
      };
    }
    if (Object.keys(cells).length > MAX_CELLS_PER_TAB) {
      return { ok: false, error: `The tab "${tab.name}" holds too many filled cells.` };
    }
    const columnWidths: Record<string, number> = {};
    if (tab.columnWidths && typeof tab.columnWidths === "object" && !Array.isArray(tab.columnWidths)) {
      for (const [key, width] of Object.entries(tab.columnWidths)) {
        const col = Number(key);
        if (Number.isInteger(col) && col >= 0 && col < MAX_COLS && typeof width === "number" && Number.isFinite(width)) {
          columnWidths[col] = Math.max(24, Math.min(800, Math.round(width)));
        }
      }
    }
    const rows = typeof tab.rows === "number" && Number.isInteger(tab.rows) ? Math.max(1, Math.min(MAX_ROWS, tab.rows)) : DEFAULT_ROWS;
    const cols = typeof tab.cols === "number" && Number.isInteger(tab.cols) ? Math.max(1, Math.min(MAX_COLS, tab.cols)) : DEFAULT_COLS;
    tabs.push({ id: tab.id, name: tab.name.trim(), cells, columnWidths, rows, cols });
  }
  return { ok: true, workbook: { version: 1, title: input.title.trim(), tabs } };
}
