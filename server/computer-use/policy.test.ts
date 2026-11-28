import { describe, expect, it } from "vitest";

import { classifyAction, decideAction, isSensitiveLabel } from "./policy.ts";

const page = "https://example.com/page";

describe("action sensitivity", () => {
  it("reads need nothing: view, screenshot, scroll and hover", () => {
    for (const kind of ["view", "screenshot", "scroll", "hover"] as const) {
      expect(classifyAction({ kind, url: page })).toBe("read");
    }
  });

  it("ordinary changes are actions: click, type, fill, select, check, drag, press and navigate", () => {
    for (const kind of ["click", "type", "fill", "select", "check", "drag", "press", "navigate"] as const) {
      expect(classifyAction({ kind, url: page })).toBe("act");
    }
  });

  it("evaluation, upload and accepting a dialog are always sensitive", () => {
    expect(classifyAction({ kind: "eval", url: page })).toBe("sensitive");
    expect(classifyAction({ kind: "upload", url: page })).toBe("sensitive");
    expect(classifyAction({ kind: "dialog", url: page, dialogAccept: true })).toBe("sensitive");
    expect(classifyAction({ kind: "dialog", url: page, dialogAccept: false })).toBe("act");
  });

  it("typing into a password field, or submitting a form, is sensitive", () => {
    expect(classifyAction({ kind: "type", url: page, fieldType: "password" })).toBe("sensitive");
    expect(classifyAction({ kind: "fill", url: page, fieldType: "text", fieldHints: ["card number"] })).toBe("sensitive");
    expect(classifyAction({ kind: "fill", url: page, fieldType: "text", submit: true })).toBe("sensitive");
    expect(classifyAction({ kind: "fill", url: page, fieldType: "text", fieldHints: ["first name"] })).toBe("act");
  });

  it("a click whose label names a consequential operation is sensitive", () => {
    expect(isSensitiveLabel("Pay now")).toBe(true);
    expect(isSensitiveLabel("Delete account")).toBe(true);
    expect(isSensitiveLabel("Next")).toBe(false);
    expect(classifyAction({ kind: "click", url: page, label: "Place order" })).toBe("sensitive");
    expect(classifyAction({ kind: "click", url: page, label: "Show more" })).toBe("act");
  });
});

describe("the policy decision", () => {
  it("lets reads through on an unlisted site with no permission", () => {
    expect(decideAction({ kind: "view", url: page }, "prompt").decision).toBe("allow");
    expect(decideAction({ kind: "screenshot", url: page }, "denied").decision).toBe("allow");
  });

  it("asks once per site for an ordinary change, then allows it once granted", () => {
    expect(decideAction({ kind: "click", url: page }, "prompt")).toMatchObject({ decision: "confirm", sensitivity: "act" });
    expect(decideAction({ kind: "click", url: page }, "granted").decision).toBe("allow");
    expect(decideAction({ kind: "click", url: page }, "denied")).toMatchObject({ decision: "deny", sensitivity: "act" });
  });

  it("never auto-approves a sensitive action, even on a granted site", () => {
    expect(decideAction({ kind: "eval", url: page }, "granted")).toMatchObject({ decision: "confirm", sensitivity: "sensitive" });
    expect(decideAction({ kind: "type", url: page, fieldType: "password" }, "granted")).toMatchObject({ decision: "confirm", sensitivity: "sensitive" });
    expect(decideAction({ kind: "click", url: page, label: "Buy now" }, "granted")).toMatchObject({ decision: "confirm", sensitivity: "sensitive" });
  });

  it("denies a blocked destination outright, whatever the permission says", () => {
    const verdict = decideAction({ kind: "view", url: "https://chase.com/accounts" }, "granted");
    expect(verdict).toMatchObject({ decision: "deny", blockedCategory: "banking" });
    expect(verdict.reason).toContain("chase.com");
    expect(decideAction({ kind: "click", url: "https://my.1password.com/", }, "granted").decision).toBe("deny");
  });

  it("denies navigation to non-http addresses and unusable addresses", () => {
    expect(decideAction({ kind: "navigate", url: "chrome://settings" }, "granted").decision).toBe("deny");
    expect(decideAction({ kind: "navigate", url: "file:///etc/passwd" }, "granted").decision).toBe("deny");
    expect(decideAction({ kind: "click", url: "://bad" }, "granted").decision).toBe("deny");
  });
});
