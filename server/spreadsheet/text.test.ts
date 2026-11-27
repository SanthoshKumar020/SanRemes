import { describe, expect, it } from "vitest";

import { APP_LIMITS } from "../../shared/app.ts";
import { addTab, createWorkbook, setCell } from "../../shared/spreadsheet/index.ts";
import { spreadsheetFallbackText, spreadsheetPlainText } from "./text.ts";

function budget() {
  const workbook = createWorkbook("Budget");
  const tab = workbook.tabs[0];
  const first = setCell(workbook, tab.id, 0, 0, "Item");
  if (!first.ok) throw new Error("fixture cell failed");
  const second = setCell(first.workbook, tab.id, 0, 1, 12);
  if (!second.ok) throw new Error("fixture cell failed");
  const third = setCell(second.workbook, tab.id, 1, 0, "Total");
  if (!third.ok) throw new Error("fixture cell failed");
  const fourth = setCell(third.workbook, tab.id, 1, 1, "=B1*2");
  if (!fourth.ok) throw new Error("fixture cell failed");
  return fourth.workbook;
}

describe("spreadsheetPlainText", () => {
  it("lists filled rows with calculated values, tabs in order", () => {
    const workbook = budget();
    const text = spreadsheetPlainText(workbook);
    expect(text).toContain("Sheet1");
    expect(text).toContain("A1: Item\tB1: 12");
    expect(text).toContain("A2: Total\tB2: 24");
  });

  it("shows a formula error in plain words, never a wrong number", () => {
    const workbook = budget();
    const tab = workbook.tabs[0];
    const broken = setCell(workbook, tab.id, 2, 0, "=1/0");
    if (!broken.ok) throw new Error("fixture cell failed");
    const text = spreadsheetPlainText(broken.workbook);
    expect(text).toContain("A3: Cannot divide by zero.");
    expect(text).not.toContain("Infinity");
  });

  it("skips empty rows and empty tabs", () => {
    const workbook = createWorkbook("Empty");
    expect(spreadsheetPlainText(workbook)).toBe("");
    const withTab = addTab(workbook, "Notes");
    if (!withTab.ok) throw new Error("fixture tab failed");
    expect(spreadsheetPlainText(withTab.workbook)).toBe("");
  });
});

describe("spreadsheetFallbackText", () => {
  it("names the sheet and carries its text", () => {
    const fallback = spreadsheetFallbackText("Budget", budget());
    expect(fallback).toBe("[Spreadsheet] Budget\nSheet1:\nA1: Item\tB1: 12\nA2: Total\tB2: 24");
  });

  it("falls back to the title alone for an empty sheet", () => {
    expect(spreadsheetFallbackText("Blank", createWorkbook("Blank"))).toBe("[Spreadsheet] Blank");
  });

  it("clips a long sheet to the fallback limit", () => {
    const workbook = createWorkbook("Long");
    const tab = workbook.tabs[0];
    let current = workbook;
    for (let row = 0; row < 200; row++) {
      const next = setCell(current, tab.id, row, 0, `row number ${row} with a longish value`);
      if (!next.ok) throw new Error("fixture cell failed");
      current = next.workbook;
    }
    const fallback = spreadsheetFallbackText("Long", current);
    expect(fallback.length).toBeLessThanOrEqual(APP_LIMITS.fallback);
    expect(fallback).toContain("row number 0");
  });
});
