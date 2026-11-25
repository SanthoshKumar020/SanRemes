import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic.ts";
import { loadWatches, patchProcedure, relearnStep, type ErrandProcedure, type ErrandStep } from "./browser-errands.ts";
import { RefIndex } from "./browser-steps.ts";
import { parseToolCall } from "./browser/tools.ts";
import {
  addNote, LEARNED_SKILLS_MAX, listSkills, loadNotesDoc, MemoryNotesError, patchSkill, saveNotesDoc, saveSkill,
} from "./memory-notes.ts";
import { stageProposal, type MemoryActor, type PendingProposal } from "./memory-trust.ts";

/** The self-improvement loop: the agent proposes what it learned, scheduled evals check whether
 * what it learned still holds, and every change waits for the owner in the Phase 2 pending queue.
 *
 * Nothing here writes a live note or skill on a bot's say-so, and nothing here touches the app's
 * own code: a proposal that names a source file is refused outright. The loop proposes skills,
 * procedures, notes and eval findings only; a code change comes from the owner, never from a
 * proposal. */

export const EVAL_RESULTS_FILE = "memory/eval-results.json";
const EVAL_RESULTS_MAX = 100;
const EVAL_RESULTS_MAX_BYTES = 64 * 1024;
/** An eval runs at most once a day per bot: the routine that schedules it ticks far more often,
 * and re-recording the same pass every tick would bury the one result that changed. */
const EVAL_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A watch unchecked this long is stale: the default watch routine checks every 15 minutes. */
const WATCH_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const PROCEDURE_SKILL_PREFIX = "browser-errand-";

/** A source file of this repo, named as a path: server/, src/, shared/, scripts/, packages/,
 * electron/, evals/ or companion/ with a code extension, or a build file at the root. A prose
 * mention of a server, or a URL, does not match: the path must follow a space, quote or bracket. */
const CODE_PATH = /(?:^|[\s"'`(])(?:server|src|shared|scripts|packages|electron|evals|companion)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|cjs|js|json|md)\b/;
const CODE_FILE = /(?:^|[\s"'`(])(?:package\.json|tsconfig(?:\.[A-Za-z]+)?\.json|pnpm-workspace\.yaml|vitest\.config\.(?:ts|js))\b/;

export function touchesCode(text: string): boolean {
  return CODE_PATH.test(text) || CODE_FILE.test(text);
}

export type ProposedImprovement =
  | { kind: "save-skill"; name: string; description: string; body: string; task?: string | null }
  | { kind: "patch-skill"; name: string; body: string }
  | { kind: "add-note"; path: string; text: string; evalId: string; resultId: string; finding: string; at: string };

function fail(code: "invalid" | "conflict" | "not-found" | "too-large" | "corrupt", status: number, message: string): never {
  throw new MemoryNotesError(code, status, message);
}

/** Stage a proposed change. The owner applies it at once; a bot's version waits in the pending
 * queue, like every other bot change. A change that names the app's own code is refused before
 * anything is staged, so the queue never holds an instruction to rewrite the server. */
export function proposeImprovement(root: string, actor: MemoryActor, change: ProposedImprovement): PendingProposal | { applied: true } {
  const texts =
    change.kind === "save-skill"
      ? [change.name, change.description, change.body]
      : change.kind === "patch-skill"
        ? [change.name, change.body]
        : [change.path, change.text, change.finding];
  if (texts.some(touchesCode)) {
    fail("invalid", 400, "a proposal cannot name the app's own code — code changes come from the owner, never from a proposal");
  }
  if (actor === "owner") {
    const doc = loadNotesDoc(root);
    if (change.kind === "save-skill") {
      saveNotesDoc(root, saveSkill(doc, { name: change.name, description: change.description, body: change.body, task: change.task ?? null }), doc.version);
    } else if (change.kind === "patch-skill") {
      saveNotesDoc(root, patchSkill(doc, change.name, change.body), doc.version);
    } else {
      const quote = change.finding.slice(0, 400);
      saveNotesDoc(
        root,
        addNote(doc, {
          path: change.path, text: change.text, status: "observed",
          sources: [{ chatId: "eval", messageId: change.resultId, quote, at: change.at }],
        }, [{ id: change.resultId, text: change.finding }]),
        doc.version,
      );
    }
    return { applied: true };
  }
  switch (change.kind) {
    case "save-skill":
      return stageProposal(root, { kind: "save-skill", input: { name: change.name, description: change.description, body: change.body, task: change.task ?? null } }, actor);
    case "patch-skill":
      return stageProposal(root, { kind: "patch-skill", name: change.name, body: change.body }, actor);
    case "add-note": {
      const quote = change.finding.slice(0, 400);
      return stageProposal(root, {
        kind: "add-note",
        input: {
          path: change.path, text: change.text, status: "observed",
          sources: [{ chatId: "eval", messageId: change.resultId, quote, at: change.at }],
        },
        messages: [{ id: change.resultId, text: change.finding }],
      }, actor);
    }
  }
}

export type EvalOutcome = "pass" | "degraded" | "failed" | "error";

export interface EvalResult {
  id: string;
  evalId: string;
  at: string;
  outcome: EvalOutcome;
  detail: string;
  findings: string[];
  proposalIds: string[];
}

export interface EvalFindingLine {
  evalId: string;
  outcome: EvalOutcome;
  detail: string;
}

interface EvalResultsDoc {
  version: 1;
  results: EvalResult[];
}

function validResultsDoc(value: unknown): value is EvalResultsDoc {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as EvalResultsDoc).version === 1 &&
    Array.isArray((value as EvalResultsDoc).results)
  );
}

export function loadEvalResults(root: string): EvalResult[] {
  let raw: string;
  try {
    raw = readFileSync(`${root}/${EVAL_RESULTS_FILE}`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("corrupt", 500, "the eval results file is not valid JSON — it needs a hand fix before evals can load");
  }
  if (!validResultsDoc(parsed)) {
    fail("corrupt", 500, "the eval results file does not hold a results document — it needs a hand fix before evals can load");
  }
  return parsed.results;
}

export function saveEvalResults(root: string, results: EvalResult[]): EvalResult[] {
  const kept = results.slice(-EVAL_RESULTS_MAX);
  const text = JSON.stringify({ version: 1, results: kept }, null, 2);
  if (Buffer.byteLength(text, "utf8") > EVAL_RESULTS_MAX_BYTES) {
    fail("too-large", 413, "too many eval results — remove some first");
  }
  mkdirSync(`${root}/memory`, { recursive: true, mode: 0o700 });
  writeFileAtomic(`${root}/${EVAL_RESULTS_FILE}`, text, { mode: 0o600 });
  return kept;
}

export interface EvalReport {
  evalId: string;
  outcome: EvalOutcome;
  detail: string;
  findings: string[];
  correctedProcedure?: ErrandProcedure;
}

export interface ParsedProcedureStep extends ErrandStep {
  line: number;
}

function extractJsonObject(text: string): { json: string; after: string } | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { json: text.slice(start, i + 1), after: text.slice(i + 1) };
    }
  }
  return null;
}

