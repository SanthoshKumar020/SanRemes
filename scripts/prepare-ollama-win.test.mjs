import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBundledOllamaEntry, OLLAMA_WINDOWS_RELEASE, parseOllamaVersion, stageOllamaFromDirectory } from "./prepare-ollama-win.mjs";

const fixtures = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "sanremes-ollama-prepare-test-")); fixtures.push(root); return root; }
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("pinned Windows Ollama preparation", () => {
  it("pins the exact official Windows zip", () => {
    expect(OLLAMA_WINDOWS_RELEASE.version).toBe("0.40.18");
    expect(OLLAMA_WINDOWS_RELEASE.file).toBe("ollama-windows-amd64.zip");
    expect(OLLAMA_WINDOWS_RELEASE.bytes).toBe(1717307988);
    expect(OLLAMA_WINDOWS_RELEASE.sha256).toBe("ca97292ac1e9acc77fcf473bb2741fa6acd12e3798f261b419680068b7cc4c16");
    expect(OLLAMA_WINDOWS_RELEASE.url).toBe("https://github.com/ollama/ollama/releases/download/v0.40.18/ollama-windows-amd64.zip");
  });

  it("ships ollama.exe plus the CPU libraries, never the GPU runners", () => {
    expect(isBundledOllamaEntry("ollama.exe")).toBe(true);
    expect(isBundledOllamaEntry("lib/ollama/ggml-cpu-alderlake.dll")).toBe(true);
    expect(isBundledOllamaEntry("lib/ollama/ggml-base.dll")).toBe(true);
    expect(isBundledOllamaEntry("lib/ollama/libllama.dll")).toBe(true);
    expect(isBundledOllamaEntry("lib/ollama/llama-server.exe")).toBe(true);
    expect(isBundledOllamaEntry("lib/ollama/cuda_v12/cublas64_12.dll")).toBe(false);
    expect(isBundledOllamaEntry("lib/ollama/cuda_v12/ggml-cuda.dll")).toBe(false);
    expect(isBundledOllamaEntry("lib/ollama/cuda_v13/ggml-cuda.dll")).toBe(false);
    expect(isBundledOllamaEntry("lib/ollama/vulkan/ggml-vulkan.dll")).toBe(false);
    expect(isBundledOllamaEntry("lib/ollama/vulkan/msvcp140.dll")).toBe(false);
    expect(isBundledOllamaEntry("README.md")).toBe(false);
    expect(isBundledOllamaEntry("lib/ollama")).toBe(false);
  });

  it("parses the version from ollama --version output", () => {
    expect(parseOllamaVersion("ollama version is 0.40.18\n")).toBe("0.40.18");
    expect(parseOllamaVersion("")).toBe(null);
    expect(parseOllamaVersion("no version here")).toBe(null);
  });

  it("stages only the CPU set out of an extracted zip", () => {
    const root = fixture();
    const extracted = join(root, "extracted");
    const stage = join(root, "stage");
    const write = (relative, content) => {
      const path = join(extracted, relative);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    };
    write("ollama.exe", "exe");
    write("lib/ollama/ggml-cpu-x64.dll", "cpu");
    write("lib/ollama/ggml-base.dll", "base");
    write("lib/ollama/cuda_v12/cublas64_12.dll", "cuda");
    write("lib/ollama/vulkan/ggml-vulkan.dll", "vulkan");
    write("stray.txt", "stray");

    const { files, bytes } = stageOllamaFromDirectory(extracted, stage);
    expect(files).toBe(3);
    expect(bytes).toBe(3 + 3 + 4);
    expect(existsSync(join(stage, "ollama.exe"))).toBe(true);
    expect(existsSync(join(stage, "lib", "ollama", "ggml-cpu-x64.dll"))).toBe(true);
    expect(existsSync(join(stage, "lib", "ollama", "ggml-base.dll"))).toBe(true);
    expect(existsSync(join(stage, "lib", "ollama", "cuda_v12"))).toBe(false);
    expect(existsSync(join(stage, "lib", "ollama", "vulkan"))).toBe(false);
    expect(existsSync(join(stage, "stray.txt"))).toBe(false);
  });

  it("refuses to stage a tree without ollama.exe", () => {
    const root = fixture();
    const extracted = join(root, "extracted");
    mkdirSync(join(extracted, "lib", "ollama"), { recursive: true });
    writeFileSync(join(extracted, "lib", "ollama", "ggml-base.dll"), "base");
    expect(() => stageOllamaFromDirectory(extracted, join(root, "stage"))).toThrow(/no ollama\.exe/);
  });
});
