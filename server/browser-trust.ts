import { mkdirSync, readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic.ts";
import { browserSteps, SECRET_TARGET, stepLabel } from "./browser-steps.ts";
import { parseToolCall, type ParsedCall, type ToolCall, type ToolName } from "./browser/tools.ts";
import { MemoryNotesError } from "./memory-notes.ts";
import {
  browserStepFingerprint,
  browserStepHasSecret,
  listProposals,
  loadPendingDoc,
  resolveMemoryFile,
  stageProposal,
  takeProposal,
  type BrowserStepInput,
  type MemoryActor,
  type PendingProposal,
} from "./memory-trust.ts";

/** Browser trust: the Phase 2 confirmation policy extended to website steps.
 *
 * Every browser tool call a bot makes passes the gate before it reaches the engine. Reading a page
 * changes nothing, so it runs. Changing something asks first: in a turn the owner started, their
 * request covers the errand's steps, so ordinary changes run and only the sensitive ones wait; in a
 * scheduled or background turn no owner is present, so every change waits as a proposal in the
 * Phase 2 pending queue. Approving a proposal records the exact action and arguments it allows;
 * the next time the bot retries that exact step the gate consumes the approval and runs it once.
 * A changed action or argument is a different step and needs its own approval. */

export type BrowserStepClass = "read" | "commit" | "sensitive";

interface BrowserTrustRule {
  actor: MemoryActor;
  action: BrowserStepClass;
  decision: "auto" | "pending";
  reason: string;
}

export const BROWSER_TRUST_POLICY: readonly BrowserTrustRule[] = [
  { actor: "owner", action: "read", decision: "auto", reason: "reading a page changes nothing" },
  { actor: "owner", action: "commit", decision: "auto", reason: "the owner's request covers the errand's steps" },
  { actor: "owner", action: "sensitive", decision: "pending", reason: "a payment, deletion or sign-in is never covered by a bare request" },
  { actor: "agent", action: "read", decision: "auto", reason: "reading a page changes nothing" },
  { actor: "agent", action: "commit", decision: "pending", reason: "no owner is present to cover a change made on a schedule" },
  { actor: "agent", action: "sensitive", decision: "pending", reason: "no owner is present to cover a change made on a schedule" },
];

/** Fail closed: an actor or step the table does not name waits for the owner. */
export function decideBrowserStep(actor: MemoryActor, action: BrowserStepClass): "auto" | "pending" {
  return BROWSER_TRUST_POLICY.find((rule) => rule.actor === actor && rule.action === action)?.decision ?? "pending";
}

const READ_TOOLS: ReadonlySet<ToolName> = new Set([
  "agent_browser_status",
  "agent_browser_open",
  "agent_browser_navigate",
  "agent_browser_snapshot",
  "agent_browser_read",
  "agent_browser_screenshot",
  "agent_browser_scroll",
  "agent_browser_hover",
  "agent_browser_wait",
  "agent_browser_tabs",
  "agent_browser_close",
  "restart_browser",
]);

/** Words on a control whose click is a point of no return: money moves, something is cancelled or
 * deleted, an account closes. Checked before the commit words, so "Send money" is sensitive while a
 * plain "Send" is an ordinary change. */
const SENSITIVE_WORDS =
  /\b(pay|buy|purchase|place order|checkout|cancel|delete|remove|unsubscribe|transfer|send money|subscribe|upgrade|downgrade|agree|accept terms|confirm (?:payment|order|purchase)|close account|deactivate|sign out|log out)\b/i;
const COMMIT_WORDS =
  /\b(submit|save|apply|confirm|continue|next|sign in|log in|sign up|register|create|update|post|publish|share|send|add)\b/i;

/** A click's class from the element the snapshot named. A link only moves; a textbox only takes
 * focus; a tab only switches. Anything else whose effect the name does not spell out counts as a
 * commitment — an unknown control may submit, delete or pay. */
export function classifyClick(element: { role: string; name: string } | undefined): BrowserStepClass {
  if (!element) return "commit";
  const role = element.role.toLowerCase();
  if (role === "link" || role === "tab") return "read";
  if (role === "textbox" || role === "combobox" || role === "slider" || role === "searchbox") return "read";
  if (SENSITIVE_WORDS.test(element.name)) return "sensitive";
  if (COMMIT_WORDS.test(element.name)) return "commit";
  return "commit";
}

/** A parsed tool call's class. The click classifier needs the snapshot's element record; every
 * other tool's class follows from its name and arguments alone. */
export function classifyBrowserCall(call: ToolCall, element?: { role: string; name: string }): BrowserStepClass {
  if (READ_TOOLS.has(call.name)) return "read";
  switch (call.name) {
    case "agent_browser_click":
      return classifyClick(element);
    case "agent_browser_fill":
    case "agent_browser_type":
    case "agent_browser_select":
    case "agent_browser_check":
    case "agent_browser_upload":
    case "agent_browser_drag":
      return "commit";
    case "agent_browser_press": {
      const key = call.input.key;
      const modifiers = call.input.modifiers ?? [];
      if (key === "Enter") return "commit";
      if (key.length === 1 && modifiers.length === 0) return "commit";
      if ((modifiers.includes("Control") || modifiers.includes("ControlOrMeta") || modifiers.includes("Meta")) && key.toLowerCase() === "v") return "commit";
      return "read";
    }
    case "agent_browser_eval":
      return call.input.world === "page" ? "sensitive" : "commit";
    case "agent_browser_dialog":
      return call.input.accept ? "commit" : "read";
    default:
      return "commit";
  }
}

function fail(code: "invalid" | "conflict" | "not-found" | "too-large" | "corrupt" | "path" | "secret", status: number, message: string): never {
  throw new MemoryNotesError(code, status, message);
}

export const BROWSER_APPROVALS_FILE = "memory/browser-approvals.json";
const BROWSER_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const BROWSER_APPROVALS_MAX = 50;
const BROWSER_APPROVALS_MAX_BYTES = 64 * 1024;

export interface BrowserApproval {
  fingerprint: string;
  step: BrowserStepInput;
  approvedAt: string;
  expiresAt: string;
}

interface BrowserApprovalsDoc {
  version: 1;
  approvals: BrowserApproval[];
}

function emptyApprovalsDoc(): BrowserApprovalsDoc {
  return { version: 1, approvals: [] };
}

function validApprovalsDoc(value: unknown): value is BrowserApprovalsDoc {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as BrowserApprovalsDoc).version === 1 &&
    Array.isArray((value as BrowserApprovalsDoc).approvals)
  );
}

