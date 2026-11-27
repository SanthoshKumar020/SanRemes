import { describe, expect, it } from "vitest";

import {
  DEFAULT_DECISION_RETENTION_DAYS,
  decisionRetentionDays,
  parseRetentionDays,
  resolveRetentionDays,
} from "./decision-log.ts";

describe("parseRetentionDays", () => {
  it("accepts whole days from 1 to 3650", () => {
    expect(parseRetentionDays(1)).toBe(1);
    expect(parseRetentionDays(180)).toBe(180);
    expect(parseRetentionDays(3650)).toBe(3650);
  });

  it("rejects fractions, out-of-range values and non-numbers", () => {
    expect(parseRetentionDays(0)).toBeNull();
    expect(parseRetentionDays(3651)).toBeNull();
    expect(parseRetentionDays(1.5)).toBeNull();
    expect(parseRetentionDays("180")).toBeNull();
    expect(parseRetentionDays(undefined)).toBeNull();
    expect(parseRetentionDays(Number.NaN)).toBeNull();
  });
});

describe("resolveRetentionDays", () => {
  it("takes the environment over config, then config over the 180-day default", () => {
    expect(resolveRetentionDays(90, "SANREMES_DECISION_RETENTION_DAYS", {})).toEqual({ days: 90, source: "config" });
    expect(resolveRetentionDays(90, "SANREMES_DECISION_RETENTION_DAYS", { SANREMES_DECISION_RETENTION_DAYS: "30" })).toEqual({ days: 30, source: "env" });
    expect(resolveRetentionDays(undefined, "SANREMES_DECISION_RETENTION_DAYS", {})).toEqual({ days: DEFAULT_DECISION_RETENTION_DAYS, source: "default" });
  });

  it("ignores an invalid environment value and falls back to config", () => {
    expect(resolveRetentionDays(90, "SANREMES_DECISION_RETENTION_DAYS", { SANREMES_DECISION_RETENTION_DAYS: "never" })).toEqual({ days: 90, source: "config" });
    expect(resolveRetentionDays(90, "SANREMES_DECISION_RETENTION_DAYS", { SANREMES_DECISION_RETENTION_DAYS: "0" })).toEqual({ days: 90, source: "config" });
  });

  it("keeps decisionRetentionDays on the same precedence", () => {
    expect(decisionRetentionDays(90, { SANREMES_DECISION_RETENTION_DAYS: "30" })).toBe(30);
    expect(decisionRetentionDays(90, {})).toBe(90);
    expect(decisionRetentionDays(undefined, {})).toBe(DEFAULT_DECISION_RETENTION_DAYS);
  });
});
