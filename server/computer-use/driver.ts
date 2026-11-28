import { agentUrl, executeTool, type ToolContext } from "../browser/dispatch.ts";
import { callOnNode, valueInWorld } from "../browser/cdp/evaluate.ts";
import { resolveElement } from "../browser/cdp/selectors.ts";
import { errorResult, type ToolResult } from "../browser/shape.ts";
import type { Tab } from "../browser/tabs.ts";
import type { ToolCall } from "../browser/tools.ts";
import type { ComputerUseGate } from "./gate.ts";
import type { ComputerUseAction } from "./policy.ts";

/** What the gate needs to know about a target: its visible text, and for a field its type and hints. */
export interface TargetDescription {
  label?: string;
  fieldType?: string;
  fieldHints?: readonly (string | null | undefined)[];
}

/** Reads a target's description; null target means the element with the focus. */
export type TargetDescriber = (tab: Tab, target: { ref?: string; selector?: string } | null) => Promise<TargetDescription | null>;

const ELEMENT_DESCRIPTION = `function () {
  const el = this;
  const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
  const label = text(el.innerText || el.getAttribute("aria-label") || el.value || "").slice(0, 200);
  const hints = [el.getAttribute("autocomplete"), el.name, el.id, el.placeholder, el.getAttribute("aria-label")];
  if (el.labels) for (const item of el.labels) hints.push(item.innerText);
  return { label: label === "" ? undefined : label, fieldType: el.type || el.tagName.toLowerCase(), fieldHints: hints };
}`;

const ACTIVE_DESCRIPTION = `(function () { const el = document.activeElement; if (!el || el === document.body) return null; return (${ELEMENT_DESCRIPTION}).call(el); })()`;

/** Reads the target off the live page, without changing it. */
export async function describeTarget(tab: Tab, target: { ref?: string; selector?: string } | null): Promise<TargetDescription | null> {
  if (target === null) {
    return valueInWorld<TargetDescription | null>(tab.page.frames, tab.page.frames.mainFrameId, ACTIVE_DESCRIPTION);
  }
  const handle = await resolveElement(tab.page.frames, tab.page.refs, target);
  return callOnNode<TargetDescription>(tab.page.frames, handle, ELEMENT_DESCRIPTION, [], { readOnly: true });
}

function tabFor(context: ToolContext, call: ToolCall): Tab | null {
  const asked = (call.input as { tab?: string }).tab;
  if (asked !== undefined && asked !== "new") return context.tabs.get(asked) ?? null;
  return context.active();
}

function requireTab(context: ToolContext, call: ToolCall): Tab {
  const tab = tabFor(context, call);
  if (!tab) throw new Error("No tab is open. Call agent_browser_open.");
  return tab;
}

function namedTarget(input: { ref?: string; selector?: string; x?: number; y?: number }): { ref?: string; selector?: string } | null {
  if (input.ref !== undefined) return { ref: input.ref };
  if (input.selector !== undefined) return { selector: input.selector };
  return null;
}

function labelOf(info: TargetDescription | null): Pick<ComputerUseAction, "label"> {
  return info?.label !== undefined ? { label: info.label } : {};
}

function fieldOf(info: TargetDescription | null): Pick<ComputerUseAction, "fieldType" | "fieldHints"> {
  if (!info) return {};
  return {
    ...(info.fieldType !== undefined ? { fieldType: info.fieldType } : {}),
    ...(info.fieldHints !== undefined ? { fieldHints: info.fieldHints } : {}),
  };
}

function requiredTarget(input: { ref?: string; selector?: string }): { ref?: string; selector?: string } {
  const target = namedTarget(input);
  if (!target) throw new Error("Name the element with ref (from a snapshot) or selector.");
  return target;
}

/**
 * The Computer Use action a browser tool call is, on the page it runs on. Null means the call touches no
 * page (closing a tab or the browser, restarting it), so the gate has nothing to ask about. Throws when the
 * call names a page or element that is not there, as the driver would.
 */
