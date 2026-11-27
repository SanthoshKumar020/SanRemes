// The spreadsheet as plain text: what the row's fallback and the bot's context both read.
import { APP_LIMITS } from "../../shared/app.ts";
import {
  cellKey, columnLabel, evaluateTab, formatDisplayValue, rawToText, usedRange, type Workbook,
} from "../../shared/spreadsheet/index.ts";

/** One line per filled row, `A1: value` cells tab-separated, tabs in order; formulas show their calculated value. */
export function spreadsheetPlainText(workbook: Workbook): string {
  const lines: string[] = [];
  for (const tab of workbook.tabs) {
    const { rows, cols } = usedRange(tab);
    if (!rows || !cols) continue;
    lines.push(`${tab.name}:`);
    const grid = evaluateTab(workbook, tab.id);
    for (let row = 0; row < rows; row++) {
      const cells: string[] = [];
      for (let col = 0; col < cols; col++) {
        const cell = tab.cells[cellKey(row, col)];
        if (!cell || cell.raw === null) continue;
        const shown = typeof cell.raw === "string" && cell.raw.startsWith("=")
          ? formatDisplayValue(grid[row]?.[col] ?? null, cell.format ?? "general")
          : rawToText(cell.raw);
        cells.push(`${columnLabel(col)}${row + 1}: ${shown}`);
      }
      if (cells.length) lines.push(cells.join("\t"));
    }
  }
  return lines.join("\n");
}

export function spreadsheetFallbackText(title: string, workbook: Workbook): string {
  const text = spreadsheetPlainText(workbook);
  const body = text ? `[Spreadsheet] ${title}\n${text}` : `[Spreadsheet] ${title}`;
  return body.length <= APP_LIMITS.fallback ? body : `${body.slice(0, APP_LIMITS.fallback - 1).trimEnd()}…`;
}
