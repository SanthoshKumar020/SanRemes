import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createWorkbook, setCell, workbookToJson } from "../../shared/spreadsheet/index.ts";
import { json, readBody } from "../harness/http.ts";
import { dispatchRoutes } from "../routes/table.ts";
import type { DataContext } from "../data/tools.ts";
import { createSpreadsheetRoutes } from "./routes.ts";
import type { SpreadsheetExportResult } from "./export.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

function workbook() {
  let book = createWorkbook("Budget");
  const tab = book.tabs[0]!;
  const next = setCell(book, tab.id, 0, 0, 42);
  if (next.ok) book = next.workbook;
  return JSON.parse(workbookToJson(book)) as unknown;
}

async function serve(exportWorkbook?: (ctx: DataContext, workbook: unknown, options: unknown) => Promise<SpreadsheetExportResult[]>) {
  const calls: unknown[] = [];
  const stub = exportWorkbook ?? (async (_ctx: DataContext, _workbook: unknown, options: unknown) => {
    calls.push(options);
    return [{ tab: "Sheet1", path: "/tmp/work/budget-sheet1.xlsx", bytes: 10, rowCount: 1 }];
  });
  const routes = [createSpreadsheetRoutes({
    bot: (id) => (id === "bot-1" ? { id, cwd: "/tmp/work" } : undefined),
    context: async () => ({}) as DataContext,
    exportWorkbook: stub as never,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] } as never, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
  await new Promise<void>((done) => server.listen(0, done));
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  return { port, calls };
}

async function post(port: number, path: string, body: unknown) {
  const response = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("spreadsheet routes", () => {
  it("exports a workbook to xlsx and reports the written files", async () => {
    const { port, calls } = await serve();
    const { status, body } = await post(port, "/api/bots/bot-1/spreadsheet/export", { workbook: workbook(), format: "xlsx" });
    expect(status).toBe(200);
    expect(body).toEqual({ exports: [{ tab: "Sheet1", path: "/tmp/work/budget-sheet1.xlsx", bytes: 10, rowCount: 1 }] });
    expect(calls).toEqual([{ format: "xlsx" }]);
  });

  it("refuses a workbook made by a newer version", async () => {
    const { port } = await serve();
    const bad = workbook() as Record<string, unknown>;
    bad.version = 2;
    const { status, body } = await post(port, "/api/bots/bot-1/spreadsheet/export", { workbook: bad, format: "csv" });
    expect(status).toBe(400);
    expect((body.error as Record<string, unknown>).code).toBe("invalid_input");
  });

  it("refuses an unknown bot and an unknown path", async () => {
    const { port } = await serve();
    const unknown = await post(port, "/api/bots/nope/spreadsheet/export", { workbook: workbook(), format: "xlsx" });
    expect(unknown.status).toBe(404);
    const response = await fetch(`http://localhost:${port}/api/bots/bot-1/spreadsheet/other`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(404);
  });

  it("passes a workbook error from the exporter as a plain 400", async () => {
    const { port } = await serve(async () => { throw new Error("Give one tab when you give a file path."); });
    const { status, body } = await post(port, "/api/bots/bot-1/spreadsheet/export", { workbook: workbook(), format: "xlsx", path: "one.xlsx" });
    expect(status).toBe(400);
    expect((body.error as Record<string, unknown>).message).toBe("Give one tab when you give a file path.");
  });
});
