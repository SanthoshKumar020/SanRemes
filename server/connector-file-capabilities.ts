// Which connected apps can move files, and which cannot.
//
// Push (a file from this computer into the app) is server/connector-file-push.ts: it stages a
// local file through Composio's upload link as an `s3key` and runs the named upload tool with it
// (the bot-call path stages the same way inside a turn: server/connector-files.ts). Pull (a file
// the app offers, into this computer) is server/connector-file-pull.ts: it reads the file content
// out of the download tool's result and writes it straight to the bot's folder.
//
// Gaps, in plain words (the live tools list is the final word for any toolkit not listed
// here; Composio renames tools, and a toolkit's list is read by listToolkitTools):
// - Dropbox: download and export are offered, but no upload tool slug was verified here,
//   so push is unproven until a live tools list names one.
// - Slack: files can be uploaded, but the toolkit offers no file download tool, so a file
//   shared in Slack cannot be pulled; only the link Slack returns can be opened.
// - Gmail: a file can be sent as an attachment, but Gmail offers no file download tool;
//   an attachment arrives inside a fetched message, not as a file to pull.
// - GitHub: repository file content is readable through content tools, but no binary
//   file-transfer tool slug was verified here, so neither direction is proven.
// - Every other toolkit: unproven until its live tool list is classified; most
//   (calendars, contacts, CRM text tools) offer no file tool at all and cannot move files.
import type { ConnectorToolListing } from "./composio.ts";

export type FileDirection = "push" | "pull";
export type FileSupport = "yes" | "no" | "unproven";

export interface ConnectorFileCapability {
  slug: string;
  label: string;
  push: FileSupport;
  pull: FileSupport;
  /** Tool slugs verified to move a file in that direction; empty when none was verified. */
  pushTools: readonly string[];
  pullTools: readonly string[];
  /** What the direction does here, or why it cannot be done. Plain words. */
  pushNote: string;
  pullNote: string;
}

const capability = (
  slug: string,
  label: string,
  push: FileSupport,
  pull: FileSupport,
  pushTools: readonly string[],
  pullTools: readonly string[],
  pushNote: string,
  pullNote: string,
): ConnectorFileCapability => ({ slug, label, push, pull, pushTools, pullTools, pushNote, pullNote });

/** Toolkits whose file tools were verified against Composio's published toolkit pages and this repo. */
export const KNOWN_CONNECTOR_FILE_CAPABILITIES: readonly ConnectorFileCapability[] = [
  capability(
    "googledrive",
    "Google Drive",
    "yes",
    "yes",
    ["GOOGLEDRIVE_UPLOAD_FILE"],
    ["GOOGLEDRIVE_DOWNLOAD_FILE"],
    "A local file is staged through Composio's upload link and sent as an s3key (server/connector-files.ts). A tool that takes text instead of a file, such as GOOGLEDRIVE_CREATE_FILE_FROM_TEXT, moves no file.",
    "GOOGLEDRIVE_DOWNLOAD_FILE returns the file in downloaded_file_content. Google-native files (Docs, Sheets, Slides) need an export MIME type instead of a plain download.",
  ),
  capability(
    "one_drive",
    "OneDrive",
    "yes",
    "yes",
    ["ONE_DRIVE_ONEDRIVE_UPLOAD_FILE"],
    ["ONE_DRIVE_DOWNLOAD_FILE"],
    "ONE_DRIVE_ONEDRIVE_UPLOAD_FILE takes a staged file. ONE_DRIVE_UPDATE_FILE_CONTENT replaces a file's content with new content instead of uploading a file.",
    "ONE_DRIVE_DOWNLOAD_FILE returns the file's contents by item ID. Further download variants (by path, as a format, a version's content) exist; resolve their slugs from a live tools list.",
  ),
  capability(
    "dropbox",
    "Dropbox",
    "unproven",
    "yes",
    [],
    [],
    "No upload tool slug was verified here; push stays unproven until a live tools list names one.",
    "Dropbox offers a file download (by path, returning content and metadata), a shared-link download, a folder download as a zip, and an export for files such as Paper documents, which returns UTF-8 text truncated past 500,000 characters. Slugs come from a live tools list.",
  ),
  capability(
    "slack",
    "Slack",
    "yes",
    "no",
    ["SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK"],
    [],
    "SLACK_UPLOAD_OR_CREATE_A_FILE_IN_SLACK uploads a staged file into a channel.",
    "Slack's toolkit offers no file download tool, so a file shared in Slack cannot be pulled into this computer. Only the link Slack returns can be opened.",
  ),
  capability(
    "gmail",
    "Gmail",
    "yes",
    "no",
    ["GMAIL_SEND_EMAIL"],
    [],
    "A local file is staged and sent as an attachment on GMAIL_SEND_EMAIL (server/connector-files.ts).",
    "Gmail offers no file download tool. An attachment arrives inside a fetched message, not as a file to pull.",
  ),
  capability(
    "github",
    "GitHub",
    "unproven",
    "unproven",
    [],
    [],
    "No binary file-upload tool slug was verified here; push stays unproven until a live tools list names one.",
    "Repository file content is readable through content tools, but no binary file-download tool slug was verified here, so pull stays unproven until a live tools list names one.",
  ),
];

