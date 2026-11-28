import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.ts";
import type { BotRecord } from "../store.ts";
import { VpsHostUnreachableError } from "../vps-command.ts";
import { vpsContainerName } from "../vps-computer.ts";
import { createVpsAttachRoutes, verifyVps, type VpsAttachRouteDeps } from "./vps-attach.ts";
import type { RouteContext } from "./table.ts";

type RunnerResult = { stdout: string; stderr: string };

function fakeStore(bots: BotRecord[]) {
  const patched: Array<{ id: string; patch: Partial<BotRecord> }> = [];
  return {
    patched,
    store: {
      bot: (id: string) => bots.find((bot) => bot.id === id) ?? null,
      patchBot: (id: string, patch: Partial<BotRecord>) => {
        patched.push({ id, patch });
        const bot = bots.find((one) => one.id === id);
        if (bot) Object.assign(bot, patch);
        return bot ?? null;
      },
    } satisfies VpsAttachRouteDeps["store"],
  };
}

function bot(partial: Partial<BotRecord> & { id: string; name: string }): BotRecord {
  return { vpsAlias: undefined, cloudBackend: "box", busy: false, ...partial } as BotRecord;
}

function serve(deps: VpsAttachRouteDeps) {
  const route = createVpsAttachRoutes(deps);
  const call = async (path: string, body: unknown) => {
    const sent: { status?: number; body?: unknown } = {};
    await route({
      req: { headers: { "content-type": "application/json" } } as never, res: {} as never,
      url: new URL(path, "http://127.0.0.1"), path, method: "POST",
      auth: { kind: "loopback", scopes: ["admin"] } as never, readBody: (async () => body) as RouteContext["readBody"],
      json: ((_res: never, status: number, value: unknown) => { sent.status = status; sent.body = value; }) as RouteContext["json"],
    });
    return sent;
  };
  return { call };
}

const cfg = { vps: {} } as AppConfig;
const okRunner = async (): Promise<RunnerResult> => ({ stdout: "Server Version: 27.0.0\n", stderr: "" });

describe("verifyVps", () => {
  it("reports the daemon answering, unreachable, and Docker refusing in plain words", async () => {
    expect(await verifyVps(okRunner, "my-vps")).toMatchObject({ ok: true, stage: "ok" });
    const unreachable = await verifyVps(async () => { throw new VpsHostUnreachableError("ssh: connect to host"); }, "my-vps");
    expect(unreachable).toMatchObject({ ok: false, stage: "unreachable" });
    expect(unreachable.message).toContain("ssh my-vps true");
    const refused = await verifyVps(async () => { throw new Error("permission denied while trying to connect to the Docker daemon"); }, "my-vps");
    expect(refused).toMatchObject({ ok: false, stage: "docker" });
    expect(refused.message).toContain("but Docker there refused");
  });
});

describe("POST /api/vps/attach", () => {
  it("verifies first, then points the bot at the server", async () => {
    const { store, patched } = fakeStore([bot({ id: "scout", name: "Scout" })]);
    const { call } = serve({ store, cfg, run: okRunner });
    const attached = await call("/api/vps/attach", { botId: "scout", alias: "my-vps" });
    expect(attached.status).toBe(200);
    expect(attached.body).toMatchObject({ botId: "scout", alias: "my-vps" });
    expect(patched).toEqual([{ id: "scout", patch: { vpsAlias: "my-vps", cloudBackend: "vps" } }]);
    const again = await call("/api/vps/attach", { botId: "scout", alias: "my-vps" });
    expect(again.status).toBe(200);
  });

  it("refuses an unreachable server, a busy bot, and a bot already on another server", async () => {
    const { store } = fakeStore([bot({ id: "scout", name: "Scout" }), bot({ id: "busy-bot", name: "Busy", busy: true })]);
    const { call } = serve({ store, cfg, run: async () => { throw new VpsHostUnreachableError("no route to host"); } });
    const down = await call("/api/vps/attach", { botId: "scout", alias: "my-vps" });
    expect(down.status).toBe(409);
    expect(down.body).toMatchObject({ stage: "unreachable" });
    const busy = await call("/api/vps/attach", { botId: "busy-bot", alias: "my-vps" });
    expect(busy.status).toBe(409);
    expect((busy.body as { error: string }).error).toContain("Stop Busy's turn");
    expect((await call("/api/vps/attach", { botId: "ghost", alias: "my-vps" })).status).toBe(404);
    expect((await call("/api/vps/attach", { botId: "scout", alias: "not an alias!" })).status).toBe(400);
    const { store: movedStore } = fakeStore([bot({ id: "scout", name: "Scout", vpsAlias: "other-vps", cloudBackend: "vps" })]);
    const moved = serve({ store: movedStore, cfg, run: okRunner });
    const second = await moved.call("/api/vps/attach", { botId: "scout", alias: "my-vps" });
    expect(second.status).toBe(409);
    expect((second.body as { error: string }).error).toContain("already attached to other-vps");
  });
});

