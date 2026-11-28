import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConnectorFileRoutes, type ConnectorFileRoutesDeps } from "./connector-files.ts";
import { PASS, type RouteContext } from "./table.ts";

const bytes = new TextEncoder().encode("%PDF-1.4 quarterly report");
const base64 = Buffer.from(bytes).toString("base64");
const dirs: string[] = [];
afterEach(() => {
  for (const one of dirs.splice(0)) rmSync(one, { recursive: true, force: true });
});

function setup(extra: Partial<ConnectorFileRoutesDeps> = {}) {
  const filesRoot = mkdtempSync(join(tmpdir(), "connector-files-route-"));
  dirs.push(filesRoot);
  const route = createConnectorFileRoutes({ filesRoot, ...extra });
  const call = async (method: string, path: string, body?: unknown) => {
    const json = vi.fn();
    const req = { headers: {} } as IncomingMessage;
    const out = await route({
      req,
      res: {} as ServerResponse,
      url: new URL(`http://127.0.0.1${path}`),
      path,
      method,
      json,
      readBody: async () => body,
    } as unknown as RouteContext);
    return { out, answer: json.mock.calls[0] as [unknown, number, Record<string, unknown>] | undefined };
  };
  return { filesRoot, call };
}

describe("connector file routes (unregistered)", () => {
  it("answers the capability map", async () => {
    const { call } = setup();
    const { answer } = await call("GET", "/api/connector-files/capabilities");
    expect(answer![1]).toBe(200);
    const capabilities = answer![2].capabilities as Array<{ slug: string; push: string; pull: string }>;
    expect(capabilities.find((entry) => entry.slug === "googledrive")).toMatchObject({ push: "yes", pull: "yes" });
    expect(capabilities.find((entry) => entry.slug === "slack")).toMatchObject({ push: "yes", pull: "no" });
  });

  it("pulls a file from a download result into the bot folder", async () => {
    const { filesRoot, call } = setup();
    const { answer } = await call("POST", "/api/connector-files/pull", {
      tool: "GOOGLEDRIVE_DOWNLOAD_FILE",
      result: { downloaded_file_content: base64, file_name: "report.pdf", mime_type: "application/pdf" },
    });
    expect(answer![1]).toBe(200);
    expect(answer![2]).toEqual({ name: "report.pdf", bytes: bytes.byteLength, mime: "application/pdf", file: "report.pdf" });
    expect(readFileSync(join(filesRoot, "report.pdf"))).toEqual(Buffer.from(bytes));
  });

  it("refuses a pull with no tool or result, and a result with no file", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/connector-files/pull", { tool: "GOOGLEDRIVE_DOWNLOAD_FILE" })).answer![1]).toBe(400);
    const { answer } = await call("POST", "/api/connector-files/pull", {
      tool: "GOOGLEDRIVE_DOWNLOAD_FILE",
      result: { file_id: "1AbC" },
    });
    expect(answer![1]).toBe(422);
    expect(answer![2].error).toMatch(/did not return a file/);
  });

  it("leaves other routes alone", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/connectors/catalog")).out).toBe(PASS);
  });
});
