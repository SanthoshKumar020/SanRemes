// The whiteboard's board model: items, connectors, viewport, and the serialised
// form stored as the artifact's content. Pure functions only; the page in
// page.ts renders this state, and the tool in tool.ts posts it as show_html.
export const WHITEBOARD_VERSION = 1;
/** A board over this many items is refused: the page embeds the state in its HTML, which show_html caps at 256 KB. */
export const WHITEBOARD_MAX_ITEMS = 500;
/** A note's text over this long is refused. */
export const WHITEBOARD_MAX_TEXT = 2000;
/** An item's side is clamped to this range, in board units. */
export const WHITEBOARD_ITEM_MIN = 8;
export const WHITEBOARD_ITEM_MAX = 4000;

export type WhiteboardItemKind = "note" | "rect" | "ellipse" | "line";

export const NOTE_COLORS = ["yellow", "pink", "blue", "green", "white"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export const NOTE_FILL: Readonly<Record<NoteColor, string>> = {
  yellow: "#ffe08a",
  pink: "#ffc2d4",
  blue: "#bcd8ff",
  green: "#b8e6b0",
  white: "#ffffff",
};

export interface WhiteboardItem {
  id: string;
  kind: WhiteboardItemKind;
  /** Top-left corner in board units; a line runs from (x, y) to (x + w, y + h). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** A note's text. */
  text?: string;
  /** A note's palette colour, or a shape's stroke as #rgb / #rrggbb. */
  color?: string;
}

export interface WhiteboardConnector {
  id: string;
  from: string;
  to: string;
}

export interface WhiteboardViewport {
  /** The board point at the screen's top-left corner. */
  x: number;
  y: number;
  scale: number;
}

export interface WhiteboardState {
  version: typeof WHITEBOARD_VERSION;
  title: string;
  items: WhiteboardItem[];
  connectors: WhiteboardConnector[];
  viewport: WhiteboardViewport;
}

export type BoardResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && (HEX_COLOR.test(value) || (NOTE_COLORS as readonly string[]).includes(value));
}

/** An empty board, titled for the chat. */
export function createBoard(title: string): WhiteboardState {
  return { version: WHITEBOARD_VERSION, title, items: [], connectors: [], viewport: { x: 0, y: 0, scale: 1 } };
}

function parseItem(value: unknown, seen: Set<string>): BoardResult<WhiteboardItem> {
  if (!isRecord(value)) return { ok: false, error: "items: each item must be an object." };
  if (typeof value.id !== "string" || !ID.test(value.id)) return { ok: false, error: "items: each item needs an id of letters, digits, - or _." };
  if (seen.has(value.id)) return { ok: false, error: `items: id "${value.id}" appears twice.` };
  if (value.kind !== "note" && value.kind !== "rect" && value.kind !== "ellipse" && value.kind !== "line") {
    return { ok: false, error: `items: "${String(value.kind)}" is not a note, rect, ellipse or line.` };
  }
  const x = value.x;
  const y = value.y;
  const w = value.w;
  const h = value.h;
  if (!isFiniteNumber(x)) return { ok: false, error: `items: "${value.id}" needs a number for x.` };
  if (!isFiniteNumber(y)) return { ok: false, error: `items: "${value.id}" needs a number for y.` };
  if (!isFiniteNumber(w)) return { ok: false, error: `items: "${value.id}" needs a number for w.` };
  if (!isFiniteNumber(h)) return { ok: false, error: `items: "${value.id}" needs a number for h.` };
  if (w < WHITEBOARD_ITEM_MIN || w > WHITEBOARD_ITEM_MAX || h < WHITEBOARD_ITEM_MIN || h > WHITEBOARD_ITEM_MAX) {
    return { ok: false, error: `items: "${value.id}" must be ${WHITEBOARD_ITEM_MIN} to ${WHITEBOARD_ITEM_MAX} board units on each side.` };
  }
  if (value.text !== undefined && (typeof value.text !== "string" || value.text.length > WHITEBOARD_MAX_TEXT)) {
    return { ok: false, error: `items: "${value.id}" text must be at most ${WHITEBOARD_MAX_TEXT} characters.` };
  }
  if (value.color !== undefined && !isColor(value.color)) return { ok: false, error: `items: "${value.id}" colour must be a palette name or #rgb / #rrggbb.` };
  if (value.kind === "note" && value.color !== undefined && typeof value.color === "string" && HEX_COLOR.test(value.color)) {
    return { ok: false, error: `items: a note's colour must be a palette name (${NOTE_COLORS.join(", ")}).` };
  }
  seen.add(value.id);
  const item: WhiteboardItem = { id: value.id, kind: value.kind, x, y, w, h };
  if (typeof value.text === "string") item.text = value.text;
  if (typeof value.color === "string") item.color = value.color;
  return { ok: true, value: item };
}

