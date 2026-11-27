// The Python tool's sandbox: model-supplied Python 3 code run inside the bot box's
// bubblewrap plan (server/bot-box/plan.ts), with no network, a fresh empty HOME and
// working folder, a seccomp filter on x86-64, and bounded time, memory, processes and
// output.
//
// Security invariants:
// - The code runs as a new user-namespace root mapped to the server's own uid, in its
//   own PID, mount, IPC, UTS and network namespaces; the host's filesystem is visible
//   only as /usr and /etc read-only, plus the run's own HOME and working folder.
// - The network namespace has loopback only and no bridge to the host, so socket
//   connects fail; there is no egress gate in this box at all.
// - The seccomp filter (server/bot-box/seccomp.ts) refuses mount, bpf, keyring and
//   other kernel-attack-surface syscalls with EPERM on x86-64 Linux. On another
//   architecture the filter is not loaded and the result says so.
// - RLIMIT_AS bounds the whole tree's virtual memory and RLIMIT_NPROC bounds its
//   process count, so a fork bomb or an allocation loop cannot take the host down.
// - The working folder and HOME are fresh per run and deleted afterwards, so one run
//   cannot read or poison another run's files, and the model cannot reach the server's
//   data folder, the person's files, or any credential.
// - This is not a proof against a kernel or bubblewrap vulnerability, and code that
//   needs /proc (psutil, /proc reads) fails here: this kernel refuses a proc mount
//   inside a new PID namespace, so the box keeps PID isolation and omits /proc
//   instead of sharing the host's.
//
// Unsupported platforms are refused, never run unboxed: Windows and macOS have no
// bubblewrap, so the tool reports unsupported there rather than executing the code
// on the host.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { whichOnPath } from "../bot-box/detect.ts";
import { bwrapArgs, planBox } from "../bot-box/plan.ts";
import { seccompBytes, seccompSupported } from "../bot-box/seccomp.ts";

/** The interpreter inside the box: /usr is bound read-only, so this is the image's python3. */
export const BOX_PYTHON = "/usr/bin/python3";
/** The file the code runs from, inside the working folder. */
export const RUN_FILENAME = "main.py";

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 120;
export const DEFAULT_MEMORY_MB = 512;
export const MIN_MEMORY_MB = 64;
export const MAX_MEMORY_MB = 1024;
export const MAX_CODE_CHARS = 100_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
/** The process-count ceiling for the whole tree: python itself, its children, and the box. */
const MAX_PROCESSES = 128;
const PROBE_TIMEOUT_MS = 10_000;

export type PythonSandboxReason = "not-linux" | "no-bwrap" | "no-prlimit" | "no-python" | "userns-refused" | null;

export interface PythonSandboxDetection {
  supported: boolean;
  reason: PythonSandboxReason;
  bwrap: string | null;
  prlimit: string | null;
  /** False off x86-64: the filter hard-codes x86-64 syscall numbers. */
  seccomp: boolean;
}

export interface RunPythonInput {
  code: string;
  timeoutSeconds?: number;
  memoryMb?: number;
}

export interface RunPythonOptions {
  /** Parent of the per-run folders; defaults to the system temp folder. */
  baseDir?: string;
  /** Keep the run folder after the run, for debugging; deleted otherwise. */
  keepWorkdir?: boolean;
  /** Bytes kept per stream; the rest is drained and dropped, and `truncated` is set. */
  maxOutputBytes?: number;
}

export interface PythonRunFile {
  name: string;
  bytes: number;
}

/** What one run returns. `note` is plain words for the model when the run did not complete normally. */
export interface PythonRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  seccomp: boolean;
  durationMs: number;
  files: PythonRunFile[];
  note: string | null;
}

function failureResult(note: string, seccomp: boolean): PythonRunResult {
  return { stdout: "", stderr: "", exitCode: null, timedOut: false, truncated: false, seccomp, durationMs: 0, files: [], note };
}

let cachedDetection: PythonSandboxDetection | null = null;

interface BoxArgv {
  argv: string[];
}

