import { describe, expect, it, vi } from "vitest";

import type { InstanceConfigMap } from "./contracts.ts";
import type { OllamaStatus } from "./drivers/ollama.ts";
import {
  botsOnBootPick,
  bundledOllamaExe,
  ensureLocalQwen,
  imageFromTasklist,
  LOCAL_QWEN_MODEL,
  LOCAL_QWEN_URL,
  portOwnerPidFromNetstat,
  pullOllamaModel,
  startLocalQwenOnBoot,
  startLocalQwenSetup,
  type OllamaSetupDeps,
  type OllamaSetupState,
} from "./ollama-setup.ts";

const status = (state: OllamaStatus["state"], models: string[] = []): OllamaStatus => ({
  state,
  url: LOCAL_QWEN_URL,
  models: models.map((name) => ({ name })),
});

function harness(overrides: Partial<OllamaSetupDeps> & { probes?: OllamaStatus[]; pullLines?: string[] } = {}) {
  const states: OllamaSetupState[] = [];
  const logs: string[] = [];
  const instances: InstanceConfigMap = {};
  const probeQueue = [...(overrides.probes ?? [status("ready", [LOCAL_QWEN_MODEL])])];
  const probe = vi.fn(async () => probeQueue.shift() ?? status("ready", [LOCAL_QWEN_MODEL]));
  const fetchImpl = vi.fn(async () => {
    const lines = overrides.pullLines ?? [`{"status":"pulling manifest"}`, `{"status":"success"}`];
    const stream = new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  });
  const persist = vi.fn(async () => {});
  const saveDefault = vi.fn(() => {});
  const startServer = vi.fn(() => ({ unref: () => {} }) as never);
  const findPortOwner = vi.fn(() => null);
  const killProcess = vi.fn(() => {});
  const deps: OllamaSetupDeps = {
    findOnPath: () => "/usr/bin/ollama",
    probe,
    fetchImpl,
    instances: () => instances,
    persist,
    defaultSelection: () => null,
    saveDefault,
    startServer,
    findPortOwner,
    killProcess,
    onState: (state) => states.push(state),
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, states, logs, instances, probe, fetchImpl, persist, saveDefault, startServer, findPortOwner, killProcess };
}

describe("bundledOllamaExe", () => {
  it("finds the bundled binary on Windows and nowhere else", () => {
    expect(bundledOllamaExe("win32", "C:\\SanRemes\\resources", () => true)).toBe("C:\\SanRemes\\resources\\ollama\\ollama.exe");
    expect(bundledOllamaExe("win32", "C:\\SanRemes\\resources", () => false)).toBeNull();
    expect(bundledOllamaExe("darwin", "/Applications/SanRemes.app/Contents/Resources", () => true)).toBeNull();
    expect(bundledOllamaExe("win32", undefined, () => true)).toBeNull();
  });
});

describe("botsOnBootPick", () => {
  const bootPick = { instanceId: "claude", model: "claude-sonnet-5" };
  const bot = (id: string, instanceId: string, model: string) => ({ id, modelSelection: { instanceId, model } });
  it("takes bots with no model and bots still on the boot pick, and leaves the rest alone", () => {
    expect(botsOnBootPick([
      bot("empty", "", ""),
      bot("boot", "claude", "claude-sonnet-5"),
      bot("other-model", "claude", "claude-opus-5"),
      bot("other-instance", "codex", "codex-default"),
    ], bootPick)).toEqual(["empty", "boot"]);
  });
});

describe("portOwnerPidFromNetstat", () => {
  const netstat = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:11434        0.0.0.0:0              LISTENING       4242",
    "  TCP    127.0.0.1:11434        127.0.0.1:50000        ESTABLISHED     4242",
    "  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       7777",
    "  TCP    0.0.0.0:11434          0.0.0.0:0              LISTENING       5151",
  ].join("\r\n");
  it("finds the listener on the loopback port and ignores established connections and other ports", () => {
    expect(portOwnerPidFromNetstat(netstat, 11434)).toBe(4242);
    expect(portOwnerPidFromNetstat(netstat, 8080)).toBe(7777);
    expect(portOwnerPidFromNetstat(netstat, 9999)).toBeNull();
  });
  it("finds a listener bound to all interfaces", () => {
    expect(portOwnerPidFromNetstat("  TCP    0.0.0.0:11434          0.0.0.0:0              LISTENING       5151\r\n", 11434)).toBe(5151);
  });
});

