import { describe, expect, it } from "vitest";

import { describeShipCommand, parseShipCommand, shipCommandHelp } from "./commands.ts";

describe("parseShipCommand", () => {
  it("parses review with repo and number", () => {
    expect(parseShipCommand("/ship review octocat/hello-world#123")).toEqual(
      { action: "review", repo: "octocat/hello-world", number: 123, sessionId: null },
    );
  });

  it("parses review with a bare number", () => {
    expect(parseShipCommand("/ship review 42")).toEqual({ action: "review", repo: null, number: 42, sessionId: null });
  });

  it("parses approve and fix", () => {
    expect(parseShipCommand("/ship approve 7")).toEqual({ action: "approve", repo: null, number: 7, sessionId: null });
    expect(parseShipCommand("/ship fix session-1")).toEqual({ action: "fix", repo: null, number: null, sessionId: "session-1" });
  });

  it("parses policy and a bare /ship as help", () => {
    expect(parseShipCommand("/ship policy")!.action).toBe("policy");
    expect(parseShipCommand("/ship")!.action).toBe("help");
    expect(parseShipCommand("/ship frobnicate")!.action).toBe("help");
  });

  it("falls back to help when the review has no number", () => {
    expect(parseShipCommand("/ship review")!.action).toBe("help");
    expect(parseShipCommand("/ship review soon")!.action).toBe("help");
  });

  it("leaves anything else as ordinary text", () => {
    expect(parseShipCommand("please ship this")).toBeNull();
    expect(parseShipCommand("/shipping 12")).toBeNull();
    expect(parseShipCommand("")).toBeNull();
  });
});

describe("describeShipCommand", () => {
  it("states the review in plain words", () => {
    expect(describeShipCommand({ action: "review", repo: "octocat/hello-world", number: 123, sessionId: null }))
      .toBe("Reviewing pull request 123 in octocat/hello-world against the team policy.");
  });

  it("returns the help text for help", () => {
    expect(describeShipCommand({ action: "help", repo: null, number: null, sessionId: null })).toBe(shipCommandHelp());
    expect(shipCommandHelp()).toContain("/ship review");
    expect(shipCommandHelp()).toContain("only when the policy allows auto-approve");
  });
});
