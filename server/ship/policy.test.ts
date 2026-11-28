import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultShipPolicy, ShipPolicyStore, validateShipPolicy } from "./policy.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sanremes-ship-policy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("defaultShipPolicy", () => {
  it("approves and merges nothing on its own", () => {
    expect(defaultShipPolicy()).toEqual({
      version: 1, autoApprove: false, autoMerge: false, requiredChecks: [], forbiddenPatterns: [], styleRules: [],
    });
  });
});

describe("validateShipPolicy", () => {
  it("accepts a policy that turns auto-approve on", () => {
    const policy = validateShipPolicy({ ...defaultShipPolicy(), autoApprove: true, requiredChecks: ["lint"] });
    expect(policy.autoApprove).toBe(true);
    expect(policy.requiredChecks).toEqual(["lint"]);
  });

  it("refuses auto-merge without auto-approve", () => {
    expect(() => validateShipPolicy({ ...defaultShipPolicy(), autoMerge: true })).toThrow("Auto-merge needs auto-approve");
  });

  it("refuses a pattern that is not a valid regular expression", () => {
    expect(() => validateShipPolicy({
      ...defaultShipPolicy(),
      forbiddenPatterns: [{ pattern: "([", message: "bad" }],
    })).toThrow("not a valid pattern");
  });

  it("refuses the wrong shape in plain words", () => {
    expect(() => validateShipPolicy({ autoApprove: "yes" })).toThrow("does not fit the expected shape");
  });
});

describe("ShipPolicyStore", () => {
  it("starts on the default policy and round-trips a saved one", () => {
    const store = new ShipPolicyStore({ dataDir: dir });
    expect(store.get()).toEqual(defaultShipPolicy());
    const saved = store.save({ ...defaultShipPolicy(), autoApprove: true, requiredChecks: ["tests"] });
    expect(saved.requiredChecks).toEqual(["tests"]);
    expect(new ShipPolicyStore({ dataDir: dir }).get()).toEqual(saved);
  });
});
