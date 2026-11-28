import { describe, expect, it } from "vitest";

import {
  capabilityForToolkit, classifyConnectorTools, connectorFileCapabilities, KNOWN_CONNECTOR_FILE_CAPABILITIES,
} from "./connector-file-capabilities.ts";

describe("connector file capabilities", () => {
  it("verifies Google Drive and OneDrive move files both ways", () => {
    const drive = KNOWN_CONNECTOR_FILE_CAPABILITIES.find((entry) => entry.slug === "googledrive")!;
    expect(drive.push).toBe("yes");
    expect(drive.pull).toBe("yes");
    expect(drive.pushTools).toContain("GOOGLEDRIVE_UPLOAD_FILE");
    expect(drive.pullTools).toContain("GOOGLEDRIVE_DOWNLOAD_FILE");
    const oneDrive = KNOWN_CONNECTOR_FILE_CAPABILITIES.find((entry) => entry.slug === "one_drive")!;
    expect(oneDrive.pushTools).toContain("ONE_DRIVE_ONEDRIVE_UPLOAD_FILE");
    expect(oneDrive.pullTools).toContain("ONE_DRIVE_DOWNLOAD_FILE");
  });

  it("records the Slack and Gmail gaps in plain words", () => {
    const slack = KNOWN_CONNECTOR_FILE_CAPABILITIES.find((entry) => entry.slug === "slack")!;
    expect(slack.push).toBe("yes");
    expect(slack.pull).toBe("no");
    expect(slack.pullNote).toMatch(/no file download tool/);
    const gmail = KNOWN_CONNECTOR_FILE_CAPABILITIES.find((entry) => entry.slug === "gmail")!;
    expect(gmail.push).toBe("yes");
    expect(gmail.pull).toBe("no");
  });

  it("marks Dropbox push and GitHub both ways unproven, not yes", () => {
    const dropbox = KNOWN_CONNECTOR_FILE_CAPABILITIES.find((entry) => entry.slug === "dropbox")!;
    expect(dropbox.push).toBe("unproven");
    expect(dropbox.pull).toBe("yes");
    const github = KNOWN_CONNECTOR_FILE_CAPABILITIES.find((entry) => entry.slug === "github")!;
    expect(github.push).toBe("unproven");
    expect(github.pull).toBe("unproven");
  });

  it("classifies a live tool list, and leaves a text-only file tool out", () => {
    const { pushTools, pullTools } = classifyConnectorTools([
      { name: "GOOGLEDRIVE_UPLOAD_FILE", description: "Upload a file to Drive" },
      { name: "GOOGLEDRIVE_DOWNLOAD_FILE", description: "Download a file from Drive" },
      { name: "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT", description: "Create a file from text" },
      { name: "GOOGLEDRIVE_LIST_FILES", description: "List files" },
    ]);
    expect(pushTools).toEqual(["GOOGLEDRIVE_UPLOAD_FILE"]);
    expect(pullTools).toEqual(["GOOGLEDRIVE_DOWNLOAD_FILE"]);
  });

  it("classifies lowercase custom MCP tools by their names", () => {
    const { pushTools, pullTools } = classifyConnectorTools([
      { name: "upload_file", description: "Upload a file" },
      { name: "download_file", description: "Download a file" },
    ]);
    expect(pushTools).toEqual(["upload_file"]);
    expect(pullTools).toEqual(["download_file"]);
  });

  it("answers unproven with the reason for a toolkit with no tool list", () => {
    const entry = capabilityForToolkit("notion");
    expect(entry.push).toBe("unproven");
    expect(entry.pullNote).toMatch(/live tools list/);
    expect(connectorFileCapabilities({ notion: [{ name: "NOTION_SEARCH", description: "Search pages" }] }))
      .toContainEqual(expect.objectContaining({ slug: "notion", push: "no", pull: "no" }));
  });
});