const bySlug = new Map(KNOWN_CONNECTOR_FILE_CAPABILITIES.map((entry) => [entry.slug, entry]));

const TEXT_ONLY = /from_text|from-text/i;
const PUSH_NAME = /(^|_)(UPLOAD|ATTACH)(_|$)|CREATE(_|_A_)?FILE|CREATE_FILE/i;
const PULL_NAME = /(^|_)(DOWNLOAD|EXPORT)(_|$)|READ_FILE|GET(_|_FILE_)?CONTENT|PARSE_FILE/i;
const PUSH_DESCRIPTION = /\bupload\b.{0,40}\bfile\b|\bfile\b.{0,40}\bupload\b/i;
const PULL_DESCRIPTION = /\bdownload\b.{0,40}\bfile\b|\bfile\b.{0,40}\bdownload\b|\bexport\b.{0,40}\bfile\b/i;

function isFileTool(tool: ConnectorToolListing, namePattern: RegExp, descriptionPattern: RegExp): boolean {
  if (TEXT_ONLY.test(tool.name) || TEXT_ONLY.test(tool.description ?? "")) return false;
  return namePattern.test(tool.name) || descriptionPattern.test(tool.description ?? "");
}

/** The file tools in one toolkit's live tool list, by direction. */
export function classifyConnectorTools(tools: readonly ConnectorToolListing[]): { pushTools: string[]; pullTools: string[] } {
  const pushTools: string[] = [];
  const pullTools: string[] = [];
  for (const tool of tools) {
    if (isFileTool(tool, PUSH_NAME, PUSH_DESCRIPTION) && !pushTools.includes(tool.name)) pushTools.push(tool.name);
    if (isFileTool(tool, PULL_NAME, PULL_DESCRIPTION) && !pullTools.includes(tool.name)) pullTools.push(tool.name);
  }
  return { pushTools, pullTools };
}

/**
 * One toolkit's capability: the verified entry when there is one, else what its live tool
 * list proves, else unproven in both directions with the reason in plain words.
 */
export function capabilityForToolkit(
  slug: string,
  tools?: readonly ConnectorToolListing[],
): ConnectorFileCapability {
  const known = bySlug.get(slug);
  if (known && !tools) return known;
  const label = known?.label ?? slug;
  if (!tools) {
    return capability(
      slug,
      label,
      "unproven",
      "unproven",
      [],
      [],
      `No file tool was verified for ${label}; a live tools list decides whether it can send files.`,
      `No file tool was verified for ${label}; a live tools list decides whether it can offer files.`,
    );
  }
  const { pushTools, pullTools } = classifyConnectorTools(tools);
  const pushNote = pushTools.length
    ? `${label} offers ${pushTools.join(", ")} to send a file.`
    : `${label} offers no file-upload tool in the tool list that was read, so it cannot send a file.`;
  const pullNote = pullTools.length
    ? `${label} offers ${pullTools.join(", ")} to get a file.`
    : `${label} offers no file-download tool in the tool list that was read, so it cannot offer a file to pull.`;
  return capability(
    slug,
    label,
    pushTools.length ? "yes" : "no",
    pullTools.length ? "yes" : "no",
    pushTools,
    pullTools,
    known && pushTools.length ? known.pushNote : pushNote,
    known && pullTools.length ? known.pullNote : pullNote,
  );
}

/** The verified map, with a live tool list per toolkit classified over it when given. */
export function connectorFileCapabilities(
  toolsBySlug?: Readonly<Record<string, readonly ConnectorToolListing[]>>,
): ConnectorFileCapability[] {
  const entries = KNOWN_CONNECTOR_FILE_CAPABILITIES.map((entry) =>
    toolsBySlug?.[entry.slug] ? capabilityForToolkit(entry.slug, toolsBySlug[entry.slug]) : entry);
  const extra = Object.keys(toolsBySlug ?? {})
    .filter((slug) => !bySlug.has(slug))
    .map((slug) => capabilityForToolkit(slug, toolsBySlug![slug]!));
  return [...entries, ...extra];
}
