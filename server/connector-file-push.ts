// Pushing a file into a connected app: the file is staged through Composio's upload link as an
// `s3key`, then the named upload tool runs with that key in its file field, so the file lands in the
// app without a download/re-upload in between. The bot-call path stages the same way inside a
// turn (server/connector-files.ts); this module is the standalone push, for a generated or
// uploaded file already in the bot's folder. Which apps can receive a file, and which cannot, is
// server/connector-file-capabilities.ts; a toolkit whose push is "no" is refused here in plain words.
import { createHash } from "node:crypto";

import { capabilityForToolkit, KNOWN_CONNECTOR_FILE_CAPABILITIES, type ConnectorFileCapability } from "./connector-file-capabilities.ts";
import { UploadServiceOutdatedError } from "./composio-files.ts";
import { serviceSlugFor, serviceSlugForCandidates } from "./connector-verdict.ts";

export interface StagedFile {
  name: string;
  mimetype: string;
  s3key: string;
}

export interface OpenedPushFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export type PushErrorKind = "cannot-push" | "no-file" | "too-large" | "stage-failed" | "execute-failed";

export interface PushError {
  kind: PushErrorKind;
  error: string;
}

export interface PushDeps {
  /** The bot's file at `path`; null when there is no such file there, or it may not be sent. Throws why a file there may not be sent. */
  open(path: string): Promise<OpenedPushFile | null>;
  /** Composio's upload link and key for the file (server/composio-files.ts). */
  requestUpload(request: { toolkit_slug: string; tool_slug: string; filename: string; mimetype: string; md5: string }): Promise<{ key: string; url: string }>;
  /** The toolkit a tool belongs to; the verified map is consulted when this is absent. */
  toolkitFor?(tool: string): string | null;
  /** The capability of one toolkit, for the push gate; the verified map when absent. */
  capabilityFor?(slug: string): ConnectorFileCapability;
  put?(url: string, bytes: Uint8Array, mimetype: string): Promise<void>;
  /** Runs the upload tool with the staged file in its arguments; absent, the file is only staged. */
  execute?(tool: string, args: Record<string, unknown>): Promise<unknown>;
}

const PUT_TIMEOUT_MS = 5 * 60_000;
const KNOWN_SLUGS = KNOWN_CONNECTOR_FILE_CAPABILITIES.map((entry) => entry.slug);

function toolkitOf(tool: string, deps: PushDeps): string | null {
  return deps.toolkitFor?.(tool) ?? serviceSlugForCandidates(tool, KNOWN_SLUGS) ?? serviceSlugFor(tool);
}

async function putBytes(url: string, bytes: Uint8Array, mimetype: string): Promise<void> {
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  // The link is Composio's own storage: a redirect elsewhere is refused, never followed with the file.
  const response = await fetch(url, { method: "PUT", body, redirect: "error", headers: { "content-type": mimetype }, signal: AbortSignal.timeout(PUT_TIMEOUT_MS) });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new Error(`the upload was refused (HTTP ${response.status})`);
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 240);

/** What the caller is told when the file it named is not one of the bot's files, or may not be sent. */
export function noPushFileText(path: string, reason?: string): string {
  return `There is no file at ${path} in the bot's folder that can be sent${reason ? ` (${reason})` : ""}. `
    + "Give the full path of a file in the bot's folder, or pull the file into the folder first, and nothing was sent.";
}

/** The staged file for `tool`, ready to go in its file field, or why it cannot be staged. */
export async function stagePushedFile(
  tool: string,
  path: string,
  deps: PushDeps,
): Promise<{ staged: StagedFile; name: string; bytes: number; mime: string } | PushError> {
  const slug = toolkitOf(tool, deps);
  const capability = slug ? (deps.capabilityFor?.(slug) ?? capabilityForToolkit(slug)) : null;
  if (capability && capability.push === "no") {
    return { kind: "cannot-push", error: `${tool} cannot receive a file: ${capability.pushNote}` };
  }
  let file: OpenedPushFile | null;
  try {
    file = await deps.open(path);
  } catch (error) {
    const reason = reasonOf(error);
    if (/larger than \d+ MB/.test(reason)) {
      return { kind: "too-large", error: `${path} is ${reason}, so it was not sent.` };
    }
    return { kind: "no-file", error: noPushFileText(path, reason) };
  }
  if (!file) return { kind: "no-file", error: noPushFileText(path) };
  const mimetype = file.mime.split(";")[0]!.trim();
  const put = deps.put ?? putBytes;
  try {
    const md5 = createHash("md5").update(file.bytes).digest("hex");
    const link = await deps.requestUpload({ toolkit_slug: slug ?? tool.toLowerCase(), tool_slug: tool, filename: file.name, mimetype, md5 });
    await put(link.url, file.bytes, mimetype);
    return { staged: { name: file.name, mimetype, s3key: link.key }, name: file.name, bytes: file.bytes.byteLength, mime: mimetype };
  } catch (error) {
    if (error instanceof UploadServiceOutdatedError) {
      return { kind: "stage-failed", error: `Uploading ${file.name} failed: the connected-apps service is out of date and does not take file uploads yet. Nothing was written. Trying again will not help: sending files works once the SanRemes team updates that service.` };
    }
    return { kind: "stage-failed", error: `Uploading ${file.name} failed (${reasonOf(error)}). Nothing was written. This is usually brief: try once more.` };
  }
}

/** The arguments for the upload tool: the staged file under `field`, added to an array there when the field already holds one. */
export function pushArguments(
  args: Record<string, unknown>,
  field: string,
  staged: StagedFile,
): Record<string, unknown> {
  const existing = args[field];
  if (Array.isArray(existing)) return { ...args, [field]: [...existing, staged] };
  return { ...args, [field]: staged };
}

export interface PushedFile {
  tool: string;
  name: string;
  bytes: number;
  mime: string;
  staged: StagedFile;
  arguments: Record<string, unknown>;
  executed: boolean;
  result?: unknown;
}

/**
 * Pushes the file at `path` into the app behind `tool`: staged, then the tool run with the staged
 * file under `field` (default `file_to_upload`) plus `args`. Without an `execute` dep the file is
 * only staged and `arguments` is what the tool call must be sent with; the file lands in the app
 * only when that call runs.
 */
export async function pushConnectorFile(
  tool: string,
  path: string,
  args: Record<string, unknown>,
  field: string,
  deps: PushDeps,
): Promise<PushedFile | PushError> {
  const staged = await stagePushedFile(tool, path, deps);
  if ("kind" in staged) return staged;
  const { staged: stagedFile, ...rest } = staged;
  const callArgs = pushArguments(args, field, stagedFile);
  if (!deps.execute) {
    return { tool, ...rest, staged: stagedFile, arguments: callArgs, executed: false };
  }
  try {
    const result = await deps.execute(tool, callArgs);
    return { tool, ...rest, staged: stagedFile, arguments: callArgs, executed: true, result };
  } catch (error) {
    return { kind: "execute-failed", error: `${tool} did not run (${reasonOf(error)}), so ${staged.name} was not written to the app. The staged file can be sent again with a new call.` };
  }
}
