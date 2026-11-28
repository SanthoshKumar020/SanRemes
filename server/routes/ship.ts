// Ship over HTTP: read and save the team policy, review a pull request against it, apply review fixes in a
// parallel session's worktree, and approve or merge only when the policy explicitly allows it.
import { z } from "zod";

import type { GhRunner } from "../parallel-sessions.ts";
import { defaultGhRunner, type ParallelSessionStore } from "../parallel-sessions.ts";
import { PASS, type RouteHandler } from "./table.ts";
import { approvePullRequest, mergePullRequest, prReviewDecision, REPO_PATTERN, ShipApproveError } from "../ship/approve.ts";
import { describeShipCommand, parseShipCommand, shipCommandHelp } from "../ship/commands.ts";
import { applyFixes, ShipFixError } from "../ship/fix-applier.ts";
import { ShipPolicyError, ShipPolicyStore, shipPolicySchema } from "../ship/policy.ts";
import { parseUnifiedDiff, reviewPullRequest, type PrCheck, type PrFile, type ReviewInput } from "../ship/reviewer.ts";

export interface ShipRouteDeps {
  policy: ShipPolicyStore;
  sessions: ParallelSessionStore;
  gh?: GhRunner;
}

const isJson = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
  String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";

const fileSchema = z.object({ path: z.string().min(1).max(1000), patch: z.string().max(1_000_000).optional(), additions: z.number().int().min(0).optional(), deletions: z.number().int().min(0).optional() }).strict();
const checkSchema = z.object({ name: z.string().min(1).max(200), status: z.enum(["pass", "fail", "pending"]) }).strict();
const reviewBody = z.object({
  repo: z.string().max(200).optional(),
  number: z.number().int().min(1).optional(),
  files: z.array(fileSchema).max(500).optional(),
  checks: z.array(checkSchema).max(500).optional(),
}).strict();
const fixesBody = z.object({
  edits: z.array(z.object({ path: z.string().min(1).max(1000), find: z.string().min(1).max(100_000), replace: z.string().max(100_000) }).strict()).min(1).max(100),
}).strict();
const prBody = reviewBody.refine((body) => Boolean(body.repo && body.number) || (Array.isArray(body.files) && Array.isArray(body.checks)), {
  message: "Send a repo and pull request number, or the changed files and their checks.",
});

const FIXES_PATH = /^\/api\/ship\/sessions\/([\w-]{1,128})\/fixes$/u;

async function reviewInputFrom(gh: GhRunner, body: z.infer<typeof reviewBody>): Promise<ReviewInput> {
  if (Array.isArray(body.files) && Array.isArray(body.checks)) return { files: body.files, checks: body.checks };
  if (body.repo && body.number) {
    if (!REPO_PATTERN.test(body.repo)) throw new ShipApproveError("Send the repo as owner/name, for example octocat/hello-world.", 400);
    if (!gh.find()) throw new ShipApproveError("GitHub CLI (gh) isn't installed on this computer, so the pull request cannot be read. Install it and sign in with gh auth login, then try again.");
    const diff = await gh.run(["pr", "diff", String(body.number), "--repo", body.repo], process.cwd());
    if (diff.code !== 0) throw new ShipApproveError(`GitHub refused to read pull request ${body.number}. Check gh auth status on this computer.`);
    const files: PrFile[] = parseUnifiedDiff(diff.stdout);
    const viewed = await gh.run(["pr", "view", String(body.number), "--repo", body.repo, "--json", "statusCheckRollup"], process.cwd());
    const checks: PrCheck[] = [];
    if (viewed.code === 0) {
      try {
        const rollup = JSON.parse(viewed.stdout) as { statusCheckRollup?: { name?: string; conclusion?: string | null; status?: string }[] };
        for (const entry of rollup.statusCheckRollup ?? []) {
          if (!entry.name) continue;
          const status: PrCheck["status"] = entry.conclusion === "SUCCESS" ? "pass"
            : entry.conclusion === "FAILURE" || entry.conclusion === "CANCELLED" || entry.conclusion === "TIMED_OUT" ? "fail" : "pending";
          checks.push({ name: entry.name, status });
        }
      } catch {
        // GitHub answered, but not in the shape expected: the review runs with no checks rather than failing.
      }
    }
    return { files, checks };
  }
  return { files: body.files ?? [], checks: body.checks ?? [] };
}

