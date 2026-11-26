import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { FUSE_NAMES, FUSE_STATE, fuseBinaryPath, readFuses } from "./electron-fuses.mjs";
import { REQUIRED_FUSES } from "./check-release-hygiene.mjs";

function wire(states) {
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
  const body = Buffer.from([1, 8, ...FUSE_NAMES.map((name) => states[name] ?? FUSE_STATE.DISABLED)]);
  return Buffer.concat([Buffer.from("ELF...."), sentinel, body, Buffer.from("....")]);
}

const ALL_DISABLED = Object.fromEntries(FUSE_NAMES.map((name) => [name, FUSE_STATE.DISABLED]));

describe("readFuses", () => {
  it("reads every V1 fuse state from the wire", async () => {
    const states = { ...ALL_DISABLED, runAsNode: FUSE_STATE.ENABLED, onlyLoadAppFromAsar: FUSE_STATE.REMOVED };
    const result = await readFuses("synthetic", async () => wire(states));
    expect(result).toEqual({
      runAsNode: "enabled",
      enableCookieEncryption: "disabled",
      enableNodeOptionsEnvironmentVariable: "disabled",
      enableNodeCliInspectArguments: "disabled",
      enableEmbeddedAsarIntegrityValidation: "disabled",
      onlyLoadAppFromAsar: "removed",
      loadBrowserProcessSpecificV8Snapshot: "disabled",
      grantFileProtocolExtraPrivileges: "disabled",
    });
  });

  it("rejects a binary without a sentinel", async () => {
    await expect(readFuses("synthetic", async () => Buffer.from("no fuses here"))).rejects.toThrow("No Electron fuse sentinel");
  });

  it("rejects an unsupported wire version", async () => {
    const binary = wire(ALL_DISABLED);
    binary[binary.indexOf("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX") + 32] = 2;
    await expect(readFuses("synthetic", async () => binary)).rejects.toThrow("Unsupported Electron fuse wire version 2");
  });

  it("rejects two fuse wires that disagree", async () => {
    const first = wire(ALL_DISABLED);
    const second = wire({ ...ALL_DISABLED, runAsNode: FUSE_STATE.ENABLED });
    await expect(readFuses("synthetic", async () => Buffer.concat([first, second]))).rejects.toThrow("disagree");
  });

  it("reads the real Electron binary's fuse wire", async () => {
    const electron = path.join(import.meta.dirname, "..", "node_modules", "electron", "dist", "electron");
    if (!fs.existsSync(electron)) return;
    const result = await readFuses(electron);
    expect(Object.keys(result).sort()).toEqual([...FUSE_NAMES].sort());
    for (const state of Object.values(result)) expect(["disabled", "enabled", "removed"]).toContain(state);
  });
});

describe("fuseBinaryPath", () => {
  it("points at the Framework binary on macOS and the app executable elsewhere", () => {
    expect(fuseBinaryPath("/out/SanRemes.app", "darwin")).toBe(
      "/out/SanRemes.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
    );
    expect(fuseBinaryPath("/out/win-unpacked", "win32")).toBe("/out/win-unpacked/SanRemes.exe");
    expect(fuseBinaryPath("/out/linux-unpacked", "linux")).toBe("/out/linux-unpacked/sanremes");
  });
});

describe("electron-builder.yml electronFuses", () => {
  it("matches the hygiene gate's required fuse policy", () => {
    const config = parseYaml(fs.readFileSync(path.join(import.meta.dirname, "..", "electron-builder.yml"), "utf8"));
    expect(config.electronFuses).toEqual({
      runAsNode: true,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    });
    expect(REQUIRED_FUSES).toEqual({
      runAsNode: "enabled",
      enableNodeCliInspectArguments: "disabled",
      enableEmbeddedAsarIntegrityValidation: "enabled",
      onlyLoadAppFromAsar: "enabled",
    });
  });
});
