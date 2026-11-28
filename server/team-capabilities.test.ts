import { describe, expect, it } from "vitest";

import { capabilityRefusal, may, roleOf, teamCapabilities, type AdminCapability } from "./team-capabilities.ts";
import type { RequestAuth } from "./request-auth.ts";

const ownerLoopback: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const serviceLoopback: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
const session = (teamRole: "owner" | "admin" | "member" | undefined, adminScope: boolean): RequestAuth => ({
  kind: "session",
  session: {
    id: "s1", label: "Person", createdAt: 0, expiresAt: 1, scopes: adminScope ? ["admin", "client"] : ["client"],
    ...(teamRole ? { teamRole } : {}),
  },
  via: "cookie",
  scopes: adminScope ? ["admin", "client"] : ["client"],
} as unknown as RequestAuth);

describe("team capabilities", () => {
  it("gives the owner everything, the admin read and export only, the member nothing", () => {
    expect(teamCapabilities("owner")).toEqual(["audit.read", "audit.export", "retention.change", "compliance.change", "motion.change"]);
    expect(teamCapabilities("admin")).toEqual(["audit.read", "audit.export"]);
    expect(teamCapabilities("member")).toEqual([]);
  });

  it("reads the role from the session, or from the admin scope when the Admin gave no role", () => {
    expect(roleOf(ownerLoopback)).toBe("owner");
    expect(roleOf(serviceLoopback)).toBe(null);
    expect(roleOf(session("owner", true))).toBe("owner");
    expect(roleOf(session("admin", true))).toBe("admin");
    expect(roleOf(session("member", false))).toBe("member");
    expect(roleOf(session(undefined, true))).toBe("owner");
    expect(roleOf(session(undefined, false))).toBe("member");
  });

  it("refuses a settings change to an admin in plain words, and a service loopback caller outright", () => {
    const change: AdminCapability = "retention.change";
    expect(may(session("admin", true), change)).toBe(false);
    expect(capabilityRefusal(session("admin", true), change)).toBe("Only the owner may do that.");
    expect(may(session("member", false), "audit.read")).toBe(false);
    expect(capabilityRefusal(session("member", false), "audit.read")).toBe("Only the owner or an admin may do that.");
    expect(may(serviceLoopback, "audit.read")).toBe(false);
    expect(may(ownerLoopback, change)).toBe(true);
    expect(capabilityRefusal(ownerLoopback, change)).toBe(null);
  });
});
