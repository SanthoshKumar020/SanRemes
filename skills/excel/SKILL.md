---
name: excel
description: "Build and export real .xlsx spreadsheets from tables and the spreadsheet model, with formulas evaluated to values. Use when the person asks for a spreadsheet, a workbook, an Excel file, or a table of numbers to work with."
---

# Excel spreadsheets

Build a real `.xlsx` file two ways: from data already loaded (a table or a SELECT) with the Data
export, or from the spreadsheet model — tabs of cells with formulas — with the spreadsheet export.
Both run locally through DuckDB. There is no live-formula export anywhere here: a `.xlsx` file made
by either path holds computed values, never live formulas. Read "Formulas" below before promising
anything that recalculates.

## When to use this skill

- The person asks for a spreadsheet, a workbook, an Excel file, or a table of numbers to work with.
- The person gives rows of data, or a table already loaded, and wants it as `.xlsx`.

Do not use it for a document to read (`word` skill), a printable handout (`pdf` skill), or slides
(`powerpoint` skill). A chart to look at in chat is a dashboard (`data-dashboards` skill), not a sheet.

## The two export paths

### 1. From loaded data: `data_export` with `format: "xlsx"`

Give exactly one of `id` (a chart card's data), `table` (a loaded table) or `sql` (a SELECT). DuckDB
runs `COPY (SELECT * FROM …) TO <path> (FORMAT xlsx, HEADER true)`, so the file's header row is the
real column names. The path must stay inside the bot's working folder or the person's Downloads;
with no path the file goes to Downloads. The tool returns the path, size and row count.

```json
{ "sql": "SELECT quarter, revenue FROM quarterly ORDER BY quarter", "format": "xlsx" }
```

Use this path whenever the data is already a table or a query result: it keeps real headers, real
types and real row counts. Load first with `data_load` when the data starts as a file — it reads
`.xlsx` too (`read_xlsx`, with `sheet` to pick a tab; without `sheet` it loads the first tab).

### 2. From the spreadsheet model: `exportSpreadsheet`

`server/spreadsheet/export.ts` exports a `Workbook` from `shared/spreadsheet/model.ts` — tabs of
sparse cells built with `createWorkbook`, `addTab` and `setCell`. Each tab becomes one SELECT over
`VALUES` (`spreadsheetToSelectSql`) handed to the same DuckDB xlsx export, so one file is written
per tab: a COPY writes a fresh file, so several tabs cannot share one `.xlsx` through this path.
`exportSpreadsheet(ctx, workbook, { format: "xlsx", tab?, path? })` returns one result per tab, each
with its path and size; giving a `path` with more than one tab is an error.

Two things about this path surprise people, so say them upfront:

- The header row of the file is the column letters (`A`, `B`, `C` …), not the sheet's first row.
  A header row typed into the sheet lands as the first data row underneath. For a file with real
  headers, use the `data_export` path above instead.
- Formulas export as their computed values (see "Formulas"). A formula error exports as its error
  text, and a column holding one is exported as text.

`generate-sample.ts`, next to this guide, builds a sample workbook this way: run it with
`node --experimental-strip-types skills/excel/generate-sample.ts [out-dir]` and it evaluates the
formulas, writes the `.xlsx` through an in-memory DuckDB, then reads it back and checks the totals
are really there. With no out-dir it uses a fresh temporary folder and prints the path.

## Editing a sheet

The interactive spreadsheet — editing cells in chat, with the sheet on screen — is the spreadsheet
artifact (`src/components/app/SpreadsheetArtifact.tsx`, shared model in `shared/spreadsheet/`). It is
the path for editing a sheet in place; this skill's export paths stay the way a finished sheet
becomes a file. The component exists, but the bot has no tool to open one in chat yet, so do not
promise the person an interactive sheet until that lands. Exporting an interactive sheet goes
through `POST /api/bots/:botId/spreadsheet/export` (`server/spreadsheet/`), which reuses the Data
export.

Build the workbook with the model in code (`createWorkbook`, `addTab`, `setCell`) and export it. `setCell(workbook, tabId, row, col, raw)` takes a string, number, boolean or null; typing
rules: numbers and `TRUE`/`FALSE` become values, a string starting with `=` is a formula, anything
else is text. A cell can be bold, and its number format one of `general`, `number`, `currency`,
`percent` or `date` (`setCellStyle`).

## Formulas

Formulas live in the spreadsheet model only (`shared/spreadsheet/formula.ts`). They are evaluated
in the app and exported as values — they never reach Excel as formulas.

- Functions, and only these: `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `IF`, `ROUND`, `ABS`.
- Arithmetic `+ - * / ^ %`, text join `&`, comparisons `= <> < <= > >=`, parentheses.
- References: `A1`, `$A$1`, `Sheet1!A1`, `'My Sheet'!A1`; ranges `A1:B2` (at most 100,000 cells).
- A formula is at most 4096 characters and 100 levels deep. A range on its own needs a function
  around it (`SUM(A1:B2)`, not bare `A1:B2`).
- A bad formula is an error value with plain words ("Cannot divide by zero.", "There is no function
  called VLOOKUP. Try SUM, AVERAGE, …"), never a silently wrong number. Circular references are an
  error too.

What this means in practice, and what not to promise:

- No `VLOOKUP`, `XLOOKUP`, `INDEX`, `MATCH`, `TEXT`, `DATE`, `CONCAT`, `IFERROR`, pivot tables,
  conditional formatting, charts inside a sheet, or merged cells. If the person asks for one, say
  plainly it is not supported and offer the closest supported version (usually a `SUM`/`IF` over a
  range, or the `data_export` path from a query that does the lookup in SQL).
- The `.xlsx` the person opens does not recalculate. Changing a value in Excel leaves the totals
  as they were exported. If the person needs a live sheet, say so: the export is a snapshot, and a
  corrected sheet means re-exporting.

```text
A1: Quarter   B1: Revenue   C1: Expenses
A2: Q1        B2: 120       C2: 90
A3: Q2        B3: 150       C3: 110
A4: Q3        B4: 180       C4: 130
A5: Total     B5: =SUM(B2:B4)   C5: =SUM(C2:C4)   → exports as 450 and 330
```

## Limits

- A workbook holds at most 50 tabs; a tab at most 500 rows, 52 columns and 10,000 filled cells.
  Cell text is at most 10,000 characters; a tab name at most 31 characters and never `[ ] : * ? / \`.
- One file per tab through the spreadsheet export; several tabs never share one `.xlsx` there.
- The `data_export` path exports the whole result of its table or SELECT; the sheet model's
  cell limits do not apply on that path.
- No live formulas in any exported file, no charts, no pivot tables, no macros.

## When the input is invalid

- A formula that does not parse, a reference to a missing tab, or a range over 100,000 cells comes
  back as an error value in the cell, not a failed build: read the error words, fix the formula and
  re-export. Do not paste the error text into the sheet as if it were data.
- `exportSpreadsheet` throws when a tab name does not exist, or when a path is given for more than
  one tab: name the tab that is wrong, or export one tab at a time.
- `data_export` throws when more than one of `id`, `table` and `sql` is given, or when the SQL is
  not a SELECT: give exactly one source, and a SELECT only.
- A workbook over the tab, row, column or cell limits is rejected at `setCell`/`addTab` time with a
  plain message: split the data (one tab per file, or aggregate first with a query) rather than
  trimming rows silently.

Never send a half-exported file, and never retry the same invalid input unchanged.