describe("imageFromTasklist", () => {
  it("reads the image name from the first CSV row and nothing from an empty result", () => {
    expect(imageFromTasklist(`"ollama.exe","4242","Console","1","45,204 K"\r\n`)).toBe("ollama.exe");
    expect(imageFromTasklist("INFO: No tasks are running which match the specified criteria.\r\n")).toBeNull();
  });
});

describe("ensureLocalQwen", () => {
  it("saves the default before reporting ready", async () => {
    const order: string[] = [];
    const { deps } = harness({
      saveDefault: () => { order.push("saved"); },
      onState: (state) => { order.push(state.state); },
    });
    await ensureLocalQwen(deps);
    expect(order).toContain("saved");
    expect(order.indexOf("saved")).toBeLessThan(order.indexOf("ready"));
  });

  it("does nothing when Qwen is already the default", async () => {
    const { deps, states, probe, saveDefault } = harness({ defaultSelection: () => ({ instanceId: "openai-compat-x", model: LOCAL_QWEN_MODEL }) });
    const result = await ensureLocalQwen(deps);
    expect(result).toEqual({ ok: true, instanceId: "openai-compat-x", alreadyDefault: true });
    expect(probe).not.toHaveBeenCalled();
    expect(saveDefault).not.toHaveBeenCalled();
    expect(states).toEqual([{ state: "ready", instanceId: "openai-compat-x" }]);
  });

  it("reports unavailable when there is no Ollama binary", async () => {
    const { deps, states } = harness({ findOnPath: () => null, resourcesPath: undefined });
    const result = await ensureLocalQwen(deps);
    expect(result.ok).toBe(false);
    expect(states.at(-1)).toMatchObject({ state: "failed" });
  });

  it("registers Ollama and saves Qwen as the default when the model is already pulled", async () => {
    const { deps, states, persist, saveDefault } = harness();
    const result = await ensureLocalQwen(deps);
    expect(result.ok).toBe(true);
    const instanceId = (result as { instanceId: string }).instanceId;
    expect(instanceId.startsWith("openai-compat-")).toBe(true);
    expect(persist).toHaveBeenCalledWith(instanceId, expect.anything());
    expect(saveDefault).toHaveBeenCalledWith({ instanceId, model: LOCAL_QWEN_MODEL });
    expect(states.at(-1)).toEqual({ state: "ready", instanceId });
  });

  it("pulls the model first when Ollama has none, reporting progress", async () => {
    const lines = [
      `{"status":"pulling a","digest":"sha256:a","total":100,"completed":50}`,
      `{"status":"pulling a","digest":"sha256:a","total":100,"completed":100}`,
      `{"status":"pulling b","digest":"sha256:b","total":100,"completed":50}`,
      `{"status":"success"}`,
    ];
    const { deps, states, fetchImpl } = harness({
      probes: [status("no-models"), status("ready", [LOCAL_QWEN_MODEL])],
      pullLines: lines,
    });
    const result = await ensureLocalQwen(deps);
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${LOCAL_QWEN_URL}/api/pull`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: LOCAL_QWEN_MODEL, stream: true }) }),
    );
    const pulling = states.filter((state) => state.state === "pulling");
    expect(pulling.map((state) => (state as { percent: number }).percent)).toEqual([0, 50, 100, 75]);
  });

  it("starts Ollama when nothing listens, then carries on", async () => {
    const { deps, startServer, probe } = harness({ probes: [status("not-running"), status("ready", [LOCAL_QWEN_MODEL])] });
    const result = await ensureLocalQwen(deps);
    expect(result.ok).toBe(true);
    expect(startServer).toHaveBeenCalledWith("/usr/bin/ollama");
    expect(probe.mock.calls.length).toBeGreaterThan(1);
  });

  it("replaces a stale Ollama holding the port, killing it before the fresh spawn", async () => {
    const order: string[] = [];
    const killProcess = vi.fn(() => { order.push("killed"); });
    const startServer = vi.fn(() => { order.push("started"); return { unref: () => {} }; }) as never;
    const { deps, logs } = harness({
      probes: [status("unreachable"), status("not-running"), status("ready", [LOCAL_QWEN_MODEL])],
      startupWaitMs: 2500,
      findPortOwner: () => ({ pid: 4242, image: "Ollama.EXE" }),
      killProcess,
      startServer,
    });
    const result = await ensureLocalQwen(deps);
    expect(result.ok).toBe(true);
    expect(order).toEqual(["killed", "started"]);
    expect(killProcess).toHaveBeenCalledWith(4242);
    expect(startServer).toHaveBeenCalledWith("/usr/bin/ollama");
    expect(logs.join("\n")).toContain("stale Ollama (PID 4242)");
  });

  it("replaces a wedged Ollama from the fresh spawn too", async () => {
    const order: string[] = [];
    const killProcess = vi.fn(() => { order.push("killed"); });
    const startServer = vi.fn(() => { order.push("started"); return { unref: () => {} }; }) as never;
    const { deps } = harness({
      probes: [status("not-running"), status("unreachable"), status("ready", [LOCAL_QWEN_MODEL])],
      startupWaitMs: 2500,
      findPortOwner: () => ({ pid: 4242, image: "ollama.exe" }),
      killProcess,
      startServer,
    });
    const result = await ensureLocalQwen(deps);
    expect(result.ok).toBe(true);
    expect(order).toEqual(["started", "killed", "started"]);
    expect(killProcess).toHaveBeenCalledTimes(1);
  });

  it("fails when Ollama still does not answer after the replacement, trying the replacement once", async () => {
    const killProcess = vi.fn(() => {});
    const findPortOwner = vi.fn(() => ({ pid: 4242, image: "ollama.exe" }));
    const { deps, startServer } = harness({
      probe: vi.fn(async () => status("unreachable")),
      startupWaitMs: 2500,
      findPortOwner,
      killProcess,
    });
    const result = await ensureLocalQwen(deps);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("did not answer");
    expect(findPortOwner).toHaveBeenCalledTimes(1);
    expect(killProcess).toHaveBeenCalledTimes(1);
    expect(startServer).toHaveBeenCalledTimes(1);
  });

  it("does not kill a process that is not Ollama", async () => {
    const killProcess = vi.fn(() => {});
    const startServer = vi.fn(() => ({ unref: () => {} }) as never);
    const { deps, logs } = harness({
      probes: [status("unreachable")],
      findPortOwner: () => ({ pid: 9999, image: "node.exe" }),
      killProcess,
      startServer,
    });
    const result = await ensureLocalQwen(deps);
    expect(result.ok).toBe(false);
    expect(killProcess).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("node.exe (PID 9999)");
  });

  it("fails without killing when nothing holds the port", async () => {
    const { deps, killProcess, startServer } = harness({ probes: [status("unreachable")] });
    const result = await ensureLocalQwen(deps);
    expect(result.ok).toBe(false);
    expect(killProcess).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
  });

  it("a failed pull leaves the default untouched", async () => {
    const { deps, saveDefault } = harness({
      probes: [status("no-models"), status("no-models")],
      pullLines: [`{"error":"out of disk"}`],
    });
    const result = await ensureLocalQwen(deps);
    expect(result.ok).toBe(false);
    expect(saveDefault).not.toHaveBeenCalled();
  });

  it("never overrides a saved default", async () => {
    const { deps, saveDefault } = harness({ defaultSelection: () => ({ instanceId: "claude", model: "claude-sonnet-5" }) });
    const result = await ensureLocalQwen(deps);
    expect(result.ok).toBe(true);
    expect(saveDefault).not.toHaveBeenCalled();
  });

  it("reuses an already-added Ollama engine instead of adding another", async () => {
    const { deps, instances } = harness();
    instances["openai-compat-existing"] = {
      driver: "openai-compat",
      displayName: "Ollama",
      access: "api",
      config: { key: "ollama", url: LOCAL_QWEN_URL, catalog: "ollama" },
    };
    const result = await ensureLocalQwen(deps);
    expect(result).toEqual({ ok: true, instanceId: "openai-compat-existing" });
    expect(Object.keys(instances)).toEqual(["openai-compat-existing"]);
  });
});

describe("startLocalQwenSetup", () => {
  it("does nothing off Windows", async () => {
    const { deps, probe, saveDefault } = harness();
    startLocalQwenSetup({ ...deps, platform: "darwin" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(probe).not.toHaveBeenCalled();
    expect(saveDefault).not.toHaveBeenCalled();
  });

  it("does nothing on a cloud host", async () => {
    const { deps, probe, saveDefault } = harness();
    startLocalQwenSetup({ ...deps, platform: "win32", cloud: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(probe).not.toHaveBeenCalled();
    expect(saveDefault).not.toHaveBeenCalled();
  });

  it("runs the setup on a packaged Windows install", async () => {
    const { deps, saveDefault } = harness();
    startLocalQwenSetup({ ...deps, platform: "win32" });
    await vi.waitFor(() => expect(saveDefault).toHaveBeenCalledWith(expect.objectContaining({ model: LOCAL_QWEN_MODEL })));
  });
});

describe("startLocalQwenOnBoot", () => {
  it("moves bots still on the boot pick to Qwen once it is the default", async () => {
    const { deps } = harness();
    const applied: string[] = [];
    const changed = vi.fn();
    const saved: { instanceId: string; model: string } = { instanceId: "", model: "" };
    startLocalQwenOnBoot({
      ...deps,
      platform: "win32",
      defaultAtBoot: null,
      bootPick: () => ({ instanceId: "claude", model: "claude-sonnet-5" }),
      bots: () => [
        { id: "boot", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } },
        { id: "other", modelSelection: { instanceId: "codex", model: "codex-default" } },
      ],
      applyDefault: (id) => { applied.push(id); },
      changed,
      saveDefault: (selection) => { Object.assign(saved, selection); },
      defaultSelection: () => (saved.model ? saved : null),
    });
    await vi.waitFor(() => expect(applied).toEqual(["boot"]));
    expect(changed).toHaveBeenCalled();
  });

  it("leaves bots alone when a default was already saved before this boot", async () => {
    const { deps, states, saveDefault } = harness();
    const applied: string[] = [];
    const changed = vi.fn();
    startLocalQwenOnBoot({
      ...deps,
      platform: "win32",
      defaultAtBoot: { instanceId: "claude", model: "claude-sonnet-5" },
      bootPick: () => ({ instanceId: "claude", model: "claude-sonnet-5" }),
      bots: () => [{ id: "boot", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }],
      applyDefault: (id) => { applied.push(id); },
      changed,
    });
    await vi.waitFor(() => expect(saveDefault).toHaveBeenCalled());
    expect(applied).toEqual([]);
    expect(states.at(-1)?.state).toBe("ready");
    expect(changed).toHaveBeenCalled();
  });

  it("broadcasts a failure so the app can show it", async () => {
    const { deps, states } = harness({ probes: [status("unreachable")] });
    const applied: string[] = [];
    const changed = vi.fn();
    startLocalQwenOnBoot({
      ...deps,
      platform: "win32",
      defaultAtBoot: null,
      bootPick: () => ({ instanceId: "claude", model: "claude-sonnet-5" }),
      bots: () => [{ id: "boot", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }],
      applyDefault: (id) => { applied.push(id); },
      changed,
    });
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ state: "failed" }));
    expect(applied).toEqual([]);
    expect(changed).toHaveBeenCalled();
  });

  it("reports pull progress so the app can show it", async () => {
    const { deps, states } = harness({
      probes: [status("ready", []), status("ready", [LOCAL_QWEN_MODEL])],
      pullLines: [`{"status":"Pulling","digest":"sha256:a","total":100,"completed":25}`, `{"status":"success"}`],
    });
    const changed = vi.fn();
    startLocalQwenOnBoot({
      ...deps,
      platform: "win32",
      defaultAtBoot: null,
      bootPick: () => ({ instanceId: "claude", model: "claude-sonnet-5" }),
      bots: () => [],
      applyDefault: () => {},
      changed,
    });
    await vi.waitFor(() => expect(states).toContainEqual({ state: "pulling", percent: 25 }));
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe("ready"));
    expect(changed).toHaveBeenCalled();
  });
});

describe("pullOllamaModel", () => {
  it("throws on a pull error event", async () => {
    const fetchImpl = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"error":"no space left"}\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(pullOllamaModel(LOCAL_QWEN_URL, LOCAL_QWEN_MODEL, fetchImpl)).rejects.toThrow("no space left");
  });
});
