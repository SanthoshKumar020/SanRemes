import { describe, expect, it, vi } from "vitest";

import { pushConnectorFile, pushArguments, stagePushedFile } from "./connector-file-push.ts";
import { UploadServiceOutdatedError } from "./composio-files.ts";

const bytes = new TextEncoder().encode("%PDF-1.4 quarterly report");
const file = { name: "report.pdf", mime: "application/pdf", bytes };

function deps(overrides: Record<string, unknown> = {}) {
  return {
    open: async () => file,
    requestUpload: async () => ({ key: "s3key-1", url: "https://files.example.test/upload" }),
    put: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as Parameters<typeof pushConnectorFile>[4];
}

describe("pushing a file into a connected app", () => {
  it("stages the file and runs the upload tool with the staged key", async () => {
    const put = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({ data: { id: "1AbC" } }));
    const pushed = await pushConnectorFile(
      "GOOGLEDRIVE_UPLOAD_FILE",
      "/bot/report.pdf",
      { folder_id: "root" },
      "file_to_upload",
      deps({ put, execute }),
    );
    expect("kind" in pushed).toBe(false);
    if ("kind" in pushed) return;
    expect(pushed.executed).toBe(true);
    expect(pushed.staged).toEqual({ name: "report.pdf", mimetype: "application/pdf", s3key: "s3key-1" });
    expect(pushed.bytes).toBe(bytes.byteLength);
    expect(put).toHaveBeenCalledWith("https://files.example.test/upload", bytes, "application/pdf");
    expect(execute).toHaveBeenCalledWith("GOOGLEDRIVE_UPLOAD_FILE", {
      folder_id: "root",
      file_to_upload: { name: "report.pdf", mimetype: "application/pdf", s3key: "s3key-1" },
    });
    expect(pushed.result).toEqual({ data: { id: "1AbC" } });
  });

  it("stages only, and hands back the arguments, when no execute dep is wired", async () => {
    const pushed = await pushConnectorFile("GOOGLEDRIVE_UPLOAD_FILE", "/bot/report.pdf", {}, "file_to_upload", deps());
    expect("kind" in pushed).toBe(false);
    if ("kind" in pushed) return;
    expect(pushed.executed).toBe(false);
    expect(pushed.arguments).toEqual({
      file_to_upload: { name: "report.pdf", mimetype: "application/pdf", s3key: "s3key-1" },
    });
    expect(pushed.result).toBeUndefined();
  });

  it("adds the staged file to an array field, for Gmail attachments", () => {
    expect(pushArguments(
      { attachments: [{ name: "a.txt", mimetype: "text/plain", s3key: "old" }] },
      "attachments",
      { name: "report.pdf", mimetype: "application/pdf", s3key: "s3key-1" },
    )).toEqual({
      attachments: [
        { name: "a.txt", mimetype: "text/plain", s3key: "old" },
        { name: "report.pdf", mimetype: "application/pdf", s3key: "s3key-1" },
      ],
    });
  });

  it("refuses in plain words a toolkit that cannot receive files", async () => {
    const refused = await stagePushedFile("SOMEAPP_UPLOAD_FILE", "/bot/report.pdf", deps({
      capabilityFor: () => ({
        slug: "someapp", label: "Some App", push: "no", pull: "no", pushTools: [], pullTools: [],
        pushNote: "Some App offers no file-upload tool, so it cannot receive a file.",
        pullNote: "Some App offers no file-download tool.",
      }),
    }));
    expect(refused).toEqual({ kind: "cannot-push", error: expect.stringContaining("cannot receive a file") });
  });

  it("says so in plain words when the file is not there, or too large", async () => {
    const missing = await pushConnectorFile("GOOGLEDRIVE_UPLOAD_FILE", "/bot/gone.pdf", {}, "file_to_upload", deps({
      open: async () => null,
    }));
    expect(missing).toEqual({ kind: "no-file", error: expect.stringContaining("no file at /bot/gone.pdf") });
    const large = await pushConnectorFile("GOOGLEDRIVE_UPLOAD_FILE", "/bot/big.pdf", {}, "file_to_upload", deps({
      open: async () => { throw new Error("it is larger than 100 MB"); },
    }));
    expect(large).toEqual({ kind: "too-large", error: expect.stringContaining("larger than 100 MB") });
  });

  it("says the service is out of date when the upload link refuses, and reports a failed run", async () => {
    const outdated = await pushConnectorFile("GOOGLEDRIVE_UPLOAD_FILE", "/bot/report.pdf", {}, "file_to_upload", deps({
      requestUpload: async () => { throw new UploadServiceOutdatedError(); },
    }));
    expect(outdated).toEqual({ kind: "stage-failed", error: expect.stringContaining("out of date") });
    const failed = await pushConnectorFile("GOOGLEDRIVE_UPLOAD_FILE", "/bot/report.pdf", {}, "file_to_upload", deps({
      execute: async () => { throw new Error("upstream down"); },
    }));
    expect(failed).toEqual({ kind: "execute-failed", error: expect.stringContaining("did not run") });
  });

  it("maps ONE_DRIVE_ tools to the one_drive toolkit, not one", async () => {
    const requestUpload = vi.fn(async () => ({ key: "k", url: "https://files.example.test/u" }));
    const staged = await stagePushedFile("ONE_DRIVE_ONEDRIVE_UPLOAD_FILE", "/bot/report.pdf", deps({ requestUpload }));
    expect("kind" in staged).toBe(false);
    expect(requestUpload).toHaveBeenCalledWith(expect.objectContaining({ toolkit_slug: "one_drive" }));
  });
});
