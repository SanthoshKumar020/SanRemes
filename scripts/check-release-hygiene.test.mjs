import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FUSE_STATE } from "./electron-fuses.mjs";
import { checkReleaseHygiene, readAsarEntries, scanText } from "./check-release-hygiene.mjs";

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fuseWire(states) {
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX", "ascii");
  const order = [
    "runAsNode",
    "enableCookieEncryption",
    "enableNodeOptionsEnvironmentVariable",
    "enableNodeCliInspectArguments",
    "enableEmbeddedAsarIntegrityValidation",
    "onlyLoadAppFromAsar",
    "loadBrowserProcessSpecificV8Snapshot",
    "grantFileProtocolExtraPrivileges",
  ];
  return Buffer.concat([sentinel, Buffer.from([1, 8, ...order.map((name) => states[name])])]);
}

const REQUIRED_WIRE = fuseWire({
  runAsNode: FUSE_STATE.ENABLED,
  enableCookieEncryption: FUSE_STATE.DISABLED,
  enableNodeOptionsEnvironmentVariable: FUSE_STATE.DISABLED,
  enableNodeCliInspectArguments: FUSE_STATE.DISABLED,
  enableEmbeddedAsarIntegrityValidation: FUSE_STATE.ENABLED,
  onlyLoadAppFromAsar: FUSE_STATE.ENABLED,
  loadBrowserProcessSpecificV8Snapshot: FUSE_STATE.DISABLED,
  grantFileProtocolExtraPrivileges: FUSE_STATE.DISABLED,
});

function writeAsar(asarPath, files) {
  const header = { files: {} };
  const data = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const buffer = Buffer.from(content, "utf8");
    header.files[name] = { size: buffer.length, offset: String(offset) };
    data.push(buffer);
    offset += buffer.length;
  }
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(json.length, 0);
  const stringPickle = Buffer.concat([length, padded]);
  const headerSizeField = Buffer.alloc(4);
  headerSizeField.writeUInt32LE(stringPickle.length, 0);
  const headerPickle = Buffer.concat([headerSizeField, stringPickle]);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  fs.writeFileSync(asarPath, Buffer.concat([sizePickle, headerPickle, ...data]));
}

