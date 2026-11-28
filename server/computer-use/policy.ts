import { isSensitiveInput } from "../browser/cdp/sensitive.ts";
import { blocklistMatch, type BlocklistCategory } from "./blocklist.ts";

/** One thing the agent browser can do on a page. `url` is the page the action runs on, or the address a
 * navigation opens. `fieldType`/`fieldHints` describe the field a type or fill targets, when there is one;
 * `label` is the target's visible text, when the snapshot gave one. */
export type ComputerUseActionKind =
  | "view"
  | "screenshot"
  | "click"
  | "type"
  | "fill"
  | "scroll"
  | "hover"
  | "press"
  | "select"
  | "check"
  | "drag"
  | "navigate"
  | "eval"
  | "upload"
  | "dialog";

export interface ComputerUseAction {
  kind: ComputerUseActionKind;
  url: string;
  fieldType?: string;
  fieldHints?: readonly (string | null | undefined)[];
  label?: string;
  submit?: boolean;
  dialogAccept?: boolean;
}

/** `read` only looks; `act` changes the page; `sensitive` changes something consequential and always needs
 * the person's own confirmation for that one action, however the site is permissioned. */
export type ActionSensitivity = "read" | "act" | "sensitive";

/** What the site's stored permission says: granted, denied, or never asked (`prompt`). */
export type PermissionState = "granted" | "denied" | "prompt";

/** `confirm` means ask the person about this one action; it is never satisfied by a stored permission. */
export type PolicyDecision = "allow" | "deny" | "confirm";

export interface PolicyVerdict {
  decision: PolicyDecision;
  sensitivity: ActionSensitivity;
  reason: string;
  blockedCategory?: BlocklistCategory;
}

const SENSITIVE_LABEL = /\b(buy|purchase|pay|checkout|place order|transfer|delete|remove|submit|send|confirm|subscribe|agree|sign ?out|log ?out)\b/i;

/** Whether the target's visible text names a consequential operation. */
export function isSensitiveLabel(label: string): boolean {
  return SENSITIVE_LABEL.test(label.trim());
}

/** How consequential an action is, before any site permission is considered. */
export function classifyAction(action: ComputerUseAction): ActionSensitivity {
  switch (action.kind) {
    case "view":
    case "screenshot":
    case "scroll":
    case "hover":
      return "read";
    case "eval":
    case "upload":
      return "sensitive";
    case "dialog":
      return action.dialogAccept === true ? "sensitive" : "act";
    case "type":
    case "fill":
      if (action.submit === true) return "sensitive";
      return isSensitiveInput(action.fieldType ?? "text", action.fieldHints ?? []) ? "sensitive" : "act";
    case "navigate":
      return "act";
    case "click":
    case "select":
    case "check":
    case "drag":
    case "press":
      return action.label !== undefined && isSensitiveLabel(action.label) ? "sensitive" : "act";
  }
}

/**
 * The one decision for an action on a page: the blocklist denies outright, a denied site denies every
 * change, a sensitive action always asks the person, an ordinary change asks once per site until granted,
 * and a read-only action goes ahead on any unlisted site.
 */
export function decideAction(action: ComputerUseAction, permission: PermissionState): PolicyVerdict {
  let parsed: URL;
  try {
    parsed = new URL(action.url);
  } catch {
    return { decision: "deny", sensitivity: classifyAction(action), reason: "The address is not a usable URL." };
  }
  if (action.kind === "navigate" && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { decision: "deny", sensitivity: "act", reason: "Only http(s) addresses may be opened." };
  }
  const blocked = blocklistMatch(action.url);
  if (blocked) {
    return {
      decision: "deny",
      sensitivity: classifyAction(action),
      reason: `${blocked.host} is blocked as a ${blocked.category} destination.`,
      blockedCategory: blocked.category,
    };
  }
  const sensitivity = classifyAction(action);
  if (sensitivity !== "read" && permission === "denied") {
    return { decision: "deny", sensitivity, reason: "Computer Use is denied for this site." };
  }
  if (sensitivity === "sensitive") {
    return { decision: "confirm", sensitivity, reason: "This action needs the person's confirmation every time; it is never auto-approved." };
  }
  if (sensitivity === "act" && permission === "prompt") {
    return { decision: "confirm", sensitivity, reason: "Computer Use has not been granted for this site yet." };
  }
  return { decision: "allow", sensitivity, reason: sensitivity === "read" ? "Reading a page needs no site permission." : "Computer Use is granted for this site." };
}