/** A board from untrusted JSON (a bot's argument, or a page's saved state). Unknown fields are dropped. */
export function parseWhiteboardState(value: unknown): BoardResult<WhiteboardState> {
  if (!isRecord(value)) return { ok: false, error: "board: must be an object." };
  if (value.version !== WHITEBOARD_VERSION) return { ok: false, error: `board: version must be ${WHITEBOARD_VERSION}.` };
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 80) {
    return { ok: false, error: "board: title must be 1 to 80 characters." };
  }
  if (!Array.isArray(value.items)) return { ok: false, error: "board: items must be an array." };
  if (value.items.length > WHITEBOARD_MAX_ITEMS) return { ok: false, error: `board: at most ${WHITEBOARD_MAX_ITEMS} items.` };
  const seen = new Set<string>();
  const items: WhiteboardItem[] = [];
  for (const raw of value.items) {
    const parsed = parseItem(raw, seen);
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  if (!Array.isArray(value.connectors)) return { ok: false, error: "board: connectors must be an array." };
  if (value.connectors.length > WHITEBOARD_MAX_ITEMS) return { ok: false, error: `board: at most ${WHITEBOARD_MAX_ITEMS} connectors.` };
  const connectors: WhiteboardConnector[] = [];
  const pairs = new Set<string>();
  for (const raw of value.connectors) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !ID.test(raw.id)) return { ok: false, error: "connectors: each needs an id of letters, digits, - or _." };
    if (typeof raw.from !== "string" || typeof raw.to !== "string" || !seen.has(raw.from) || !seen.has(raw.to)) {
      return { ok: false, error: `connectors: "${raw.id}" must join two items on the board.` };
    }
    if (raw.from === raw.to) return { ok: false, error: `connectors: "${raw.id}" cannot join an item to itself.` };
    const pair = [raw.from, raw.to].sort().join(":");
    if (pairs.has(pair)) return { ok: false, error: `connectors: "${raw.from}" and "${raw.to}" are already joined.` };
    pairs.add(pair);
    connectors.push({ id: raw.id, from: raw.from, to: raw.to });
  }
  if (!isRecord(value.viewport) || !isFiniteNumber(value.viewport.x) || !isFiniteNumber(value.viewport.y) || !isFiniteNumber(value.viewport.scale)) {
    return { ok: false, error: "board: viewport needs numbers for x, y and scale." };
  }
  if (value.viewport.scale < MIN_SCALE || value.viewport.scale > MAX_SCALE) {
    return { ok: false, error: `board: viewport scale must be ${MIN_SCALE} to ${MAX_SCALE}.` };
  }
  return {
    ok: true,
    value: {
      version: WHITEBOARD_VERSION,
      title: value.title,
      items,
      connectors,
      viewport: { x: value.viewport.x, y: value.viewport.y, scale: value.viewport.scale },
    },
  };
}

/** The board as one JSON string, for the page's embedded state and the bot's next call. */
export function serializeBoard(state: WhiteboardState): string {
  return JSON.stringify(state);
}

