/**
 * Computer Use on the agent browser: screen view and click/type/scroll through the existing CDP driver
 * (`server/browser/cdp/`), gated by a policy, a high-risk blocklist and per-site permissions. The driver
 * calls `ComputerUseGate.request` before acting; a sensitive action runs only when the person confirms
 * that exact action. Screen view is the driver's own screenshot/screencast, gated here as `view` and
 * `screenshot` actions. Nothing in this module touches the person's own Chrome policy
 * (`server/browser/desktop/policy.ts`).
 */
export { actionForCall, describeTarget, guardedExecuteTool } from "./driver.ts";
export type { TargetDescriber, TargetDescription } from "./driver.ts";
export { blocklistMatch, blockedCategory, BLOCKED_CATEGORIES, DEFAULT_BLOCKLIST, hostMatchesEntry, normalizeHost } from "./blocklist.ts";
export type { BlocklistCategory, BlocklistEntry, BlocklistMatch } from "./blocklist.ts";
export { ComputerUseGate, GATE_HISTORY_LIMIT, PENDING_CONFIRMATION_TTL_MS } from "./gate.ts";
export type { ConfirmationRequest, Confirmer, GateOutcome, GateRecord } from "./gate.ts";
export { ComputerUsePermissions, siteOrigin } from "./permissions.ts";
export type { GrantState, PermissionGrant } from "./permissions.ts";
export { classifyAction, decideAction, isSensitiveLabel } from "./policy.ts";
export type { ActionSensitivity, ComputerUseAction, ComputerUseActionKind, PermissionState, PolicyDecision, PolicyVerdict } from "./policy.ts";
