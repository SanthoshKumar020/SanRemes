import type { PatternRule, ShipPolicy } from "./policy.ts";

export interface PrFile {
  path: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}

export interface PrCheck {
  name: string;
  status: "pass" | "fail" | "pending";
}

export interface ReviewFinding {
  /** Empty when the finding is about the pull request as a whole, not one file. */
  file: string;
  line: number | null;
  severity: "block" | "warn";
  message: string;
}

export interface ReviewResult {
  verdict: "pass" | "fail";
  findings: ReviewFinding[];
  summary: string;
}

export interface ReviewInput {
  files: PrFile[];
  checks: PrCheck[];
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;
const FILE_HEADER = /^\+\+\+ b\/(.+)$/u;

interface PatchLine {
  line: number;
  text: string;
}

/** Added lines of a unified-diff patch, each with its line number in the new file. */
export function addedLines(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let line = 0;
  for (const raw of patch.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      out.push({ line, text: raw.slice(1) });
      line += 1;
    } else if (raw.startsWith("-")) {
      continue;
    } else {
      line += 1;
    }
  }
  return out;
}

/** Splits a unified diff (`gh pr diff` output) into one entry per changed file. */
export function parseUnifiedDiff(diff: string): PrFile[] {
  const files: PrFile[] = [];
  let current: { path: string; patch: string[] } | null = null;
  const flush = () => {
    if (current) files.push({ path: current.path, patch: current.patch.join("\n") });
    current = null;
  };
  for (const raw of diff.split("\n")) {
    const header = FILE_HEADER.exec(raw);
    if (header) {
      flush();
      current = { path: header[1]!, patch: [] };
      continue;
    }
    if (raw.startsWith("diff --git")) {
      flush();
      continue;
    }
    if (current) current.patch.push(raw);
  }
  flush();
  return files;
}

function scanRules(files: PrFile[], rules: PatternRule[], severity: "block" | "warn", findings: ReviewFinding[]): void {
  for (const rule of rules) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(rule.pattern);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.patch) continue;
      for (const added of addedLines(file.patch)) {
        if (pattern.test(added.text)) findings.push({ file: file.path, line: added.line, severity, message: rule.message });
      }
    }
  }
}

/** Reviews a pull request against the team policy. Findings name the file and line in plain words. */
export function reviewPullRequest(policy: ShipPolicy, input: ReviewInput): ReviewResult {
  const findings: ReviewFinding[] = [];
  for (const required of policy.requiredChecks) {
    const check = input.checks.find((one) => one.name === required);
    if (!check) {
      findings.push({ file: "", line: null, severity: "block", message: `Required check ${JSON.stringify(required)} has no result on this pull request yet.` });
    } else if (check.status !== "pass") {
      findings.push({ file: "", line: null, severity: "block", message: `Required check ${JSON.stringify(required)} is ${check.status}, not passing.` });
    }
  }
  scanRules(input.files, policy.forbiddenPatterns, "block", findings);
  scanRules(input.files, policy.styleRules, "warn", findings);
  const blocks = findings.filter((finding) => finding.severity === "block").length;
  const verdict: ReviewResult["verdict"] = blocks > 0 ? "fail" : "pass";
  const summary = verdict === "pass"
    ? findings.length === 0
      ? "No problems found against the team policy."
      : `${findings.length} ${findings.length === 1 ? "note" : "notes"}, none of them blocking.`
    : `${blocks} ${blocks === 1 ? "problem blocks" : "problems block"} this pull request.`;
  return { verdict, findings, summary };
}
