import { lstat, open, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fuseBinaryPath, readFuses } from "./electron-fuses.mjs";

// Release hygiene gate: a packaged desktop app must ship no source maps, no
// embedded source, no plaintext secrets, and the Electron fuses from
// electron-builder.yml. Run it on every packaged app before a release is
// published; see docs/releasing.md.
//
//   node scripts/check-release-hygiene.mjs --app <packaged app dir> [--app ...]
//     [--platform darwin|win32|linux] [--executable <name>]
//
// Findings print the file and the check, never the matched text: a secret
// must not leak into the log that reports it.

export const REQUIRED_FUSES = {
  runAsNode: "enabled",
  enableNodeCliInspectArguments: "disabled",
  enableEmbeddedAsarIntegrityValidation: "enabled",
  onlyLoadAppFromAsar: "enabled",
};

export const SECRET_CHECKS = [
  { name: "pem-private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{20,}/ },
  { name: "github-token", pattern: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { name: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "openai-key", pattern: /sk-proj-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}/ },
  { name: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "npm-token", pattern: /npm_[A-Za-z0-9]{20,}/ },
];

const MAX_SCAN_BYTES = 2 * 1024 * 1024;

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

export function scanText(text) {
  const found = [];
  const sourceMap = text.indexOf("sourceMappingURL");
  if (sourceMap !== -1) found.push({ check: "sourceMappingURL", line: lineNumber(text, sourceMap) });
  const sources = text.indexOf("sourcesContent");
  if (sources !== -1) found.push({ check: "sourcesContent", line: lineNumber(text, sources) });
  for (const { name, pattern } of SECRET_CHECKS) {
    const match = pattern.exec(text);
    if (match) found.push({ check: `secret:${name}`, line: lineNumber(text, match.index) });
  }
  return found;
}

function isText(buffer) {
  return !buffer.subarray(0, 8192).includes(0);
}

// An asar archive starts with an 8-byte pickle holding the header size,
// then a pickle holding the header JSON; file data follows at
// 8 + headerSize, at each entry's offset.
export async function readAsarEntries(asarPath) {
  const handle = await open(asarPath, "r");
  try {
    const sizeBuffer = Buffer.alloc(8);
    if ((await handle.read(sizeBuffer, 0, 8, 0)).bytesRead !== 8) {
      throw new Error(`${asarPath} is too short for an asar header`);
    }
    const headerSize = sizeBuffer.readUInt32LE(4);
    const headerBuffer = Buffer.alloc(headerSize);
    if ((await handle.read(headerBuffer, 0, headerSize, 8)).bytesRead !== headerSize) {
      throw new Error(`${asarPath} has a truncated asar header`);
    }
    const stringLength = headerBuffer.readUInt32LE(4);
    const header = JSON.parse(headerBuffer.subarray(8, 8 + stringLength).toString("utf8"));
    const entries = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const file = prefix ? `${prefix}/${name}` : name;
        if (child.files) walk(child, file);
        else entries.push({ path: file, size: child.size ?? 0, offset: Number(child.offset ?? 0), unpacked: child.unpacked === true });
      }
    };
    walk(header, "");
    return { headerSize, entries };
  } finally {
    await handle.close();
  }
}

async function readAsarEntry(asarPath, headerSize, entry) {
  const handle = await open(asarPath, "r");
  try {
    const buffer = Buffer.alloc(entry.size);
    await handle.read(buffer, 0, entry.size, 8 + headerSize + entry.offset);
    return buffer;
  } finally {
    await handle.close();
  }
}

function resourcesDir(appPath, platform) {
  return platform === "darwin" ? path.join(appPath, "Contents", "Resources") : path.join(appPath, "resources");
}

async function walkUnpacked(directory, visit) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await walkUnpacked(file, visit);
    else if (entry.isFile()) await visit(file);
  }
}

export async function checkReleaseHygiene(apps) {
  const findings = [];
  let scanned = 0;
  let skipped = 0;
  const add = (app, file, check, line) => findings.push({ app, file, check, line });
  const scanBuffer = (app, file, buffer) => {
    if (buffer.length > MAX_SCAN_BYTES || !isText(buffer)) {
      skipped++;
      return;
    }
    scanned++;
    for (const hit of scanText(buffer.toString("utf8"))) add(app, file, hit.check, hit.line);
  };

  for (const { path: appPath, platform = process.platform, executable = null } of apps) {
    const resources = resourcesDir(appPath, platform);
    const asarPath = path.join(resources, "app.asar");
    let asar;
    try {
      asar = await readAsarEntries(asarPath);
    } catch {
      add(appPath, "app.asar", "missing-asar", null);
      continue;
    }
    for (const entry of asar.entries) {
      const display = `app.asar/${entry.path}`;
      if (entry.path.endsWith(".map")) add(appPath, display, "sourcemap-file", null);
      if (entry.unpacked || entry.size === 0) continue;
      scanBuffer(appPath, display, await readAsarEntry(asarPath, asar.headerSize, entry));
    }
    try {
      await walkUnpacked(resources, async (file) => {
        if (path.resolve(file) === path.resolve(asarPath)) return;
        const display = path.relative(appPath, file);
        if (file.endsWith(".map")) add(appPath, display, "sourcemap-file", null);
        const details = await lstat(file);
        if (details.size > MAX_SCAN_BYTES) {
          skipped++;
          return;
        }
        scanBuffer(appPath, display, await readFile(file));
      });
    } catch {
      add(appPath, "resources", "missing-resources", null);
    }
    let fuses;
    try {
      fuses = await readFuses(fuseBinaryPath(appPath, platform, executable));
    } catch (error) {
      add(appPath, "electron-fuses", "unreadable-fuses", null);
      findings[findings.length - 1].detail = error instanceof Error ? error.message : String(error);
      continue;
    }
    for (const [name, expected] of Object.entries(REQUIRED_FUSES)) {
      if (fuses[name] !== expected) {
        add(appPath, "electron-fuses", `fuse:${name}`, null);
        findings[findings.length - 1].detail = `expected ${expected}, found ${fuses[name]}`;
      }
    }
  }
  return { ok: findings.length === 0, findings, scanned, skipped };
}

function parseArgs(argv) {
  const paths = [];
  let platform = process.platform;
  let executable = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--app") paths.push(argv[++i]);
    else if (argv[i] === "--platform") platform = argv[++i];
    else if (argv[i] === "--executable") executable = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (paths.length === 0) throw new Error("usage: check-release-hygiene.mjs --app <packaged app dir> [--app ...] [--platform darwin|win32|linux] [--executable <name>]");
  return paths.map((appPath) => ({ path: appPath, platform, executable }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let apps;
  try {
    apps = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const result = await checkReleaseHygiene(apps);
  for (const finding of result.findings) {
    const line = finding.line == null ? "" : `:${finding.line}`;
    const detail = finding.detail ? ` (${finding.detail})` : "";
    console.error(`::error::${finding.app} ${finding.file}${line} ${finding.check}${detail}`);
  }
  if (result.ok) {
    console.log(`ok: ${apps.length} packaged app(s), ${result.scanned} file(s) scanned, ${result.skipped} skipped (binary or over 2 MiB), no source maps, no embedded source, no plaintext secrets, fuses as required`);
  } else {
    console.error(`${result.findings.length} release-hygiene finding(s) in ${apps.length} packaged app(s)`);
    process.exit(1);
  }
}
