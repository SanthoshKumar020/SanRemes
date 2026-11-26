import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

import type { InstanceConfigMap, ModelSelection } from "./contracts.ts";
import { OLLAMA_PLACEHOLDER_KEY, probeOllama, type OllamaStatus } from "./drivers/ollama.ts";
import { addEndpoint, endpointDisplayUrl, isAddedEndpoint, type AddEndpoint } from "./openai-compat-endpoints.ts";

/** The model the packaged app installs first: small enough for 8 GB RAM, with native tool calling. */
export const LOCAL_QWEN_MODEL = "qwen3:4b";
export const LOCAL_QWEN_URL = "http://127.0.0.1:11434";

export type OllamaSetupState =
  | { state: "idle" }
  | { state: "starting" }
  | { state: "pulling"; percent: number }
  | { state: "ready"; instanceId: string }
  | { state: "failed"; error: string };

export interface OllamaSetupDeps {
  /** The packaged app's resources dir (SANREMES_RESOURCES_PATH); the bundled binary lives under it. */
  resourcesPath?: string;
  exists?: (path: string) => boolean;
  /** Find `ollama` on PATH; the default shells out to `where`/`which`. */
  findOnPath?: () => string | null;
  /** Start `ollama serve`; the default spawns it detached so it outlives the server. */
  startServer?: (exe: string) => ChildProcess;
  fetchImpl?: typeof fetch;
  probe?: (url: string) => Promise<OllamaStatus>;
  /** The saved provider instances, as the add-server route reads them. */
  instances: () => InstanceConfigMap;
  addInstance?: (instances: InstanceConfigMap, body: AddEndpoint) => { instanceId: string } | { error: string };
  /** Persist the new instance and load it into the registry, like the add-server route. */
  persist?: (instanceId: string, instances: InstanceConfigMap) => Promise<void>;
  /** The saved default model selection, if any. */
  defaultSelection: () => ModelSelection | null;
  /** Save the default model selection, like the settings save. */
  saveDefault?: (selection: ModelSelection) => void;
  onState?: (state: OllamaSetupState) => void;
  log?: (line: string) => void;
}

