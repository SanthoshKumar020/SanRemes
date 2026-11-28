import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { ParallelSessionStore } from "../parallel-sessions.ts";

export interface FileEdit {
  path: string;
  find: string;
  replace: string;
}

export interface AppliedFix {
  path: string;
}

export class ShipFixError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

function countOccurrences(content: string, find: string): number {
  let count = 0;
  let at = 0;
  for (;;) {
    const next = content.indexOf(find, at);
    if (next === -1) return count;
    count += 1;
    at = next + find.length;
  }
}

/** Applies exact-text fixes inside a parallel session's worktree. Every edit is checked before any file
 * is written, so a bad edit leaves the worktree untouched. Conflicts are never resolved here. */
export function applyFixes(
  sessions: ParallelSessionStore,
  sessionId: string,
  edits: FileEdit[],
): AppliedFix[] {
  const session = sessions.get(sessionId);
  if (!session) throw new ShipFixError("No such session.", 404);
  if (session.state === "closed") throw new ShipFixError("That session is closed. Start a new session for this work.");
  if (session.state === "conflict") {
    throw new ShipFixError(`Resolve the conflicts in ${session.branch} first (${session.conflictFiles.join(", ") || "unknown files"}). SanRemes never resolves them for you.`);
  }
  if (edits.length === 0) throw new ShipFixError("Give at least one fix to apply.");
  const root = resolve(session.worktreeDir);
  const prepared: { file: string; path: string; content: string }[] = [];
  for (const edit of edits) {
    if (!edit.path || edit.path.startsWith("/") || edit.path.split("/").includes("..")) {
      throw new ShipFixError(`Fix path ${JSON.stringify(edit.path)} must stay inside the worktree.`);
    }
    if (!edit.find) throw new ShipFixError(`The fix for ${edit.path} has nothing to find.`);
    const file = resolve(root, edit.path);
    if (file !== root && !file.startsWith(`${root}${sep}`)) throw new ShipFixError(`Fix path ${JSON.stringify(edit.path)} must stay inside the worktree.`);
    if (!existsSync(file)) throw new ShipFixError(`File ${edit.path} does not exist in the worktree.`);
    const content = readFileSync(file, "utf8");
    const count = countOccurrences(content, edit.find);
    if (count === 0) throw new ShipFixError(`The text to replace was not found in ${edit.path}. The file may have changed since the review.`);
    if (count > 1) throw new ShipFixError(`The text to replace appears ${count} times in ${edit.path}. Narrow it down so it matches exactly once.`);
    prepared.push({ file, path: edit.path, content: content.replace(edit.find, edit.replace) });
  }
  for (const one of prepared) writeFileSync(one.file, one.content, "utf8");
  return prepared.map((one) => ({ path: one.path }));
}