/** A procedure body back into steps: `1. tool {"args": …} — label`, one per line. A line that is
 * not a numbered step, or whose arguments are not an object, is broken, never skipped silently. */
export function parseProcedureBody(body: string): { steps: ParsedProcedureStep[]; broken: Array<{ line: number; error: string }> } {
  const steps: ParsedProcedureStep[] = [];
  const broken: Array<{ line: number; error: string }> = [];
  body.split("\n").forEach((raw, index) => {
    const text = raw.trim();
    if (!text) return;
    const head = /^(\d+)\.\s+(\S+)\s+(.*)$/.exec(text);
    if (!head) {
      broken.push({ line: index + 1, error: "not a numbered step" });
      return;
    }
    const line = Number(head[1]);
    const json = extractJsonObject(head[3]!);
    if (!json) {
      broken.push({ line: index + 1, error: "its arguments are not an object" });
      return;
    }
    let args: unknown;
    try {
      args = JSON.parse(json.json);
    } catch {
      broken.push({ line: index + 1, error: "its arguments are not JSON" });
      return;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      broken.push({ line: index + 1, error: "its arguments are not an object" });
      return;
    }
    steps.push({ tool: head[2]!, args: args as Record<string, unknown>, label: json.after.replace(/^\s+—\s+/, "").trim(), line });
  });
  return { steps, broken };
}

/** Every learned browser procedure still parses, and every step names a browser tool that exists
 * with arguments it accepts. A procedure whose body reads as nothing at all has failed outright. */
export function evalProcedureRecall(root: string): EvalReport {
  const procedures = listSkills(loadNotesDoc(root)).filter((skill) => skill.name.startsWith(PROCEDURE_SKILL_PREFIX));
  if (!procedures.length) return { evalId: "procedure-recall", outcome: "pass", detail: "no learned browser procedures", findings: [] };
  const findings: string[] = [];
  let readable = 0;
  for (const skill of procedures) {
    const parsed = parseProcedureBody(skill.body);
    if (parsed.steps.length) readable += 1;
    for (const broken of parsed.broken) findings.push(`procedure ${skill.name} line ${broken.line}: ${broken.error}`);
    for (const step of parsed.steps) {
      const checked = parseToolCall(step.tool, step.args);
      if (!checked.ok) findings.push(`procedure ${skill.name} step ${step.line} cannot run: ${checked.error}`);
    }
  }
  const outcome = findings.length === 0 ? "pass" : readable === 0 ? "failed" : "degraded";
  return {
    evalId: "procedure-recall",
    outcome,
    detail: `${procedures.length} learned procedures, ${findings.length} problems`,
    findings,
  };
}

