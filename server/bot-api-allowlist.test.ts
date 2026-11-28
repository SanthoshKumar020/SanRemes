import { describe, expect, it } from "vitest";

import { isAllowedIp, parseAllowlist } from "./bot-api-allowlist.ts";

describe("isAllowedIp", () => {
  it("allows everything while the list is empty", () => {
    expect(isAllowedIp("203.0.113.5", [])).toBe(true);
    expect(isAllowedIp(undefined, [])).toBe(true);
  });

  it("matches exact addresses and IPv4 CIDR ranges", () => {
    const list = ["203.0.113.5", "198.51.100.0/24"];
    expect(isAllowedIp("203.0.113.5", list)).toBe(true);
    expect(isAllowedIp("203.0.113.6", list)).toBe(false);
    expect(isAllowedIp("198.51.100.200", list)).toBe(true);
    expect(isAllowedIp("198.51.101.1", list)).toBe(false);
  });

  it("treats an IPv4-mapped IPv6 address as its IPv4 form", () => {
    expect(isAllowedIp("::ffff:203.0.113.5", ["203.0.113.5"])).toBe(true);
    expect(isAllowedIp("::ffff:198.51.100.9", ["198.51.100.0/24"])).toBe(true);
  });

  it("matches IPv6 addresses exactly", () => {
    expect(isAllowedIp("2001:db8::1", ["2001:db8::1"])).toBe(true);
    expect(isAllowedIp("2001:db8::2", ["2001:db8::1"])).toBe(false);
  });

  it("refuses garbage addresses and never matches an invalid entry", () => {
    expect(isAllowedIp("not-an-ip", ["203.0.113.5"])).toBe(false);
    expect(isAllowedIp("203.0.113.5", ["203.0.113.0/33"])).toBe(false);
  });
});

describe("parseAllowlist", () => {
  it("accepts addresses and CIDR ranges, dedupes, trims", () => {
    expect(parseAllowlist(["203.0.113.5", " 198.51.100.0/24 ", "203.0.113.5"])).toEqual(["203.0.113.5", "198.51.100.0/24"]);
    expect(parseAllowlist([])).toEqual([]);
  });

  it("rejects anything that is not an address or an IPv4 CIDR range", () => {
    expect(parseAllowlist(["203.0.113.5/33"])).toBeNull();
    expect(parseAllowlist(["2001:db8::/32"])).toBeNull();
    expect(parseAllowlist(["not-an-ip"])).toBeNull();
    expect(parseAllowlist(["203.0.113.5", 42])).toBeNull();
    expect(parseAllowlist("203.0.113.5")).toBeNull();
  });
});