describe("POST /api/vps/detach", () => {
  it("detaches when no computer lives on the server", async () => {
    const { store, patched } = fakeStore([bot({ id: "scout", name: "Scout", vpsAlias: "my-vps", cloudBackend: "vps" })]);
    const { call } = serve({ store, cfg, run: async () => ({ stdout: "\n", stderr: "" }) });
    const detached = await call("/api/vps/detach", { botId: "scout" });
    expect(detached.status).toBe(200);
    expect(detached.body).toMatchObject({ detached: true, alias: "my-vps" });
    expect(patched).toEqual([{ id: "scout", patch: { vpsAlias: undefined, cloudBackend: "box" } }]);
  });

  it("refuses while the bot's computer still lives on the server, naming the removal command", async () => {
    const { store } = fakeStore([bot({ id: "scout", name: "Scout", vpsAlias: "my-vps", cloudBackend: "vps" })]);
    const container = vpsContainerName("scout");
    const { call } = serve({
      store, cfg,
      run: async () => ({ stdout: `${container}\n`, stderr: "" }),
    });
    const refused = await call("/api/vps/detach", { botId: "scout" });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toContain(`Remove it first: docker -H ssh://my-vps rm -f ${container}`);
    expect((refused.body as { container: string }).container).toBe(container);
  });

  it("detaches anyway when the server cannot be reached, saying what may be left there", async () => {
    const { store, patched } = fakeStore([bot({ id: "scout", name: "Scout", vpsAlias: "my-vps", cloudBackend: "vps" })]);
    const { call } = serve({ store, cfg, run: async () => { throw new VpsHostUnreachableError("no route to host"); } });
    const detached = await call("/api/vps/detach", { botId: "scout" });
    expect(detached.status).toBe(200);
    expect(detached.body).toMatchObject({ detached: true });
    expect((detached.body as { leftBehind: string }).leftBehind).toContain("docker -H ssh://my-vps rm -f");
    expect(patched).toHaveLength(1);
  });

  it("says plainly when the bot is not attached to any server", async () => {
    const { store } = fakeStore([bot({ id: "scout", name: "Scout" })]);
    const { call } = serve({ store, cfg: { vps: {} } as AppConfig, run: okRunner });
    const detached = await call("/api/vps/detach", { botId: "scout" });
    expect(detached.status).toBe(200);
    expect(detached.body).toMatchObject({ detached: false });
  });
});

describe("POST /api/vps/verify", () => {
  it("checks an alias without moving any bot", async () => {
    const { store } = fakeStore([]);
    const { call } = serve({ store, cfg, run: okRunner });
    expect((await call("/api/vps/verify", { alias: "my-vps" })).body).toMatchObject({ ok: true, stage: "ok" });
    expect((await call("/api/vps/verify", { alias: "bad alias!" })).status).toBe(400);
  });
});
