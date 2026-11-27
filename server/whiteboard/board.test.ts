import { describe, expect, it } from "vitest";

import {
  boardToScreen,
  connectorEndpoints,
  createBoard,
  edgeAnchor,
  fitViewport,
  hitTest,
  panBy,
  parseBoardJson,
  parseWhiteboardState,
  screenToBoard,
  serializeBoard,
  zoomAt,
  type WhiteboardState,
} from "./board.ts";

function board(): WhiteboardState {
  return {
    version: 1,
    title: "Plan",
    items: [
      { id: "a", kind: "note", x: 0, y: 0, w: 200, h: 140, text: "First", color: "yellow" },
      { id: "b", kind: "rect", x: 300, y: 0, w: 120, h: 80, color: "#3366cc" },
      { id: "c", kind: "ellipse", x: 300, y: 200, w: 120, h: 80 },
      { id: "d", kind: "line", x: 0, y: 300, w: 200, h: 0 + 8 },
    ],
    connectors: [{ id: "ab", from: "a", to: "b" }],
    viewport: { x: 0, y: 0, scale: 1 },
  };
}

describe("parseWhiteboardState", () => {
  it("accepts a full board and drops unknown fields", () => {
    const parsed = parseWhiteboardState({ ...board(), extra: true, items: board().items.map((item, index) => (index === 0 ? { ...item, extra: 1 } : item)) });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.items).toHaveLength(4);
      expect(parsed.value.items[0]).toEqual(board().items[0]);
    }
  });

  it("refuses a wrong version, a missing title and duplicate ids", () => {
    expect(parseWhiteboardState({ ...board(), version: 2 }).ok).toBe(false);
    expect(parseWhiteboardState({ ...board(), title: "" }).ok).toBe(false);
    expect(parseWhiteboardState({ ...board(), items: [board().items[0], board().items[0]] }).ok).toBe(false);
  });

  it("refuses a bad kind, a bad colour and oversized text", () => {
    expect(parseWhiteboardState({ ...board(), items: [{ id: "x", kind: "star", x: 0, y: 0, w: 10, h: 10 }] }).ok).toBe(false);
    expect(parseWhiteboardState({ ...board(), items: [{ id: "x", kind: "rect", x: 0, y: 0, w: 10, h: 10, color: "red" }] }).ok).toBe(false);
    expect(parseWhiteboardState({ ...board(), items: [{ id: "x", kind: "note", x: 0, y: 0, w: 10, h: 10, color: "#ff0000" }] }).ok).toBe(false);
    expect(parseWhiteboardState({ ...board(), items: [{ id: "x", kind: "note", x: 0, y: 0, w: 10, h: 10, text: "a".repeat(2001) }] }).ok).toBe(false);
  });

  it("refuses connectors to missing items, to itself, and a duplicate pair", () => {
    const missing = { ...board(), connectors: [{ id: "x", from: "a", to: "ghost" }] };
    expect(parseWhiteboardState(missing).ok).toBe(false);
    const self = { ...board(), connectors: [{ id: "x", from: "a", to: "a" }] };
    expect(parseWhiteboardState(self).ok).toBe(false);
    const duplicate = { ...board(), connectors: [...board().connectors, { id: "x", from: "b", to: "a" }] };
    expect(parseWhiteboardState(duplicate).ok).toBe(false);
  });

  it("refuses a viewport scale outside 0.1 to 4", () => {
    expect(parseWhiteboardState({ ...board(), viewport: { x: 0, y: 0, scale: 0.05 } }).ok).toBe(false);
    expect(parseWhiteboardState({ ...board(), viewport: { x: 0, y: 0, scale: 4 } }).ok).toBe(true);
  });
});

