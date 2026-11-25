import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { newWatch, procedureBody, procedureSkillName, recordProcedure, saveWatches, type ErrandProcedure } from "./browser-errands.ts";
import { loadNotesDoc, saveNotesDoc, saveSkill } from "./memory-notes.ts";
import { approveProposal, denyProposal, listProposals, MemoryNotesError } from "./memory-trust.ts";
import {
  evalProcedureAgainstSnapshot,
  evalProcedureRecall,
  evalSkillRecall,
  evalWatchHealth,
  loadEvalResults,
  parseProcedureBody,
  proposeImprovement,
  runSelfImprovementEvals,
  saveEvalResults,
  touchesCode,
  type EvalResult,
} from "./self-improvement.ts";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function root(): string {
  dir = mkdtempSync(join(tmpdir(), "sanremes-self-improvement-"));
  return dir;
}

function seedSkill(base: string, name: string, body: string, description = "A learned skill"): void {
  const doc = loadNotesDoc(base);
  saveNotesDoc(base, saveSkill(doc, { name, description, body, task: null }), doc.version);
}

function procedure(steps?: ErrandProcedure["steps"]): ErrandProcedure {
  return {
    name: procedureSkillName("cancel trial", "example.com"),
    description: "Cancel the free trial on example.com",
    steps: steps ?? [
      { tool: "agent_browser_open", args: { url: "https://example.com/account" }, label: "Opened the account page" },
      { tool: "agent_browser_click", args: { ref: "e3" }, label: "Clicked Cancel subscription" },
    ],
  };
}

const SNAPSHOT = [
  "- button \"Cancel plan\" [ref=e7]",
  "- link \"Billing\" [ref=e2]",
  "- button \"Save\" [ref=e9]",
].join("\n");

describe("touchesCode", () => {
  it("refuses a source path", () => {
    expect(touchesCode("edit server/index.ts to add the check")).toBe(true);
    expect(touchesCode("see src/lib/memory.ts for the shape")).toBe(true);
    expect(touchesCode("update package.json and rebuild")).toBe(true);
    expect(touchesCode("the plan lives in server/host/README.md")).toBe(true);
  });

  it("allows prose about servers and plain URLs", () => {
    expect(touchesCode("the server returned 500")).toBe(false);
    expect(touchesCode("check the server status page")).toBe(false);
    expect(touchesCode("read https://example.com/docs/server/guide first")).toBe(false);
    expect(touchesCode("restart the browser and try again")).toBe(false);
  });
});

describe("proposeImprovement", () => {
  it("a bot's skill waits as a proposal; nothing live changes", () => {
    const base = root();
    const staged = proposeImprovement(base, "agent", {
      kind: "save-skill", name: "weekly-report", description: "Build the weekly report", body: "1. Open the report page",
    });
    expect("id" in staged && staged.kind).toBe("save-skill");
    expect(loadNotesDoc(base).skills).toEqual([]);
    expect(listProposals(base)).toHaveLength(1);
  });

  it("the owner's change applies at once", () => {
    const base = root();
    expect(proposeImprovement(base, "owner", {
      kind: "save-skill", name: "weekly-report", description: "Build the weekly report", body: "1. Open the report page",
    })).toEqual({ applied: true });
    expect(loadNotesDoc(base).skills.map((skill) => skill.name)).toEqual(["weekly-report"]);
    expect(listProposals(base)).toEqual([]);
  });

  it("a proposal that names the app's code is refused, and nothing is staged", () => {
    const base = root();
    expect(() =>
      proposeImprovement(base, "agent", {
        kind: "save-skill", name: "fix-gate", description: "Fix the gate", body: "Open server/index.ts and change the gate",
      }),
    ).toThrow(MemoryNotesError);
    expect(listProposals(base)).toEqual([]);
  });

  it("approval replays a staged skill patch; denial drops it", () => {
    const base = root();
    seedSkill(base, "weekly-report", "1. Open the report page");
    const staged = proposeImprovement(base, "agent", { kind: "patch-skill", name: "weekly-report", body: "1. Open the report page\n2. Export it" });
    if (!("id" in staged)) throw new Error("expected a staged proposal");
    const approved = approveProposal(base, staged.id);
    expect(approved.doc.skills.find((skill) => skill.name === "weekly-report")?.body).toBe("1. Open the report page\n2. Export it");
    expect(listProposals(base)).toEqual([]);

    const second = proposeImprovement(base, "agent", { kind: "patch-skill", name: "weekly-report", body: "1. Open the report page" });
    if (!("id" in second)) throw new Error("expected a staged proposal");
    denyProposal(base, second.id);
    expect(listProposals(base)).toEqual([]);
    expect(loadNotesDoc(base).skills.find((skill) => skill.name === "weekly-report")?.body).toBe("1. Open the report page\n2. Export it");
  });

  it("approval refuses when the notes moved on, and the proposal stays queued", () => {
    const base = root();
    seedSkill(base, "weekly-report", "1. Open the report page");
    const staged = proposeImprovement(base, "agent", { kind: "patch-skill", name: "weekly-report", body: "1. Open the report page\n2. Export it" });
    if (!("id" in staged)) throw new Error("expected a staged proposal");
    const doc = loadNotesDoc(base);
    saveNotesDoc(base, saveSkill(doc, { name: "other-skill", description: "Another skill", body: "Do it", task: null }), doc.version);
    expect(() => approveProposal(base, staged.id)).toThrow(MemoryNotesError);
    expect(listProposals(base)).toHaveLength(1);
  });
});

