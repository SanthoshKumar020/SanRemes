import { describe, expect, it, vi } from "vitest";

import type { InstanceConfigMap } from "./contracts.ts";
import type { OllamaStatus } from "./drivers/ollama.ts";
import {
  botsOnBootPick,
  bundledOllamaExe,
  ensureLocalQwen,
  LOCAL_QWEN_MODEL,
  LOCAL_QWEN_URL,
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
  const deps: OllamaSetupDeps = {
    findOnPath: () => "/usr/bin/ollama",
    probe,
    fetchImpl,
    instances: () => instances,
    persist,
    defaultSelection: () => null,
    saveDefault,
    startServer,
    onState: (state) => states.push(state),
    ...overrides,
  };
  return { deps, states, instances, probe, fetchImpl, persist, saveDefault, startServer };
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
    const { deps, saveDefault } = harness();
    const applied: string[] = [];
    startLocalQwenOnBoot({
      ...deps,
      platform: "win32",
      defaultAtBoot: { instanceId: "claude", model: "claude-sonnet-5" },
      bootPick: () => ({ instanceId: "claude", model: "claude-sonnet-5" }),
      bots: () => [{ id: "boot", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }],
      applyDefault: (id) => { applied.push(id); },
      changed: () => {},
    });
    await vi.waitFor(() => expect(saveDefault).toHaveBeenCalled());
    expect(applied).toEqual([]);
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
