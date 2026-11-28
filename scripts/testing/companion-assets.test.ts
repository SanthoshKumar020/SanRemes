import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const html = readFileSync(new URL("public/companion/index.html", root), "utf8");
const js = readFileSync(new URL("public/companion/app.js", root), "utf8");
const css = readFileSync(new URL("public/companion/app.css", root), "utf8");

describe("phone companion assets", () => {
  it("is a phone page with safe areas and no focus zoom", () => {
    const viewport = html.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? "";
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).not.toMatch(/user-scalable=no|maximum-scale=1/);
    expect(css).toContain("env(safe-area-inset-top");
    expect(css).toContain("env(safe-area-inset-bottom");
    expect(css).toMatch(/input, textarea \{[^}]*font-size: 16px/s);
  });

  it("talks only to the Bot API with a bearer key, and never hard-codes one", () => {
    expect(js).toContain("/hooks/api/bots/");
    expect(js).toContain('"Authorization": "Bearer "');
    expect(js).not.toMatch(/Bearer [A-Za-z0-9]{16,}/);
    expect(js).not.toContain("service worker");
    expect(js).not.toContain("register(");
  });

  it("says plainly that approvals wait for the app", () => {
    expect(js).toContain("needs_approval");
    expect(js).toContain("Approvals can't be given from outside");
    expect(js).toContain("answer it in the SanRemes app");
  });

  it("keeps keys in the browser and sends them only to the saved address", () => {
    expect(js).toContain("localStorage");
    expect(js).toContain("Keys stay in this browser");
    expect(js).not.toMatch(/fetch\("https?:\/\//);
  });
});
