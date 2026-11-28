export type ShipCommandAction = "review" | "approve" | "fix" | "policy" | "help";

export interface ShipCommand {
  action: ShipCommandAction;
  repo: string | null;
  number: number | null;
  sessionId: string | null;
}

const REPO_NUMBER = /^([\w.-]+\/[\w.-]+)#(\d+)$/u;
const NUMBER_ONLY = /^(\d+)$/u;
const SESSION_ID = /^[\w-]{1,128}$/u;

function repoAndNumber(arg: string | undefined): { repo: string | null; number: number | null } {
  if (!arg) return { repo: null, number: null };
  const withRepo = REPO_NUMBER.exec(arg);
  if (withRepo) return { repo: withRepo[1]!, number: Number(withRepo[2]) };
  const bare = NUMBER_ONLY.exec(arg);
  if (bare) return { repo: null, number: Number(bare[1]) };
  return { repo: null, number: null };
}

/** Parses a `/ship …` message. Anything else is ordinary text and returns null. */
export function parseShipCommand(text: string): ShipCommand | null {
  const trimmed = text.trim();
  if (!/^\/ship(?:\s|$)/u.test(trimmed)) return null;
  const rest = trimmed.slice("/ship".length).trim();
  if (!rest) return { action: "help", repo: null, number: null, sessionId: null };
  const [verb, arg] = rest.split(/\s+/u, 2);
  if (verb === "review" || verb === "approve") {
    const { repo, number } = repoAndNumber(arg);
    if (number === null) return { action: "help", repo: null, number: null, sessionId: null };
    return { action: verb, repo, number, sessionId: null };
  }
  if (verb === "fix") {
    if (!arg || !SESSION_ID.test(arg)) return { action: "help", repo: null, number: null, sessionId: null };
    return { action: "fix", repo: null, number: null, sessionId: arg };
  }
  if (verb === "policy") return { action: "policy", repo: null, number: null, sessionId: null };
  if (verb === "help") return { action: "help", repo: null, number: null, sessionId: null };
  return { action: "help", repo: null, number: null, sessionId: null };
}

export function shipCommandHelp(): string {
  return [
    "Ship reviews pull requests against the team policy.",
    "/ship review owner/repo#123 — review pull request 123",
    "/ship review 123 — review pull request 123 in the repo this chat works in",
    "/ship approve owner/repo#123 — approve it, only when the policy allows auto-approve and the review passes",
    "/ship fix <session> — apply the review's fixes in that parallel session's worktree",
    "/ship policy — show the team policy",
  ].join("\n");
}

/** The command back in plain words, for the reply that confirms what was understood. */
export function describeShipCommand(command: ShipCommand): string {
  switch (command.action) {
    case "review":
      return `Reviewing pull request ${command.number}${command.repo ? ` in ${command.repo}` : ""} against the team policy.`;
    case "approve":
      return `Approving pull request ${command.number}${command.repo ? ` in ${command.repo}` : ""} if the policy allows it and the review passes.`;
    case "fix":
      return `Applying the review's fixes in session ${command.sessionId}.`;
    case "policy":
      return "Showing the team policy for pull request reviews.";
    case "help":
      return shipCommandHelp();
  }
}
