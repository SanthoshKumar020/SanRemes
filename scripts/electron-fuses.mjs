import { readFile } from "node:fs/promises";
import path from "node:path";

// Electron V1 fuse wire (Electron 12+, electron/fuses wire format): the
// binary carries the sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`, then a
// version byte, a wire-length byte, and one state byte per fuse. `0` is
// disabled, `1` is enabled, `r` is removed.
export const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
export const FUSE_STATE = { DISABLED: 0x30, ENABLED: 0x31, REMOVED: 0x72 };
export const FUSE_NAMES = [
  "runAsNode",
  "enableCookieEncryption",
  "enableNodeOptionsEnvironmentVariable",
  "enableNodeCliInspectArguments",
  "enableEmbeddedAsarIntegrityValidation",
  "onlyLoadAppFromAsar",
  "loadBrowserProcessSpecificV8Snapshot",
  "grantFileProtocolExtraPrivileges",
];

function stateName(byte) {
  if (byte === FUSE_STATE.DISABLED) return "disabled";
  if (byte === FUSE_STATE.ENABLED) return "enabled";
  if (byte === FUSE_STATE.REMOVED) return "removed";
  return "unknown";
}

function readWire(binary, sentinelOffset) {
  const position = sentinelOffset + FUSE_SENTINEL.length;
  if (binary[position] !== 1) {
    throw new Error(`Unsupported Electron fuse wire version ${binary[position]} in ${binary.length}-byte binary`);
  }
  const length = binary[position + 1];
  if (length < FUSE_NAMES.length) {
    throw new Error(`Electron fuse wire has ${length} entries, expected at least ${FUSE_NAMES.length}`);
  }
  const fuses = {};
  for (let i = 0; i < FUSE_NAMES.length; i++) {
    fuses[FUSE_NAMES[i]] = stateName(binary[position + 2 + i]);
  }
  return fuses;
}

// The fuses live in the Electron Framework binary on macOS, not in the app
// executable; on Windows and Linux they live in the app executable itself.
export function fuseBinaryPath(appPath, platform = process.platform, executable = null) {
  if (platform === "darwin") {
    return path.join(appPath, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework");
  }
  if (platform === "win32") {
    return path.join(appPath, executable ?? "SanRemes.exe");
  }
  return path.join(appPath, executable ?? "sanremes");
}

export async function readFuses(binaryPath, read = readFile) {
  const binary = await read(binaryPath);
  const sentinel = Buffer.from(FUSE_SENTINEL, "ascii");
  const first = binary.indexOf(sentinel);
  if (first === -1) {
    throw new Error(`No Electron fuse sentinel in ${binaryPath}: fuses need Electron 12 or later`);
  }
  const last = binary.lastIndexOf(sentinel);
  const wires = (first === last ? [first] : [first, last]).map((offset) => readWire(binary, offset));
  for (const wire of wires.slice(1)) {
    if (JSON.stringify(wire) !== JSON.stringify(wires[0])) {
      throw new Error(`Electron binary ${binaryPath} carries two fuse wires that disagree`);
    }
  }
  return wires[0];
}
