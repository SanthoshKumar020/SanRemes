// Spreadsheet export through the existing Data export: each tab becomes one
// SELECT over VALUES (computed values only, never raw formulas) handed to
// exportData, which runs DuckDB COPY ... (FORMAT xlsx, HEADER true) or
// (FORMAT csv, HEADER true). One file per tab: a COPY writes a fresh file,
// so several tabs cannot share one .xlsx through this path.

import { columnLabel, evaluateTab, isFormulaError, shortNumber, tabByName, usedRange, type ComputedValue, type Workbook } from "../../shared/spreadsheet/index.ts";
import { exportData, tableNameFrom, type DataContext, type ExportInput, type ExportOutput } from "../data/tools.ts";

type ColumnKind = "number" | "boolean" | "text";

function sqlString(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function columnKind(values: ComputedValue[]): ColumnKind {
  const filled = values.filter((value) => value !== null);
  if (filled.some((value) => isFormulaError(value))) return "text";
  if (filled.length && filled.every((value) => typeof value === "number")) return "number";
  if (filled.length && filled.every((value) => typeof value === "boolean")) return "boolean";
  return "text";
}

function sqlLiteral(value: ComputedValue, kind: ColumnKind): string {
  if (value === null) return "NULL";
  if (isFormulaError(value)) return sqlString(value.message);
  if (kind === "number") return shortNumber(value as number);
  if (kind === "boolean") return (value as boolean) ? "TRUE" : "FALSE";
  if (typeof value === "number") return sqlString(shortNumber(value));
  if (typeof value === "boolean") return sqlString(value ? "TRUE" : "FALSE");
  return sqlString(value);
}

/** One SELECT over the tab's used rectangle, with column letters as headers. */
export function spreadsheetToSelectSql(workbook: Workbook, tabName: string): string {
  const tab = tabByName(workbook, tabName);
  if (!tab) throw new Error(`There is no tab named "${tabName}".`);
  const { rows, cols } = usedRange(tab);
  if (!rows || !cols) return `SELECT * FROM (VALUES (NULL)) AS t("A") WHERE false`;
  const grid = evaluateTab(workbook, tab.id);
  const kinds: ColumnKind[] = [];
  for (let col = 0; col < cols; col++) {
    kinds.push(columnKind(grid.map((line) => line[col]!)));
  }
  const aliases = Array.from({ length: cols }, (_, col) => `"${columnLabel(col)}"`).join(", ");
  const lines = grid.slice(0, rows).map((line) =>
    `(${line.slice(0, cols).map((value, col) => sqlLiteral(value, kinds[col]!)).join(", ")})`,
  );
  return `SELECT * FROM (VALUES ${lines.join(", ")}) AS t(${aliases})`;
}

export interface SpreadsheetExportItem {
  tabName: string;
  sql: string;
  filename: string;
  rows: number;
  cols: number;
}

export function spreadsheetExportPlan(workbook: Workbook, options: { tab?: string } = {}): SpreadsheetExportItem[] {
  const tabs = options.tab ? [tabByName(workbook, options.tab)] : workbook.tabs;
  if (options.tab && !tabs[0]) throw new Error(`There is no tab named "${options.tab}".`);
  return (tabs as NonNullable<typeof tabs[number]>[]).map((tab) => {
    const { rows, cols } = usedRange(tab);
    return {
      tabName: tab.name,
      sql: spreadsheetToSelectSql(workbook, tab.name),
      filename: `${tableNameFrom(workbook.title)}-${tableNameFrom(tab.name)}`,
      rows,
      cols,
    };
  });
}

export interface SpreadsheetExportResult {
  tab: string;
  path: string;
  bytes: number;
  rowCount?: number;
}

export type ExportOne = (ctx: DataContext, input: ExportInput) => Promise<ExportOutput>;

/** One file per tab, named after the workbook and the tab. */
export async function exportSpreadsheet(
  ctx: DataContext,
  workbook: Workbook,
  options: { format: "xlsx" | "csv"; tab?: string; path?: string },
  exportOne: ExportOne = exportData,
): Promise<SpreadsheetExportResult[]> {
  const plan = spreadsheetExportPlan(workbook, options);
  if (options.path !== undefined && plan.length > 1) {
    throw new Error("Give one tab when you give a file path.");
  }
  const results: SpreadsheetExportResult[] = [];
  for (const item of plan) {
    const exported = await exportOne(ctx, {
      sql: item.sql,
      format: options.format,
      path: options.path ?? item.filename,
    });
    results.push({ tab: item.tabName, ...exported });
  }
  return results;
}