/** The bubblewrap argv for one boxed command, from the bot-box plan minus its /proc mount. */
function pythonBoxArgv(root: { dataDir: string; home: string }, command: string, args: readonly string[], cwd: string, seccomp: boolean): BoxArgv {
  const plan = planBox(
    { dataDir: root.dataDir, home: root.home, codeRoots: [], engineRoots: [], bridges: [], ...(seccomp ? { seccompFd: 3 } : {}) },
    { command, args, cwd, env: {}, net: "isolated" },
  );
  return { argv: [...bwrapArgs({ ...plan, mounts: plan.mounts.filter((mount) => mount.kind !== "proc") }), "--", command, ...args] };
}

/** The seccomp filter as a file the box reads on descriptor 3, or null off x86-64. */
function openSeccompFile(dir: string): number | null {
  if (!seccompSupported()) return null;
  const file = join(dir, "seccomp.bpf");
  writeFileSync(file, seccompBytes(), { mode: 0o600 });
  return openSync(file, "r");
}

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

function collectCapped(stream: NodeJS.ReadableStream, cap: number, state: { truncated: boolean }): { text(): string } {
  const chunks: Buffer[] = [];
  let kept = 0;
  stream.on("data", (chunk: Buffer) => {
    if (kept >= cap) { state.truncated = true; return; }
    const take = chunk.subarray(0, cap - kept);
    chunks.push(Buffer.from(take));
    kept += take.length;
    if (chunk.length > take.length) state.truncated = true;
  });
  return { text: () => Buffer.concat(chunks).toString("utf8") };
}

/** Runs `argv` with a wall-clock timeout, killing the whole process group on expiry. */
function spawnBoxed(argv: string[], env: Record<string, string>, seccompFd: number | null, timeoutMs: number, cap: number): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    const state = { truncated: false };
    let child: ChildProcess;
    try {
      const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe"];
      if (seccompFd !== null) stdio.push(seccompFd);
      child = spawn(argv[0]!, argv.slice(1), { env, stdio, detached: true });
    } catch {
      resolvePromise({ stdout: "", stderr: "", exitCode: null, timedOut: false, truncated: false });
      return;
    }
    const out = collectCapped(child.stdout!, cap, state);
    const err = collectCapped(child.stderr!, cap, state);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ stdout: out.text(), stderr: err.text(), exitCode: null, timedOut, truncated: state.truncated });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      // A child the code detached in the same group dies with it: the PID namespace's teardown kills the rest, and
      // this catches anything that outlived it.
      if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      resolvePromise({ stdout: out.text(), stderr: err.text(), exitCode, timedOut, truncated: state.truncated });
    });
  });
}

/** Whether this machine can run the box, probed with the real argv shape (/bin/true). A refused probe is not cached:
 * under load a user namespace can be refused once and allowed the next time, and a cached refusal would fail every
 * later run in this process. */
export function detectPythonSandbox(): PythonSandboxDetection {
  if (cachedDetection) return cachedDetection;
  const unsupported = (reason: PythonSandboxReason, bwrap: string | null = null, prlimit: string | null = null): PythonSandboxDetection =>
    ({ supported: false, reason, bwrap, prlimit, seccomp: false });
  if (process.platform !== "linux") { cachedDetection = unsupported("not-linux"); return cachedDetection; }
  const bwrap = whichOnPath("bwrap");
  if (!bwrap) { cachedDetection = unsupported("no-bwrap"); return cachedDetection; }
  const prlimit = whichOnPath("prlimit");
  if (!prlimit) { cachedDetection = unsupported("no-prlimit", bwrap); return cachedDetection; }
  if (!existsSync(BOX_PYTHON)) { cachedDetection = unsupported("no-python", bwrap, prlimit); return cachedDetection; }
  const seccomp = seccompSupported();
  const root = mkdtempSync(join(tmpdir(), "sanremes-python-probe-"));
  let fd: number | null = null;
  try {
    const dataDir = join(root, "data"), home = join(root, "home"), work = join(dataDir, "work");
    mkdirSync(work, { recursive: true });
    mkdirSync(home, { recursive: true });
    fd = openSeccompFile(root);
    const { argv } = pythonBoxArgv({ dataDir, home }, "/bin/true", [], work, seccomp);
    const outcome = spawnBoxedSync([bwrap, ...argv], fd);
    if (!outcome) return { supported: false, reason: "userns-refused", bwrap, prlimit, seccomp };
    cachedDetection = { supported: true, reason: null, bwrap, prlimit, seccomp };
    return cachedDetection;
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch {} }
    rmSync(root, { recursive: true, force: true });
  }
}