describe("parseProcedureBody", () => {
  it("round-trips a recorded procedure", () => {
    const parsed = parseProcedureBody(procedureBody(procedure()));
    expect(parsed.broken).toEqual([]);
    expect(parsed.steps.map((step) => step.tool)).toEqual(["agent_browser_open", "agent_browser_click"]);
    expect(parsed.steps[1]?.args).toEqual({ ref: "e3" });
    expect(parsed.steps[1]?.label).toBe("Clicked Cancel subscription");
  });

  it("reports lines that are not steps or whose arguments are not objects", () => {
    const parsed = parseProcedureBody("1. agent_browser_open {\"url\": \"https://example.com\"} — Opened it\nsome prose\n2. agent_browser_click not-json — Clicked it");
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.broken).toEqual([
      { line: 2, error: "not a numbered step" },
      { line: 3, error: "its arguments are not an object" },
    ]);
  });
});

describe("evalProcedureRecall", () => {
  it("passes with no procedures, and with a valid one", () => {
    const base = root();
    expect(evalProcedureRecall(base).outcome).toBe("pass");
    recordProcedure(base, "owner", procedure());
    expect(evalProcedureRecall(base).outcome).toBe("pass");
  });

  it("degrades when a step names a tool that does not exist", () => {
    const base = root();
    recordProcedure(base, "owner", procedure([
      { tool: "agent_browser_open", args: { url: "https://example.com/account" }, label: "Opened the account page" },
      { tool: "agent_browser_nope", args: {}, label: "Did something unknown" },
    ]));
    const report = evalProcedureRecall(base);
    expect(report.outcome).toBe("degraded");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toContain("agent_browser_nope");
  });

  it("fails when a procedure's body reads as nothing at all", () => {
    const base = root();
    seedSkill(base, procedure().name, "just some prose, no steps at all");
    expect(evalProcedureRecall(base).outcome).toBe("failed");
  });
});

describe("evalProcedureAgainstSnapshot", () => {
  it("passes when every step's element is still there", () => {
    const report = evalProcedureAgainstSnapshot(procedure([
      { tool: "agent_browser_click", args: { ref: "e9" }, label: "Clicked Save" },
    ]), SNAPSHOT);
    expect(report.outcome).toBe("pass");
    expect(report.correctedProcedure).toBeUndefined();
  });

  it("re-derives a moved step and offers the corrected procedure", () => {
    const report = evalProcedureAgainstSnapshot(procedure([
      { tool: "agent_browser_click", args: { ref: "e3", role: "button", name: "Cancel subscription" }, label: "Clicked Cancel subscription" },
    ]), SNAPSHOT);
    expect(report.outcome).toBe("degraded");
    expect(report.correctedProcedure?.steps[0]?.args).toEqual({ ref: "e7", role: "button", name: "Cancel subscription" });
  });

  it("reports a step that is gone and cannot be re-derived, with no corrected procedure", () => {
    const report = evalProcedureAgainstSnapshot(procedure([
      { tool: "agent_browser_click", args: { ref: "e3" }, label: "Clicked Cancel subscription" },
    ]), SNAPSHOT);
    expect(report.outcome).toBe("failed");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toContain("no longer matches the page");
    expect(report.correctedProcedure).toBeUndefined();
  });
});

