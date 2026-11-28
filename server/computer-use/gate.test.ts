import { describe, expect, it } from "vitest";

import { GATE_HISTORY_LIMIT, PENDING_CONFIRMATION_TTL_MS, ComputerUseGate } from "./gate.ts";
import { ComputerUsePermissions } from "./permissions.ts";

const page = "https://example.com/page";

describe("the action gate", () => {
  it("lets a read through with no confirmer wired up", async () => {
    const gate = new ComputerUseGate(new ComputerUsePermissions());
    await expect(gate.request({ kind: "view", url: page })).resolves.toMatchObject({ allowed: true, confirmed: false });
    expect(gate.check({ kind: "view", url: page })).toMatchObject({ decision: "allow" });
  });

  it("lets an ordinary change through once the site is granted, and denies it once denied", async () => {
    const permissions = new ComputerUsePermissions();
    permissions.grant(page);
    const gate = new ComputerUseGate(permissions);
    await expect(gate.request({ kind: "click", url: page })).resolves.toMatchObject({ allowed: true, confirmed: false });
    permissions.deny(page);
    await expect(gate.request({ kind: "click", url: page })).resolves.toMatchObject({ allowed: false, confirmed: false });
  });

  it("denies anything needing confirmation when no confirmer is wired up", async () => {
    const gate = new ComputerUseGate(new ComputerUsePermissions());
    const outcome = await gate.request({ kind: "click", url: page });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toContain("no confirmation prompt is wired up");
  });

  it("denies a blocked destination even when the confirmer would approve", async () => {
    const permissions = new ComputerUsePermissions();
    permissions.grant("https://chase.com/");
    const gate = new ComputerUseGate(permissions, async () => true);
    await expect(gate.request({ kind: "view", url: "https://chase.com/accounts" })).resolves.toMatchObject({ allowed: false });
    expect(gate.check({ kind: "view", url: "https://chase.com/accounts" })).toMatchObject({ decision: "deny" });
  });

  it("runs a sensitive action only when the confirmer approves that exact action", async () => {
    const seen: string[] = [];
    const gate = new ComputerUseGate(new ComputerUsePermissions(), async (request) => {
      seen.push(request.action.kind);
      return request.action.kind === "eval";
    });
    await expect(gate.request({ kind: "eval", url: page })).resolves.toMatchObject({ allowed: true, confirmed: true });
    expect(seen).toEqual(["eval"]);
    await expect(gate.request({ kind: "upload", url: page })).resolves.toMatchObject({ allowed: false, confirmed: false });
    const history = gate.history();
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ kind: "eval", decision: "allow", confirmed: true });
    expect(history[1]).toMatchObject({ kind: "upload", decision: "deny", confirmed: false });
  });

  it("treats a confirmer that throws as a decline, not an approval", async () => {
    const gate = new ComputerUseGate(new ComputerUsePermissions(), async () => {
      throw new Error("prompt crashed");
    });
    await expect(gate.request({ kind: "eval", url: page })).resolves.toMatchObject({ allowed: false, confirmed: false });
  });

  it("never stores a confirmation as a site permission", async () => {
    const permissions = new ComputerUsePermissions();
    const gate = new ComputerUseGate(permissions, async () => true);
    await gate.request({ kind: "eval", url: page });
    expect(permissions.status(page)).toBe("prompt");
    expect(gate.check({ kind: "click", url: page }).decision).toBe("confirm");
  });

  it("answers a pending confirmation later, and settles an expired one as declined", async () => {
    const gate = new ComputerUseGate(new ComputerUsePermissions());
    const { request, decided } = gate.ask({ kind: "eval", url: page }, "needs confirmation", 1_000);
    expect(gate.pending(1_000)).toHaveLength(1);
    expect(gate.resolve("cu-99", true, 1_000)).toBe(false);
    expect(gate.resolve(request.id, true, 1_000)).toBe(true);
    await expect(decided).resolves.toBe(true);
    expect(gate.pending(1_000)).toEqual([]);
    const { decided: stale } = gate.ask({ kind: "eval", url: page }, "needs confirmation", 1_000);
    expect(gate.pending(1_000 + PENDING_CONFIRMATION_TTL_MS)).toEqual([]);
    await expect(stale).resolves.toBe(false);
  });

  it("keeps only the most recent decisions", async () => {
    const gate = new ComputerUseGate(new ComputerUsePermissions());
    for (let i = 0; i < GATE_HISTORY_LIMIT + 5; i++) await gate.request({ kind: "view", url: `${page}?n=${i}` });
    expect(gate.history()).toHaveLength(GATE_HISTORY_LIMIT);
    expect(gate.history()[0]?.url).toBe(`${page}?n=5`);
  });
});
