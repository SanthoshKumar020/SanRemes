import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

import { DuckDBInstance } from "@duckdb/node-api";

import { createWorkbook, evaluateTab, setCell, type Workbook } from "../../shared/spreadsheet/index.ts";
import { spreadsheetToSelectSql } from "../../server/spreadsheet/export.ts";

/** ZIP reader over the central directory: scanning for local headers misfires on
 *  the same bytes inside compressed data. */
function unzip(buffer: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("No ZIP end-of-central-directory record found.");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Bad ZIP central directory entry.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, data.toString("utf8"));
    else if (method === 8) entries.set(name, inflateRawSync(data).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function put(workbook: Workbook, tabId: string, row: number, col: number, raw: string | number): Workbook {
  const next = setCell(workbook, tabId, row, col, raw);
  if (!next.ok) throw new Error(next.error);
  return next.workbook;
}

export function sampleWorkbook(): Workbook {
  let workbook = createWorkbook("Quarterly Review");
  const tab = workbook.tabs[0]!;
  workbook = put(workbook, tab.id, 0, 0, "Quarter");
  workbook = put(workbook, tab.id, 0, 1, "Revenue");
  workbook = put(workbook, tab.id, 0, 2, "Expenses");
  const rows: Array<[string, number, number]> = [["Q1", 120, 90], ["Q2", 150, 110], ["Q3", 180, 130]];
  rows.forEach(([quarter, revenue, expenses], i) => {
    workbook = put(workbook, tab.id, i + 1, 0, quarter);
    workbook = put(workbook, tab.id, i + 1, 1, revenue);
    workbook = put(workbook, tab.id, i + 1, 2, expenses);
  });
  workbook = put(workbook, tab.id, 4, 0, "Total");
  workbook = put(workbook, tab.id, 4, 1, "=SUM(B2:B4)");
  workbook = put(workbook, tab.id, 4, 2, "=SUM(C2:C4)");
  return workbook;
}

export interface SampleResult {
  path: string;
  bytes: number;
  rows: number;
  revenueTotal: number;
  expensesTotal: number;
}

export async function generateSample(outDir?: string): Promise<SampleResult> {
  const dir = outDir ?? mkdtempSync(join(tmpdir(), "sanremes-excel-sample-"));
  mkdirSync(dir, { recursive: true });
  const workbook = sampleWorkbook();
  const tab = workbook.tabs[0]!;

  const evaluated = evaluateTab(workbook, tab.id);
  const revenueTotal = evaluated[4]?.[1];
  const expensesTotal = evaluated[4]?.[2];
  if (revenueTotal !== 450 || expensesTotal !== 330) {
    throw new Error(`Formulas did not evaluate: expected totals 450 and 330, got ${String(revenueTotal)} and ${String(expensesTotal)}.`);
  }

  const sql = spreadsheetToSelectSql(workbook, tab.name);
  const path = join(dir, "quarterly-review.xlsx");
  const sqlPath = path.replaceAll("'", "''");
  // DuckDB rejects a credentialed proxy URL ("user:pass@host:port") while parsing
  // proxy settings, even though the proxy itself accepts the bare host. Strip
  // the userinfo from the proxy vars so INSTALL can reach the extension
  // repository; the excel extension is downloaded on first use and cached.
  for (const name of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) {
    const value = process.env[name];
    if (!value) continue;
    try {
      const url = new URL(value);
      process.env[name] = `${url.protocol}//${url.host}`;
    } catch {
      delete process.env[name];
    }
  }
  const instance = await DuckDBInstance.create(":memory:");
  try {
    const connection = await instance.connect();
    try {
      await connection.run("INSTALL excel FROM core");
      await connection.run("LOAD excel");
      await connection.run(`COPY (${sql}) TO '${sqlPath}' (FORMAT xlsx, HEADER true)`);
      const readBack = await connection.runAndReadAll(`SELECT * FROM read_xlsx('${sqlPath}')`);
      const rows = readBack.getRowsJS();
      if (rows.length !== 5) throw new Error(`Expected 5 rows back from the .xlsx, found ${rows.length}.`);
      const totalRow = rows[4]!;
      if (Number(totalRow[1]) !== 450 || Number(totalRow[2]) !== 330) {
        throw new Error(`Totals did not read back: expected 450 and 330, got ${String(totalRow[1])} and ${String(totalRow[2])}.`);
      }
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }

  const bytes = readFileSync(path);
  const zip = unzip(bytes);
  const contentTypes = zip.get("[Content_Types].xml") ?? "";
  if (!contentTypes.includes("spreadsheetml")) throw new Error("Generated file is not a .xlsx (no spreadsheetml content type).");
  const sharedStrings = [...zip.values()].join("\n");
  for (const text of ["Quarter", "Revenue", "Total"]) {
    if (!sharedStrings.includes(text)) throw new Error(`Generated spreadsheet is missing ${JSON.stringify(text)}.`);
  }
  return { path, bytes: bytes.length, rows: 5, revenueTotal: 450, expensesTotal: 330 };
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const outDir = process.argv[2];
  generateSample(outDir)
    .then((result) => {
      console.log(
        `Wrote ${result.path} (${result.bytes} bytes, ${result.rows} rows, totals ${result.revenueTotal}/${result.expensesTotal}; parsed back OK).`,
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