describe("evalWatchHealth", () => {
  it("passes with no watches, and with a fresh one", () => {
    const base = root();
    const now = Date.parse("2026-11-25T10:00:00Z");
    expect(evalWatchHealth(base, now).outcome).toBe("pass");
    saveWatches(base, [{ ...newWatch("Price page", "https://example.com/price", "r1"), digest: "abc", lastCheckedAt: new Date(now - 60_000).toISOString() }]);
    expect(evalWatchHealth(base, now).outcome).toBe("pass");
  });

  it("degrades a watch unchecked for a week, and skips one never checked", () => {
    const base = root();
    const now = Date.parse("2026-11-25T10:00:00Z");
    saveWatches(base, [
      { ...newWatch("Price page", "https://example.com/price", "r1"), digest: "abc", lastCheckedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString() },
      { ...newWatch("New page", "https://example.com/new", "r1"), digest: "", lastCheckedAt: null },
    ]);
    const report = evalWatchHealth(base, now);
    expect(report.outcome).toBe("degraded");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toContain("Price page");
  });
});

describe("evalSkillRecall", () => {
  it("passes with no skills, and with healthy ones", () => {
    const base = root();
    expect(evalSkillRecall(base).outcome).toBe("pass");
    seedSkill(base, "weekly-report", "1. Open the report page");
    expect(evalSkillRecall(base).outcome).toBe("pass");
  });

  it("degrades a skill with an empty body", () => {
    const base = root();
    const doc = loadNotesDoc(base);
    saveNotesDoc(base, {
      ...doc,
      skills: [{ name: "weekly-report", description: "Build the weekly report", body: "   ", learned: "2026-11-25T00:00:00Z", updated: "2026-11-25T00:00:00Z", edited: null, task: null }],
    }, doc.version);
    const report = evalSkillRecall(base);
    expect(report.outcome).toBe("degraded");
    expect(report.findings[0]).toContain("weekly-report");
  });

  it("names the cap in the detail when memory is full of skills", () => {
    const base = root();
    for (let i = 0; i < 40; i++) seedSkill(base, `skill-${i}`, "Do it");
    expect(evalSkillRecall(base).detail).toContain("40-skill cap");
  });
});

describe("eval results store", () => {
  it("records and loads results, keeping only the newest hundred", () => {
    const base = root();
    const results: EvalResult[] = Array.from({ length: 105 }, (_, i) => ({
      id: `r${i}`, evalId: "skill-recall", at: new Date(Date.parse("2026-11-25T10:00:00Z") + i * 1000).toISOString(),
      outcome: "pass", detail: "ok", findings: [], proposalIds: [],
    }));
    expect(saveEvalResults(base, results)).toHaveLength(100);
    expect(loadEvalResults(base)[0]?.id).toBe("r5");
  });
});