export async function actionForCall(context: ToolContext, call: ToolCall, describe: TargetDescriber = describeTarget): Promise<ComputerUseAction | null> {
  const tab = tabFor(context, call);
  const pageUrl = tab?.page.url() ?? "about:blank";
  switch (call.name) {
    case "agent_browser_open": {
      const url = call.input.url !== undefined && call.input.url.trim() !== "" ? agentUrl(call.input.url) : null;
      return url === null ? { kind: "view", url: pageUrl } : { kind: "navigate", url };
    }
    case "agent_browser_navigate": {
      if (call.input.url !== undefined) return { kind: "navigate", url: agentUrl(call.input.url) };
      return { kind: "navigate", url: pageUrl };
    }
    case "agent_browser_read": {
      if (call.input.url !== undefined && call.input.url.trim() !== "") return { kind: "navigate", url: agentUrl(call.input.url) };
      return { kind: "view", url: pageUrl };
    }
    case "agent_browser_snapshot":
      return { kind: call.input.includeImage === true || call.input.save === true ? "screenshot" : "view", url: pageUrl };
    case "agent_browser_screenshot":
    case "agent_browser_status":
    case "agent_browser_wait":
      return { kind: call.name === "agent_browser_screenshot" ? "screenshot" : "view", url: pageUrl };
    case "agent_browser_click": {
      const acting = requireTab(context, call);
      const target = namedTarget(call.input);
      return { kind: "click", url: acting.page.url(), ...labelOf(target ? await describe(acting, target) : null) };
    }
    case "agent_browser_fill": {
      const acting = requireTab(context, call);
      const info = await describe(acting, requiredTarget(call.input));
      return { kind: "fill", url: acting.page.url(), submit: call.input.submit === true, ...fieldOf(info) };
    }
    case "agent_browser_type": {
      const acting = requireTab(context, call);
      const target = namedTarget(call.input);
      const info = await describe(acting, target);
      return { kind: "type", url: acting.page.url(), ...fieldOf(info) };
    }
    case "agent_browser_press": {
      const acting = requireTab(context, call);
      return { kind: "press", url: acting.page.url() };
    }
    case "agent_browser_select": {
      const acting = requireTab(context, call);
      const info = await describe(acting, requiredTarget(call.input));
      return { kind: "select", url: acting.page.url(), ...labelOf(info) };
    }
    case "agent_browser_check": {
      const acting = requireTab(context, call);
      const info = await describe(acting, requiredTarget(call.input));
      return { kind: "check", url: acting.page.url(), ...labelOf(info) };
    }
    case "agent_browser_hover": {
      const acting = requireTab(context, call);
      const target = namedTarget(call.input);
      return { kind: "hover", url: acting.page.url(), ...labelOf(target ? await describe(acting, target) : null) };
    }
    case "agent_browser_drag": {
      const acting = requireTab(context, call);
      const target = namedTarget(call.input.from);
      return { kind: "drag", url: acting.page.url(), ...labelOf(target ? await describe(acting, target) : null) };
    }
    case "agent_browser_scroll": {
      const acting = requireTab(context, call);
      return { kind: "scroll", url: acting.page.url() };
    }
    case "agent_browser_upload": {
      const acting = requireTab(context, call);
      return { kind: "upload", url: acting.page.url() };
    }
    case "agent_browser_eval": {
      const acting = requireTab(context, call);
      return { kind: "eval", url: acting.page.url() };
    }
    case "agent_browser_dialog": {
      const acting = requireTab(context, call);
      return { kind: "dialog", url: acting.page.url(), dialogAccept: call.input.accept };
    }
    case "agent_browser_tabs": {
      const { action, url, tab: which } = call.input;
      if (action === "close") return null;
      if (action === "new") {
        return url !== undefined && url.trim() !== "" ? { kind: "navigate", url: agentUrl(url) } : { kind: "view", url: "about:blank" };
      }
      if (action === "switch") {
        const target = which ? context.tabs.get(which) : null;
        return { kind: "view", url: target?.page.url() ?? pageUrl };
      }
      return { kind: "view", url: pageUrl };
    }
    case "agent_browser_close":
    case "restart_browser":
      return null;
  }
}

/**
 * Runs a browser tool call through the gate: a denied action never reaches the driver, and a refused
 * confirmation is the bot's answer, not an exception. `run` is the driver's own dispatch, replaceable in
 * tests; `describe` reads target elements off the live page, likewise replaceable.
 */
export async function guardedExecuteTool(
  context: ToolContext,
  call: ToolCall,
  gate: ComputerUseGate,
  run: (context: ToolContext, call: ToolCall) => Promise<ToolResult> = executeTool,
  describe: TargetDescriber = describeTarget,
): Promise<ToolResult> {
  let action: ComputerUseAction | null;
  try {
    action = await actionForCall(context, call, describe);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
  if (action === null) return run(context, call);
  const outcome = await gate.request(action);
  if (!outcome.allowed) return errorResult(outcome.reason);
  return run(context, call);
}
