import { describe, expect, it } from "vitest";

import { APP_LIMITS } from "../../packages/phone-protocol/src/app.ts";
import { createBoard, parseBoardJson, serializeBoard } from "./board.ts";
import { buildWhiteboardHtml, emptyWhiteboardPage, extractBoardState } from "./page.ts";

describe("buildWhiteboardHtml", () => {
  it("embeds the board and reads it back unchanged", () => {
    const board = createBoard("Plan");
    board.items.push(
      { id: "a", kind: "note", x: 10, y: 20, w: 200, h: 140, text: "First idea", color: "yellow" },
      { id: "b", kind: "rect", x: 300, y: 20, w: 120, h: 80, color: "#3366cc" },
    );
    board.connectors.push({ id: "ab", from: "a", to: "b" });
    const built = buildWhiteboardHtml(board);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(extractBoardState(built.html)).toEqual({ ok: true, value: board });
  });

  it("stays under show_html's size cap, even with a full board", () => {
    const board = createBoard("Big");
    for (let index = 0; index < 500; index++) {
      board.items.push({ id: `n${index}`, kind: "note", x: index * 10, y: 0, w: 200, h: 140, text: "x".repeat(100), color: "blue" });
    }
    const built = buildWhiteboardHtml(board);
    expect(built.ok).toBe(true);
    if (built.ok) expect(new TextEncoder().encode(built.html).length).toBeLessThan(APP_LIMITS.htmlBytes);
  });

  it("keeps a hostile note from closing the state script tag", () => {
    const board = createBoard("Tricky");
    board.items.push({ id: "a", kind: "note", x: 0, y: 0, w: 200, h: 140, text: "</script><script>alert(1)</script>", color: "pink" });
    const built = buildWhiteboardHtml(board);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.html).not.toContain("</script><script>alert(1)");
    expect(built.html.match(/<script type="application\/json"/g)).toHaveLength(1);
    const parsed = extractBoardState(built.html);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.items[0].text).toBe("</script><script>alert(1)</script>");
  });

  it("escapes the title in the document", () => {
    const built = buildWhiteboardHtml(createBoard("<b>Plan & notes</b>"));
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.html).toContain("<title>&lt;b&gt;Plan &amp; notes&lt;/b&gt;</title>");
      expect(built.html).not.toContain("<title><b>");
    }
  });

  it("ships the editing controls and no network or storage calls", () => {
    const built = emptyWhiteboardPage("Blank");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    for (const tool of ["select", "note", "rect", "ellipse", "line", "connect"]) expect(built.html).toContain(`data-tool="${tool}"`);
    for (const control of ["zoomIn", "zoomOut", "fit", "save", "editor"]) expect(built.html).toContain(`id="${control}"`);
    expect(built.html).not.toMatch(/localStorage|sessionStorage|fetch\(|XMLHttpRequest/);
    expect(built.html).toContain("sanremes.setContext");
    expect(built.html).toContain("sanremes.send");
  });

  it("refuses a board whose page would not fit", () => {
    const board = createBoard("Too big");
    for (let index = 0; index < 500; index++) {
      board.items.push({ id: `n${index}`, kind: "note", x: 0, y: 0, w: 200, h: 140, text: "x".repeat(2000), color: "blue" });
    }
    expect(buildWhiteboardHtml(board)).toEqual({ ok: false, error: expect.stringContaining("over the 262144-byte show_html limit") });
  });
});

describe("extractBoardState", () => {
  it("reports a page with no state, and a state that fails validation", () => {
    expect(extractBoardState("<html></html>")).toEqual({ ok: false, error: "page: no embedded whiteboard state." });
    const built = buildWhiteboardHtml(createBoard("Ok"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const tampered = built.html.replace('"version":1', '"version":9');
    expect(extractBoardState(tampered).ok).toBe(false);
  });

  it("round-trips through the serialised form the bot re-sends", () => {
    const board = createBoard("Saved");
    board.items.push({ id: "a", kind: "note", x: 0, y: 0, w: 200, h: 140, text: "kept", color: "green" });
    const reparsed = parseBoardJson(serializeBoard(board));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      const rebuilt = buildWhiteboardHtml(reparsed.value);
      expect(rebuilt.ok).toBe(true);
      if (rebuilt.ok) expect(extractBoardState(rebuilt.html)).toEqual({ ok: true, value: board });
    }
  });
});
