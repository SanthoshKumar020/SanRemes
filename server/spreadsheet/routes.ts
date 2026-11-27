// One route: export a spreadsheet workbook (sent as JSON) to xlsx or csv
// through the existing Data export. The workbook is validated before any
// file is written; the coordinator mounts this handler in server/index.ts.

import { z } from "zod";

import { workbookFromJson } from "../../shared/spreadsheet/index.ts";
import { dataErrorStatus } from "../data/routes.ts";
import { PASS, type RouteContext, type RouteHandler } from "../routes/table.ts";
import { toDataError, type DataContext } from "../data/tools.ts";
import type { DataError } from "../../shared/data-surface.ts";
import { DataFailure } from "../data/types.ts";
import { exportSpreadsheet } from "./export.ts";

export interface SpreadsheetRouteDeps {
  bot(id: string): { id: string; cwd?: string } | null | undefined;
  context(bot: { id: string; cwd?: string }, signal: AbortSignal): Promise<DataContext>;
  exportWorkbook?: typeof exportSpreadsheet;
}

const ROUTE = /^\/api\/bots\/([\w-]+)\/spreadsheet(?:\/(.+))?$/;

const cellSchema = z.object({
  raw: z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]),
  bold: z.boolean().optional(),
  format: z.enum(["general", "number", "currency", "percent", "date"]).optional(),
}).strict();
const tabSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(31),
  cells: z.record(z.string(), cellSchema),
  columnWidths: z.record(z.string(), z.number().min(20).max(2000)),
  rows: z.number().int().min(1).max(1000),
  cols: z.number().int().min(1).max(104),
}).strict();
const workbookSchema = z.object({
  version: z.literal(1),
  title: z.string().min(1).max(200),
  tabs: z.array(tabSchema).min(1).max(50),
}).strict();
const exportBody = z.object({
  workbook: workbookSchema,
  format: z.enum(["xlsx", "csv"]),
  tab: z.string().min(1).max(31).optional(),
  path: z.string().min(1).max(4000).optional(),
}).strict();

export function createSpreadsheetRoutes(deps: SpreadsheetRouteDeps): RouteHandler {
  const replyError = (ctx: RouteContext, error: DataError) => ctx.json(ctx.res, dataErrorStatus(error.code), { error });
  const invalid = (message: string): DataError => ({ code: "invalid_input", message });
  const runExport = deps.exportWorkbook ?? exportSpreadsheet;

  async function body<T>(ctx: RouteContext, schema: z.ZodType<T>): Promise<T | undefined> {
    let raw: unknown;
    try {
      raw = await ctx.readBody(ctx.req, 1_000_000);
    } catch (error) {
      replyError(ctx, invalid((error as Error).message || "The request body is not JSON."));
      return undefined;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      replyError(ctx, invalid(parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")));
      return undefined;
    }
    return parsed.data;
  }

  return async (ctx) => {
    const match = ROUTE.exec(ctx.path);
    if (!match) return PASS;
    const { res, method } = ctx;
    res.setHeader("cache-control", "no-store");
    const bot = deps.bot(match[1]!);
    if (!bot) return replyError(ctx, { code: "source_not_found", message: "no such bot" });
    const rest = match[2] ?? "";
    if (rest !== "export" || method !== "POST") return PASS;
    const input = await body(ctx, exportBody);
    if (!input) return;
    const parsed = workbookFromJson(JSON.stringify(input.workbook));
    if (!parsed.ok) return replyError(ctx, invalid(parsed.error));
    const abort = new AbortController();
    res.once("close", () => { if (!res.writableEnded) abort.abort(); });
    const context = await deps.context(bot, abort.signal);
    try {
      const exports = await runExport(context, parsed.workbook, {
        format: input.format,
        ...(input.tab ? { tab: input.tab } : {}),
        ...(input.path ? { path: input.path } : {}),
      });
      return ctx.json(res, 200, { exports });
    } catch (error) {
      if (error instanceof DataFailure) return replyError(ctx, toDataError(error, undefined, abort.signal));
      return replyError(ctx, invalid(error instanceof Error ? error.message : String(error)));
    }
  };
}