describe("serialisation round-trip", () => {
  it("survives JSON and re-parsing unchanged", () => {
    const parsed = parseBoardJson(serializeBoard(board()));
    expect(parsed).toEqual({ ok: true, value: board() });
  });

  it("rejects broken JSON", () => {
    expect(parseBoardJson("{nope")).toEqual({ ok: false, error: "board: is not valid JSON." });
  });

  it("keeps a fresh board empty", () => {
    expect(createBoard("Blank")).toEqual({ version: 1, title: "Blank", items: [], connectors: [], viewport: { x: 0, y: 0, scale: 1 } });
  });
});

describe("viewport math", () => {
  it("converts board to screen and back", () => {
    const viewport = { x: 10, y: 20, scale: 2 };
    expect(boardToScreen(viewport, 30, 40)).toEqual({ x: 40, y: 40 });
    expect(screenToBoard(viewport, 40, 40)).toEqual({ x: 30, y: 40 });
  });

  it("zooms around the cursor point and clamps the scale", () => {
    const zoomed = zoomAt({ x: 0, y: 0, scale: 1 }, 100, 50, 2);
    expect(zoomed.scale).toBe(2);
    expect(screenToBoard(zoomed, 100, 50)).toEqual({ x: 100, y: 50 });
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 0, 0, 100).scale).toBe(4);
    expect(zoomAt({ x: 0, y: 0, scale: 1 }, 0, 0, 0.001).scale).toBe(0.1);
  });

  it("pans by screen pixels", () => {
    expect(panBy({ x: 0, y: 0, scale: 2 }, 20, 10)).toEqual({ x: -10, y: -5, scale: 2 });
  });

  it("fits every item inside the view", () => {
    const fitted = fitViewport(board(), 800, 600);
    const topLeft = boardToScreen(fitted, 0, 0);
    const bottomRight = boardToScreen(fitted, 420, 308);
    expect(topLeft.x).toBeGreaterThanOrEqual(0);
    expect(topLeft.y).toBeGreaterThanOrEqual(0);
    expect(bottomRight.x).toBeLessThanOrEqual(800);
    expect(bottomRight.y).toBeLessThanOrEqual(600);
    expect(fitViewport(createBoard("Empty"), 800, 600)).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe("hitTest", () => {
  it("finds notes, rects and ellipses inside, and nothing outside", () => {
    const state = board();
    expect(hitTest(state, 10, 10)).toBe("a");
    expect(hitTest(state, 310, 10)).toBe("b");
    expect(hitTest(state, 360, 240)).toBe("c");
    expect(hitTest(state, 250, 250)).toBeNull();
  });

  it("treats an ellipse as round, not its box", () => {
    expect(hitTest(board(), 305, 205)).toBeNull();
  });

  it("hits a line only near its segment, and picks the topmost item", () => {
    const state = board();
    expect(hitTest(state, 100, 304)).toBe("d");
    expect(hitTest(state, 100, 320)).toBeNull();
    const stacked = { ...state, items: [...state.items, { id: "top", kind: "rect" as const, x: 0, y: 0, w: 200, h: 140 }] };
    expect(hitTest(stacked, 10, 10)).toBe("top");
  });
});

describe("connectors", () => {
  it("anchors on the facing edges of both items", () => {
    const endpoints = connectorEndpoints(board(), { id: "ab", from: "a", to: "b" });
    expect(endpoints?.from.x).toBeCloseTo(200);
    expect(endpoints?.from.y).toBeCloseTo(58.46, 1);
    expect(endpoints?.to.x).toBeCloseTo(300);
    expect(endpoints?.to.y).toBeCloseTo(46.92, 1);
  });

  it("returns null when an item is gone", () => {
    expect(connectorEndpoints(board(), { id: "x", from: "a", to: "ghost" })).toBeNull();
  });

  it("anchors straight out when the centres coincide", () => {
    const item = { id: "a", kind: "rect" as const, x: 0, y: 0, w: 100, h: 60 };
    expect(edgeAnchor(item, { x: 50, y: 30 })).toEqual({ x: 100, y: 30 });
  });
});
