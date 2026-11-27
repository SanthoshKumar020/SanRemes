// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { addTab, createWorkbook, setCell, type Workbook } from "../../../shared/spreadsheet/index.ts";
import { SpreadsheetArtifact } from "./SpreadsheetArtifact";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fixture(): Workbook {
  let book = createWorkbook("Budget");
  const tab = book.tabs[0]!;
  const set = (row: number, col: number, raw: string | number) => {
    const next = setCell(book, tab.id, row, col, raw);
    if (next.ok) book = next.workbook;
  };
  set(0, 0, 10);
  set(1, 0, 20);
  set(2, 0, "=SUM(A1:A2)");
  const added = addTab(book, "Second");
  if (added.ok) book = added.workbook;
  return book;
}

describe("SpreadsheetArtifact", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(360);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  const render = (props: Partial<React.ComponentProps<typeof SpreadsheetArtifact>> = {}) => {
    const onChange = props.onChange ?? (() => {});
    flushSync(() => {
      root.render(createElement(SpreadsheetArtifact, { workbook: fixture(), onChange, ...props }));
    });
  };
  const formulaBar = () => host.querySelector<HTMLInputElement>("#spreadsheet-formula")!;

  it("shows tabs and the computed value of a formula cell", async () => {
    render();
    await vi.waitFor(() => expect(host.querySelector('[role="grid"]')).not.toBeNull());
    expect(host.textContent).toContain("Sheet1");
    expect(host.textContent).toContain("Second");
    await vi.waitFor(() => expect(host.querySelector('.ag-row[row-index="2"] .ag-cell')?.textContent).toBe("30"));
    expect(formulaBar().value).toBe("10");
  });

  it("shows the raw formula in the formula bar when its cell is selected", async () => {
    render();
    await vi.waitFor(() => expect(host.querySelector('.ag-row[row-index="2"] .ag-cell')).not.toBeNull());
    const cell = host.querySelector<HTMLElement>('.ag-row[row-index="2"] .ag-cell')!;
    flushSync(() => cell.click());
    await vi.waitFor(() => expect(formulaBar().value).toBe("=SUM(A1:A2)"));
  });

  it("asks the parent to export the active tab, and to add a tab", async () => {
    const onExport = vi.fn();
    const onChange = vi.fn();
    render({ onExport, onChange });
    await vi.waitFor(() => expect(host.querySelector('[role="grid"]')).not.toBeNull());
    const buttons = [...host.querySelectorAll("button")];
    const excel = buttons.find((button) => button.textContent === "Excel")!;
    flushSync(() => excel.click());
    expect(onExport).toHaveBeenCalledWith("xlsx", "Sheet1");
    const add = host.querySelector<HTMLButtonElement>('button[aria-label="Add tab"]')!;
    flushSync(() => add.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0]![0] as Workbook).tabs).toHaveLength(3);
  });
});
