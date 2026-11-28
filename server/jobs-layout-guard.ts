import { createHash } from "node:crypto";

/** An apply turn stopped by a changed page layout starts its closing message with this marker so the server can stop the run. */
export const LAYOUT_CHANGE_MARKER = "LAYOUT CHANGED:";
/** An apply turn reports the page labels it used on a line starting with this prefix so the next run can compare. */
export const LAYOUT_REPORT_PREFIX = "LAYOUT:";

const MAX_REPORT_LABELS = 50;
const MAX_LABEL_LENGTH = 200;
const MAX_CHANGE_DESCRIPTION_LENGTH = 500;

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const label of labels) {
    const normalizedLabel = normalizeLabel(label);
    if (!normalizedLabel || seen.has(normalizedLabel)) continue;
    seen.add(normalizedLabel);
    normalized.push(normalizedLabel);
  }
  return normalized;
}

/** A stable digest of the page's control labels; case, whitespace and order do not change it. */
export function layoutFingerprint(labels: readonly string[]): string {
  const normalized = normalizeLabels(labels).sort();
  return createHash("sha256").update(normalized.join("\n"), "utf8").digest("hex");
}

/** Pulls the labels off a LAYOUT: report line; null when no such line exists. */
export function parseLayoutReport(text: string): string[] | null {
  try {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(LAYOUT_REPORT_PREFIX)) continue;
      const rest = trimmed.slice(LAYOUT_REPORT_PREFIX.length).trim();
      if (rest.toUpperCase().startsWith("CHANGED:")) continue;
      const labels = rest.split("|")
        .map((label) => label.trim().replace(/\s+/g, " "))
        .filter(Boolean)
        .map((label) => label.slice(0, MAX_LABEL_LENGTH));
      return labels.slice(0, MAX_REPORT_LABELS);
    }
    return null;
  } catch {
    return null;
  }
}

/** Compares the labels a page showed last time against the labels it shows now; extra labels are not a change. */
export function checkLayout(expected: readonly string[], seen: readonly string[]): { changed: boolean; missing: string[]; note: string } {
  const seenSet = new Set(normalizeLabels(seen));
  const missing: string[] = [];
  const missingNormalized = new Set<string>();
  for (const label of expected) {
    const normalized = normalizeLabel(label);
    if (!normalized || seenSet.has(normalized) || missingNormalized.has(normalized)) continue;
    missingNormalized.add(normalized);
    missing.push(label.trim().replace(/\s+/g, " "));
  }
  if (!missing.length) {
    return { changed: false, missing: [], note: "The page looks the same as last time." };
  }
  return { changed: true, missing, note: `The page no longer shows: ${missing.join(", ")}.` };
}

/** Returns the plain-words description after a LAYOUT CHANGED: marker at the start of a closing message; null when absent. */
export function parseLayoutChange(text: string): string | null {
  try {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith(LAYOUT_CHANGE_MARKER)) return null;
    const description = trimmed.slice(LAYOUT_CHANGE_MARKER.length).trim().slice(0, MAX_CHANGE_DESCRIPTION_LENGTH);
    return description ? description : null;
  } catch {
    return null;
  }
}

/** The prompt section for an apply turn: check the page still shows the expected controls, stop on a redesign, report the labels used. */
export function layoutPromptSection(expectedLabels?: readonly string[]): string {
  const lines = [
    "Before submitting, check the page still shows the controls you expect.",
  ];
  const expected = (expectedLabels ?? []).map((label) => label.trim().replace(/\s+/g, " ")).filter(Boolean);
  if (expected.length) {
    lines.push(`Last time this page showed: ${expected.join(" | ")}.`);
  }
  lines.push(
    `If any of those controls are missing, or the page looks redesigned (different buttons, renamed fields, a new layout), STOP at once — do not submit, do not guess, do not work around it — and start your closing message with ${LAYOUT_CHANGE_MARKER} plus one plain-words sentence saying what looks different.`,
  );
  if (!expected.length) {
    lines.push(`Report the key labels on the page on a line starting with ${LAYOUT_REPORT_PREFIX} so the next run can compare.`);
  }
  lines.push(`After a successful submit, report the key labels you used on a line starting with ${LAYOUT_REPORT_PREFIX}.`);
  return lines.join(" ");
}
