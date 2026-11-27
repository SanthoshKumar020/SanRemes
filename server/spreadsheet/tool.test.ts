import { describe, expect, it, vi } from "vitest";

import type { ToolCallContext } from "../drivers/agents-call.ts";
import type { HarnessClient } from "../drivers/agents-client.ts";
import { createWorkbook, setCell, workbookToJson, cellKey } from "../../shared/spreadsheet/index.ts";
import { callSpreadsheetTool, parseSpreadsheetToolInput, SPREADSHEET_TOOL_DEFINITION, SPREADSHEET_TOOL_NAME } from "./tool.ts";

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

describe("parseSpreadsheetToolInput", () => {
  it("builds a workbook from values, A1 first", () => {
    const parsed = parseSpreadsheetToolInput({ title: "Budget", values: [[ "Item", "Cost" ], [ "Tea", 12 ], [ "Total", "=SUM(B2:B2)" ]] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.workbook.title).toBe("Budget");
    const tab = parsed.value.workbook.tabs[0];
    expect(tab.cells[cellKey(0, 0)]?.raw).toBe("Item");
    expect(tab.cells[cellKey(1, 1)]?.raw).toBe(12);
    expect(tab.cells[cellKey(2, 1)]?.raw).toBe("=SUM(B2:B2)");
  });

  it("prefers a saved workbook over values", () => {
    const saved = createWorkbook("Saved");
    const withCell = setCell(saved, saved.tabs[0].id, 0, 0, "kept");
    expect(withCell.ok).toBe(true);
    const parsed = parseSpreadsheetToolInput({ title: "Saved", workbook: workbookToJson(withCell.ok ? withCell.workbook : saved), values: [[ "ignored" ]] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.workbook.tabs[0].cells[cellKey(0, 0)]?.raw).toBe("kept");
  });

  it("refuses a missing title, bad values, a bad height and an oversize workbook", () => {
    expect(parseSpreadsheetToolInput({}).ok).toBe(false);
    expect(parseSpreadsheetToolInput({ title: "x", values: "nope" }).ok).toBe(false);
    expect(parseSpreadsheetToolInput({ title: "x", values: [[ "ok" ], "nope" ] }).ok).toBe(false);
    expect(parseSpreadsheetToolInput({ title: "x", values: [[ "ok" ]], height: "tall" }).ok).toBe(false);
    expect(parseSpreadsheetToolInput({ title: "x", workbook: "{broken" }).ok).toBe(false);
    expect(parseSpreadsheetToolInput({ title: "x", workbook: "y".repeat(1_000_001) }).ok).toBe(false);
  });

  it("clamps the height into range", () => {
    const parsed = parseSpreadsheetToolInput({ title: "x", values: [[ 1 ]], height: 9000 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.height).toBe(720);
  });
});

describe("SPREADSHEET_TOOL_DEFINITION", () => {
  it("names the tool, requires a title, and tells the bot how replacing works", () => {
    expect(SPREADSHEET_TOOL_DEFINITION.name).toBe(SPREADSHEET_TOOL_NAME);
    expect(SPREADSHEET_TOOL_DEFINITION.inputSchema.required).toEqual(["title"]);
    expect(SPREADSHEET_TOOL_DEFINITION.description).toContain("app_id");
    expect(SPREADSHEET_TOOL_DEFINITION.description).toContain("values");
  });
});

describe("callSpreadsheetTool", () => {
  it("posts the sheet as show_spreadsheet and reports the app id", async () => {
    const { apiResponse, context } = harness();
    const result = await callSpreadsheetTool(SPREADSHEET_TOOL_NAME, { title: "Budget", values: [[ "Item", 12 ]] }, context);
    expect(result).toEqual({ text: "Shown as spreadsheet m42. To change it, call show_spreadsheet again with app_id \"m42\" and the saved workbook." });
    expect(apiResponse).toHaveBeenCalledTimes(1);
    const [route, init] = apiResponse.mock.calls[0];
    expect(route).toBe("/api/internal/options-card");
    const body = JSON.parse(String((init as { body: string }).body));
    expect(body.tool).toBe("show_spreadsheet");
    expect(body.title).toBe("Budget");
    expect(body.height).toBe(480);
    const workbook = JSON.parse(body.workbook);
    expect(workbook.tabs[0].cells[cellKey(0, 0)].raw).toBe("Item");
  });

  it("replaces a sheet through update_spreadsheet when app_id is given", async () => {
    const { apiResponse, context } = harness();
    const saved = createWorkbook("Budget");
    const result = await callSpreadsheetTool(SPREADSHEET_TOOL_NAME, { title: "Budget", workbook: workbookToJson(saved), app_id: "m42" }, context);
    expect(result).toEqual({ text: "Updated spreadsheet m42." });
    const body = JSON.parse(String((apiResponse.mock.calls[0][1] as { body: string }).body));
    expect(body).toMatchObject({ tool: "update_spreadsheet", app_id: "m42" });
  });

  it("returns the route's error, and refuses bad input without calling", async () => {
    const { context } = harness({ ok: false, status: 500, body: { error: "No room." } });
    const failed = await callSpreadsheetTool(SPREADSHEET_TOOL_NAME, { title: "Budget" }, context);
    expect(failed).toEqual({ text: "No room.", isError: true });
    const { apiResponse: second, context: secondContext } = harness();
    const refused = await callSpreadsheetTool(SPREADSHEET_TOOL_NAME, {}, secondContext);
    expect(refused.isError).toBe(true);
    expect(second).not.toHaveBeenCalled();
  });

  it("refuses any other tool name", async () => {
    const { context } = harness();
    expect(await callSpreadsheetTool("show_html", { title: "Budget" }, context)).toEqual({ text: "show_html is not a spreadsheet tool.", isError: true });
  });
});