export function parseBoardJson(text: string): BoardResult<WhiteboardState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "board: is not valid JSON." };
  }
  return parseWhiteboardState(parsed);
}

export function boardToScreen(viewport: WhiteboardViewport, x: number, y: number): { x: number; y: number } {
  return { x: (x - viewport.x) * viewport.scale, y: (y - viewport.y) * viewport.scale };
}

export function screenToBoard(viewport: WhiteboardViewport, x: number, y: number): { x: number; y: number } {
  return { x: x / viewport.scale + viewport.x, y: y / viewport.scale + viewport.y };
}

/** The viewport after zooming by `factor` around the screen point (sx, sy): the board point under the cursor stays put. */
export function zoomAt(viewport: WhiteboardViewport, sx: number, sy: number, factor: number): WhiteboardViewport {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewport.scale * factor));
  const before = screenToBoard(viewport, sx, sy);
  const x = before.x - sx / scale;
  const y = before.y - sy / scale;
  return { x, y, scale };
}

/** The viewport after panning by screen pixels (dx, dy). */
export function panBy(viewport: WhiteboardViewport, dx: number, dy: number): WhiteboardViewport {
  return { x: viewport.x - dx / viewport.scale, y: viewport.y - dy / viewport.scale, scale: viewport.scale };
}

function pointInRect(bx: number, by: number, item: WhiteboardItem): boolean {
  return bx >= item.x && bx <= item.x + item.w && by >= item.y && by <= item.y + item.h;
}

function pointInEllipse(bx: number, by: number, item: WhiteboardItem): boolean {
  const cx = item.x + item.w / 2;
  const cy = item.y + item.h / 2;
  const dx = (bx - cx) / (item.w / 2);
  const dy = (by - cy) / (item.h / 2);
  return dx * dx + dy * dy <= 1;
}

function distanceToSegment(bx: number, by: number, item: WhiteboardItem): number {
  const x1 = item.x;
  const y1 = item.y;
  const x2 = item.x + item.w;
  const y2 = item.y + item.h;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const along = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((bx - x1) * dx + (by - y1) * dy) / lengthSquared));
  const px = x1 + along * dx;
  const py = y1 + along * dy;
  return Math.hypot(bx - px, by - py);
}

/** The topmost item under the board point (bx, by), or null. `tolerance` is in board units, for thin lines. */
export function hitTest(state: WhiteboardState, bx: number, by: number, tolerance = 6): string | null {
  for (let index = state.items.length - 1; index >= 0; index--) {
    const item = state.items[index];
    if (item.kind === "ellipse" ? pointInEllipse(bx, by, item) : item.kind === "line" ? distanceToSegment(bx, by, item) <= tolerance : pointInRect(bx, by, item)) {
      return item.id;
    }
  }
  return null;
}

/** The point on an item's box edge facing `toward`: a connector's anchor on that item. */
export function edgeAnchor(item: WhiteboardItem, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = item.x + item.w / 2;
  const cy = item.y + item.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: item.x + item.w, y: cy };
  const scaleX = dx === 0 ? Infinity : (item.w / 2) / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : (item.h / 2) / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** A connector's two endpoints, on its items' facing edges; null when an item is gone. */
export function connectorEndpoints(state: WhiteboardState, connector: WhiteboardConnector): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
  const from = state.items.find((item) => item.id === connector.from);
  const to = state.items.find((item) => item.id === connector.to);
  if (!from || !to) return null;
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  return { from: edgeAnchor(from, toCenter), to: edgeAnchor(to, fromCenter) };
}

/** The viewport that fits every item with a margin, or the board's own when it is empty. */
export function fitViewport(state: WhiteboardState, width: number, height: number): WhiteboardViewport {
  if (state.items.length === 0) return state.viewport;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of state.items) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.w);
    maxY = Math.max(maxY, item.y + item.h);
  }
  const margin = 40;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(width / (maxX - minX + margin * 2), height / (maxY - minY + margin * 2))));
  return { x: minX - margin, y: minY - margin, scale };
}
