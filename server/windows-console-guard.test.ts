import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OWN_GROUP } from "./group-exec.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// A child process spawned on Windows without windowsHide opens a console
// window: the packaged app is a GUI executable, but every console-subsystem
// child it starts (node, ffmpeg, ollama, powershell, cmd) pops a terminal
// unless the spawn hides it. The shared helpers guarantee it (OWN_GROUP,
// spawnCli, execCli); this test locks every other direct spawn site in the
// shipped server and Electron main process to the same guarantee.
const SCAN_DIRS = ["server", "electron"];
const SCAN_EXTENSIONS = new Set([".ts", ".mjs", ".js"]);

// Files the scan skips, with the reason each one cannot show a console on
// the Windows desktop. A file leaves this list only by gaining a hidden
// spawn or a platform gate the scan can see.
const EXEMPT: Record<string, string> = {
  "server/memory-store.ts":
    "spawnOpener deliberately uses windowsHide: false: it opens GUI programs (Explorer, Obsidian) and hiding would start them invisible.",
  "electron/terminal-launch.mjs":
    "openBlankTerminal deliberately opens a visible PowerShell; it runs only when the person asks for a terminal.",
  "electron/build-speech-helper.mjs": "build-time macOS script (swiftc, lipo, codesign); never shipped or run on Windows.",
  "server/bot-box/box-bridge.ts": "runs inside the Linux bubblewrap box; bwrap does not exist on Windows.",
  "server/bot-box/box-probe.ts": "runs inside the Linux bubblewrap box.",
  "server/bot-box/detect.ts": "bwrap capability probe; only reached after the Linux check.",
  "server/bot-box/self-check.ts": "boxed self-check; only runs when the box is bwrap (Linux).",
  "server/browser/desktop/displays.ts": "Xvnc launch; findXvnc returns null unless Linux.",
  "server/browser/desktop/policy.ts": "bwrap probe; only reached on Linux.",
  "server/host/conversation-folder-cleanup.ts": "rm/nice/chmod; gated behind gnuRm(), Linux-only.",
  "server/tts/system-voices.ts": "/usr/bin/say; macOS-only.",
  "server/cloud-home-start.ts": "Linux cloud-home entry; never runs on the Windows desktop.",
  "server/oom-score.ts": "its `spawn` is a caller-supplied callback, not child_process.spawn.",
  "server/browser/memory-cgroup.ts": "its `spawn` is a caller-supplied callback; the only caller is the Linux cgroup path.",
  "server/drivers/codex-process.ts": "its `spawn` is a caller-supplied callback; the production caller passes spawnCli.",
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "testing") continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.mjs") || entry.endsWith(".node-test.mjs")) continue;
    out.push(full);
  }
  return out;
}

// Comments blanked out, length preserved so line numbers stay true. A
// comment naming spawn (a doc note, a regex pattern) is not a spawn site.
function stripComments(source: string): string {
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s({;,])\/\/[^\n]*/g, (_match, prefix: string) => `${prefix} `);
}

// Raw child_process calls. spawnCli, execCli, execFileInGroup and friends
// never match: their names are longer than the raw call. A ".spawn("
// property call (an injected spawn, whose caller supplies spawnCli) never
// matches either, and neither does a bare `exec` (no child_process.exec
// call exists in the repo; the word is a method or regex elsewhere).
const CALL = /(?<![\w$.])(spawn|execFileAsync|execFileSync|execFile|spawnSync|fork)\s*\(/g;
const WINDOW = 1500;
const BACK_WINDOW = 800;

// The options hide the console when they set windowsHide to true, spread
// the shared OWN_GROUP, or set it from the platform (true on win32).
const HIDDEN = /windowsHide\s*:\s*(true|process\.platform)|OWN_GROUP/;

function unhiddenSpawns(source: string): { line: number; call: string }[] {
  const stripped = stripComments(source);
  const found: { line: number; call: string }[] = [];
  for (const match of stripped.matchAll(CALL)) {
    const lineStart = stripped.lastIndexOf("\n", match.index - 1) + 1;
    const lineEnd = stripped.indexOf("\n", match.index);
    const line = stripped.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    // An interface or type declaration (`spawn(file: string, ...): GhChild;`)
    // is not a call: its line carries a return-type annotation.
    if (/\)\s*:\s*[A-Za-z_]/.test(line)) continue;
    const forward = stripped.slice(match.index, match.index + WINDOW);
    if (HIDDEN.test(forward)) continue;
    // Options passed as a variable (`execFile(file, args, options, ...)`)
    // are built just above the call; the guarantee lives there.
    const args = forward.slice(0, 300);
    if (/,\s*[A-Za-z_$][\w$]*\s*[,)]/.test(args) && HIDDEN.test(stripped.slice(Math.max(0, match.index - BACK_WINDOW), match.index))) continue;
    found.push({ line: stripped.slice(0, match.index).split("\n").length, call: match[0].trim() });
  }
  return found;
}

describe("windows console guard", () => {
  it("the shared spawn options hide the console", () => {
    expect(OWN_GROUP.windowsHide).toBe(true);
  });

  it("every spawn in the shipped server and Electron main process hides its console", () => {
    const failures: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const full of listSourceFiles(join(ROOT, dir))) {
        const relative = full.slice(ROOT.length);
        if (EXEMPT[relative]) continue;
        const source = readFileSync(full, "utf8");
        if (!source.includes("node:child_process")) continue;
        for (const { line, call } of unhiddenSpawns(source)) {
          failures.push(`${relative}:${line}: ${call} has no windowsHide: true (or OWN_GROUP) in its options`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("the deliberate visible spawns stay visible", () => {
    expect(readFileSync(join(ROOT, "server/memory-store.ts"), "utf8")).toContain("windowsHide: false");
    expect(readFileSync(join(ROOT, "electron/terminal-launch.mjs"), "utf8")).toMatch(/Start-Process|powershell/i);
  });
});
