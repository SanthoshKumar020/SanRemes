import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { extractPulledFile, pullConnectorFile, safePulledName, savePulledFile } from "./connector-file-pull.ts";

const bytes = new TextEncoder().encode("%PDF-1.4 quarterly report");
const base64 = Buffer.from(bytes).toString("base64");
const dirs: string[] = [];
const dir = () => {
  const one = mkdtempSync(join(tmpdir(), "connector-pull-"));
  dirs.push(one);
  return one;
};
afterEach(() => {
  for (const one of dirs.splice(0)) rmSync(one, { recursive: true, force: true });
});

describe("pulling a file out of a connector tool result", () => {
  it("reads Google Drive's downloaded_file_content as base64", () => {
    const found = extractPulledFile(
      { downloaded_file_content: base64, file_name: "report.pdf", mime_type: "application/pdf" },
      "GOOGLEDRIVE_DOWNLOAD_FILE",
    );
    expect("file" in found && found.file).toEqual({ name: "report.pdf", mime: "application/pdf", bytes });
  });

  it("reads plain text content when the type says text", () => {
    const found = extractPulledFile(
      { downloaded_file_content: "hello, world", file_name: "notes.txt", mime_type: "text/plain" },
      "GOOGLEDRIVE_DOWNLOAD_FILE",
    );
    expect("file" in found && new TextDecoder().decode(found.file.bytes)).toBe("hello, world");
  });

  it("reads a file out of an MCP text block carrying JSON", () => {
    const found = extractPulledFile(
      { content: [{ type: "text", text: JSON.stringify({ file_content: base64, file_name: "a.bin" }) }] },
      "DROPBOX_DOWNLOAD_FILE",
    );
    expect("file" in found && found.file.name).toBe("a.bin");
    expect("file" in found && found.file.bytes).toEqual(bytes);
  });

  it("says so in plain words when the result carries no file", () => {
    const found = extractPulledFile({ file_id: "1AbC", name: "report.pdf" }, "GOOGLEDRIVE_DOWNLOAD_FILE");
    expect(found).toEqual({ kind: "no-file", error: expect.stringContaining("did not return a file") });
  });

  it("saves the pulled bytes straight into the folder, never overwriting", async () => {
    const folder = dir();
    const first = await pullConnectorFile(
      { downloaded_file_content: base64, file_name: "report.pdf", mime_type: "application/pdf" },
      "GOOGLEDRIVE_DOWNLOAD_FILE",
      folder,
    );
    expect("path" in first && first.name).toBe("report.pdf");
    expect(readFileSync(join(folder, "report.pdf"))).toEqual(Buffer.from(bytes));
    const second = await pullConnectorFile(
      { downloaded_file_content: base64, file_name: "report.pdf", mime_type: "application/pdf" },
      "GOOGLEDRIVE_DOWNLOAD_FILE",
      folder,
    );
    expect("path" in second && second.name).toBe("report (2).pdf");
    expect(readdirSync(folder).sort()).toEqual(["report (2).pdf", "report.pdf"]);
  });

  it("fetches a bare download link once, straight into the file", async () => {
    const folder = dir();
    const fetchImpl = async () => new Response(bytes, { headers: { "content-type": "application/pdf" } });
    const pulled = await pullConnectorFile(
      { download_url: "https://files.example.test/report.pdf", file_name: "report.pdf", mime_type: "application/pdf" },
      "ONE_DRIVE_DOWNLOAD_FILE",
      folder,
      { fetchImpl: fetchImpl as (url: string, init: RequestInit) => Promise<Response> },
    );
    expect("path" in pulled && pulled.bytes).toBe(bytes.byteLength);
    expect(readFileSync(join(folder, "report.pdf"))).toEqual(Buffer.from(bytes));
  });

  it("refuses a download link it cannot open, and a name that escapes the folder", async () => {
    const folder = dir();
    const refused = await pullConnectorFile(
      { download_url: "https://files.example.test/x.pdf", file_name: "x.pdf" },
      "ONE_DRIVE_DOWNLOAD_FILE",
      folder,
      { fetchImpl: async () => { throw new Error("down"); } },
    );
    expect(refused).toEqual({ kind: "fetch-failed", error: expect.stringContaining("could not be opened") });
    expect(safePulledName("../../etc/passwd")).toBe("passwd");
    expect(safePulledName("")).toBe("download");
  });

  it("savePulledFile writes with the safe name", async () => {
    const folder = dir();
    const saved = await savePulledFile({ name: "../evil.pdf", mime: "application/pdf", bytes }, folder);
    expect(saved.name).toBe("evil.pdf");
    expect(readFileSync(join(folder, "evil.pdf"))).toEqual(Buffer.from(bytes));
  });
});