function fixture({ asarFiles = { "main.js": "console.log('hi');\n" }, unpackedFiles = {}, fuseWire: wire = REQUIRED_WIRE } = {}) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "sanremes-hygiene-"));
  temporaryDirectories.push(app);
  const resources = path.join(app, "resources");
  fs.mkdirSync(resources, { recursive: true });
  writeAsar(path.join(resources, "app.asar"), asarFiles);
  for (const [name, content] of Object.entries(unpackedFiles)) {
    const file = path.join(resources, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  fs.writeFileSync(path.join(app, "sanremes"), wire);
  return app;
}

const LINUX = { path: "", platform: "linux" };

describe("readAsarEntries", () => {
  it("round-trips the asar header a real packer would write", async () => {
    const app = fixture({ asarFiles: { "a.js": "one", "dir/b.js": "two" } });
    const { entries } = await readAsarEntries(path.join(app, "resources", "app.asar"));
    expect(entries.map((entry) => entry.path).sort()).toEqual(["a.js", "dir/b.js"]);
    expect(entries.find((entry) => entry.path === "dir/b.js").size).toBe(3);
  });
});

describe("scanText", () => {
  it("names each exposure without returning the matched text", () => {
    expect(scanText("const x = 1;\n//# sourceMappingURL=app.js.map")).toEqual([
      { check: "sourceMappingURL", line: 2 },
    ]);
    expect(scanText("{\"sourcesContent\":[\"secret\"]}")).toEqual([{ check: "sourcesContent", line: 1 }]);
    const token = "ghp_abcdefghij1234567890ABCDEF1234";
    const hits = scanText(`key = "${token}"`);
    expect(hits).toEqual([{ check: "secret:github-token", line: 1 }]);
    expect(JSON.stringify(hits)).not.toContain(token);
  });

  it("still flags a real PEM key but not the redaction placeholder shipped in exit-report.ts", () => {
    expect(scanText("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----")).toEqual([
      { check: "secret:pem-private-key", line: 1 },
    ]);
    expect(scanText('return "-----BEGIN PRIVATE KEY----- «redacted»";')).toEqual([]);
  });
});

describe("checkReleaseHygiene", () => {
  it("passes a clean packaged app", async () => {
    const app = fixture({ unpackedFiles: { "server/index.js": "console.log('server');\n" } });
    const result = await checkReleaseHygiene([{ ...LINUX, path: app }]);
    expect(result).toEqual({ ok: true, findings: [], scanned: expect.any(Number), skipped: 0 });
    expect(result.scanned).toBeGreaterThan(0);
  });

  it("flags a .map file inside the asar", async () => {
    const app = fixture({ asarFiles: { "main.js": "console.log(1);\n", "main.js.map": "{}" } });
    const result = await checkReleaseHygiene([{ ...LINUX, path: app }]);
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ file: "app.asar/main.js.map", check: "sourcemap-file" }),
    );
  });

  it("flags a sourceMappingURL comment in a packed file", async () => {
    const app = fixture({ asarFiles: { "main.js": "console.log(1);\n//# sourceMappingURL=main.js.map\n" } });
    const result = await checkReleaseHygiene([{ ...LINUX, path: app }]);
    expect(result.findings).toContainEqual(expect.objectContaining({ check: "sourceMappingURL", line: 2 }));
  });

  it("flags sourcesContent in an unpacked resource", async () => {
    const app = fixture({ unpackedFiles: { "ui/app.js": "{\"sourcesContent\":[]}" } });
    const result = await checkReleaseHygiene([{ ...LINUX, path: app }]);
    expect(result.findings).toContainEqual(expect.objectContaining({ check: "sourcesContent" }));
  });

  it("flags a plaintext token without ever printing it", async () => {
    const token = "ghp_abcdefghij1234567890ABCDEF1234";
    const app = fixture({ asarFiles: { "main.js": `const key = "${token}";\n` } });
    const result = await checkReleaseHygiene([{ ...LINUX, path: app }]);
    expect(result.findings).toContainEqual(expect.objectContaining({ check: "secret:github-token" }));
    expect(JSON.stringify(result.findings)).not.toContain(token);
  });

  it("flags a fuse left in the wrong state", async () => {
    const app = fixture({
      fuseWire: fuseWire({
        runAsNode: FUSE_STATE.DISABLED,
        enableCookieEncryption: FUSE_STATE.DISABLED,
        enableNodeOptionsEnvironmentVariable: FUSE_STATE.DISABLED,
        enableNodeCliInspectArguments: FUSE_STATE.DISABLED,
        enableEmbeddedAsarIntegrityValidation: FUSE_STATE.ENABLED,
        onlyLoadAppFromAsar: FUSE_STATE.ENABLED,
        loadBrowserProcessSpecificV8Snapshot: FUSE_STATE.DISABLED,
        grantFileProtocolExtraPrivileges: FUSE_STATE.DISABLED,
      }),
    });
    const result = await checkReleaseHygiene([{ ...LINUX, path: app }]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({ check: "fuse:runAsNode", detail: "expected enabled, found disabled" }),
    );
  });

  it("fails closed when app.asar is missing", async () => {
    const app = fixture();
    fs.unlinkSync(path.join(app, "resources", "app.asar"));
    const result = await checkReleaseHygiene([{ ...LINUX, path: app }]);
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ check: "missing-asar" }));
  });

  it("skips binary files instead of flagging their bytes", async () => {
    const app = fixture({ unpackedFiles: { "browser-engine/chrome": Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]) } });
    const result = await checkReleaseHygiene([{ ...LINUX, path: app }]);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(1);
  });
});
