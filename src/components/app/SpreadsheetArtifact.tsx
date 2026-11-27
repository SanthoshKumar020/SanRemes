import { useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { CellStyleModule, ClientSideRowModelModule, RenderApiModule, RowApiModule, ScrollApiModule, TextEditorModule, TooltipModule, type ColDef, type Column, type GridApi } from "ag-grid-community";
import { Bold, Download, Plus } from "lucide-react";

import {
  addTab,
  columnLabel,
  evaluateTab,
  formatDisplayValue,
  getCell,
  rawToText,
  renameTab,
  setCell,
  setCellStyle,
  setColumnWidth,
  tabById,
  NUMBER_FORMATS,
  type NumberFormat,
  type Workbook,
} from "../../../shared/spreadsheet/index.ts";
import { intlLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Select } from "../Select";
import { gridTheme } from "../data/DataGrid";

const modules = [ClientSideRowModelModule, TextEditorModule, RowApiModule, RenderApiModule, ScrollApiModule, CellStyleModule, TooltipModule];
const defaultColDef: ColDef<SheetRow> = { sortable: false, filter: false, resizable: true, suppressMovable: true };

interface SheetRow {
  __row: number;
  [key: string]: string | number | boolean | null;
}

export interface SpreadsheetArtifactProps {
  workbook: Workbook;
  onChange: (next: Workbook) => void;
  onExport?: (format: "xlsx" | "csv", tabName: string) => void;
  exportState?: "idle" | "working" | "done" | "failed";
  exportMessage?: string;
}

export function SpreadsheetArtifact({ workbook, onChange, onExport, exportState = "idle", exportMessage }: SpreadsheetArtifactProps) {
  const [activeTabId, setActiveTabId] = useState(workbook.tabs[0]?.id ?? "");
  const [selected, setSelected] = useState({ row: 0, col: 0 });
  const [formulaInput, setFormulaInput] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const grid = useRef<GridApi<SheetRow> | null>(null);

  const tab = tabById(workbook, activeTabId) ?? workbook.tabs[0]!;
  const computed = useMemo(() => evaluateTab(workbook, tab.id), [workbook, tab.id]);
  const live = useRef({ workbook, tab, computed, onChange });
  live.current = { workbook, tab, computed, onChange };

  const selectedCell = getCell(tab, selected.row, selected.col);
  useEffect(() => {
    setFormulaInput(rawToText(selectedCell?.raw ?? null));
  }, [selected.row, selected.col, selectedCell?.raw, tab.id]);

  const rowData = useMemo<SheetRow[]>(() => Array.from({ length: tab.rows }, (_, row) => {
    const line: SheetRow = { __row: row };
    for (let col = 0; col < tab.cols; col++) line[`c${col}`] = getCell(tab, row, col)?.raw ?? null;
    return line;
  }), [tab]);

  const widthsKey = JSON.stringify(tab.columnWidths);
  const columnDefs = useMemo<ColDef<SheetRow>[]>(() => Array.from({ length: tab.cols }, (_, col) => ({
    colId: `c${col}`,
    field: `c${col}`,
    headerName: columnLabel(col),
    width: tab.columnWidths[col] ?? 110,
    minWidth: 24,
    editable: true,
    valueFormatter: (params) => {
      const { computed: values, tab: current } = live.current;
      const cell = getCell(current, params.data?.__row ?? 0, col);
      return formatDisplayValue(values[params.data?.__row ?? 0]?.[col] ?? null, cell?.format ?? "general", { locale: intlLocale(), currency: "INR" });
    },
    valueSetter: (params) => {
      const { workbook: current, tab: currentTab, onChange: change } = live.current;
      const next = setCell(current, currentTab.id, params.data?.__row ?? 0, col, params.newValue ?? null);
      if (!next.ok) { setError(next.error); return false; }
      setError(null);
      change(next.workbook);
      return true;
    },
    cellStyle: (params) => {
      const { computed: values, tab: current } = live.current;
      const row = params.data?.__row ?? 0;
      const cell = getCell(current, row, col);
      const align = { textAlign: typeof values[row]?.[col] === "number" ? "right" : "left", fontVariantNumeric: "tabular-nums" };
      return cell?.bold ? { ...align, fontWeight: 600 } : align;
    },
  })), [tab.id, tab.cols, widthsKey]);

  const selectCell = (rowIndex: number | null, column: Column | string | null | undefined) => {
    if (rowIndex === null || !column || typeof column === "string") return;
    setSelected({ row: rowIndex, col: Number(column.getColId().slice(1)) });
  };

  const commitFormulaBar = () => {
    const { workbook: current, tab: currentTab, onChange: change } = live.current;
    const next = setCell(current, currentTab.id, selected.row, selected.col, formulaInput);
    if (!next.ok) { setError(next.error); return; }
    setError(null);
    change(next.workbook);
  };

  const commitRename = () => {
    if (!renaming) return;
    const { workbook: current, onChange: change } = live.current;
    const next = renameTab(current, renaming, renameText);
    setRenaming(null);
    if (!next.ok) { setError(next.error); return; }
    setError(null);
    change(next.workbook);
  };

  const toggleBold = () => {
    const { workbook: current, tab: currentTab, onChange: change } = live.current;
    const next = setCellStyle(current, currentTab.id, selected.row, selected.col, { bold: !selectedCell?.bold });
    if (!next.ok) { setError(next.error); return; }
    setError(null);
    change(next.workbook);
  };

  const changeFormat = (format: NumberFormat) => {
    const { workbook: current, tab: currentTab, onChange: change } = live.current;
    const next = setCellStyle(current, currentTab.id, selected.row, selected.col, { format });
    if (!next.ok) { setError(next.error); return; }
    setError(null);
    change(next.workbook);
  };

  const addNewTab = () => {
    const { workbook: current, onChange: change } = live.current;
    const next = addTab(current);
    if (!next.ok) { setError(next.error); return; }
    setError(null);
    change(next.workbook);
    setActiveTabId(next.value!.id);
  };

  const exporting = exportState === "working";

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-hairline bg-panel text-ink" data-testid="spreadsheet-artifact">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-hairline/40 px-2 py-1">
        <button type="button" className="ui-icon-button" aria-pressed={selectedCell?.bold ?? false} aria-label={t("spreadsheet.bold")} title={t("spreadsheet.bold")} onClick={toggleBold}>
          <Bold size={16} aria-hidden="true" />
        </button>
        <Select
          variant="field" size="sm" className="w-32" aria-label={t("spreadsheet.numberFormat")} title={t("spreadsheet.numberFormat")}
          value={selectedCell?.format ?? "general"}
          onChange={(event) => changeFormat(event.target.value as NumberFormat)}
        >
          {NUMBER_FORMATS.map((format) => (
            <option key={format} value={format}>{t(`spreadsheet.format.${format}`)}</option>
          ))}
        </Select>
        <span className="min-w-0 flex-1" />
        {onExport && (
          <>
            <button type="button" className="ui-button ui-button-sm" disabled={exporting} onClick={() => onExport("xlsx", tab.name)}>
              <Download size={14} aria-hidden="true" />{t("spreadsheet.exportExcel")}
            </button>
            <button type="button" className="ui-button ui-button-sm" disabled={exporting} onClick={() => onExport("csv", tab.name)}>
              <Download size={14} aria-hidden="true" />{t("spreadsheet.exportCsv")}
            </button>
          </>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b border-hairline/40 px-2 py-1">
        <span className="w-12 shrink-0 text-center text-[13px] font-medium text-ink-secondary" aria-hidden="true">
          {`${columnLabel(selected.col)}${selected.row + 1}`}
        </span>
        <label htmlFor="spreadsheet-formula" className="sr-only">{t("spreadsheet.formula")}</label>
        <input
          id="spreadsheet-formula" dir="auto" value={formulaInput}
          className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-2 py-1 font-mono text-[13px] text-ink outline-none focus-visible:border-focus"
          onChange={(event) => setFormulaInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.currentTarget.blur(); }
            if (event.key === "Escape") { setFormulaInput(rawToText(selectedCell?.raw ?? null)); event.currentTarget.blur(); }
          }}
          onBlur={commitFormulaBar}
        />
      </div>
      <div className="min-h-0 flex-1" data-testid="spreadsheet-grid" role="region" aria-label={workbook.title}>
        <AgGridReact<SheetRow>
          modules={modules} theme={gridTheme} loadThemeGoogleFonts={false}
          columnDefs={columnDefs} defaultColDef={defaultColDef} rowData={rowData}
          rowHeight={32} headerHeight={36} animateRows={false} enableCellTextSelection={true} ensureDomOrder={true}
          onGridReady={({ api }) => { grid.current = api; }}
          onGridPreDestroyed={({ api }) => { if (grid.current === api) grid.current = null; }}
          onCellFocused={({ rowIndex, column }) => selectCell(rowIndex, column)}
          onCellClicked={({ rowIndex, column }) => selectCell(rowIndex, column)}
          onColumnResized={({ column, finished }) => {
            if (!finished || !column || typeof column === "string") return;
            const { workbook: current, tab: currentTab, onChange: change } = live.current;
            const next = setColumnWidth(current, currentTab.id, Number(column.getColId().slice(1)), column.getActualWidth());
            if (next.ok) change(next.workbook);
          }}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-hairline/40 px-2 py-1" role="tablist" aria-label={workbook.title}>
        {workbook.tabs.map((entry) => (
          renaming === entry.id ? (
            <input
              key={entry.id} autoFocus value={renameText} dir="auto" aria-label={t("spreadsheet.renameTab")}
              className="h-7 w-28 rounded-lg border border-hairline/40 bg-inset px-2 text-[13px] text-ink outline-none focus-visible:border-focus"
              onChange={(event) => setRenameText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitRename();
                if (event.key === "Escape") setRenaming(null);
              }}
              onBlur={commitRename}
            />
          ) : (
            <button
              key={entry.id} type="button" role="tab" aria-selected={entry.id === tab.id}
              className={cn("h-7 shrink-0 rounded-full px-3 text-[13px]", entry.id === tab.id ? "bg-ink/[0.08] font-medium text-ink" : "text-ink-secondary hover:bg-ink/[0.06]")}
              onClick={() => { setActiveTabId(entry.id); setSelected({ row: 0, col: 0 }); }}
              onDoubleClick={() => { setRenaming(entry.id); setRenameText(entry.name); }}
            >
              {entry.name}
            </button>
          )
        ))}
        <button type="button" className="ui-icon-button" aria-label={t("spreadsheet.addTab")} title={t("spreadsheet.addTab")} onClick={addNewTab}>
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      {(error || exportMessage || exporting) && (
        <div className="flex shrink-0 items-center border-t border-hairline/40 px-3 py-1 text-[12px]">
          {error
            ? <span role="alert" className="text-danger">{error}</span>
            : exporting
              ? <span role="status" className="text-ink-secondary">{t("spreadsheet.exporting")}</span>
              : <span role="status" className="text-ink-secondary">{exportMessage}</span>}
        </div>
      )}
    </div>
  );
}