/** A learned procedure against a fresh page snapshot: a step whose element is still there is fine;
 * one whose element moved is re-derived by role and name when the step carries them, and stale
 * otherwise. A corrected procedure is offered only when every stale step was re-derived. */
export function evalProcedureAgainstSnapshot(procedure: ErrandProcedure, snapshotText: string): EvalReport {
  const refs = new RefIndex();
  refs.replace([snapshotText]);
  const present = new Set(refs.entries().map((entry) => entry.ref));
  const findings: string[] = [];
  const corrected: ErrandStep[] = [];
  let fine = 0;
  let rederived = 0;
  let stale = 0;
  let skipped = 0;
  for (const step of procedure.steps) {
    const ref = typeof step.args.ref === "string" ? step.args.ref.replace(/^@/, "") : undefined;
    const role = typeof step.args.role === "string" ? step.args.role : undefined;
    const name = typeof step.args.name === "string" ? step.args.name : undefined;
    if (ref !== undefined && present.has(ref)) {
      fine += 1;
      corrected.push(step);
      continue;
    }
    if (role !== undefined && name !== undefined) {
      const found = relearnStep({ role, name }, snapshotText);
      if (found) {
        rederived += 1;
        corrected.push({ ...step, args: { ...step.args, ref: found.ref } });
        continue;
      }
    }
    if (ref !== undefined || (role !== undefined && name !== undefined)) {
      stale += 1;
      findings.push(`procedure ${procedure.name} step "${step.label}" no longer matches the page`);
      corrected.push(step);
      continue;
    }
    skipped += 1;
    corrected.push(step);
  }
  const targeted = procedure.steps.length - skipped;
  const outcome = rederived === 0 && stale === 0 ? "pass" : targeted > 0 && stale === targeted && rederived === 0 ? "failed" : "degraded";
  return {
    evalId: `procedure-snapshot-${procedure.name}`,
    outcome,
    detail: `${procedure.steps.length} steps: ${fine} still match, ${rederived} re-derived, ${stale} stale, ${skipped} skipped`,
    findings,
    ...(stale === 0 && rederived > 0 ? { correctedProcedure: { ...procedure, steps: corrected } } : {}),
  };
}

/** Every watch still being checked: one unchecked for a week is stale. A watch never checked yet is
 * not judged — it has had no chance to fail. */
export function evalWatchHealth(root: string, nowMs: number): EvalReport {
  const watches = loadWatches(root);
  if (!watches.length) return { evalId: "watch-health", outcome: "pass", detail: "no watches", findings: [] };
  const findings: string[] = [];
  for (const watch of watches) {
    if (watch.lastCheckedAt === null) continue;
    const ageMs = nowMs - Date.parse(watch.lastCheckedAt);
    if (ageMs > WATCH_STALE_MS) {
      findings.push(`watch ${watch.name} has not been checked in ${Math.floor(ageMs / (24 * 60 * 60 * 1000))} days`);
    }
  }
  return {
    evalId: "watch-health",
    outcome: findings.length ? "degraded" : "pass",
    detail: `${watches.length} watches, ${findings.length} stale`,
    findings,
  };
}

/** Every learned skill still has a body and a description. A skill the owner edited is named as
 * needing their hand: it can never be patched by a proposal. */
export function evalSkillRecall(root: string): EvalReport {
  const skills = listSkills(loadNotesDoc(root));
  if (!skills.length) return { evalId: "skill-recall", outcome: "pass", detail: "no learned skills", findings: [] };
  const findings: string[] = [];
  for (const skill of skills) {
    if (!skill.body.trim()) {
      findings.push(`skill ${skill.name} has an empty body${skill.edited !== null ? " — the owner edited it, so it needs their hand, not a proposal" : ""}`);
    } else if (!skill.description.trim()) {
      findings.push(`skill ${skill.name} has an empty description`);
    }
  }
  return {
    evalId: "skill-recall",
    outcome: findings.length ? "degraded" : "pass",
    detail: `${skills.length} learned skills${skills.length >= LEARNED_SKILLS_MAX ? `, at the ${LEARNED_SKILLS_MAX}-skill cap` : ""}`,
    findings,
  };
}

export interface EvalRunOptions {
  now?: () => number;
  actor?: MemoryActor;
  /** A fresh page snapshot for a procedure, for the snapshot eval; without one that eval is skipped. */
  snapshotFor?: (procedure: ErrandProcedure) => Promise<string | null>;
}

