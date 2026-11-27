import { describe, expect, it } from "vitest";

import {
  addTab,
  createWorkbook,
  evaluateTab,
  formatDisplayValue,
  getCell,
  rawToText,
  renameTab,
  setCell,
  setCellStyle,
  setColumnWidth,
  usedRange,
  workbookFromJson,
  workbookToJson,
  type Workbook,
} from "./model.ts";
import { isFormulaError } from "./formula.ts";

function filled(): Workbook {
  let book = createWorkbook("Budget");
  const tab = book.tabs[0]!;
  const set = (row: number, col: number, raw: string | number) => {
    const next = setCell(book, tab.id, row, col, raw);
    expect(next.ok).toBe(true);
    if (next.ok) book = next.workbook;
  };
  set(0, 0, 10);
  set(1, 0, 20);
  set(2, 0, "=SUM(A1:A2)");
  set(3, 0, "=A3*2");
  set(0, 1, "Rent");
  return book;
}

describe("cells and typing", () => {
  it("stores typed numbers, booleans and text as values", () => {
    let book = createWorkbook();
    const tab = book.tabs[0]!;
    for (const [raw, want] of [["42", 42], ["3.5", 3.5], ["TRUE", true], ["false", false], ["hello", "hello"], ["001", 1]] as const) {
      const next = setCell(book, tab.id, 0, 0, raw);
      expect(next.ok).toBe(true);
      if (next.ok) book = next.workbook;
      expect(getCell(book.tabs[0]!, 0, 0)?.raw).toBe(want);
    }
  });

  it("clears a cell on empty input and grows the grid", () => {
    let book = createWorkbook();
    const tab = book.tabs[0]!;
    const set = setCell(book, tab.id, 150, 30, "x");
    expect(set.ok).toBe(true);
    if (set.ok) book = set.workbook;
    expect(book.tabs[0]!.rows).toBe(151);
    expect(book.tabs[0]!.cols).toBe(31);
    const cleared = setCell(book, tab.id, 150, 30, "   ");
    expect(cleared.ok).toBe(true);
    if (cleared.ok) book = cleared.workbook;
    expect(getCell(book.tabs[0]!, 150, 30)).toBeUndefined();
  });

  it("refuses cells outside the sheet and overlong formulas", () => {
    const book = createWorkbook();
    const tab = book.tabs[0]!;
    expect(setCell(book, tab.id, 500, 0, 1)).toMatchObject({ ok: false, error: expect.stringContaining("500 rows") });
    expect(setCell(book, tab.id, 0, 52, 1)).toMatchObject({ ok: false, error: expect.stringContaining("52 columns") });
    expect(setCell(book, tab.id, 0, 0, `=${"1+".repeat(3000)}1`)).toMatchObject({ ok: false, error: expect.stringContaining("too long") });
  });
});

describe("evaluation", () => {
  it("evaluates formulas, chains and cross-tab references", () => {
    const book = filled();
    const tab = book.tabs[0]!;
    const grid = evaluateTab(book, tab.id);
    expect(grid[2]![0]).toBe(30);
    expect(grid[3]![0]).toBe(60);
    expect(grid[0]![1]).toBe("Rent");
    const added = addTab(book, "Second");
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const second = added.workbook.tabs[1]!;
    const linked = setCell(added.workbook, second.id, 0, 0, "=Sheet1!A3+1");
    expect(linked.ok).toBe(true);
    if (linked.ok) expect(evaluateTab(linked.workbook, second.id)[0]![0]).toBe(31);
  });

  it("reports circular references and missing tabs in plain words", () => {
    let book = createWorkbook();
    const tab = book.tabs[0]!;
    for (const [row, col, raw] of [[0, 0, "=B1"], [0, 1, "=A1"]] as const) {
      const next = setCell(book, tab.id, row, col, raw as string);
      if (next.ok) book = next.workbook;
    }
    const grid = evaluateTab(book, tab.id);
    expect(isFormulaError(grid[0]![0])).toBe(true);
    expect((grid[0]![0] as { message: string }).message).toContain("Circular reference");
    const missing = setCell(book, tab.id, 5, 0, "=Nope!A1+1");
    expect(missing.ok).toBe(true);
    if (missing.ok) {
      const value = evaluateTab(missing.workbook, tab.id)[5]![0];
      expect((value as { message: string }).message).toBe('There is no tab named "Nope".');
    }
  });

  it("keeps a referenced cell's error instead of inventing a value", () => {
    let book = createWorkbook();
    const tab = book.tabs[0]!;
    const bad = setCell(book, tab.id, 0, 0, "=1/0");
    if (bad.ok) book = bad.workbook;
    const dep = setCell(book, tab.id, 1, 0, "=A1+1");
    if (dep.ok) book = dep.workbook;
    const grid = evaluateTab(book, tab.id);
    expect((grid[1]![0] as { message: string }).message).toBe("Cannot divide by zero.");
  });
});

