import { describe, expect, it, vi } from "vitest";

import type { ToolCallContext } from "../drivers/agents-call.ts";
import type { HarnessClient } from "../drivers/agents-client.ts";
import { createBoard, serializeBoard } from "./board.ts";
import { extractBoardState } from "./page.ts";
import { callWhiteboardTool, parseWhiteboardToolInput, WHITEBOARD_TOOL_DEFINITION, WHITEBOARD_TOOL_NAME } from "./tool.ts";

function harness(answer: { ok: boolean; status: number; body: Record<string, unknown> } = { ok: true, status: 201, body: { messageId: "m42" } }) {
  const apiResponse = vi.fn<HarnessClient["apiResponse"]>(async () => answer);
  const context: ToolCallContext = {
    botId: "bot-scout",
    threadId: "thread-scout",
    externalRuntime: false,
    sharedComputers: false,
    client: { api: vi.fn(async () => ({})), apiResponse },
  };
  return { apiResponse, context };
}

describe("parseWhiteboardToolInput", () => {
  it("builds a board from notes and shapes", () => {
    const parsed = parseWhiteboardToolInput({
      title: "Plan",
      notes: [{ text: "First", x: 10, y: 20, color: "pink" }],
      shapes: [{ kind: "rect", x: 300, y: 20, w: 120, h: 80, color: "#3366cc" }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.board.items).toHaveLength(2);
    expect(parsed.value.board.items[0]).toMatchObject({ kind: "note", text: "First", color: "pink" });
    expect(parsed.value.board.items[1]).toMatchObject({ kind: "rect", color: "#3366cc" });
  });

  it("prefers a saved board over notes and shapes", () => {
    const saved = createBoard("Saved");
    saved.items.push({ id: "a", kind: "note", x: 0, y: 0, w: 200, h: 140, text: "kept", color: "green" });
    const parsed = parseWhiteboardToolInput({ title: "Saved", board: serializeBoard(saved), notes: [{ text: "ignored" }] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.board.items).toHaveLength(1);
  });

  it("refuses a missing title, a bad note and a bad shape", () => {
    expect(parseWhiteboardToolInput({}).ok).toBe(false);
    expect(parseWhiteboardToolInput({ title: "x", notes: [{ text: "" }] }).ok).toBe(false);
    expect(parseWhiteboardToolInput({ title: "x", notes: [{ text: "ok", color: "red" }] }).ok).toBe(false);
    expect(parseWhiteboardToolInput({ title: "x", shapes: [{ kind: "star", x: 0, y: 0, w: 10, h: 10 }] }).ok).toBe(false);
    expect(parseWhiteboardToolInput({ title: "x", board: "{broken" }).ok).toBe(false);
  });
});

describe("WHITEBOARD_TOOL_DEFINITION", () => {
  it("names the tool, requires a title, and tells the bot how saving works", () => {
    expect(WHITEBOARD_TOOL_DEFINITION.name).toBe(WHITEBOARD_TOOL_NAME);
    expect(WHITEBOARD_TOOL_DEFINITION.inputSchema.required).toEqual(["title"]);
    expect(WHITEBOARD_TOOL_DEFINITION.description).toContain("Save button");
    expect(WHITEBOARD_TOOL_DEFINITION.description).toContain("app_id");
  });
});

describe("callWhiteboardTool", () => {
  it("posts the page as show_html and reports the app id", async () => {
    const { apiResponse, context } = harness();
    const result = await callWhiteboardTool(WHITEBOARD_TOOL_NAME, { title: "Plan", notes: [{ text: "First" }] }, context);
    expect(result).toEqual({ text: "Shown as whiteboard m42. To change it, call show_whiteboard again with app_id \"m42\" and the saved board." });
    expect(apiResponse).toHaveBeenCalledTimes(1);
    const [route, init] = apiResponse.mock.calls[0];
    expect(route).toBe("/api/internal/options-card");
    const body = JSON.parse(String((init as { body: string }).body));
    expect(body.tool).toBe("show_html");
    expect(body.title).toBe("Plan");
    expect(body.height).toBe(720);
    expect(extractBoardState(body.html)).toEqual({ ok: true, value: expect.objectContaining({ title: "Plan" }) });
  });

  it("replaces a board through update_html when app_id is given", async () => {
    const { apiResponse, context } = harness();
    const result = await callWhiteboardTool(WHITEBOARD_TOOL_NAME, { title: "Plan", board: serializeBoard(createBoard("Plan")), app_id: "m42" }, context);
    expect(result).toEqual({ text: "Updated whiteboard m42." });
    const body = JSON.parse(String((apiResponse.mock.calls[0][1] as { body: string }).body));
    expect(body).toMatchObject({ tool: "update_html", app_id: "m42" });
  });

  it("returns the route's error, and refuses bad input without calling", async () => {
    const { context } = harness({ ok: false, status: 500, body: { error: "No room." } });
    const failed = await callWhiteboardTool(WHITEBOARD_TOOL_NAME, { title: "Plan" }, context);
    expect(failed).toEqual({ text: "No room.", isError: true });
    const { apiResponse: second, context: secondContext } = harness();
    const refused = await callWhiteboardTool(WHITEBOARD_TOOL_NAME, {}, secondContext);
    expect(refused.isError).toBe(true);
    expect(second).not.toHaveBeenCalled();
  });

  it("refuses any other tool name", async () => {
    const { context } = harness();
    expect(await callWhiteboardTool("show_html", { title: "Plan" }, context)).toEqual({ text: "show_html is not a whiteboard tool.", isError: true });
  });
});
