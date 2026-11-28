// Pulling a file a connected app offers: the download tool already ran, and its result is
// here. The file's bytes come out of that result and are written straight to the bot's
// folder, so there is no download-then-re-upload step: the result is the transfer.
// A result that only carries a download link is fetched once, straight to the same file.
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { FILE_MAX_BYTES } from "../shared/upload-limits.ts";

export interface PulledFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export type PullErrorKind = "no-file" | "too-large" | "fetch-failed" | "save-failed";

export interface PullError {
  kind: PullErrorKind;
  error: string;
}

const CONTENT_KEYS = new Set([
  "downloaded_file_content",
  "file_content",
  "filecontentbase64",
  "file_content_base64",
  "content_base64",
  "base64_content",
  "exported_file_content",
  "downloaded_content",
]);
const NAME_KEYS = ["file_name", "filename", "fileName", "name"];
const MIME_KEYS = ["mime_type", "mimetype", "mimeType", "mime"];
const URL_KEYS = ["download_url", "downloadUrl", "download_link", "url"];
const MAX_DEPTH = 4;
const FETCH_TIMEOUT_MS = 5 * 60_000;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isTextMime = (mime: string) => mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json");

function base64Bytes(value: string): Uint8Array | null {
  const compact = value.replace(/\s+/g, "");
  if (compact.length < 8 || compact.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(compact)) return null;
  try {
    const bytes = Buffer.from(compact, "base64");
    if (!bytes.length || bytes.toString("base64") !== compact) return null;
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function companion(record: Json, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = textOf(record[key]);
    if (value) return value;
  }
  return null;
}

/** The file content in one result record, with the name and type named beside it. */
function fileInRecord(record: Json, tool: string): { file: PulledFile } | { url: string; name: string; mime: string } | null {
  const name = companion(record, NAME_KEYS) ?? `${tool.toLowerCase()}.bin`;
  const mime = companion(record, MIME_KEYS) ?? "application/octet-stream";
  for (const key of Object.keys(record)) {
    const value = textOf(record[key]);
    if (!value || !CONTENT_KEYS.has(key.toLowerCase())) continue;
    const bytes = base64Bytes(value);
    if (bytes) return { file: { name, mime, bytes } };
    if (isTextMime(mime)) return { file: { name, mime, bytes: new TextEncoder().encode(value) } };
    return null;
  }
  for (const key of URL_KEYS) {
    const value = textOf(record[key]);
    if (value && /^https:\/\//i.test(value)) return { url: value, name, mime };
  }
  return null;
}

function collectRecords(value: unknown, depth: number, found: Json[]): void {
  if (depth > MAX_DEPTH || found.length > 20) return;
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, depth + 1, found);
    return;
  }
  if (typeof value === "string") {
    try {
      collectRecords(JSON.parse(value), depth + 1, found);
    } catch { /* text, not a result record */ }
    return;
  }
  if (!isRecord(value)) return;
  found.push(value);
  for (const entry of Object.values(value)) collectRecords(entry, depth + 1, found);
}

/** What the bot is told when a tool result carries no file. */
export function noFileText(tool: string): string {
  return `${tool} did not return a file, so there was nothing to pull. Ask the app for the file first `
    + "(search for it, then run its download tool), and check the file is a file and not a folder.";
}

/** The file in a connector download tool's result, or why there is none to pull. */
export function extractPulledFile(
  result: unknown,
  tool: string,
): { file: PulledFile } | { url: string; name: string; mime: string } | PullError {
  const records: Json[] = [];
  if (isRecord(result) && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (isRecord(block) && typeof block.text === "string") collectRecords(block.text, 0, records);
      if (isRecord(block) && isRecord(block.resource)) collectRecords(block.resource, 0, records);
    }
  }
  if (isRecord(result) && result.structuredContent !== undefined) collectRecords(result.structuredContent, 0, records);
  collectRecords(result, 0, records);
  let sawUrl: { url: string; name: string; mime: string } | null = null;
  for (const record of records) {
    const found = fileInRecord(record, tool);
    if (!found) continue;
    if ("file" in found) {
      if (found.file.bytes.byteLength > FILE_MAX_BYTES) {
        return { kind: "too-large", error: `${tool} returned ${found.file.name}, which is larger than 100 MB, so it was not saved.` };
      }
      return found;
    }
    sawUrl ??= found;
  }
  if (sawUrl) return sawUrl;
  return { kind: "no-file", error: noFileText(tool) };
}

/** A file name that cannot escape its folder: no separators, no leading dot, one extension kept. */
export function safePulledName(name: string): string {
  const cleaned = basename(name.replace(/[\\/]+/g, "/"))
    // eslint-disable-next-line no-control-regex -- stripping control characters from the name is the point
    .replace(/[\x00-\x1f\x7f]/g, "").replace(/^\.+/, "").trim();
  return cleaned || "download";
}

async function uniquePath(dir: string, name: string): Promise<string> {
  const stem = name.slice(0, name.length - extname(name).length) || "download";
  const extension = extname(name);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(dir, attempt === 0 ? name : `${stem} (${attempt + 1})${extension}`);
    try {
      await writeFile(candidate, new Uint8Array(), { flag: "wx", mode: 0o600 });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not find a free name for ${name} in this folder`);
}

/** Writes the pulled bytes into `dir`, never overwriting a file that is already there. */
export async function savePulledFile(
  file: PulledFile,
  dir: string,
): Promise<{ path: string; name: string; bytes: number }> {
  const name = safePulledName(file.name);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = await uniquePath(dir, name);
    await writeFile(path, file.bytes, { mode: 0o600 });
    return { path, name: basename(path), bytes: file.bytes.byteLength };
  } catch (error) {
    throw new Error(`could not save ${name} in this folder (${error instanceof Error ? error.message : String(error)})`);
  }
}

export interface PullDeps {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/** The file a download tool's result offers, saved into `dir`: content inline is written as it
 * is; a bare download link is fetched once, straight into the same file. */
export async function pullConnectorFile(
  result: unknown,
  tool: string,
  dir: string,
  deps: PullDeps = {},
): Promise<{ path: string; name: string; bytes: number; mime: string } | PullError> {
  const extracted = extractPulledFile(result, tool);
  if ("kind" in extracted) return extracted;
  if ("file" in extracted) {
    try {
      const saved = await savePulledFile(extracted.file, dir);
      return { ...saved, mime: extracted.file.mime };
    } catch (error) {
      return { kind: "save-failed", error: error instanceof Error ? error.message : String(error) };
    }
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(extracted.url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return { kind: "fetch-failed", error: `The download link ${tool} returned could not be opened, so nothing was pulled.` };
  }
  if (!response.ok) {
    return { kind: "fetch-failed", error: `The download link ${tool} returned was refused (HTTP ${response.status}), so nothing was pulled.` };
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > FILE_MAX_BYTES) {
    return { kind: "too-large", error: `${extracted.name} is larger than 100 MB, so it was not saved.` };
  }
  try {
    const saved = await savePulledFile({ name: extracted.name, mime: extracted.mime, bytes }, dir);
    return { ...saved, mime: extracted.mime };
  } catch (error) {
    return { kind: "save-failed", error: error instanceof Error ? error.message : String(error) };
  }
}
