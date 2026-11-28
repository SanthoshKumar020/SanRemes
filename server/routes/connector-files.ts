// GET /api/connector-files/capabilities[?toolkit=<slug>]  which connected apps can move files
// POST /api/connector-files/pull  save the file a download tool's result offers into the bot's folder
// POST /api/connector-files/push  stage a file from the bot's folder and run an upload tool with it
//
// Registered in server/index.ts with the bot folder DATA_DIR/connector-files. Push is
// stage-only until the connected-apps upload link and tool relay are wired: without
// `requestUpload` it answers 501 and nothing is sent.
import { basename, isAbsolute, join } from "node:path";

import { capabilityForToolkit, connectorFileCapabilities } from "../connector-file-capabilities.ts";
import { pushConnectorFile, type PushErrorKind } from "../connector-file-push.ts";
import { pullConnectorFile, safePulledName, type PullErrorKind } from "../connector-file-pull.ts";
import { openBotFile } from "../connector-files.ts";
import type { ConnectorToolListing } from "../composio.ts";
import { FILE_MAX_BYTES } from "../../shared/upload-limits.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ConnectorFileRoutesDeps {
  /** The bot folder pulled files are saved into and pushed files are read from. */
  filesRoot: string;
  /** When given, `?toolkit=<slug>` classifies that toolkit's live tool list over the verified map. */
  listToolkitTools?: (slug: string) => Promise<ConnectorToolListing[]>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Composio's upload link and key for a file; without it push answers 501. */
  requestUpload?: (request: { toolkit_slug: string; tool_slug: string; filename: string; mimetype: string; md5: string }) => Promise<{ key: string; url: string }>;
  /** Runs the upload tool with the staged file in its arguments; without it a push only stages. */
  execute?: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}

const statusFor = (kind: PullErrorKind | PushErrorKind): number =>
  kind === "fetch-failed" || kind === "stage-failed" || kind === "execute-failed" ? 502 : kind === "save-failed" ? 500 : 422;

export function createConnectorFileRoutes(deps: ConnectorFileRoutesDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody, url }) => {
    if (method === "GET" && path === "/api/connector-files/capabilities") {
      const slug = url.searchParams.get("toolkit")?.trim().toLowerCase() ?? "";
      if (!slug) return json(res, 200, { capabilities: connectorFileCapabilities() });
      if (!deps.listToolkitTools) return json(res, 200, { capabilities: [capabilityForToolkit(slug)] });
      try {
        return json(res, 200, { capabilities: [capabilityForToolkit(slug, await deps.listToolkitTools(slug))] });
      } catch (error) {
        return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (method === "POST" && path === "/api/connector-files/pull") {
      let body: { tool?: unknown; result?: unknown; filename?: unknown };
      try {
        body = await readBody(req, FILE_MAX_BYTES * 2);
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        return json(res, typeof status === "number" ? status : 400, { error: error instanceof Error ? error.message : String(error) });
      }
      if (typeof body.tool !== "string" || !body.tool.trim() || body.result === undefined) {
        return json(res, 400, { error: "Pull needs the download tool's name and its result: { tool, result, filename? }." });
      }
      const filename = typeof body.filename === "string" && body.filename.trim() ? safePulledName(body.filename) : undefined;
      const result = filename && body.result !== null && typeof body.result === "object" && !Array.isArray(body.result)
        ? { ...(body.result as Record<string, unknown>), file_name: filename }
        : body.result;
      const pulled = await pullConnectorFile(result, body.tool.trim(), deps.filesRoot, { fetchImpl: deps.fetchImpl });
      if ("kind" in pulled) return json(res, statusFor(pulled.kind), { error: pulled.error });
      return json(res, 200, { name: pulled.name, bytes: pulled.bytes, mime: pulled.mime, file: basename(pulled.path) });
    }
    if (method === "POST" && path === "/api/connector-files/push") {
      let body: { tool?: unknown; file?: unknown; field?: unknown; args?: unknown };
      try {
        body = await readBody(req, FILE_MAX_BYTES * 2);
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        return json(res, typeof status === "number" ? status : 400, { error: error instanceof Error ? error.message : String(error) });
      }
      if (typeof body.tool !== "string" || !body.tool.trim() || typeof body.file !== "string" || !body.file.trim()) {
        return json(res, 400, { error: "Push needs the upload tool and the file in the bot's folder: { tool, file, field?, args? }." });
      }
      if (body.field !== undefined && (typeof body.field !== "string" || !body.field.trim())) {
        return json(res, 400, { error: "Push field, when given, names the tool argument that takes the file." });
      }
      if (body.args !== undefined && (body.args === null || typeof body.args !== "object" || Array.isArray(body.args))) {
        return json(res, 400, { error: "Push args, when given, is the tool's other arguments as an object." });
      }
      if (!deps.requestUpload) {
        return json(res, 501, { error: "Push is not wired yet: the connected-apps upload link is not connected, so nothing was sent." });
      }
      const file = body.file.trim();
      const target = isAbsolute(file) ? file : join(deps.filesRoot, file);
      const pushed = await pushConnectorFile(
        body.tool.trim(),
        target,
        (body.args ?? {}) as Record<string, unknown>,
        body.field?.trim() || "file_to_upload",
        {
          open: (path) => openBotFile(path, { roots: [deps.filesRoot], attachments: [], refuse: [] }),
          requestUpload: deps.requestUpload,
          ...(deps.execute ? { execute: deps.execute } : {}),
        },
      );
      if ("kind" in pushed) return json(res, statusFor(pushed.kind), { error: pushed.error });
      return json(res, 200, {
        tool: pushed.tool,
        name: pushed.name,
        bytes: pushed.bytes,
        mime: pushed.mime,
        staged: pushed.staged,
        arguments: pushed.arguments,
        executed: pushed.executed,
        ...(pushed.executed ? { result: pushed.result } : { note: `The file is staged; run ${pushed.tool} with these arguments to write it to the app.` }),
      });
    }
    return PASS;
  };
}
