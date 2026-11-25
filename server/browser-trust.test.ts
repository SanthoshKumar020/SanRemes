import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseToolCall } from "./browser/tools.ts";
import {
  approveBrowserStep,
  classifyBrowserCall,
  decideBrowserStep,
  gateBrowserCall,
  gateBrowserMcpCall,
  loadApprovals,
  takeApproval,
  waitingMessage,
} from "./browser-trust.ts";
import { MemoryNotesError } from "./memory-notes.ts";
import { browserStepFingerprint, listProposals, stageProposal } from "./memory-trust.ts";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function root(): string {
  dir = mkdtempSync(join(tmpdir(), "sanremes-browser-trust-"));
  return dir;
}

const button = (name: string) => ({ role: "button", name });
const link = (name: string) => ({ role: "link", name });

describe("classifyBrowserCall", () => {
  it("reads run: status, snapshot, read, navigation, scrolling, tabs", () => {
    for (const [tool, args] of [
      ["agent_browser_status", {}],
      ["agent_browser_snapshot", {}],
      ["agent_browser_read", {}],
      ["agent_browser_screenshot", {}],
      ["agent_browser_open", { url: "https://example.com" }],
      ["agent_browser_navigate", { url: "https://example.com" }],
      ["agent_browser_scroll", { dy: 600 }],
      ["agent_browser_hover", { ref: "e1" }],
      ["agent_browser_wait", { ms: 1000 }],
      ["agent_browser_tabs", { action: "list" }],
      ["agent_browser_close", {}],
      ["restart_browser", {}],
    ] as const) {
      const parsed = parseToolCall(tool, args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(classifyBrowserCall(parsed.call)).toBe("read");
    }
  });

  it("clicks follow the element: links and fields read, money and deletion ask, the rest commits", () => {
    const click = (args: Record<string, unknown>) => parseToolCall("agent_browser_click", args);
    const called = click({ ref: "e3" });
    expect(called.ok).toBe(true);
    if (!called.ok) return;
    expect(classifyBrowserCall(called.call, link("Pricing"))).toBe("read");
    expect(classifyBrowserCall(called.call, { role: "tab", name: "Orders" })).toBe("read");
    expect(classifyBrowserCall(called.call, { role: "textbox", name: "Search" })).toBe("read");
    expect(classifyBrowserCall(called.call, button("Buy now"))).toBe("sensitive");
    expect(classifyBrowserCall(called.call, button("Cancel subscription"))).toBe("sensitive");
    expect(classifyBrowserCall(called.call, button("Delete account"))).toBe("sensitive");
    expect(classifyBrowserCall(called.call, button("Send money"))).toBe("sensitive");
    expect(classifyBrowserCall(called.call, button("Save"))).toBe("commit");
    expect(classifyBrowserCall(called.call, button("Submit"))).toBe("commit");
    expect(classifyBrowserCall(called.call, button("Send"))).toBe("commit");
    expect(classifyBrowserCall(called.call, button("Show more"))).toBe("commit");
    expect(classifyBrowserCall(called.call, undefined)).toBe("commit");
  });

  it("fills, typing, choices and uploads commit; Enter commits; Escape reads", () => {
    const cases: Array<[string, Record<string, unknown>, "commit" | "read"]> = [
      ["agent_browser_fill", { ref: "e1", text: "hello" }, "commit"],
      ["agent_browser_fill", { ref: "e1", text: "hello", submit: true }, "commit"],
      ["agent_browser_type", { ref: "e1", text: "hello" }, "commit"],
      ["agent_browser_select", { ref: "e1", values: ["a"] }, "commit"],
      ["agent_browser_check", { ref: "e1" }, "commit"],
      ["agent_browser_upload", { ref: "e1", files: ["/tmp/a.pdf"] }, "commit"],
      ["agent_browser_drag", { from: { ref: "e1" }, to: { ref: "e2" } }, "commit"],
      ["agent_browser_press", { key: "Enter" }, "commit"],
      ["agent_browser_press", { key: "a" }, "commit"],
      ["agent_browser_press", { key: "v", modifiers: ["Control"] }, "commit"],
      ["agent_browser_press", { key: "Escape" }, "read"],
      ["agent_browser_press", { key: "Tab" }, "read"],
      ["agent_browser_press", { key: "c", modifiers: ["Control"] }, "read"],
    ];
    for (const [tool, args, expected] of cases) {
      const parsed = parseToolCall(tool, args);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(classifyBrowserCall(parsed.call)).toBe(expected);
    }
  });

  it("eval in the page's world is sensitive, isolated eval commits, accepting a dialog commits", () => {
    const pageEval = parseToolCall("agent_browser_eval", { expression: "1+1", world: "page" });
    const isolatedEval = parseToolCall("agent_browser_eval", { expression: "1+1" });
    const accept = parseToolCall("agent_browser_dialog", { accept: true });
    const dismiss = parseToolCall("agent_browser_dialog", { accept: false });
    expect(pageEval.ok && classifyBrowserCall(pageEval.call)).toBe("sensitive");
    expect(isolatedEval.ok && classifyBrowserCall(isolatedEval.call)).toBe("commit");
    expect(accept.ok && classifyBrowserCall(accept.call)).toBe("commit");
    expect(dismiss.ok && classifyBrowserCall(dismiss.call)).toBe("read");
  });
});

describe("decideBrowserStep", () => {
  it("lets the owner read and change at once, makes sensitive steps wait, and makes a background turn wait for every change", () => {
    expect(decideBrowserStep("owner", "read")).toBe("auto");
    expect(decideBrowserStep("owner", "commit")).toBe("auto");
    expect(decideBrowserStep("owner", "sensitive")).toBe("pending");
    expect(decideBrowserStep("agent", "read")).toBe("auto");
    expect(decideBrowserStep("agent", "commit")).toBe("pending");
    expect(decideBrowserStep("agent", "sensitive")).toBe("pending");
  });
});

describe("browserStepFingerprint", () => {
  it("binds the exact tool and arguments, whatever order the keys came in", () => {
    const first = browserStepFingerprint({ tool: "agent_browser_click", args: { ref: "e3", button: "left" }, url: null, label: "Clicked" });
    const reordered = browserStepFingerprint({ tool: "agent_browser_click", args: { button: "left", ref: "e3" }, url: null, label: "Clicked it" });
    const changed = browserStepFingerprint({ tool: "agent_browser_click", args: { ref: "e4", button: "left" }, url: null, label: "Clicked" });
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });
});

describe("gateBrowserCall", () => {
  it("runs reads and owner commits, stages agent commits and sensitive steps", () => {
    const base = root();
    const snapshot = parseToolCall("agent_browser_snapshot", {});
    expect(gateBrowserCall({ root: base, actor: "agent", call: snapshot, url: null, label: "Snapshot" }).decision).toBe("run");
    const save = parseToolCall("agent_browser_click", { ref: "e3" });
    expect(gateBrowserCall({ root: base, actor: "owner", call: save, element: button("Save"), url: "https://example.com", label: "Clicked Save" }).decision).toBe("run");
    const staged = gateBrowserCall({ root: base, actor: "agent", call: save, element: button("Save"), url: "https://example.com", label: "Clicked Save" });
    expect(staged.decision).toBe("staged");
    if (staged.decision !== "staged") return;
    expect(staged.proposal.kind).toBe("browser-step");
    expect(staged.proposal.proposedBy).toBe("agent");
    if (staged.proposal.kind === "browser-step") {
      expect(staged.proposal.fingerprint).toBe(browserStepFingerprint(staged.proposal.step));
      expect(staged.proposal.step.label).toBe("Clicked Save");
    }
    const pay = parseToolCall("agent_browser_click", { ref: "e9" });
    expect(gateBrowserCall({ root: base, actor: "owner", call: pay, element: button("Pay now"), url: "https://example.com", label: "Clicked Pay now" }).decision).toBe("staged");
  });

  it("stages the same step once: a repeat returns the waiting proposal, not a second one", () => {
    const base = root();
    const call = parseToolCall("agent_browser_fill", { ref: "e1", text: "hello" });
    const first = gateBrowserCall({ root: base, actor: "agent", call, element: { role: "textbox", name: "Name" }, url: null, label: "Filled Name" });
    const second = gateBrowserCall({ root: base, actor: "agent", call, element: { role: "textbox", name: "Name" }, url: null, label: "Filled Name" });
    expect(first.decision).toBe("staged");
    expect(second.decision).toBe("staged");
    if (first.decision === "staged" && second.decision === "staged") expect(second.proposal.id).toBe(first.proposal.id);
    expect(listProposals(base)).toHaveLength(1);
  });

  it("refuses a step that carries a shaped secret and stages nothing", () => {
    const base = root();
    const keyed = parseToolCall("agent_browser_fill", { ref: "e1", text: "sk-live-abc1234567890" });
    const refused = gateBrowserCall({ root: base, actor: "owner", call: keyed, element: { role: "textbox", name: "Notes" }, url: null, label: "Filled Notes" });
    expect(refused.decision).toBe("refused");
    expect(listProposals(base)).toHaveLength(0);
  });

  it("refuses typing into a secret-looking field, whatever the text", () => {
    const base = root();
    const fill = parseToolCall("agent_browser_fill", { ref: "e1", text: "hello" });
    const refused = gateBrowserCall({ root: base, actor: "owner", call: fill, element: { role: "textbox", name: "Password" }, url: null, label: "Filled Password" });
    expect(refused.decision).toBe("refused");
    expect(listProposals(base)).toHaveLength(0);
  });

  it("refuses an unparseable call and a javascript: address", () => {
    const base = root();
    const bad = parseToolCall("agent_browser_frobnicate", {});
    expect(gateBrowserCall({ root: base, actor: "owner", call: bad, url: null, label: "?" }).decision).toBe("refused");
    const script = parseToolCall("agent_browser_open", { url: "javascript:alert(1)" });
    expect(gateBrowserCall({ root: base, actor: "owner", call: script, url: "javascript:alert(1)", label: "Opened" }).decision).toBe("refused");
  });

  it("approval replays the exact step once, then it waits again; a changed argument needs its own approval", () => {
    const base = root();
    const call = parseToolCall("agent_browser_click", { ref: "e3" });
    const staged = gateBrowserCall({ root: base, actor: "agent", call, element: button("Save"), url: null, label: "Clicked Save" });
    expect(staged.decision).toBe("staged");
    if (staged.decision !== "staged") return;
    const { proposal } = approveBrowserStep(base, staged.proposal.id);
    expect(proposal.kind).toBe("browser-step");
    expect(listProposals(base)).toHaveLength(0);
    expect(loadApprovals(base).approvals).toHaveLength(1);
    const replayed = gateBrowserCall({ root: base, actor: "agent", call, element: button("Save"), url: null, label: "Clicked Save" });
    expect(replayed.decision).toBe("approved");
    expect(loadApprovals(base).approvals).toHaveLength(0);
    const again = gateBrowserCall({ root: base, actor: "agent", call, element: button("Save"), url: null, label: "Clicked Save" });
    expect(again.decision).toBe("staged");
    const changed = parseToolCall("agent_browser_click", { ref: "e4" });
    expect(gateBrowserCall({ root: base, actor: "agent", call: changed, element: button("Save"), url: null, label: "Clicked Save" }).decision).toBe("staged");
    expect(takeApproval(base, "0".repeat(64))).toBeNull();
  });

  it("an expired approval does not replay the step", () => {
    const base = root();
    const call = parseToolCall("agent_browser_click", { ref: "e3" });
    const staged = gateBrowserCall({ root: base, actor: "agent", call, element: button("Save"), url: null, label: "Clicked Save" });
    if (staged.decision !== "staged") return;
    approveBrowserStep(base, staged.proposal.id);
    const doc = loadApprovals(base);
    const approval = doc.approvals[0]!;
    mkdirSync(join(base, "memory"), { recursive: true });
    writeFileSync(
      join(base, "memory", "browser-approvals.json"),
      JSON.stringify({ version: 1, approvals: [{ ...approval, expiresAt: new Date(Date.now() - 1000).toISOString() }] }, null, 2),
    );
    expect(gateBrowserCall({ root: base, actor: "agent", call, element: button("Save"), url: null, label: "Clicked Save" }).decision).toBe("staged");
  });

  it("approving a proposal that is not a browser step fails, and the waiting message names the proposal", () => {
    const base = root();
    const call = parseToolCall("agent_browser_click", { ref: "e3" });
    const staged = gateBrowserCall({ root: base, actor: "agent", call, element: button("Save"), url: null, label: "Clicked Save" });
    expect(staged.decision).toBe("staged");
    if (staged.decision !== "staged") return;
    expect(waitingMessage(staged.proposal)).toContain(staged.proposal.id);
    expect(waitingMessage(staged.proposal)).toContain("Clicked Save");
    expect(() => approveBrowserStep(base, "missing")).toThrow(MemoryNotesError);
    const note = stageProposal(base, {
      kind: "add-note",
      input: { path: "preferences/test", text: "A test note", sources: [{ chatId: "c1", messageId: "m1", quote: "A test note", at: "2026-11-25T10:00:00.000Z" }] },
      messages: [{ id: "m1", text: "A test note" }],
    }, "agent");
    expect(() => approveBrowserStep(base, note.id)).toThrow(MemoryNotesError);
    expect(listProposals(base).some((proposal) => proposal.id === note.id)).toBe(true);
  });
});

describe("gateBrowserMcpCall", () => {
  it("rejects an unknown method, lets tools/list through, and runs reads", () => {
    const base = root();
    const bad = gateBrowserMcpCall({ method: "tools/bogus", params: {}, root: base, actor: "owner", session: "s1" });
    expect(bad?.status).toBe(400);
    expect(bad?.body).toEqual({ error: "unsupported browser method" });
    expect(gateBrowserMcpCall({ method: "tools/list", params: {}, root: base, actor: "agent", session: "s1" })).toBeNull();
    expect(gateBrowserMcpCall({ method: "tools/call", params: { name: "agent_browser_snapshot", arguments: {} }, root: base, actor: "agent", session: "s1" })).toBeNull();
  });

  it("stages an agent commit as a 200 waiting response and refuses an unparseable call", () => {
    const base = root();
    const staged = gateBrowserMcpCall({ method: "tools/call", params: { name: "agent_browser_fill", arguments: { ref: "e1", text: "hello" } }, root: base, actor: "agent", session: "s2" });
    expect(staged?.status).toBe(200);
    expect(listProposals(base)).toHaveLength(1);
    const body = staged?.body as { result?: { content?: Array<{ text?: string }> } };
    expect(body.result?.content?.[0]?.text).toContain("approval");
    const bad = gateBrowserMcpCall({ method: "tools/call", params: { name: "agent_browser_frobnicate", arguments: {} }, root: base, actor: "owner", session: "s2" });
    expect(bad?.status).toBe(200);
    const badBody = bad?.body as { result?: { isError?: boolean } };
    expect(badBody.result?.isError).toBe(true);
    expect(listProposals(base)).toHaveLength(1);
  });
});
