import { describe, expect, it } from "vitest";

import { BLOCKED_CATEGORIES, blocklistMatch, blockedCategory, hostMatchesEntry, normalizeHost } from "./blocklist.ts";

describe("the high-risk blocklist", () => {
  it("covers each named category", () => {
    expect(BLOCKED_CATEGORIES).toEqual(["banking", "finance", "email-settings", "password-manager", "government-id"]);
    expect(blockedCategory("chase.com")).toBe("banking");
    expect(blockedCategory("fidelity.com")).toBe("finance");
    expect(blockedCategory("myaccount.google.com")).toBe("email-settings");
    expect(blockedCategory("1password.com")).toBe("password-manager");
    expect(blockedCategory("ssa.gov")).toBe("government-id");
    expect(blockedCategory("uidai.gov.in")).toBe("government-id");
  });

  it("matches a listed domain, its subdomains and www, but not a lookalike domain", () => {
    expect(hostMatchesEntry("login.chase.com", "chase.com")).toBe(true);
    expect(hostMatchesEntry("www.chase.com", "chase.com")).toBe(true);
    expect(hostMatchesEntry("notchase.com", "chase.com")).toBe(false);
    expect(hostMatchesEntry("chase.com.evil.example", "chase.com")).toBe(false);
    expect(normalizeHost("WWW.Chase.COM.")).toBe("chase.com");
  });

  it("matches an address to its entry and names the category", () => {
    expect(blocklistMatch("https://vault.bitwarden.com/#/login")).toEqual({ category: "password-manager", domain: "bitwarden.com", host: "vault.bitwarden.com" });
    expect(blocklistMatch("https://example.com/")).toBeNull();
  });

  it("matches nothing for other schemes and unparseable addresses", () => {
    expect(blocklistMatch("chrome://settings")).toBeNull();
    expect(blocklistMatch("file:///etc/passwd")).toBeNull();
    expect(blocklistMatch("not a url")).toBeNull();
  });

  it("takes extra entries without changing the defaults", () => {
    const custom = [{ domain: "example-bank.test", category: "banking" as const }];
    expect(blockedCategory("app.example-bank.test", custom)).toBe("banking");
    expect(blockedCategory("example-bank.test")).toBeNull();
  });
});
