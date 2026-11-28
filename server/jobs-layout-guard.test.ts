import { describe, expect, it } from "vitest";

import { checkLayout, layoutFingerprint, layoutPromptSection, LAYOUT_CHANGE_MARKER, LAYOUT_REPORT_PREFIX, parseLayoutChange, parseLayoutReport } from "./jobs-layout-guard.ts";

describe("layoutFingerprint", () => {
  it("is stable under case, whitespace and order changes", () => {
    const a = layoutFingerprint(["Apply now", "Upload resume", "First name"]);
    const b = layoutFingerprint(["  first NAME ", "APPLY   NOW", "upload resume"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a label is added or removed", () => {
    const base = layoutFingerprint(["Apply now", "Upload resume"]);
    expect(layoutFingerprint(["Apply now", "Upload resume", "First name"])).not.toBe(base);
    expect(layoutFingerprint(["Apply now"])).not.toBe(base);
  });

  it("ignores empty labels and duplicates", () => {
    expect(layoutFingerprint(["Apply now", "  ", "Apply now"])).toBe(layoutFingerprint(["Apply now"]));
  });
});

describe("parseLayoutReport", () => {
  it("pulls labels off a normal line", () => {
    expect(parseLayoutReport(`Submitted.\n${LAYOUT_REPORT_PREFIX} Apply now | Upload resume | First name`))
      .toEqual(["Apply now", "Upload resume", "First name"]);
  });

  it("returns null when no such line exists", () => {
    expect(parseLayoutReport("Submitted, no report line.")).toBeNull();
    expect(parseLayoutReport("")).toBeNull();
  });

  it("never throws on hostile input", () => {
    expect(parseLayoutReport(`${LAYOUT_REPORT_PREFIX} ${"x".repeat(10_000)}`)).toEqual(["x".repeat(200)]);
    expect(parseLayoutReport(`${LAYOUT_REPORT_PREFIX} | | |`)).toEqual([]);
    expect(parseLayoutReport(`${LAYOUT_REPORT_PREFIX} 😀 Apply | 🚀 Submit`)).toEqual(["😀 Apply", "🚀 Submit"]);
    const many = Array.from({ length: 60 }, (_, i) => `Label ${i}`).join(" | ");
    const parsed = parseLayoutReport(`${LAYOUT_REPORT_PREFIX} ${many}`);
    expect(parsed).toHaveLength(50);
    expect(parsed![0]).toBe("Label 0");
  });

  it("does not mistake a change marker for a report line", () => {
    expect(parseLayoutReport(`${LAYOUT_CHANGE_MARKER} the buttons moved.`)).toBeNull();
  });
});

describe("checkLayout", () => {
  it("detects missing labels", () => {
    const result = checkLayout(["Apply now", "Upload resume", "First name"], ["Apply now", "First name"]);
    expect(result.changed).toBe(true);
    expect(result.missing).toEqual(["Upload resume"]);
    expect(result.note).toBe("The page no longer shows: Upload resume.");
  });

  it("matches case- and whitespace-insensitively", () => {
    const result = checkLayout(["Apply now"], ["  APPLY   NOW "]);
    expect(result.changed).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.note).toBe("The page looks the same as last time.");
  });

  it("treats extra labels as fine", () => {
    const result = checkLayout(["Apply now"], ["Apply now", "New captcha box", "Chat with us"]);
    expect(result.changed).toBe(false);
  });

  it("treats an empty expected list as not changed", () => {
    expect(checkLayout([], ["Apply now"]).changed).toBe(false);
    expect(checkLayout([], []).changed).toBe(false);
  });

  it("treats an empty seen list as changed when labels were expected", () => {
    const result = checkLayout(["Apply now", "Upload resume"], []);
    expect(result.changed).toBe(true);
    expect(result.missing).toEqual(["Apply now", "Upload resume"]);
  });
});

describe("parseLayoutChange", () => {
  it("returns the description after the marker", () => {
    expect(parseLayoutChange(`${LAYOUT_CHANGE_MARKER} the apply button is gone and the form has new fields.`))
      .toBe("the apply button is gone and the form has new fields.");
  });

  it("returns null when the marker is absent", () => {
    expect(parseLayoutChange("The application was submitted.")).toBeNull();
    expect(parseLayoutChange("")).toBeNull();
    expect(parseLayoutChange(`Submitted, then ${LAYOUT_CHANGE_MARKER} too late.`)).toBeNull();
  });

  it("caps an overlong description at 500 chars", () => {
    const description = parseLayoutChange(`${LAYOUT_CHANGE_MARKER} ${"y".repeat(600)}`);
    expect(description).toHaveLength(500);
  });
});

describe("layoutPromptSection", () => {
  it("contains the marker and the stop instruction, with expected labels", () => {
    const section = layoutPromptSection(["Apply now", "Upload resume"]);
    expect(section).toContain(LAYOUT_CHANGE_MARKER);
    expect(section).toContain("STOP at once");
    expect(section).toContain("do not submit");
    expect(section).toContain("do not guess");
    expect(section).toContain("Last time this page showed: Apply now | Upload resume.");
    expect(section).toContain(LAYOUT_REPORT_PREFIX);
    expect(section).toContain("After a successful submit, report the key labels you used");
  });

  it("asks for a report line when no expected labels are given", () => {
    const section = layoutPromptSection();
    expect(section).toContain(LAYOUT_CHANGE_MARKER);
    expect(section).toContain("STOP at once");
    expect(section).toContain("Report the key labels on the page");
    expect(section).toContain(LAYOUT_REPORT_PREFIX);
    expect(section).not.toContain("Last time this page showed");
  });
});
