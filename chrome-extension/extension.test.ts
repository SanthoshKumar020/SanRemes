// The extension is side-loaded, never published, so its checks are static: the manifest stays a minimal MV3
// panel that talks only to the local server, and its scripts stay plain JavaScript with no remote calls.
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

const dir = new URL("./", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir), "utf8");
const manifest = JSON.parse(read("manifest.json")) as Record<string, unknown>;

describe("the side-loaded extension", () => {
  it("is a minimal MV3 side panel with no store listing or page-wide access", () => {
    expect(manifest.manifest_version).toBe(3);
    expect((manifest.side_panel as Record<string, unknown>).default_path).toBe("panel.html");
    expect(manifest.background).toEqual({ service_worker: "background.js" });
    expect(manifest.permissions).toEqual(["sidePanel", "activeTab", "scripting", "storage"]);
    expect(manifest.host_permissions).toEqual(["http://localhost:8799/*"]);
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("update_url");
  });

  it("keeps its scripts plain JavaScript that runs, and its panel free of remote resources", () => {
    for (const name of ["background.js", "panel.js"]) new Script(read(name), { filename: name });
    const panel = read("panel.html");
    expect(panel).toContain('<script src="panel.js"></script>');
    expect(panel).not.toMatch(/<(?:script|link|img)[^>]*(?:src|href)="https?:\/\//);
    expect(panel).not.toContain("url(http");
  });

  it("calls nothing but the local server", () => {
    expect(read("background.js").match(/https?:\/\/[^\s"'`]+/g) ?? []).toEqual([]);
    expect(read("panel.js").match(/https?:\/\/[^\s"'`]+/g) ?? []).toEqual(["http://localhost:8799"]);
    expect(read("panel.js")).toContain("/hooks/api/bots/");
  });
});
