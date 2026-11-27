import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { addTab, createWorkbook, setCell, type Workbook } from "../../shared/spreadsheet/index.ts";
import { FakeDataDatabase } from "../testing/fake-data-database.ts";
import { DataSheetStore } from "../data/sheet.ts";
import { type DataContext } from "../data/tools.ts";
import { exportSpreadsheet, spreadsheetExportPlan, spreadsheetToSelectSql } from "./export.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function context() {
  const dir = mkdtempSync(join(tmpdir(), "sanremes-spreadsheet-export-"));
  dirs.push(dir);
  mkdirSync(join(dir, "work"), { recursive: true });
  const database = new FakeDataDatabase();
  const ctx: DataContext = {
    database,
    sheet: new DataSheetStore({ botId: "bot-1", dir: join(dir, "sheet"), dropResult: (name) => database.dropResult(name) }),
    compileChart: () => { throw new Error("unused"); },
    validateVegaLite: async (spec) => spec as Record<string, unknown>,
    renderer: { svg: async () => "", png: async () => Buffer.from("") },
    exportRoots: () => [join(dir, "work")],
    signal: new AbortController().signal,
    connection: "panel",
    by: "person",
  };
  return { ctx, database, dir };
}

function filled(): Workbook {
  let book = createWorkbook("Budget");
  const tab = book.tabs[0]!;
  const set = (row: number, col: number, raw: string | number | boolean) => {
    const next = setCell(book, tab.id, row, col, raw);
    if (next.ok) book = next.workbook;
  };
  set(0, 0, "Item");
  set(0, 1, "Cost");
  set(1, 0, "Rent");
  set(1, 1, 1200);
  set(2, 0, "Total");
  set(2, 1, "=SUM(B2:B2)");
  set(3, 0, "It's");
  set(3, 1, true);
  return book;
}

describe("spreadsheetToSelectSql", () => {
  it("exports computed values, not formulas, with typed columns", () => {
    const sql = spreadsheetToSelectSql(filled(), "Sheet1");
    expect(sql).toBe(
      `SELECT * FROM (VALUES ('Item', 'Cost'), ('Rent', '1200'), ('Total', '1200'), ('It''s', 'TRUE')) AS t("A", "B")`,
    );
  });

  it("exports formula errors as their plain-words message, never a wrong value", () => {
    let book = createWorkbook("Errors");
    const tab = book.tabs[0]!;
    const bad = setCell(book, tab.id, 0, 0, "=1/0");
    if (bad.ok) book = bad.workbook;
    const next = setCell(book, tab.id, 1, 0, 5);
    if (next.ok) book = next.workbook;
    expect(spreadsheetToSelectSql(book, "Sheet1")).toBe(
      `SELECT * FROM (VALUES ('Cannot divide by zero.'), ('5')) AS t("A")`,
    );
  });

  it("exports an empty tab as a header-only select and refuses unknown tabs", () => {
    expect(spreadsheetToSelectSql(createWorkbook("Empty"), "Sheet1")).toBe(
      `SELECT * FROM (VALUES (NULL)) AS t("A") WHERE false`,
    );
    expect(() => spreadsheetToSelectSql(createWorkbook("Empty"), "Nope")).toThrow('There is no tab named "Nope".');
  });

  it("plans one file per tab, named after the workbook and the tab", () => {
    const plan = spreadsheetExportPlan(filled());
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ tabName: "Sheet1", filename: "budget-sheet1", rows: 4, cols: 2 });
  });
});

describe("exportSpreadsheet", () => {
  it("writes one xlsx per tab through the existing export path", async () => {
    const { ctx, database, dir } = context();
    const results = await exportSpreadsheet(ctx, filled(), { format: "xlsx" });
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe(join(dir, "work", "budget-sheet1.xlsx"));
    expect(existsSync(results[0]!.path)).toBe(true);
    expect(results[0]!.rowCount).toBe(2);
    const copy = database.calls.find((call) => call.sql?.startsWith("COPY ") ?? false)!;
    expect(copy.sql).toContain("(FORMAT xlsx, HEADER true)");
    expect(copy.sql).toContain("VALUES ('Item', 'Cost')");
  });

  it("writes csv the same way, and honours a single-tab path", async () => {
    const { ctx, dir } = context();
    const results = await exportSpreadsheet(ctx, filled(), { format: "csv", path: join(dir, "work", "totals") });
    expect(results[0]!.path).toBe(join(dir, "work", "totals.csv"));
    expect(existsSync(results[0]!.path)).toBe(true);
  });

  it("refuses one path for several tabs", async () => {
    const { ctx } = context();
    let book = filled();
    const added = addTab(book, "Second");
    if (added.ok) book = added.workbook;
    await expect(exportSpreadsheet(ctx, book, { format: "xlsx", path: "one.xlsx" })).rejects.toThrow(
      "Give one tab when you give a file path.",
    );
  });
});
