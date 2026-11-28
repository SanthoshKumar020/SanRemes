import { describe, expect, it } from "vitest";

import { defaultShipPolicy } from "./policy.ts";
import { addedLines, parseUnifiedDiff, reviewPullRequest } from "./reviewer.ts";

const PATCH = [
  "@@ -1,3 +1,4 @@",
  " context",
  "+const password = \"hunter2\";",
  " more context",
  "+// TODO: fix this later",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("splits a diff into one entry per file", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,1 +1,2 @@",
      " x",
      "+y",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,1 +1,1 @@",
      " z",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0]!.patch).toContain("+y");
  });
});

describe("addedLines", () => {
  it("does not count a no-newline marker as a line", () => {
    const patch = "@@ -1,2 +1,3 @@\n context\n+first\n\\ No newline at end of file\n+second";
    expect(addedLines(patch)).toEqual([
      { line: 2, text: "first" },
      { line: 3, text: "second" },
    ]);
  });

  it("numbers added lines in the new file and skips removed lines", () => {
    expect(addedLines(PATCH)).toEqual([
      { line: 2, text: "const password = \"hunter2\";" },
      { line: 4, text: "// TODO: fix this later" },
    ]);
  });
});

describe("reviewPullRequest", () => {
  it("passes a clean pull request", () => {
    const review = reviewPullRequest(defaultShipPolicy(), { files: [{ path: "src/a.ts", patch: PATCH }], checks: [] });
    expect(review.verdict).toBe("pass");
    expect(review.findings).toEqual([]);
    expect(review.summary).toBe("No problems found against the team policy.");
  });

  it("blocks on a missing required check and names it", () => {
    const review = reviewPullRequest(
      { ...defaultShipPolicy(), requiredChecks: ["lint", "tests"] },
      { files: [], checks: [{ name: "lint", status: "pass" }] },
    );
    expect(review.verdict).toBe("fail");
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]!.message).toContain("tests");
    expect(review.summary).toBe("1 problem blocks this pull request.");
  });

  it("blocks on a failing required check", () => {
    const review = reviewPullRequest(
      { ...defaultShipPolicy(), requiredChecks: ["tests"] },
      { files: [], checks: [{ name: "tests", status: "fail" }] },
    );
    expect(review.verdict).toBe("fail");
    expect(review.findings[0]!.message).toContain("is fail");
  });

  it("reports a forbidden pattern with file and line", () => {
    const review = reviewPullRequest(
      { ...defaultShipPolicy(), forbiddenPatterns: [{ pattern: "password\\s*=", message: "Do not hard-code passwords." }] },
      { files: [{ path: "src/a.ts", patch: PATCH }], checks: [] },
    );
    expect(review.verdict).toBe("fail");
    expect(review.findings).toEqual([
      { file: "src/a.ts", line: 2, severity: "block", message: "Do not hard-code passwords." },
    ]);
  });

  it("warns on a style rule without blocking", () => {
    const review = reviewPullRequest(
      { ...defaultShipPolicy(), styleRules: [{ pattern: "TODO", message: "Clear TODOs before merging." }] },
      { files: [{ path: "src/a.ts", patch: PATCH }], checks: [] },
    );
    expect(review.verdict).toBe("pass");
    expect(review.findings[0]!.severity).toBe("warn");
    expect(review.findings[0]!.line).toBe(4);
    expect(review.summary).toBe("1 note, none of them blocking.");
  });

  it("only scans added lines, never removed ones", () => {
    const removedOnly = "@@ -1,2 +1,1 @@\n-const password = \"old\";\n context";
    const review = reviewPullRequest(
      { ...defaultShipPolicy(), forbiddenPatterns: [{ pattern: "password", message: "No passwords." }] },
      { files: [{ path: "src/a.ts", patch: removedOnly }], checks: [] },
    );
    expect(review.verdict).toBe("pass");
  });
});
