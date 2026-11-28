import type { GhRunner } from "../parallel-sessions.ts";
import type { ShipPolicy } from "./policy.ts";
import type { ReviewResult } from "./reviewer.ts";

export interface ApproveDecision {
  allowed: boolean;
  reason: string;
}

export interface ApproveOutcome {
  approved: boolean;
  merged: boolean;
  reason: string;
}

export class ShipApproveError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/u;

/** Auto-approve runs only under an explicit policy, and only when the review passes. Default: off. */
export function decideAutoApprove(policy: ShipPolicy, review: ReviewResult): ApproveDecision {
  if (!policy.autoApprove) return { allowed: false, reason: "Auto-approve is off in the team policy. Turn it on explicitly before any pull request is approved automatically." };
  if (review.verdict !== "pass") return { allowed: false, reason: `The review found ${review.findings.filter((finding) => finding.severity === "block").length} blocking problems, so this pull request is not approved automatically.` };
  return { allowed: true, reason: "The review passed and the team policy allows auto-approve." };
}

/** Auto-merge needs its own explicit policy line, a passing review, and an approval already in place. */
export function decideAutoMerge(policy: ShipPolicy, review: ReviewResult, approved: boolean): ApproveDecision {
  if (!policy.autoMerge) return { allowed: false, reason: "Auto-merge is off in the team policy. Merge this pull request by hand." };
  if (!approved) return { allowed: false, reason: "This pull request is not approved yet, so it is not merged automatically." };
  if (review.verdict !== "pass") return { allowed: false, reason: "The review did not pass, so this pull request is not merged automatically." };
  return { allowed: true, reason: "The review passed, the pull request is approved, and the team policy allows auto-merge." };
}

function tail(stderr: string): string {
  const last = stderr.trim().split("\n").at(-1)?.trim() ?? "";
  return last ? `: ${last.slice(0, 300)}` : "";
}

function requireGh(gh: GhRunner): string {
  const found = gh.find();
  if (!found) throw new ShipApproveError("GitHub CLI (gh) isn't installed on this computer, so no pull request can be approved. Install it and sign in with gh auth login, then try again.");
  return found;
}

function requireRepo(repo: string): void {
  if (!REPO_PATTERN.test(repo)) throw new ShipApproveError("Send the repo as owner/name, for example octocat/hello-world.", 400);
}

/** Approves a pull request through `gh`, only when the gate allows it. Never merges here. */
export async function approvePullRequest(
  gh: GhRunner,
  repo: string,
  number: number,
  policy: ShipPolicy,
  review: ReviewResult,
): Promise<ApproveOutcome> {
  requireRepo(repo);
  if (!Number.isInteger(number) || number < 1) throw new ShipApproveError("Send a pull request number of 1 or more.", 400);
  const decision = decideAutoApprove(policy, review);
  if (!decision.allowed) return { approved: false, merged: false, reason: decision.reason };
  requireGh(gh);
  const approved = await gh.run(["pr", "review", String(number), "--approve", "--repo", repo], process.cwd());
  if (approved.code !== 0) throw new ShipApproveError(`GitHub refused the approval${tail(approved.stderr)}. Check gh auth status on this computer.`);
  return { approved: true, merged: false, reason: decision.reason };
}

/** Merges a pull request through `gh`, only when the policy, the review and an approval all allow it. */
export async function mergePullRequest(
  gh: GhRunner,
  repo: string,
  number: number,
  policy: ShipPolicy,
  review: ReviewResult,
  approved: boolean,
): Promise<ApproveOutcome> {
  requireRepo(repo);
  if (!Number.isInteger(number) || number < 1) throw new ShipApproveError("Send a pull request number of 1 or more.", 400);
  const decision = decideAutoMerge(policy, review, approved);
  if (!decision.allowed) return { approved, merged: false, reason: decision.reason };
  requireGh(gh);
  const merged = await gh.run(["pr", "merge", String(number), "--repo", repo], process.cwd());
  if (merged.code !== 0) throw new ShipApproveError(`GitHub refused the merge${tail(merged.stderr)}. Check gh auth status on this computer.`);
  return { approved, merged: true, reason: decision.reason };
}

/** Reads a pull request's review decision (`APPROVED`, `CHANGES_REQUESTED`, …) through `gh`, or null when GitHub gives none. */
export async function prReviewDecision(gh: GhRunner, repo: string, number: number): Promise<string | null> {
  requireRepo(repo);
  requireGh(gh);
  const viewed = await gh.run(["pr", "view", String(number), "--repo", repo, "--json", "reviewDecision", "--jq", ".reviewDecision"], process.cwd());
  if (viewed.code !== 0) throw new ShipApproveError(`GitHub refused to read pull request ${number}${tail(viewed.stderr)}.`);
  const decision = viewed.stdout.trim();
  return decision && decision !== "null" ? decision : null;
}