function spawnBoxedSync(argv: string[], seccompFd: number | null): boolean {
  try {
    const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "ignore", "ignore"];
    if (seccompFd !== null) stdio.push(seccompFd);
    const result = spawnSync(argv[0]!, argv.slice(1), { stdio, timeout: PROBE_TIMEOUT_MS });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Files the run left in its working folder, relative names, at most 50, code file excluded. */
function listRunFiles(work: string): PythonRunFile[] {
  const files: PythonRunFile[] = [];
  const walk = (dir: string): void => {
    if (files.length >= 50) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= 50) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { files.push({ name: `${relative(work, full)}/`, bytes: 0 }); walk(full); }
      else if (entry.isFile() && entry.name !== RUN_FILENAME) files.push({ name: relative(work, full), bytes: statSync(full).size });
    }
  };
  try { walk(work); } catch { /* a run that removed its own folder lists nothing */ }
  return files;
}

/** Runs Python code in the sandbox and returns its output. Never throws for a bad run: failures come back as `note`. */
export async function runPython(input: RunPythonInput, options: RunPythonOptions = {}): Promise<PythonRunResult> {
  const started = Date.now();
  const detection = detectPythonSandbox();
  if (!detection.supported || !detection.bwrap || !detection.prlimit) {
    const why = detection.reason === "not-linux"
      ? "this machine is not Linux, so there is no bubblewrap sandbox to run Python in"
      : detection.reason === "no-bwrap"
        ? "bubblewrap (bwrap) is not installed on this machine"
        : detection.reason === "no-prlimit"
          ? "prlimit is not installed on this machine, so memory and process limits cannot be enforced"
          : detection.reason === "no-python"
            ? "python3 is not installed in /usr on this machine"
            : "this machine refused to start a bubblewrap sandbox (user namespaces are not allowed here)";
    return failureResult(`Python cannot run here: ${why}. The code was not executed.`, false);
  }
  const code = typeof input.code === "string" ? input.code : "";
  if (!code.trim()) return failureResult("No Python code was given.", detection.seccomp);
  if (code.length > MAX_CODE_CHARS) return failureResult(`The code is ${code.length} characters, over the ${MAX_CODE_CHARS} limit.`, detection.seccomp);
  const timeoutSeconds = Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.floor(input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) || DEFAULT_TIMEOUT_SECONDS));
  const memoryMb = Math.min(MAX_MEMORY_MB, Math.max(MIN_MEMORY_MB, Math.floor(input.memoryMb ?? DEFAULT_MEMORY_MB) || DEFAULT_MEMORY_MB));
  const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const base = options.baseDir ?? join(tmpdir(), "sanremes-python-sandbox");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, "run-"));
  const dataDir = join(root, "data"), home = join(root, "home"), work = join(dataDir, "work");
  let seccompFd: number | null = null;
  try {
    mkdirSync(work, { recursive: true, mode: 0o700 });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(work, RUN_FILENAME), code, { mode: 0o600 });
    seccompFd = openSeccompFile(root);
    const { argv } = pythonBoxArgv({ dataDir, home }, BOX_PYTHON, [RUN_FILENAME], work, detection.seccomp);
    const prlimitArgs = [
      `--as=${memoryMb * 1024 * 1024}`,
      `--nproc=${MAX_PROCESSES}`,
      `--cpu=${timeoutSeconds + 10}`,
      detection.bwrap,
      ...argv,
    ];
    const env = { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: "/tmp", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" };
    const outcome = await spawnBoxed([detection.prlimit, ...prlimitArgs], env, seccompFd, timeoutSeconds * 1000, cap);
    const files = listRunFiles(work);
    const note = outcome.timedOut
      ? `Stopped after ${timeoutSeconds} seconds: the code was still running.`
      : outcome.exitCode === null
        ? "The sandbox stopped without an exit code."
        : null;
    return {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      truncated: outcome.truncated,
      seccomp: detection.seccomp,
      durationMs: Date.now() - started,
      files,
      note,
    };
  } catch (error) {
    return failureResult(`The sandbox failed to start the run: ${error instanceof Error ? error.message : String(error)}`, detection.seccomp);
  } finally {
    if (seccompFd !== null) { try { closeSync(seccompFd); } catch {} }
    if (!options.keepWorkdir) rmSync(root, { recursive: true, force: true });
  }
}