export interface EvalRunReport {
  results: EvalResult[];
  proposals: PendingProposal[];
  needsOwner: boolean;
}

const rank = (outcome: EvalOutcome): number => (outcome === "pass" ? 0 : outcome === "degraded" ? 1 : 2);

const evalNotePath = (evalId: string): string => `lessons/eval-${evalId}`;

/** Run the evals, record the results, and stage an improvement proposal only when something got
 * worse or its findings changed — a steady failure is reported once, never once a tick. A proposal
 * already waiting, or one the notes refuse, is skipped, never fatal: one eval's trouble never stops
 * the rest. */
export async function runSelfImprovementEvals(root: string, options: EvalRunOptions = {}): Promise<EvalRunReport> {
  const now = options.now ?? Date.now;
  const actor = options.actor ?? "agent";
  const at = new Date(now()).toISOString();
  let previous: EvalResult[];
  try {
    previous = loadEvalResults(root);
  } catch (error) {
    console.warn(`self-improvement: could not load past eval results: ${error instanceof Error ? error.message : String(error)}`);
    previous = [];
  }
  const lastByEval = new Map<string, EvalResult>();
  for (const result of previous) lastByEval.set(result.evalId, result);
  const fresh = (evalId: string): boolean => {
    const last = lastByEval.get(evalId);
    return last === undefined || Number.isNaN(Date.parse(last.at)) || now() - Date.parse(last.at) >= EVAL_MIN_INTERVAL_MS;
  };

  const reports: EvalReport[] = [];
  const runEval = async (evalId: string, run: () => EvalReport | Promise<EvalReport>): Promise<void> => {
    if (!fresh(evalId)) return;
    try {
      reports.push(await run());
    } catch (error) {
      reports.push({ evalId, outcome: "error", detail: error instanceof Error ? error.message : String(error), findings: [] });
    }
  };
  await runEval("procedure-recall", () => evalProcedureRecall(root));
  await runEval("watch-health", () => evalWatchHealth(root, now()));
  await runEval("skill-recall", () => evalSkillRecall(root));
  if (options.snapshotFor) {
    const doc = loadNotesDoc(root);
    for (const skill of listSkills(doc).filter((candidate) => candidate.name.startsWith(PROCEDURE_SKILL_PREFIX))) {
      const parsed = parseProcedureBody(skill.body);
      if (!parsed.steps.length) continue;
      const procedure: ErrandProcedure = { name: skill.name, description: skill.description, steps: parsed.steps };
      const evalId = `procedure-snapshot-${skill.name}`;
      if (!fresh(evalId)) continue;
      const snapshot = await options.snapshotFor(procedure).catch(() => null);
      if (snapshot === null) continue;
      await runEval(evalId, () => evalProcedureAgainstSnapshot(procedure, snapshot));
    }
  }

  const results: EvalResult[] = [];
  const proposals: PendingProposal[] = [];
  let needsOwner = false;
  for (const report of reports) {
    const id = randomUUID();
    const prev = lastByEval.get(report.evalId);
    const changed = prev === undefined || rank(report.outcome) > rank(prev.outcome) || report.findings.join("\n") !== prev.findings.join("\n");
    const proposalIds: string[] = [];
    if (changed && report.outcome !== "pass") {
      needsOwner = true;
      const stageNote = (text: string, finding: string): void => {
        try {
          const staged = proposeImprovement(root, actor, {
            kind: "add-note", path: evalNotePath(report.evalId), text, evalId: report.evalId, resultId: id, finding, at,
          });
          if ("id" in staged) {
            proposals.push(staged);
            proposalIds.push(staged.id);
          }
        } catch (error) {
          if (!(error instanceof MemoryNotesError) || error.code !== "conflict") {
            console.warn(`self-improvement: could not stage an eval note: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      };
      if (report.correctedProcedure) {
        try {
          const staged = patchProcedure(root, actor, report.correctedProcedure);
          if ("proposal" in staged) {
            proposals.push(staged.proposal);
            proposalIds.push(staged.proposal.id);
          }
        } catch {
          stageNote(
            `${report.detail}\nThe corrected procedure was not staged as a patch — review the eval result and apply it by hand if the re-derived steps look right.`,
            report.findings[0] ?? report.detail,
          );
        }
      } else if (report.findings.length) {
        stageNote(report.findings.join("\n"), report.findings[0]!);
      }
    }
    results.push({ id, evalId: report.evalId, at, outcome: report.outcome, detail: report.detail, findings: report.findings, proposalIds });
  }
  try {
    saveEvalResults(root, [...previous, ...results]);
  } catch (error) {
    console.warn(`self-improvement: could not save eval results: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { results, proposals, needsOwner };
}
