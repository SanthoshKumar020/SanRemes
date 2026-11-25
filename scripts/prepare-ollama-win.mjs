// Windows Ollama preparation: downloads the official Ollama Windows zip and
// stages the CPU-only bundle the installer ships, so the first-run setup can
// start a local Ollama server and pull Qwen without the user installing
// anything. Run it with `pnpm build:ollama:win` (Windows-only).
//
// The official zip is ~1.6 GB compressed / ~2.3 GB uncompressed, most of it
// GPU runners (cuda_v12, cuda_v13, vulkan). The installer ships only the
// CPU set — ollama.exe plus the libraries directly under lib/ollama/ — which
// keeps the staged bundle around 85 MB. CPU inference is what the Qwen live
// proof ran on; a machine with an NVIDIA/AMD card can still use the CPU
// runner, just slower. The GPU runners are a future option, not a first-run
// requirement.
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";

const runFile = promisify(execFile);

// Pinned from Ollama's official sha256sum.txt for v0.40.18
// (https://github.com/ollama/ollama/releases/download/v0.40.18/sha256sum.txt).
export const OLLAMA_WINDOWS_RELEASE = {
  version: "0.40.18",
  file: "ollama-windows-amd64.zip",
  bytes: 1717307988,
  sha256: "ca97292ac1e9acc77fcf473bb2741fa6acd12e3798f261b419680068b7cc4c16",
  url: "https://github.com/ollama/ollama/releases/download/v0.40.18/ollama-windows-amd64.zip",
};

export const OLLAMA_STAGE_DIR = "ollama-win32-x64";

/** Whether a zip entry ships in the installer: ollama.exe, plus the libraries directly under lib/ollama/. GPU runner subdirectories (cuda_v12, cuda_v13, vulkan) are excluded. */
export function isBundledOllamaEntry(name) {
  if (name === "ollama.exe") return true;
  const prefix = "lib/ollama/";
  if (!name.startsWith(prefix)) return false;
  return !name.slice(prefix.length).includes("/");
}

/** `ollama --version` prints "ollama version is 0.40.18". */
export function parseOllamaVersion(stdout) {
  return String(stdout ?? "").match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

async function probeVersion(binary) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { stdout } = await runFile(binary, ["--version"], { timeout: 30_000, windowsHide: true });
      const version = parseOllamaVersion(stdout);
      if (version) return version;
    } catch {
    }
  }
  return null;
}

function listFiles(directory, root = directory) {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, root));
    else out.push(path.slice(root.length + 1));
  }
  return out;
}

/**
 * Copy the CPU-only Ollama set out of an extracted official zip into the
 * stage directory, preserving the layout Ollama expects (ollama.exe beside
 * lib/ollama/). Returns the staged file count and total bytes.
 */
export function stageOllamaFromDirectory(extracted, stage) {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const relative of listFiles(extracted)) {
    const normalized = relative.split(/[\\/]/).join("/");
    if (!isBundledOllamaEntry(normalized)) continue;
    const source = join(extracted, relative);
    const target = join(stage, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    copyFileSync(source, target);
    files += 1;
    bytes += statSync(source).size;
  }
  if (!existsSync(join(stage, "ollama.exe"))) {
    throw new Error(`staging left no ollama.exe in ${stage}`);
  }
  return { files, bytes };
}

async function downloadRelease(release, archive) {
  const response = await fetch(release.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`downloading ${release.url} failed: HTTP ${response.status}`);
  }
  const hash = createHash("sha256");
  let received = 0;
  const file = createWriteStream(archive);
  await pipeline(response.body, async function* (source) {
    for await (const chunk of source) {
      received += chunk.length;
      hash.update(chunk);
      yield chunk;
    }
  }, file);
  const digest = hash.digest("hex");
  if (received !== release.bytes || digest !== release.sha256) {
    throw new Error(`downloaded ${release.file} failed verification: got ${received} bytes sha256 ${digest}, expected ${release.bytes} bytes sha256 ${release.sha256}`);
  }
}

export async function prepareOllamaWin({
  root = join(import.meta.dirname, ".."),
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  if (platform !== "win32" || arch !== "x64") {
    throw new Error(`prepare-ollama-win is Windows x64-only (got ${platform}-${arch})`);
  }
  const release = OLLAMA_WINDOWS_RELEASE;
  const cache = join(root, "node_modules", ".cache", "sanremes", `ollama-${release.version}-win`);
  const stage = join(root, "dist-native", OLLAMA_STAGE_DIR);
  const stagedBinary = join(stage, "ollama.exe");
  if (existsSync(stagedBinary) && (await probeVersion(stagedBinary)) === release.version) {
    console.log(`Ollama ${release.version} is already staged at ${stage}`);
    return { stage, version: release.version, cached: true };
  }

  mkdirSync(cache, { recursive: true });
  const archive = join(cache, release.file);
  const override = env.OLLAMA_WINDOWS_ZIP_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`OLLAMA_WINDOWS_ZIP_PATH names a missing file: ${override}`);
    console.log(`Using a local Ollama zip from OLLAMA_WINDOWS_ZIP_PATH: ${override}`);
    copyFileSync(override, archive);
  } else if (!existsSync(archive) || statSync(archive).size !== release.bytes) {
    console.log(`Downloading Ollama ${release.version} (${(release.bytes / 1048576).toFixed(0)} MB)…`);
    await downloadRelease(release, archive);
  } else {
    console.log(`Reusing the cached Ollama ${release.version} zip at ${archive}`);
  }

  const digest = createHash("sha256");
  digest.update(readFileSync(archive));
  if (digest.digest("hex") !== release.sha256) {
    throw new Error(`cached ${release.file} failed sha256 verification — delete ${archive} and re-run`);
  }

  // Windows' own bsdtar reads zip archives, and says so when it cannot.
  // PowerShell's Expand-Archive, run from here, exited 0 on the windows-2025
  // runner image of 2026-11-16 while extracting nothing.
  const extracted = join(cache, "extracted");
  rmSync(extracted, { recursive: true, force: true });
  mkdirSync(extracted, { recursive: true });
  const tar = join(env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  try {
    await runFile(tar, ["-xf", archive, "-C", extracted], { timeout: 300_000, windowsHide: true });
  } catch (error) {
    throw new Error(`extracting ${release.file} with ${tar} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!existsSync(join(extracted, "ollama.exe"))) {
    throw new Error(`extracting ${release.file} with ${tar} exited 0 but left no ollama.exe in ${extracted}`);
  }

  const { files, bytes } = stageOllamaFromDirectory(extracted, stage);
  const version = await probeVersion(stagedBinary);
  if (version !== release.version) {
    throw new Error(`staged ollama.exe reported version ${version ?? "none"}, expected ${release.version}`);
  }
  console.log(`Staged Ollama ${version} for win32-x64: ${files} files, ${(bytes / 1048576).toFixed(1)} MB at ${stage}`);
  return { stage, version, cached: false, files, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await prepareOllamaWin();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