export function createShipRoutes(deps: ShipRouteDeps): RouteHandler {
  const gh = deps.gh ?? defaultGhRunner;
  const fail = (res: Parameters<RouteHandler>[0]["res"], json: Parameters<RouteHandler>[0]["json"], error: unknown) => {
    if (error instanceof ShipPolicyError || error instanceof ShipFixError || error instanceof ShipApproveError) {
      return json(res, error.status, { error: error.message });
    }
    return json(res, 500, { error: error instanceof Error ? error.message : "Could not run that ship step." });
  };
  return async ({ req, res, path, method, json, readBody }) => {
    if (path === "/api/ship/policy") {
      if (method === "GET") return json(res, 200, { policy: deps.policy.get() });
      if (method !== "PUT") return json(res, 405, { error: "Use GET or PUT." });
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = shipPolicySchema.safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send a policy with autoApprove, autoMerge, requiredChecks, forbiddenPatterns and styleRules." });
      try {
        return json(res, 200, { policy: deps.policy.save(parsed.data) });
      } catch (error) {
        return fail(res, json, error);
      }
    }
    if (path === "/api/ship/review" && method === "POST") {
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = reviewBody.safeParse(await readBody(req, 256_000));
      if (!parsed.success) return json(res, 400, { error: "Send the changed files and their checks, or a repo and pull request number." });
      try {
        const input = await reviewInputFrom(gh, parsed.data);
        return json(res, 200, { review: reviewPullRequest(deps.policy.get(), input) });
      } catch (error) {
        return fail(res, json, error);
      }
    }
    if (path === "/api/ship/command" && method === "POST") {
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = z.object({ text: z.string().min(1).max(1000) }).strict().safeParse(await readBody(req, 64_000));
      if (!parsed.success) return json(res, 400, { error: "Send the message text to parse." });
      const command = parseShipCommand(parsed.data.text);
      if (!command) return json(res, 200, { command: null, reply: null });
      return json(res, 200, { command, reply: describeShipCommand(command), help: command.action === "help" ? shipCommandHelp() : undefined });
    }
    const fixes = FIXES_PATH.exec(path);
    if (fixes && method === "POST") {
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = fixesBody.safeParse(await readBody(req, 256_000));
      if (!parsed.success) return json(res, 400, { error: "Send at least one fix, each with a file path, the text to find, and its replacement." });
      try {
        return json(res, 200, { applied: applyFixes(deps.sessions, fixes[1]!, parsed.data.edits) });
      } catch (error) {
        return fail(res, json, error);
      }
    }
    if ((path === "/api/ship/pr/approve" || path === "/api/ship/pr/merge") && method === "POST") {
      if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
      const parsed = prBody.safeParse(await readBody(req, 256_000));
      if (!parsed.success) return json(res, 400, { error: "Send a repo and pull request number, or the changed files and their checks." });
      try {
        const input = await reviewInputFrom(gh, parsed.data);
        const review = reviewPullRequest(deps.policy.get(), input);
        const repo = parsed.data.repo!;
        const number = parsed.data.number!;
        if (path.endsWith("/approve")) {
          return json(res, 200, await approvePullRequest(gh, repo, number, deps.policy.get(), review));
        }
        const decision = await prReviewDecision(gh, repo, number);
        return json(res, 200, await mergePullRequest(gh, repo, number, deps.policy.get(), review, decision === "APPROVED"));
      } catch (error) {
        return fail(res, json, error);
      }
    }
    return PASS;
  };
}