export function loadApprovals(root: string): BrowserApprovalsDoc {
  let raw: string;
  try {
    raw = readFileSync(resolveMemoryFile(root, BROWSER_APPROVALS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyApprovalsDoc();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("corrupt", 500, "the browser approvals file is not valid JSON — it needs a hand fix before approvals can load");
  }
  if (!validApprovalsDoc(parsed)) {
    fail("corrupt", 500, "the browser approvals file does not hold an approvals document — it needs a hand fix before approvals can load");
  }
  const now = Date.now();
  return { version: 1, approvals: parsed.approvals.filter((approval) => Date.parse(approval.expiresAt) > now) };
}

function saveApprovals(root: string, doc: BrowserApprovalsDoc): BrowserApprovalsDoc {
  const text = JSON.stringify(doc, null, 2);
  if (Buffer.byteLength(text, "utf8") > BROWSER_APPROVALS_MAX_BYTES) {
    fail("too-large", 413, "too many browser approvals — run or discard some first");
  }
  mkdirSync(`${root}/memory`, { recursive: true, mode: 0o700 });
  writeFileAtomic(resolveMemoryFile(root, BROWSER_APPROVALS_FILE), text, { mode: 0o600 });
  return doc;
}

/** Approve a staged browser step: the proposal leaves the queue and its exact action and arguments
 * are recorded as a one-shot approval, good for a day. The replay runs the step, never a
 * re-interpretation of it. */
export function approveBrowserStep(root: string, proposalId: string): { proposal: PendingProposal; approval: BrowserApproval } {
  const pending = loadPendingDoc(root);
  const proposal = pending.proposals.find((candidate) => candidate.id === proposalId);
  if (!proposal) fail("not-found", 404, `no pending proposal ${JSON.stringify(proposalId)}`);
  if (proposal.kind !== "browser-step") fail("invalid", 400, "that proposal is not a browser step");
  const parsed = parseToolCall(proposal.step.tool, proposal.step.args);
  if (!parsed.ok) fail("invalid", 400, `that browser step cannot run: ${parsed.error}`);
  if (browserStepFingerprint(proposal.step) !== proposal.fingerprint) {
    fail("invalid", 400, "that browser step does not match its approval fingerprint");
  }
  if (browserStepHasSecret(proposal.step)) {
    fail("secret", 400, "a browser step cannot carry a password, key or code — sign in with the saved login instead");
  }
  takeProposal(root, proposalId);
  const now = Date.now();
  const approval: BrowserApproval = {
    fingerprint: proposal.fingerprint,
    step: proposal.step,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + BROWSER_APPROVAL_TTL_MS).toISOString(),
  };
  const approvals = loadApprovals(root);
  const kept = approvals.approvals.filter((candidate) => candidate.fingerprint !== approval.fingerprint);
  if (kept.length >= BROWSER_APPROVALS_MAX) kept.shift();
  saveApprovals(root, { version: 1, approvals: [...kept, approval] });
  return { proposal, approval };
}

/** Consume the one-shot approval for this exact step, or null when there is none. The approval
 * goes before the step runs, so a failed or interrupted replay is uncertain and never re-runs on
 * the same approval — the bot checks what happened first. */
export function takeApproval(root: string, fingerprint: string): BrowserStepInput | null {
  const doc = loadApprovals(root);
  const approval = doc.approvals.find((candidate) => candidate.fingerprint === fingerprint);
  if (!approval) return null;
  saveApprovals(root, { version: 1, approvals: doc.approvals.filter((candidate) => candidate.fingerprint !== fingerprint) });
  return approval.step;
}

export type BrowserGateResult =
  | { decision: "run" }
  | { decision: "approved"; step: BrowserStepInput }
  | { decision: "staged"; proposal: PendingProposal }
  | { decision: "refused"; reason: string };

/** What the bot hears when its step waits for the owner: which proposal, what it asks, and that
 * the errand stops here instead of working around the wait. */
export function waitingMessage(proposal: PendingProposal): string {
  const step = proposal.kind === "browser-step" ? proposal.step : null;
  const what = step ? step.label : "that step";
  return (
    `That step needs the owner's approval first, so I staged it as proposal ${proposal.id} (${what}). ` +
    `Stop this errand here and tell the owner what is waiting for their approval; do not repeat the step, ` +
    `work around it, or try a different way to do the same thing.`
  );
}

/** The one gate every bot browser call passes before it reaches the engine. Reads run. Changes
 * run for the owner and wait as proposals for a background turn; sensitive changes always wait.
 * A call that would type into a secret-looking field, or that carries a shaped secret, is refused
 * outright — credentials go through the Vault's saved login, never through a tool call. */
export function gateBrowserCall(input: {
  root: string;
  actor: MemoryActor;
  call: ParsedCall;
  element?: { role: string; name: string };
  url: string | null;
  label: string;
}): BrowserGateResult {
  if (!input.call.ok) return { decision: "refused", reason: input.call.error };
  const call = input.call.call;
  const step: BrowserStepInput = {
    tool: call.name,
    args: call.input as Record<string, unknown>,
    url: input.url,
    label: input.label,
  };
  if ((call.name === "agent_browser_fill" || call.name === "agent_browser_type") && input.element && SECRET_TARGET.test(`${input.element.role} ${input.element.name}`)) {
    return {
      decision: "refused",
      reason: "That field looks like a password, code or card field. Do not type into it — sign in with the saved login instead, and if there is no saved login, ask the owner to sign in themselves.",
    };
  }
  if (browserStepHasSecret(step)) {
    return {
      decision: "refused",
      reason: "That step carries a password, key or code. Never put credentials in a browser step — sign in with the saved login instead.",
    };
  }
  const urlArg = typeof step.args.url === "string" ? step.args.url : "";
  if (urlArg.trim().toLowerCase().startsWith("javascript:")) {
    return { decision: "refused", reason: "A javascript: address is never opened from a browser step." };
  }
  if (decideBrowserStep(input.actor, classifyBrowserCall(call, input.element)) !== "pending") return { decision: "run" };
  const fingerprint = browserStepFingerprint(step);
  const approved = takeApproval(input.root, fingerprint);
  if (approved) return { decision: "approved", step: approved };
  try {
    const proposal = stageProposal(input.root, { kind: "browser-step", step, fingerprint }, input.actor);
    return { decision: "staged", proposal };
  } catch (error) {
    if (error instanceof MemoryNotesError && error.code === "conflict") {
      const existing = listProposals(input.root).find((candidate) => candidate.kind === "browser-step" && candidate.fingerprint === fingerprint);
      if (existing) return { decision: "staged", proposal: existing };
    }
    throw error;
  }
}

/** The pre-flight answer for a browser MCP call: the response to send, or null to run it.
 * A waiting or refused step never takes the browser. */
export function gateBrowserMcpCall(input: {
  method: unknown;
  params: unknown;
  root: string;
  actor: MemoryActor;
  session: string;
}): { status: number; body: unknown } | null {
  if (input.method !== "tools/list" && input.method !== "tools/call") {
    return { status: 400, body: { error: "unsupported browser method" } };
  }
  if (input.method !== "tools/call") return null;
  const params = input.params && typeof input.params === "object" ? (input.params as { name?: unknown; arguments?: unknown }) : {};
  const callArgs = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
    ? (params.arguments as Record<string, unknown>)
    : {};
  const ref = typeof callArgs.ref === "string" ? callArgs.ref : null;
  const element = ref ? browserSteps.refs(input.session).get(ref) : undefined;
  const gated = gateBrowserCall({
    root: input.root,
    actor: input.actor,
    call: parseToolCall(params.name, params.arguments),
    ...(element ? { element } : {}),
    url: typeof callArgs.url === "string" ? callArgs.url : null,
    label: stepLabel(typeof params.name === "string" ? params.name : "", callArgs, element),
  });
  if (gated.decision === "refused") {
    return { status: 200, body: { result: { isError: true, content: [{ type: "text", text: gated.reason }] } } };
  }
  if (gated.decision === "staged") {
    return { status: 200, body: { result: { content: [{ type: "text", text: waitingMessage(gated.proposal) }] } } };
  }
  return null;
}