describe("runSelfImprovementEvals", () => {
  it("stages an eval note on a first failure, then stays quiet until the next day", async () => {
    const base = root();
    let now = Date.parse("2026-11-25T10:00:00Z");
    recordProcedure(base, "owner", procedure([
      { tool: "agent_browser_open", args: { url: "https://example.com/account" }, label: "Opened the account page" },
      { tool: "agent_browser_nope", args: {}, label: "Did something unknown" },
    ]));
    const first = await runSelfImprovementEvals(base, { now: () => now });
    expect(first.needsOwner).toBe(true);
    expect(first.proposals).toHaveLength(1);
    expect(first.proposals[0]?.kind).toBe("add-note");
    expect(loadEvalResults(base)).toHaveLength(3);
    expect(listProposals(base)).toHaveLength(1);

    const second = await runSelfImprovementEvals(base, { now: () => now });
    expect(second.results).toEqual([]);
    expect(second.proposals).toEqual([]);
    expect(second.needsOwner).toBe(false);

    now += 25 * 60 * 60 * 1000;
    const third = await runSelfImprovementEvals(base, { now: () => now });
    expect(third.needsOwner).toBe(false);
    expect(third.proposals).toEqual([]);
    expect(listProposals(base)).toHaveLength(1);
  });

  it("records a recovery as a pass, with no proposal", async () => {
    const base = root();
    let now = Date.parse("2026-11-25T10:00:00Z");
    recordProcedure(base, "owner", procedure([
      { tool: "agent_browser_open", args: { url: "https://example.com/account" }, label: "Opened the account page" },
      { tool: "agent_browser_nope", args: {}, label: "Did something unknown" },
    ]));
    await runSelfImprovementEvals(base, { now: () => now });
    const doc = loadNotesDoc(base);
    const skill = doc.skills.find((candidate) => candidate.name === procedure().name)!;
    saveNotesDoc(base, {
      ...doc,
      skills: doc.skills.map((candidate) => (candidate === skill ? { ...candidate, body: procedureBody(procedure()) } : candidate)),
    }, doc.version);
    now += 25 * 60 * 60 * 1000;
    const recovered = await runSelfImprovementEvals(base, { now: () => now });
    expect(recovered.results.find((result) => result.evalId === "procedure-recall")?.outcome).toBe("pass");
    expect(recovered.proposals).toEqual([]);
    expect(recovered.needsOwner).toBe(false);
  });

  it("stages a patch-skill proposal when a snapshot re-derives a moved step", async () => {
    const base = root();
    const now = Date.parse("2026-11-25T10:00:00Z");
    recordProcedure(base, "owner", procedure([
      { tool: "agent_browser_open", args: { url: "https://example.com/account" }, label: "Opened the account page" },
      { tool: "agent_browser_click", args: { ref: "e3", role: "button", name: "Cancel subscription" }, label: "Clicked Cancel subscription" },
    ]));
    const run = await runSelfImprovementEvals(base, { now: () => now, snapshotFor: async () => SNAPSHOT });
    expect(run.needsOwner).toBe(true);
    const patch = run.proposals.find((proposal) => proposal.kind === "patch-skill");
    expect(patch).toBeDefined();
    if (patch?.kind === "patch-skill") expect(patch.body).toContain('"ref":"e7"');
  });

  it("falls back to a note when the owner edited the procedure it would patch", async () => {
    const base = root();
    const now = Date.parse("2026-11-25T10:00:00Z");
    recordProcedure(base, "owner", procedure([
      { tool: "agent_browser_open", args: { url: "https://example.com/account" }, label: "Opened the account page" },
      { tool: "agent_browser_click", args: { ref: "e3", role: "button", name: "Cancel subscription" }, label: "Clicked Cancel subscription" },
    ]));
    const doc = loadNotesDoc(base);
    const skill = doc.skills.find((candidate) => candidate.name === procedure().name)!;
    saveNotesDoc(base, {
      ...doc,
      skills: doc.skills.map((candidate) => (candidate === skill ? { ...candidate, edited: new Date(now).toISOString() } : candidate)),
    }, doc.version);
    const run = await runSelfImprovementEvals(base, { now: () => now, snapshotFor: async () => SNAPSHOT });
    expect(run.proposals.some((proposal) => proposal.kind === "patch-skill")).toBe(false);
    expect(run.proposals.some((proposal) => proposal.kind === "add-note")).toBe(true);
  });

  it("one corrupt file degrades only its own evals", async () => {
    const base = root();
    const now = Date.parse("2026-11-25T10:00:00Z");
    mkdirSync(join(base, "memory"), { recursive: true });
    writeFileSync(join(base, "memory", "notes.json"), "{not json", "utf8");
    const run = await runSelfImprovementEvals(base, { now: () => now });
    expect(run.results.find((result) => result.evalId === "procedure-recall")?.outcome).toBe("error");
    expect(run.results.find((result) => result.evalId === "skill-recall")?.outcome).toBe("error");
    expect(run.results.find((result) => result.evalId === "watch-health")?.outcome).toBe("pass");
  });
});
