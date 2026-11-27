// The show_whiteboard bot tool: a whiteboard as a show_html page. The driver
// builds the page from the board state and posts it through the same internal
// route show_html uses, so the page gets its versioning, Point, Share and
// .html download for free. Wiring (coordinator): add WHITEBOARD_TOOL_DEFINITION
// to the chat card tools and route "show_whiteboard" here from callCardTool.
import { createBoard, parseBoardJson, parseWhiteboardState, type BoardResult, type WhiteboardItem, type WhiteboardItemKind, type WhiteboardState } from "./board.ts";
import { buildWhiteboardHtml } from "./page.ts";
import type { ToolCallContext, ToolCallResult } from "../drivers/agents-call.ts";
import type { Json } from "../drivers/agents-client.ts";

export const WHITEBOARD_TOOL_NAME = "show_whiteboard";

export const WHITEBOARD_TOOL_DEFINITION = {
  name: WHITEBOARD_TOOL_NAME,
  description:
    "Show a whiteboard in this chat: sticky notes, shapes, lines and connectors on a canvas the person can pan, zoom, move and edit, saved as the page itself. Pass `title` and, to start with content, `notes` (each with text, and x, y, colour) and `shapes` (rect, ellipse or line with x, y, w, h). To show a board the person saved, pass its `board` JSON instead. The person's Save button sends the board's state back into the chat; call again with that `board` and `app_id` to keep the new version. In rooms it is view-only: ask in text there.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", description: "One line, at most 80 characters; a new board needs one." },
      board: { type: "string", description: "A saved board's JSON, from the person's Save button; it replaces notes and shapes." },
      notes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            x: { type: "number" },
            y: { type: "number" },
            color: { type: "string", description: "yellow, pink, blue, green or white." },
          },
          required: ["text"],
        },
      },
      shapes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", description: "rect, ellipse or line." },
            x: { type: "number" },
            y: { type: "number" },
            w: { type: "number" },
            h: { type: "number" },
            color: { type: "string", description: "A #rgb / #rrggbb stroke." },
          },
          required: ["kind", "x", "y", "w", "h"],
        },
      },
      app_id: { type: "string", description: "Only to replace a board you showed." },
    },
    required: ["title"],
  },
};

export interface WhiteboardToolInput {
  title: string;
  board: WhiteboardState;
  appId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isShapeKind(value: unknown): value is WhiteboardItemKind {
  return value === "rect" || value === "ellipse" || value === "line";
}

/** A board from the tool's arguments: a saved `board` wins, else notes and shapes laid out from the top-left. */
export function parseWhiteboardToolInput(args: Json): BoardResult<WhiteboardToolInput> {
  if (!isRecord(args)) return { ok: false, error: "title: must be 1 to 80 characters on one line." };
  if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 80) {
    return { ok: false, error: "title: must be 1 to 80 characters on one line." };
  }
  if (args.app_id !== undefined && (typeof args.app_id !== "string" || !args.app_id.trim())) {
    return { ok: false, error: "app_id: must be the id show_whiteboard returned." };
  }
  const appId = typeof args.app_id === "string" ? args.app_id : undefined;
  if (typeof args.board === "string") {
    const parsed = parseBoardJson(args.board);
    if (!parsed.ok) return parsed;
    if (parsed.value.title !== args.title) parsed.value.title = args.title;
    return { ok: true, value: { title: args.title, board: parsed.value, ...(appId ? { appId } : {}) } };
  }
  const board = createBoard(args.title);
  let next = 0;
  const id = () => `item-${++next}`;
  if (args.notes !== undefined) {
    if (!Array.isArray(args.notes)) return { ok: false, error: "notes: must be an array." };
    for (const raw of args.notes) {
      if (!isRecord(raw) || typeof raw.text !== "string" || !raw.text.trim()) return { ok: false, error: "notes: each note needs text." };
      const item = { id: id(), kind: "note" as const, x: isNumber(raw.x) ? raw.x : 0, y: isNumber(raw.y) ? raw.y : 0, w: 200, h: 140, text: raw.text, color: "yellow" };
      if (typeof raw.color === "string") item.color = raw.color;
      board.items.push(item);
    }
  }
  if (args.shapes !== undefined) {
    if (!Array.isArray(args.shapes)) return { ok: false, error: "shapes: must be an array." };
    for (const raw of args.shapes) {
      if (!isRecord(raw) || !isShapeKind(raw.kind)) {
        return { ok: false, error: "shapes: kind must be rect, ellipse or line." };
      }
      if (!isNumber(raw.x) || !isNumber(raw.y) || !isNumber(raw.w) || !isNumber(raw.h)) {
        return { ok: false, error: "shapes: each shape needs numbers for x, y, w and h." };
      }
      const item: WhiteboardItem = { id: id(), kind: raw.kind, x: raw.x, y: raw.y, w: raw.w, h: raw.h };
      if (typeof raw.color === "string") item.color = raw.color;
      board.items.push(item);
    }
  }
  const validated = parseWhiteboardState(board);
  if (!validated.ok) return validated;
  return { ok: true, value: { title: args.title, board: validated.value, ...(appId ? { appId } : {}) } };
}

const CARD_ROUTE = "/api/internal/options-card";

/** Show (or replace) the board as a show_html page, through the options-card route. */
export async function callWhiteboardTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  if (name !== WHITEBOARD_TOOL_NAME) return { text: `${name} is not a whiteboard tool.`, isError: true };
  const parsed = parseWhiteboardToolInput(args);
  if (!parsed.ok) return { text: parsed.error, isError: true };
  const built = buildWhiteboardHtml(parsed.value.board);
  if (!built.ok) return { text: built.error, isError: true };
  const updating = parsed.value.appId !== undefined;
  const body = updating
    ? { tool: "update_html", app_id: parsed.value.appId, html: built.html, title: parsed.value.title }
    : { tool: "show_html", html: built.html, title: parsed.value.title, height: 720, fallback_text: `Whiteboard: ${parsed.value.title}` };
  const answer = await context.client.apiResponse(CARD_ROUTE, { method: "POST", body: JSON.stringify(body) });
  if (!answer.ok) return { text: String((answer.body as Record<string, unknown>).error ?? (updating ? "Could not update that whiteboard." : "Could not show that whiteboard.")), isError: true };
  const messageId = String((answer.body as Record<string, unknown>).messageId ?? "");
  return {
    text: updating
      ? `Updated whiteboard ${messageId}.`
      : `Shown as whiteboard ${messageId}. To change it, call show_whiteboard again with app_id "${messageId}" and the saved board.`,
  };
}
