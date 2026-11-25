// Windows Ollama smoke: the staged CPU-only bundle starts a server and
// answers /api/version. Run it after `pnpm build:ollama:win`.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32") {
  console.error("smoke-ollama-win is Windows-only");
  process.exit(1);
}

const stage = join(import.meta.dirname, "..", "dist-native", "ollama-win32-x64");
const binary = join(stage, "ollama.exe");

for (const [label, file] of [
  ["ollama.exe", binary],
  ["ggml-base.dll", join(stage, "lib", "ollama", "ggml-base.dll")],
  ["libllama.dll", join(stage, "lib", "ollama", "libllama.dll")],
]) {
  if (!existsSync(file)) {
    console.error(`staged ${label} is missing at ${file} — run pnpm build:ollama:win first`);
    process.exit(1);
  }
}

const cpuRunners = readdirSync(join(stage, "lib", "ollama")).filter((name) => name.startsWith("ggml-cpu-"));
if (cpuRunners.length === 0) {
  console.error("staged lib/ollama holds no ggml-cpu-*.dll runner — re-run pnpm build:ollama:win");
  process.exit(1);
}
for (const excluded of ["cuda_v12", "cuda_v13", "vulkan"]) {
  if (existsSync(join(stage, "lib", "ollama", excluded))) {
    console.error(`staged lib/ollama still holds ${excluded} — the CPU-only stage excluded nothing`);
    process.exit(1);
  }
}

const version = await new Promise((resolve, reject) => {
  const child = spawn(binary, ["--version"], { windowsHide: true });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.on("error", reject);
  child.on("close", () => resolve(stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null));
});
if (version !== "0.40.18") {
  console.error(`staged ollama.exe reported version ${version ?? "none"}, expected 0.40.18`);
  process.exit(1);
}

const modelsDir = mkdtempSync(join(tmpdir(), "sanremes-ollama-smoke-"));
const port = 11435;
const server = spawn(binary, ["serve"], {
  windowsHide: true,
  env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: modelsDir },
});
let served = null;
try {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/version`);
      if (response.ok) { served = await response.json(); break; }
    } catch {
      // Not up yet.
    }
    await delay(500);
  }
} finally {
  server.kill();
  await Promise.race([new Promise((resolve) => server.on("close", resolve)), delay(5_000)]);
  rmSync(modelsDir, { recursive: true, force: true });
}
if (!served || served.version !== "0.40.18") {
  console.error(`staged ollama serve did not answer /api/version with 0.40.18 (got ${JSON.stringify(served)})`);
  process.exit(1);
}
console.log(`Ollama smoke OK: ollama ${version}, ${cpuRunners.length} CPU runners, serve answers /api/version`);
