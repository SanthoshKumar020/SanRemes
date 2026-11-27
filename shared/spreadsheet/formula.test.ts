import { describe, expect, it } from "vitest";

import {
  columnLabel,
  evaluateFormulaText,
  formatCellRef,
  isFormulaError,
  parseCellRef,
  parseColumnLabel,
  parseFormula,
  type ComputedValue,
  type FormulaResolver,
} from "./formula.ts";

function resolver(cells: Record<string, ComputedValue>): FormulaResolver {
  return {
    sheetName: "Sheet1",
    cell: (ref) => cells[formatCellRef(ref)] ?? null,
    range: (range) => {
      const values: ComputedValue[] = [];
      for (let row = range.startRow; row <= range.endRow; row++) {
        for (let col = range.startCol; col <= range.endCol; col++) {
          values.push(cells[formatCellRef({ row, col })] ?? null);
        }
      }
      return values;
    },
  };
}

const value = (text: string, cells: Record<string, ComputedValue> = {}) => evaluateFormulaText(text, resolver(cells));
const errorMessage = (text: string, cells: Record<string, ComputedValue> = {}): string => {
  const result = value(text, cells);
  expect(isFormulaError(result)).toBe(true);
  return (result as { message: string }).message;
};

describe("cell references", () => {
  it.each([
    [0, "A"],
    [25, "Z"],
    [26, "AA"],
    [27, "AB"],
    [51, "AZ"],
    [52, "BA"],
    [701, "ZZ"],
    [702, "AAA"],
  ])("labels column %s as %s", (index, label) => {
    expect(columnLabel(index)).toBe(label);
    expect(parseColumnLabel(label)).toBe(index);
  });

  it("reads plain, absolute and tab-qualified references", () => {
    expect(parseCellRef("A1")).toEqual({ row: 0, col: 0 });
    expect(parseCellRef("$B$12")).toEqual({ row: 11, col: 1 });
    expect(parseCellRef("Sheet2!C3")).toEqual({ sheet: "Sheet2", row: 2, col: 2 });
    expect(parseCellRef("'My Sheet'!A1")).toEqual({ sheet: "My Sheet", row: 0, col: 0 });
    expect(parseCellRef("A0")).toBeNull();
    expect(parseCellRef("A1048577")).toBeNull();
    expect(parseCellRef("Hello")).toBeNull();
    expect(formatCellRef({ sheet: "My Sheet", row: 0, col: 0 })).toBe("'My Sheet'!A1");
  });
});

describe("arithmetic", () => {
  it("follows precedence, brackets and unary minus", () => {
    expect(value("=1+2*3")).toBe(7);
    expect(value("=(1+2)*3")).toBe(9);
    expect(value("=2^3^2")).toBe(512);
    expect(value("=-2^2")).toBe(-4);
    expect(value("=2^-2")).toBe(0.25);
    expect(value("=10/4")).toBe(2.5);
    expect(value("=50%")).toBe(0.5);
    expect(value("=200*10%")).toBe(20);
  });

  it("concatenates with & and compares values", () => {
    expect(value('="Total: "&42')).toBe("Total: 42");
    expect(value("=1<2")).toBe(true);
    expect(value("=2<=2")).toBe(true);
    expect(value('="a"="A"')).toBe(true);
    expect(value('="b">"a"')).toBe(true);
    expect(value("=1<>1")).toBe(false);
    expect(value("=1+2=3")).toBe(true);
  });

  it("reads references and empty cells as zero in arithmetic", () => {
    expect(value("=A1+1", { A1: 41 })).toBe(42);
    expect(value("=A1+1")).toBe(1);
    expect(value("=$A$1*2", { A1: 21 })).toBe(42);
    expect(value('="5"+1')).toBe(6);
    expect(value("=TRUE+1")).toBe(2);
  });

  it("reports plain-words errors instead of wrong values", () => {
    expect(errorMessage("=1/0")).toBe("Cannot divide by zero.");
    expect(errorMessage('="abc"+1')).toBe('"abc" is text, not a number.');
    expect(errorMessage("=A1+1", { A1: "abc" })).toBe('"abc" is text, not a number.');
    expect(errorMessage("=NOSUCH(1)")).toContain("There is no function called NOSUCH.");
    expect(errorMessage("=A1:B2")).toContain("needs a function such as SUM");
    expect(errorMessage("=1+")).toContain("ends before a value");
    expect(errorMessage("=(1+2")).toBe("Missing closing bracket.");
    expect(errorMessage("1+1")).toBe("A formula starts with =.");
    expect(errorMessage("=")).toBe("The formula is empty.");
    expect(errorMessage('="open')).toContain("closing quote");
    expect(parseFormula("=SUM(A1;B1)")).toMatchObject({ ok: true });
  });
});

describe("functions", () => {
  const numbers = { A1: 1, A2: 2, A3: 3, B1: "text", B2: true, B3: null };

  it("sums, averages and finds extremes over ranges", () => {
    expect(value("=SUM(A1:A3)", numbers)).toBe(6);
    expect(value("=SUM(A1:A3,B1:B3)", numbers)).toBe(6);
    expect(value("=AVERAGE(A1:A3)", numbers)).toBe(2);
    expect(value("=MIN(A1:A3)", numbers)).toBe(1);
    expect(value("=MAX(A1:A3)", numbers)).toBe(3);
    expect(value("=MIN(B1:B3)", numbers)).toBe(0);
    expect(value("=SUM(1,2,3)")).toBe(6);
    expect(value('=SUM("5",5)')).toBe(10);
  });

  it("counts numbers and non-empty cells", () => {
    expect(value("=COUNT(A1:A3)", numbers)).toBe(3);
    expect(value("=COUNT(A1:B3)", numbers)).toBe(3);
    expect(value("=COUNTA(A1:B3)", numbers)).toBe(5);
    expect(value("=COUNTA(A1)", numbers)).toBe(1);
    expect(value("=COUNTA(B3)", numbers)).toBe(0);
  });

  it("averages nothing as an error and rejects text it cannot use", () => {
    expect(errorMessage("=AVERAGE(B1:B1)", numbers)).toBe("AVERAGE has no numbers to average.");
    expect(errorMessage('=SUM("abc")')).toContain("is text, not a number.");
    expect(errorMessage("=SUM()")).toContain("needs 1 to 255 values");
  });

  it("branches on IF and rounds and takes absolute values", () => {
    expect(value("=IF(A2>1,10,20)", numbers)).toBe(10);
    expect(value("=IF(A1>5,10,20)", numbers)).toBe(20);
    expect(value("=IF(TRUE,1)")).toBe(1);
    expect(value("=IF(FALSE,1)")).toBe(false);
    expect(value("=ROUND(3.567,2)")).toBe(3.57);
    expect(value("=ROUND(3.5)")).toBe(4);
    expect(value("=ROUND(-3.5)")).toBe(-4);
    expect(value("=ABS(0-7)")).toBe(7);
    expect(errorMessage("=IF(1)")).toContain("needs 2 to 3 values");
    expect(errorMessage('=IF("maybe",1,2)')).toBe("IF needs a true/false value.");
  });

  it("propagates a referenced cell's error unchanged", () => {
    const bad = { kind: "formula-error", message: "Cannot divide by zero." } as const;
    expect(value("=A1+1", { A1: bad })).toEqual(bad);
    expect(value("=SUM(A1:A2)", { A1: 1, A2: bad })).toEqual(bad);
  });
});
