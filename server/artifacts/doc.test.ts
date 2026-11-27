import { describe, expect, it } from "vitest";
import {
  DOC_EDIT_MARKER,
  applyDocLineEdits,
  docFromText,
  parseDocEditMessage,
  renderDoc,
  validateDocInput,
  type DocInput,
} from "./doc.ts";

const DOC: DocInput = {
  title: "Launch notes",
  lines: [
    { kind: "heading", text: "What ships" },
    { kind: "bullet", text: "Search <everywhere>" },
    { kind: "paragraph", text: "Friday." },
  ],
};

describe("validateDocInput", () => {
  it("accepts a well-formed document", () => {
    expect(validateDocInput(DOC)).toEqual({ doc: DOC });
  });

  it("rejects a missing title, empty lines and unknown kinds", () => {
    expect(validateDocInput({ lines: [] })).toMatchObject({ error: expect.stringContaining("title") });
    expect(validateDocInput({ title: "T", lines: [] })).toMatchObject({ error: expect.stringContaining("at least one") });
    expect(validateDocInput({ title: "T", lines: [{ kind: "table", text: "x" }] })).toMatchObject({ error: expect.stringContaining("unknown kind") });
  });

  it("rejects more than 200 lines", () => {
    const lines = Array.from({ length: 201 }, () => ({ kind: "paragraph", text: "x" }));
    expect(validateDocInput({ title: "T", lines })).toMatchObject({ error: expect.stringContaining("200") });
  });
});

describe("renderDoc", () => {
  it("renders editable lines with their index and escapes content", () => {
    const rendered = renderDoc(DOC);
    expect(rendered).not.toHaveProperty("error");
    if ("error" in rendered) return;
    expect(rendered.html).toContain('data-line="1" contenteditable="true"');
    expect(rendered.html).toContain("Search &lt;everywhere&gt;");
    expect(rendered.html).not.toContain("<everywhere>");
    expect(rendered.html).toContain("Send edits");
    expect(rendered.html).toContain("sanremes.send");
    expect(rendered.title).toBe("Launch notes");
    expect(rendered.height).toBeGreaterThan(0);
    expect(rendered.height).toBeLessThanOrEqual(720);
  });

  it("renders a bullet with its marker class and a heading tag", () => {
    const rendered = renderDoc(DOC);
    if ("error" in rendered) return;
    expect(rendered.html).toContain("<h2");
    expect(rendered.html).toContain('class="bullet"');
  });

  it("keeps the whole page under the show_html size limit", () => {
    const rendered = renderDoc(DOC);
    if ("error" in rendered) return;
    expect(new TextEncoder().encode(rendered.html).length).toBeLessThan(256 * 1024);
  });

  it("returns the validation error for bad input", () => {
    expect(renderDoc({ title: "T", lines: [] })).toMatchObject({ error: expect.any(String) });
  });
});

describe("docFromText", () => {
  it("turns headings, bullets and quotes into lines", () => {
    expect(docFromText("T", "# Head\n- one\n> said\nplain")).toEqual({
      title: "T",
      lines: [
        { kind: "heading", text: "Head" },
        { kind: "bullet", text: "one" },
        { kind: "quote", text: "said" },
        { kind: "paragraph", text: "plain" },
      ],
    });
  });

  it("never returns an empty document", () => {
    expect(docFromText("T", "\n\n").lines.length).toBe(1);
  });
});

describe("parseDocEditMessage and applyDocLineEdits", () => {
  it("round-trips an edit message through render and apply", () => {
    const message = `${DOC_EDIT_MARKER}\n${JSON.stringify({ line: 1, text: "Search everywhere" })}\n${JSON.stringify({ line: -1, text: "New title" })}`;
    const parsed = parseDocEditMessage(message);
    expect(parsed).toEqual({ title: "New title", edits: [{ line: 1, text: "Search everywhere" }] });
    const next = applyDocLineEdits(DOC, parsed!);
    expect(next.title).toBe("New title");
    expect(next.lines[1]?.text).toBe("Search everywhere");
    expect(next.lines[0]?.text).toBe("What ships");
    const rendered = renderDoc(next);
    if ("error" in rendered) return;
    expect(rendered.html).toContain("Search everywhere");
    expect(rendered.html).not.toContain("Search &lt;everywhere&gt;");
  });

  it("ignores out-of-range lines and rejects non-edit messages", () => {
    const parsed = parseDocEditMessage(`${DOC_EDIT_MARKER}\n${JSON.stringify({ line: 99, text: "x" })}`);
    expect(applyDocLineEdits(DOC, parsed!)).toEqual(DOC);
    expect(parseDocEditMessage("hello")).toBeNull();
    expect(parseDocEditMessage(`${DOC_EDIT_MARKER}\nnot json`)).toBeNull();
  });

  it("keeps multiline edits intact", () => {
    const parsed = parseDocEditMessage(`${DOC_EDIT_MARKER}\n${JSON.stringify({ line: 2, text: "one\ntwo" })}`);
    expect(applyDocLineEdits(DOC, parsed!).lines[2]?.text).toBe("one\ntwo");
  });
});
