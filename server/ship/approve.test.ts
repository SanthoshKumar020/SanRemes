import { describe, expect, it } from "vitest";

import type { GhRunner } from "../parallel-sessions.ts";
import { approvePullRequest, decideAutoApprove, decideAutoMerge, mergePullRequest, prReviewDecision } from "./approve.ts";
import { defaultShipPolicy } from "./policy.ts";
import type { ReviewResult } from "./reviewer.ts";

const PASS_REVIEW: ReviewResult = { verdict: "pass", findings: [], summary: "No problems found against the team policy." };
const FAIL_REVIEW: ReviewResult = {
  verdict: "fail",
  findings: [{ file: "src/a.ts", line: 2, severity: "block", message: "Do not hard-code passwords." }],
  summary: "1 problem blocks this pull request.",
};

function fakeGh(calls: string[][] = [], runResult = { code: 0, stdout: "", stderr: "" }): GhRunner {
  return {
    find: () => "/usr/bin/gh",
    run: async (args) => {
      calls.push(args);
      return runResult;
    },
  };
}

describe("decideAutoApprove", () => {
  it("is off by default, even when the review passes", () => {
    expect(decideAutoApprove(defaultShipPolicy(), PASS_REVIEW).allowed).toBe(false);
  });

  it("allows a passing review under an explicit policy", () => {
    expect(decideAutoApprove({ ...defaultShipPolicy(), autoApprove: true }, PASS_REVIEW).allowed).toBe(true);
  });

  it("refuses a failing review even when the policy allows auto-approve", () => {
    const decision = decideAutoApprove({ ...defaultShipPolicy(), autoApprove: true }, FAIL_REVIEW);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("1 blocking problems");
  });
});

describe("decideAutoMerge", () => {
  it("needs its own policy line, a pass, and an approval", () => {
    const policy = { ...defaultShipPolicy(), autoApprove: true, autoMerge: true };
    expect(decideAutoMerge(policy, PASS_REVIEW, true).allowed).toBe(true);
    expect(decideAutoMerge(policy, PASS_REVIEW, false).allowed).toBe(false);
    expect(decideAutoMerge(policy, FAIL_REVIEW, true).allowed).toBe(false);
    expect(decideAutoMerge({ ...defaultShipPolicy(), autoApprove: true }, PASS_REVIEW, true).allowed).toBe(false);
  });
});

describe("approvePullRequest", () => {
  it("never calls gh when the gate refuses", async () => {
    const calls: string[][] = [];
    const outcome = await approvePullRequest(fakeGh(calls), "octocat/hello-world", 12, defaultShipPolicy(), PASS_REVIEW);
    expect(outcome).toEqual({ approved: false, merged: false, reason: expect.stringContaining("Auto-approve is off") });
    expect(calls).toEqual([]);
  });

  it("approves through gh when the gate allows it", async () => {
    const calls: string[][] = [];
    const outcome = await approvePullRequest(fakeGh(calls), "octocat/hello-world", 12, { ...defaultShipPolicy(), autoApprove: true }, PASS_REVIEW);
    expect(outcome.approved).toBe(true);
    expect(calls).toEqual([["pr", "review", "12", "--approve", "--repo", "octocat/hello-world"]]);
  });

  it("refuses a repo that is not owner/name", async () => {
    await expect(approvePullRequest(fakeGh(), "not-a-repo", 12, { ...defaultShipPolicy(), autoApprove: true }, PASS_REVIEW))
      .rejects.toThrow("owner/name");
  });
});

describe("mergePullRequest", () => {
  it("never calls gh without auto-merge in the policy", async () => {
    const calls: string[][] = [];
    const outcome = await mergePullRequest(fakeGh(calls), "octocat/hello-world", 12, { ...defaultShipPolicy(), autoApprove: true }, PASS_REVIEW, true);
    expect(outcome.merged).toBe(false);
    expect(calls).toEqual([]);
  });

  it("merges through gh when policy, review and approval all allow it", async () => {
    const calls: string[][] = [];
    const outcome = await mergePullRequest(
      fakeGh(calls), "octocat/hello-world", 12,
      { ...defaultShipPolicy(), autoApprove: true, autoMerge: true }, PASS_REVIEW, true,
    );
    expect(outcome).toEqual({ approved: true, merged: true, reason: expect.stringContaining("allows auto-merge") });
    expect(calls).toEqual([["pr", "merge", "12", "--repo", "octocat/hello-world"]]);
  });
});

describe("prReviewDecision", () => {
  it("reads APPROVED from gh output", async () => {
    const gh = fakeGh([], { code: 0, stdout: "APPROVED\n", stderr: "" });
    expect(await prReviewDecision(gh, "octocat/hello-world", 12)).toBe("APPROVED");
  });

  it("returns null when GitHub gives no decision", async () => {
    const gh = fakeGh([], { code: 0, stdout: "null\n", stderr: "" });
    expect(await prReviewDecision(gh, "octocat/hello-world", 12)).toBeNull();
  });
});