export type OllamaSetupResult =
  | { ok: true; instanceId: string; alreadyDefault?: boolean }
  | { ok: false; reason: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where the bundled binary is, on the platform that ships it; null elsewhere. Built with that platform's
 * separators, so the path is right even when this runs somewhere else. */
export function bundledOllamaExe(platform: string, resourcesPath: string | undefined, exists: (path: string) => boolean): string | null {
  if (platform !== "win32" || !resourcesPath) return null;
  const exe = win32.join(resourcesPath, "ollama", "ollama.exe");
  return exists(exe) ? exe : null;
}

function findOnPathDefault(): string | null {
  try {
    const command = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(command, ["ollama"], { encoding: "utf8", timeout: 10_000, windowsHide: true }).trim().split(/\r?\n/)[0]?.trim();
    return found ? found : null;
  } catch {
    return null;
  }
}

/** Pull a model through Ollama's API, reporting overall download progress; throws when the pull fails. */
export async function pullOllamaModel(
  url: string,
  model: string,
  fetchImpl: typeof fetch,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const response = await fetchImpl(`${url}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: model, stream: true }),
  });
  if (!response.ok || !response.body) throw new Error(`Ollama refused the ${model} download (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const layers = new Map<string, { completed: number; total: number }>();
  let buffer = "";
  let lastError: string | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: { status?: unknown; digest?: unknown; completed?: unknown; total?: unknown; error?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (typeof event.error === "string" && event.error) lastError = event.error;
      if (typeof event.digest === "string" && typeof event.completed === "number" && typeof event.total === "number" && event.total > 0) {
        layers.set(event.digest, { completed: event.completed, total: event.total });
        const doneBytes = [...layers.values()].reduce((sum, layer) => sum + layer.completed, 0);
        const allBytes = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0);
        onProgress?.(Math.min(100, Math.round((doneBytes / allBytes) * 100)));
      }
    }
  }
  if (lastError) throw new Error(lastError);
}

/** First-run local-model setup: make sure Ollama runs, pull Qwen, register it, and — only when no default is
 * saved yet — make it the default, so a fresh install opens on Qwen instead of Claude. A saved default is never
 * overridden, and any failure leaves the current default untouched. Never throws. */
export async function ensureLocalQwen(deps: OllamaSetupDeps): Promise<OllamaSetupResult> {
  const log = deps.log ?? (() => {});
  const onState = deps.onState ?? (() => {});
  const fetchImpl = deps.fetchImpl ?? fetch;
  const probe = deps.probe ?? probeOllama;
  const exists = deps.exists ?? existsSync;
  try {
    const saved = deps.defaultSelection();
    if (saved?.instanceId && saved.model === LOCAL_QWEN_MODEL) {
      onState({ state: "ready", instanceId: saved.instanceId });
      return { ok: true, instanceId: saved.instanceId, alreadyDefault: true };
    }
    const exe = bundledOllamaExe(process.platform, deps.resourcesPath, exists) ?? (deps.findOnPath ?? findOnPathDefault)();
    if (!exe) {
      const reason = "no Ollama binary is bundled with this install and none is on PATH";
      log(`local Qwen setup skipped: ${reason}`);
      onState({ state: "failed", error: reason });
      return { ok: false, reason };
    }
    let status = await probe(LOCAL_QWEN_URL);
    if (status.state === "not-running") {
      onState({ state: "starting" });
      log(`starting Ollama from ${exe}`);
      const start = deps.startServer ?? ((binary: string) => spawn(binary, ["serve"], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11434" } }));
      const child = start(exe);
      child.unref?.();
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await sleep(1_000);
        status = await probe(LOCAL_QWEN_URL);
        if (status.state !== "not-running") break;
      }
    }
    if (status.state === "unreachable") {
      const reason = `Ollama at ${LOCAL_QWEN_URL} did not answer: ${status.problem ?? "unreachable"}`;
      log(`local Qwen setup failed: ${reason}`);
      onState({ state: "failed", error: reason });
      return { ok: false, reason };
    }
    if (!status.models.some((model) => model.name === LOCAL_QWEN_MODEL)) {
      onState({ state: "pulling", percent: 0 });
      log(`downloading ${LOCAL_QWEN_MODEL} (about 2.5 GB)`);
      await pullOllamaModel(LOCAL_QWEN_URL, LOCAL_QWEN_MODEL, fetchImpl, (percent) => onState({ state: "pulling", percent }));
      status = await probe(LOCAL_QWEN_URL);
      if (!status.models.some((model) => model.name === LOCAL_QWEN_MODEL)) {
        const reason = `${LOCAL_QWEN_MODEL} did not appear after the download`;
        log(`local Qwen setup failed: ${reason}`);
        onState({ state: "failed", error: reason });
        return { ok: false, reason };
      }
    }
    const instances = deps.instances();
    const existingId = Object.entries(instances).find(
      ([id, entry]) => isAddedEndpoint(id, entry) && endpointDisplayUrl(entry.config) === LOCAL_QWEN_URL,
    )?.[0];
    let instanceId: string;
    if (existingId) {
      instanceId = existingId;
    } else {
      const added = (deps.addInstance ?? addEndpoint)(instances, { displayName: "Ollama", url: LOCAL_QWEN_URL, key: OLLAMA_PLACEHOLDER_KEY, catalog: "ollama" });
      if ("error" in added) {
        log(`local Qwen setup failed: ${added.error}`);
        onState({ state: "failed", error: added.error });
        return { ok: false, reason: added.error };
      }
      instanceId = added.instanceId;
      await deps.persist?.(instanceId, instances);
    }
    if (!saved?.instanceId && !saved?.model) {
      deps.saveDefault?.({ instanceId, model: LOCAL_QWEN_MODEL });
      log(`Qwen is now the default model (${instanceId})`);
    }
    onState({ state: "ready", instanceId });
    return { ok: true, instanceId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`local Qwen setup failed: ${reason}`);
    onState({ state: "failed", error: reason });
    return { ok: false, reason };
  }
}

/** First run on a packaged Windows install: start the bundled Ollama, pull Qwen and make it the default when
 * nothing is saved yet. It runs in the background and never blocks startup; a failure leaves the current
 * default alone. */
export function startLocalQwenSetup(deps: OllamaSetupDeps & { platform?: string; cloud?: boolean }): void {
  if (deps.platform !== "win32" || deps.cloud) return;
  void ensureLocalQwen(deps);
}

/** First run on a packaged Windows install, with the handoff to the bots: once Qwen is the saved default, the
 * bots still on the model the server picked at boot move to Qwen, so a fresh install opens on Qwen instead of
 * Claude. A bot the person pointed elsewhere keeps its model, and a default saved before this boot is never
 * moved. Progress goes to the log; a failure leaves the current default untouched. Every state also goes to
 * `onState`, and `changed` fires on each transition, so the app can show the install and open only once it is
 * done. */
export function startLocalQwenOnBoot(deps: OllamaSetupDeps & {
  platform?: string;
  cloud?: boolean;
  defaultAtBoot: ModelSelection | null;
  bootPick: () => ModelSelection;
  bots: () => readonly { id: string; modelSelection: ModelSelection }[];
  applyDefault: (id: string, selection: ModelSelection) => void;
  changed: () => void;
}): void {
  const log = deps.log ?? (() => {});
  let pullLogged = -1;
  startLocalQwenSetup({ ...deps, onState: (state) => {
    deps.onState?.(state);
    if (state.state === "pulling") {
      const band = Math.floor(state.percent / 25) * 25;
      if (band !== pullLogged) { pullLogged = band; log(`downloading Qwen ${state.percent}%`); deps.changed(); }
      return;
    }
    if (state.state === "starting" || state.state === "failed") { deps.changed(); return; }
    if (state.state !== "ready") return;
    if (!deps.defaultAtBoot) {
      const saved = deps.defaultSelection();
      if (saved?.model === LOCAL_QWEN_MODEL) {
        const ids = botsOnBootPick(deps.bots(), deps.bootPick());
        for (const id of ids) deps.applyDefault(id, saved);
        if (ids.length) log(`local Qwen is ready and is now the default for ${ids.length} bot(s)`);
      }
    }
    deps.changed();
  } });
}

/** Bots that never had a model of their own: no selection, or still the one the server picked at boot. */
export function botsOnBootPick(bots: readonly { id: string; modelSelection: ModelSelection }[], bootPick: ModelSelection): string[] {
  return bots.filter((bot) => (!bot.modelSelection.instanceId && !bot.modelSelection.model)
    || (bot.modelSelection.instanceId === bootPick.instanceId && bot.modelSelection.model === bootPick.model)).map((bot) => bot.id);
}
