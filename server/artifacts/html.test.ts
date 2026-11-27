import { describe, expect, it } from "vitest";
import { artifactShell, escapeAttr, escapeHtml, jsonForScript } from "./html.ts";

describe("escapeHtml", () => {
  it("escapes markup and quotes", () => {
    expect(escapeHtml(`<b>"a" & 'b'</b>`)).toBe("&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;");
  });

  it("leaves plain text alone", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("escapeAttr", () => {
  it("escapes newlines for attribute values", () => {
    expect(escapeAttr("a\nb")).toBe("a&#10;b");
  });
});

describe("jsonForScript", () => {
  it("never lets a string close the script element", () => {
    expect(jsonForScript({ text: "</script><script>alert(1)" })).not.toContain("</script>");
    expect(jsonForScript({ text: "</script>" })).toContain("\\u003c/script>");
  });

  it("round-trips through JSON.parse", () => {
    expect(JSON.parse(jsonForScript({ a: [1, "x"] }))).toEqual({ a: [1, "x"] });
  });
});

describe("artifactShell", () => {
  it("builds a document on the host theme variables", () => {
    const html = artifactShell({ title: "T", css: ".x{}", body: "<p>hi</p>" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("var(--font-sans)");
    expect(html).toContain("<p>hi</p>");
  });

  it("escapes the title", () => {
    expect(artifactShell({ title: "<b>", css: "", body: "" })).toContain("&lt;b&gt;");
  });
});