describe("tabs", () => {
  it("adds numbered tabs and validates names", () => {
    let book = createWorkbook();
    const first = addTab(book);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value!.name).toBe("Sheet2");
      book = first.workbook;
    }
    expect(addTab(book, "sheet2")).toMatchObject({ ok: false, error: expect.stringContaining("already a tab") });
    expect(addTab(book, "Bad/Name")).toMatchObject({ ok: false, error: expect.stringContaining("cannot contain") });
    expect(addTab(book, "   ").ok).toBe(true);
    expect(renameTab(book, book.tabs[0]!.id, "   ")).toMatchObject({ ok: false, error: expect.stringContaining("needs a name") });
    const renamed = renameTab(book, book.tabs[0]!.id, "Budget 2026");
    expect(renamed.ok).toBe(true);
    if (renamed.ok) expect(renamed.value!.name).toBe("Budget 2026");
  });
});

describe("formatting", () => {
  it("stores bold and number formats per cell", () => {
    let book = filled();
    const tab = book.tabs[0]!;
    const styled = setCellStyle(book, tab.id, 0, 0, { bold: true, format: "currency" });
    expect(styled.ok).toBe(true);
    if (styled.ok) book = styled.workbook;
    expect(getCell(book.tabs[0]!, 0, 0)).toMatchObject({ raw: 10, bold: true, format: "currency" });
    const plain = setCellStyle(book, tab.id, 0, 0, { bold: false });
    if (plain.ok) book = plain.workbook;
    expect(getCell(book.tabs[0]!, 0, 0)?.bold).toBeUndefined();
  });

  it("formats numbers, percents, currency and dates for display", () => {
    expect(formatDisplayValue(1234.5, "number", { locale: "en-US" })).toBe("1,234.50");
    expect(formatDisplayValue(0.25, "percent", { locale: "en-US" })).toBe("25%");
    expect(formatDisplayValue(1234.5, "currency", { locale: "en-IN", currency: "INR" })).toContain("1,234.50");
    expect(formatDisplayValue(0.30000000000000004, "general")).toBe("0.3");
    expect(formatDisplayValue(44927, "date", { locale: "en-GB" })).toBe("1 Jan 2023");
    expect(formatDisplayValue("2026-11-28", "date", { locale: "en-GB" })).toBe("28 Nov 2026");
    expect(formatDisplayValue(true, "general")).toBe("TRUE");
    expect(formatDisplayValue(null, "general")).toBe("");
    expect(rawToText(true)).toBe("TRUE");
    expect(rawToText("=SUM(A1:A2)")).toBe("=SUM(A1:A2)");
  });

  it("stores column widths, clamped to the allowed range", () => {
    let book = createWorkbook();
    const tab = book.tabs[0]!;
    const wide = setColumnWidth(book, tab.id, 0, 5000);
    expect(wide.ok).toBe(true);
    if (wide.ok) expect(wide.workbook.tabs[0]!.columnWidths[0]).toBe(800);
    const narrow = setColumnWidth(book, tab.id, 1, 1);
    if (narrow.ok) expect(narrow.workbook.tabs[0]!.columnWidths[1]).toBe(24);
  });
});

describe("serialization", () => {
  it("round-trips through JSON with values and styles intact", () => {
    const book = filled();
    const parsed = workbookFromJson(workbookToJson(book));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.workbook.title).toBe("Budget");
    expect(evaluateTab(parsed.workbook, parsed.workbook.tabs[0]!.id)[2]![0]).toBe(30);
  });

  it("rejects damaged or out-of-range workbooks in plain words", () => {
    expect(workbookFromJson("not json")).toMatchObject({ ok: false });
    expect(workbookFromJson(JSON.stringify({ version: 2, title: "x", tabs: [] }))).toMatchObject({
      ok: false, error: "This spreadsheet was made by a newer version.",
    });
    expect(workbookFromJson(JSON.stringify({ version: 1, title: "x", tabs: [] }))).toMatchObject({
      ok: false, error: expect.stringContaining("1 to 50 tabs"),
    });
    const duplicate = createWorkbook();
    duplicate.tabs.push({ ...duplicate.tabs[0]!, id: "tab-other" });
    expect(workbookFromJson(workbookToJson(duplicate))).toMatchObject({ ok: false, error: expect.stringContaining("already a tab") });
  });

  it("trims the used range to filled cells", () => {
    const book = filled();
    expect(usedRange(book.tabs[0]!)).toEqual({ rows: 4, cols: 2 });
    expect(usedRange(createWorkbook().tabs[0]!)).toEqual({ rows: 0, cols: 0 });
  });
});
