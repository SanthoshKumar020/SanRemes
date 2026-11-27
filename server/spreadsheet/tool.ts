// The show_spreadsheet bot tool: a spreadsheet as an app row. The driver builds the workbook from the
// tool's arguments and posts it through the same internal route show_html uses, so the sheet gets its
// versioning for free.
import { APP_LIMITS, utf8Bytes } from "../../shared/app.ts";
import {
  createWorkbook, setCell, workbookFromJson, workbookToJson, type Workbook,
} from "../../shared/spreadsheet/index.ts";
import type { ToolCallContext, ToolCallResult } from "../drivers/agents-call.ts";
import type { Json } from "../drivers/agents-client.ts";

export const SPREADSHEET_TOOL_NAME = "show_spreadsheet";

export const SPREADSHEET_TOOL_DEFINITION = {
  name: SPREADSHEET_TOOL_NAME,
  description:
    "Show a spreadsheet in this chat: an editable sheet the person can change in place, with formulas that calculate live. Pass `title` and, to start with content, `values` (rows of raw values for the first tab; a string starting with = is a formula, numbers and TRUE/FALSE become values). To show a sheet the person saved, pass its `workbook` JSON instead. The person's edits save themselves and reach you with their next message; call again with that `workbook` and `app_id` to replace it. In rooms it is view-only: ask in text there.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", description: "One line, at most 80 characters; a new sheet needs one." },
      workbook: { type: "string", description: "A saved workbook's JSON, from a previous show_spreadsheet result; it replaces values." },
      values: {
        type: "array",
        description: "Rows of raw values for the first tab, starting at A1.",
        items: {
          type: "array",
          items: { type: ["string", "number", "boolean", "null"] },
        },
      },
      height: { type: "number", description: "Card height in pixels, 80 to 720; 480 when omitted." },
      app_id: { type: "string", description: "Only to replace a sheet you showed." },
    },
    required: ["title"],
  },
};

export interface SpreadsheetToolInput {
  title: string;
  workbook: Workbook;
  height: number;
  appId?: string;
}

type ParseResult = { ok: true; value: SpreadsheetToolInput } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCellValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** A workbook from the tool's arguments: a saved `workbook` wins, else `values` laid out from A1. */
export function parseSpreadsheetToolInput(args: Json): ParseResult {
  if (!isRecord(args)) return { ok: false, error: "title: must be 1 to 80 characters on one line." };
  if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 80) {
    return { ok: false, error: "title: must be 1 to 80 characters on one line." };
  }
  if (args.app_id !== undefined && (typeof args.app_id !== "string" || !args.app_id.trim())) {
    return { ok: false, error: "app_id: must be the id show_spreadsheet returned." };
  }
  const appId = typeof args.app_id === "string" ? args.app_id : undefined;
  let height = 480;
  if (args.height !== undefined && args.height !== null) {
    if (typeof args.height !== "number" || !Number.isFinite(args.height)) return { ok: false, error: "height: must be a number of pixels, 80 to 720." };
    height = Math.round(Math.min(APP_LIMITS.heightMax, Math.max(APP_LIMITS.heightMin, args.height)));
  }
  if (typeof args.workbook === "string") {
    if (utf8Bytes(args.workbook) > APP_LIMITS.spreadsheetJsonBytes) {
      return { ok: false, error: `workbook: is over the ${APP_LIMITS.spreadsheetJsonBytes.toLocaleString("en-US")}-byte limit; show a smaller sheet.` };
    }
    const parsed = workbookFromJson(args.workbook);
    if (!parsed.ok) return parsed;
    if (parsed.workbook.title !== args.title) parsed.workbook.title = args.title;
    return { ok: true, value: { title: args.title, workbook: parsed.workbook, height, ...(appId ? { appId } : {}) } };
  }
  let workbook = createWorkbook(args.title);
  const tab = workbook.tabs[0]!;
  if (args.values !== undefined) {
    if (!Array.isArray(args.values)) return { ok: false, error: "values: must be rows of raw values." };
    for (let row = 0; row < args.values.length; row++) {
      const line = args.values[row];
      if (!Array.isArray(line)) return { ok: false, error: "values: each row must be an array." };
      for (let col = 0; col < line.length; col++) {
        const raw = line[col];
        if (!isCellValue(raw)) return { ok: false, error: "values: each cell must be text, a number, TRUE/FALSE, or empty." };
        const next = setCell(workbook, tab.id, row, col, raw);
        if (!next.ok) return next;
        workbook = next.workbook;
      }
    }
  }
  return { ok: true, value: { title: args.title, workbook, height, ...(appId ? { appId } : {}) } };
}

const CARD_ROUTE = "/api/internal/options-card";
const MASKED = " Something in it read as a secret and was masked before it was stored. Never put secrets in a spreadsheet.";

/** Show (or replace) the sheet through the options-card route. */
export async function callSpreadsheetTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  if (name !== SPREADSHEET_TOOL_NAME) return { text: `${name} is not a spreadsheet tool.`, isError: true };
  const parsed = parseSpreadsheetToolInput(args);
  if (!parsed.ok) return { text: parsed.error, isError: true };
  const updating = parsed.value.appId !== undefined;
  const body = updating
    ? { tool: "update_spreadsheet", app_id: parsed.value.appId, workbook: workbookToJson(parsed.value.workbook), title: parsed.value.title, height: parsed.value.height }
    : { tool: "show_spreadsheet", workbook: workbookToJson(parsed.value.workbook), title: parsed.value.title, height: parsed.value.height };
  const answer = await context.client.apiResponse(CARD_ROUTE, { method: "POST", body: JSON.stringify(body) });
  if (!answer.ok) return { text: String((answer.body as Record<string, unknown>).error ?? (updating ? "Could not update that spreadsheet." : "Could not show that spreadsheet.")), isError: true };
  const messageId = String((answer.body as Record<string, unknown>).messageId ?? "");
  const masked = (answer.body as Record<string, unknown>).masked === true ? MASKED : "";
  return {
    text: (updating
      ? `Updated spreadsheet ${messageId}.`
      : `Shown as spreadsheet ${messageId}. To change it, call show_spreadsheet again with app_id "${messageId}" and the saved workbook.`) + masked,
  };
}
