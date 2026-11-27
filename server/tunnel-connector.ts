// The managed tunnel: the connector token reaches cloudflared only through a
// private short-lived file, never argv, the environment, status or logs. A
// guardian process (server/tunnel-guardian-main.mjs) owns the gateway and the
// connector, so no orphan connector outlives this process.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeTunnelEndpoint, TUNNEL_ENDPOINT_FIELD, TUNNEL_TOKEN_FIELD } from "./tunnel-account.ts";
import { TUNNEL_ORIGIN_PORT, validOriginTarget } from "./tunnel-origin.ts";

export interface ManagedTunnelAccess {
  endpoint: string;
  token: string;
}

export interface ManagedTunnelState {
  status: string;
  ready: boolean;
  configured?: boolean;
  error?: string;
  retryInMs?: number;
}

export interface ManagedTunnelOriginTarget {
  pid: number;
  socketPath: string;
}

export interface ManagedTunnel {
  start(access: ManagedTunnelAccess & { originTarget: ManagedTunnelOriginTarget }): Promise<ManagedTunnelState>;
  stop(): Promise<ManagedTunnelState>;
  shutdown(): Promise<ManagedTunnelState>;
}

const TOKEN_FILE_PATTERN = /^connector-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.token$/;
const TOKEN_MIN_BYTES = 40;
const TOKEN_MAX_BYTES = 16 * 1024;

function validConnectorToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value);
  return (
    bytes >= TOKEN_MIN_BYTES &&
    bytes <= TOKEN_MAX_BYTES &&
    value.trim() === value &&
    !/[\0\r\n\t ]/.test(value)
  );
}

function normalizeManagedAccess(credentials: Record<string, unknown>): ManagedTunnelAccess | null {
  const endpoint = normalizeTunnelEndpoint(credentials?.[TUNNEL_ENDPOINT_FIELD]);
  const token = credentials?.[TUNNEL_TOKEN_FIELD];
  if (!endpoint || !validConnectorToken(token)) return null;
  return { endpoint, token };
}

export function stagedCloudflaredPath({ appPath, platform = process.platform, arch = process.arch }: {
  appPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
} = {}): string {
  const executable = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  return path.join(String(appPath ?? ""), "dist-native", "cloudflared", `${platform}-${arch}`, executable);
}

/** Packaged apps trust only the connector shipped in Resources. */
export function resolveCloudflaredBinary({
  isPackaged,
  resourcesPath,
  appPath,
  platform = process.platform,
  arch = process.arch,
  environment = process.env,
  exists = fs.existsSync,
}: {
  isPackaged?: boolean;
  resourcesPath?: string;
  appPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  environment?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
} = {}): string | null {
  const executable = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const bundled = path.join(String(resourcesPath ?? ""), "cloudflared", executable);
  if (isPackaged) return exists(bundled) ? bundled : null;

  const override = environment.SANREMES_CLOUDFLARED_PATH?.trim();
  if (override) return path.isAbsolute(override) && exists(override) ? override : null;

  const staged = stagedCloudflaredPath({ appPath, platform, arch });
  if (exists(staged)) return staged;
  const pathEntry = Object.entries(environment).find(([name]) => name.toLowerCase() === "path");
  const pathValue = pathEntry?.[1];
  if (!pathValue) return null;
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, executable);
    if (exists(candidate)) return candidate;
  }
  return null;
}

const copyEnvironmentValue = (source: NodeJS.ProcessEnv, target: NodeJS.ProcessEnv, names: string[]): void => {
  const entries = Object.entries(source);
  for (const name of names) {
    const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (found) target[found[0]] = found[1];
  }
};

/** An allowlist of OS process plumbing: every TUNNEL_*, CF_*, CLOUDFLARED_*, proxy, config and secret variable is stripped. */
export function minimalCloudflaredEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const minimal: NodeJS.ProcessEnv = {};
  copyEnvironmentValue(environment, minimal, ["PATH"]);
  if (platform === "win32") {
    copyEnvironmentValue(environment, minimal, ["SystemRoot", "WINDIR", "TEMP", "TMP"]);
  }
  return minimal;
}

export function minimalGuardianEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return {
    ...minimalCloudflaredEnvironment(environment, platform),
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function ensurePrivateDirectory(directory: string, fileSystem: typeof fs, currentUid: number | undefined): void {
  fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fileSystem.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The managed tunnel runtime path is unsafe");
  }
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error("The managed tunnel runtime path has an unexpected owner");
  }
  fileSystem.chmodSync(directory, 0o700);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string })?.code !== "ESRCH";
  }
}

// Node reports synthetic uids on Windows; ACLs on the per-user data directory are the ownership boundary there.
const currentUserId = (): number | undefined =>
  process.platform === "win32" ? undefined : (process.getuid?.() ?? os.userInfo().uid);

/** Suspicious paths are preserved instead of broadening cleanup around a secret. */
export function cleanupStaleTunnelTokens(
  runtimeRoot: string,
  {
    fileSystem = fs,
    currentUid = currentUserId(),
    isProcessAlive = processIsAlive,
  }: {
    fileSystem?: typeof fs;
    currentUid?: number;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): number {
  let entries: fs.Dirent[];
  try {
    ensurePrivateDirectory(runtimeRoot, fileSystem, currentUid);
    entries = fileSystem.readdirSync(runtimeRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const match = TOKEN_FILE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
    const ownerPid = Number(match[1]);
    if (!Number.isSafeInteger(ownerPid) || isProcessAlive(ownerPid)) continue;
    const file = path.join(runtimeRoot, entry.name);
    try {
      const stat = fileSystem.lstatSync(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (currentUid !== undefined && stat.uid !== currentUid) ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      ) {
        continue;
      }
      fileSystem.unlinkSync(file);
      removed += 1;
    } catch {
      // A token file that cannot be verified is left alone.
    }
  }
  return removed;
}

function writePrivateToken(
  runtimeRoot: string,
  token: string,
  { fileSystem, processId, identifier, currentUid }: {
    fileSystem: typeof fs;
    processId: number;
    identifier: () => string;
    currentUid: number | undefined;
  },
): string {
  ensurePrivateDirectory(runtimeRoot, fileSystem, currentUid);
  const file = path.join(runtimeRoot, `connector-${processId}-${identifier()}.token`);
  let descriptor: number | undefined;
  try {
    descriptor = fileSystem.openSync(file, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, token, "utf8");
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.chmodSync(file, 0o600);
    return file;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        // The descriptor is closed on the way out regardless.
      }
    }
    try {
      fileSystem.unlinkSync(file);
    } catch {
      // The partial file is left for the stale-token sweep.
    }
    throw error;
  }
}

async function waitForExit(child: ChildProcess, milliseconds: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", finish);
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
  });
}

async function terminateChild(child: ChildProcess | null, graceMs: number): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // Synchronously, so stop intent preempts a hanging health probe; the guardian kills cloudflared before releasing 8812.
  try {
    child.stdin?.end();
  } catch {
    // A child with no stdin still gets the signal below.
  }
  await waitForExit(child, graceMs);
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // A child that already died needs no signal.
  }
  // Never SIGKILL the guardian: a wedged cloudflared would outlive it while 8812 is released. A stuck guardian keeps 8812 closed.
  await waitForExit(child, Math.min(graceMs, 500));
}

async function verifyHostedEndpoint(
  endpoint: string,
  { fetchImpl, timeoutSignal, timeoutMs, cancellationSignal }: {
    fetchImpl: typeof fetch;
    timeoutSignal: (milliseconds: number) => AbortSignal;
    timeoutMs: number;
    cancellationSignal?: AbortSignal;
  },
): Promise<boolean> {
  const requestSignal = timeoutSignal(timeoutMs);
  const response = await fetchImpl(`${endpoint}/api/health`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: cancellationSignal
      ? AbortSignal.any([requestSignal, cancellationSignal])
      : requestSignal,
  });
  if (!response.ok) return false;
  const text = await response.text();
  if (Buffer.byteLength(text) > 4096) return false;
  try {
    return (JSON.parse(text) as { app?: unknown })?.app === "sanremes";
  } catch {
    return false;
  }
}

/** Its public state is secret-free, safe for diagnostics. */
export function createManagedTunnel({
  binaryPath,
  guardianEntry,
  runtimeExecutable = process.execPath,
  originPort = TUNNEL_ORIGIN_PORT,
  runtimeRoot,
  environment = process.env,
  fileSystem = fs,
  spawnProcess = spawn,
  fetchImpl = globalThis.fetch,
  timeoutSignal = (milliseconds: number) => AbortSignal.timeout(milliseconds),
  identifier = randomUUID,
  processId = process.pid,
  currentUid = currentUserId(),
  isProcessAlive = processIsAlive,
  verifyTimeoutMs = 15_000,
  verifyRequestTimeoutMs = 2_500,
  verifyIntervalMs = 250,
  stopGraceMs = 1_500,
  maxRetryMs = 30_000,
  onChange = () => {},
  log = () => {},
}: {
  binaryPath: string | null;
  guardianEntry: string | null;
  runtimeExecutable?: string;
  originPort?: number;
  runtimeRoot: string;
  environment?: NodeJS.ProcessEnv;
  fileSystem?: typeof fs;
  spawnProcess?: typeof spawn;
  fetchImpl?: typeof fetch;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
  identifier?: () => string;
  processId?: number;
  currentUid?: number;
  isProcessAlive?: (pid: number) => boolean;
  verifyTimeoutMs?: number;
  verifyRequestTimeoutMs?: number;
  verifyIntervalMs?: number;
  stopGraceMs?: number;
  maxRetryMs?: number;
  onChange?: (state: ManagedTunnelState) => void;
  log?: (line: string) => void;
}): ManagedTunnel {
  let desired = false;
  let generation = 0;
  let intentRevision = 0;
  let child: ChildProcess | null = null;
  let tokenFile: string | null = null;
  let activeAttempt: { generation: number; cancel(): void } | null = null;
  let originTarget: ManagedTunnelOriginTarget | null = null;
  let access: ManagedTunnelAccess | null = null;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let state: ManagedTunnelState = Object.freeze({ status: "stopped", ready: false, configured: false });
  let transition = Promise.resolve();

  cleanupStaleTunnelTokens(runtimeRoot, {
    fileSystem,
    currentUid,
    isProcessAlive,
  });

  const publish = (next: ManagedTunnelState): ManagedTunnelState => {
    const published: ManagedTunnelState = {
      ...next,
      configured: Boolean(access),
      ready: next.status === "ready",
    };
    if (access) (published as { endpoint?: string }).endpoint = access.endpoint;
    state = Object.freeze(published);
    onChange(state);
    return state;
  };

  const removeTokenFile = (file: string | null = tokenFile): void => {
    if (!file) return;
    if (tokenFile === file) tokenFile = null;
    try {
      fileSystem.unlinkSync(file);
    } catch (error) {
      if ((error as { code?: string })?.code !== "ENOENT") log("managed tunnel connector token cleanup failed");
    }
  };

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const scheduleRetry = (reason: string, ownedGeneration: number): void => {
    if (!desired || ownedGeneration !== generation || retryTimer) return;
    const delay = Math.min(1_000 * 2 ** retryAttempt, maxRetryMs);
    retryAttempt += 1;
    publish({ status: "retrying", ready: false, error: reason, retryInMs: delay });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!desired || ownedGeneration !== generation) return;
      void serialize(() => attempt(ownedGeneration));
    }, delay);
    retryTimer.unref?.();
  };

  const attempt = async (ownedGeneration: number): Promise<ManagedTunnelState> => {
    if (!desired || ownedGeneration !== generation || !access) return state;
    const currentAccess = access;
    if (
      !binaryPath ||
      !path.isAbsolute(binaryPath) ||
      !guardianEntry ||
      !path.isAbsolute(guardianEntry) ||
      !path.isAbsolute(runtimeExecutable) ||
      !validOriginTarget(originTarget)
    ) {
      publish({
        status: "unavailable",
        ready: false,
        error: "The managed tunnel connector is missing from this build.",
      });
      return state;
    }

    publish({ status: "starting", ready: false });
    let attemptHandle: { generation: number; cancel(): void } | null = null;
    let attemptTokenFile: string | null = null;
    try {
      tokenFile = writePrivateToken(runtimeRoot, currentAccess.token, {
        fileSystem,
        processId,
        identifier,
        currentUid,
      });
      attemptTokenFile = tokenFile;
      const spawned = spawnProcess(
        runtimeExecutable,
        [
          guardianEntry,
          binaryPath,
          tokenFile,
          originTarget!.socketPath,
          String(originTarget!.pid),
          String(originPort),
        ],
        {
          env: minimalGuardianEnvironment(environment),
          shell: false,
          windowsHide: true,
          // This open pipe is the parent-death signal: the guardian tears down gateway and connector on EOF.
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      child = spawned;
      const cancellationController = new AbortController();
      let resolveCancellation!: (value: boolean) => void;
      const cancellation = new Promise<boolean>((resolve) => {
        resolveCancellation = resolve;
      });
      let cancelled = false;
      attemptHandle = {
        generation: ownedGeneration,
        cancel() {
          if (cancelled) return;
          cancelled = true;
          cancellationController.abort();
          resolveCancellation(false);
        },
      };
      activeAttempt = attemptHandle;
      let terminated = false;
      let expectedStop = false;
      let resolveExit!: () => void;
      const exit = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const onTerminated = () => {
        if (terminated) return;
        terminated = true;
        resolveExit();
        if (child === spawned) child = null;
        removeTokenFile(attemptTokenFile);
        if (!expectedStop && desired && ownedGeneration === generation) {
          scheduleRetry("The secure connection stopped unexpectedly.", ownedGeneration);
        }
      };
      spawned.once("exit", onTerminated);
      // A child that fails before spawn emits `error` and `close`, not necessarily `exit`.
      spawned.once("error", onTerminated);

      const deadline = Date.now() + verifyTimeoutMs;
      while (desired && ownedGeneration === generation && child === spawned && !terminated) {
        const verified = await Promise.race([
          verifyHostedEndpoint(currentAccess.endpoint, {
            fetchImpl,
            timeoutSignal,
            timeoutMs: verifyRequestTimeoutMs,
            cancellationSignal: cancellationController.signal,
          }).catch(() => false),
          exit.then(() => false),
          cancellation,
        ]);
        if (verified && child === spawned && desired && ownedGeneration === generation) {
          removeTokenFile(attemptTokenFile);
          retryAttempt = 0;
          publish({ status: "ready", ready: true });
          return state;
        }
        if (Date.now() >= deadline) break;
        await Promise.race([
          new Promise((resolve) => {
            const timer = setTimeout(resolve, verifyIntervalMs);
            timer.unref?.();
          }),
          exit,
          cancellation,
        ]);
      }

      if (child === spawned) {
        // Invalidate this exit before asking the child to stop, or its handler and this attempt both schedule a retry.
        expectedStop = true;
        child = null;
        await terminateChild(spawned, stopGraceMs);
      }
      removeTokenFile(attemptTokenFile);
      if (desired && ownedGeneration === generation) {
        scheduleRetry("The secure connection could not be verified.", ownedGeneration);
      }
      return state;
    } catch {
      const spawned = child;
      child = null;
      removeTokenFile(attemptTokenFile);
      if (spawned) await terminateChild(spawned, stopGraceMs);
      if (desired && ownedGeneration === generation) {
        scheduleRetry("The secure connection could not start.", ownedGeneration);
      }
      return state;
    } finally {
      if (activeAttempt === attemptHandle) activeAttempt = null;
    }
  };

  const tunnel: ManagedTunnel = Object.freeze({
    start(rawAccess: ManagedTunnelAccess & { originTarget: ManagedTunnelOriginTarget }) {
      const requestedRevision = ++intentRevision;
      return serialize(async () => {
        // A stop requested before this queued start began wins (start and quit can land in one event-loop turn).
        if (requestedRevision !== intentRevision) return state;
        const normalized = normalizeManagedAccess({
          [TUNNEL_ENDPOINT_FIELD]: rawAccess?.endpoint,
          [TUNNEL_TOKEN_FIELD]: rawAccess?.token,
        });
        const normalizedOriginTarget = validOriginTarget(rawAccess?.originTarget)
          ? Object.freeze({
              pid: rawAccess.originTarget.pid,
              socketPath: rawAccess.originTarget.socketPath,
            })
          : null;
        if (
          desired &&
          normalized &&
          access?.endpoint === normalized.endpoint &&
          access?.token === normalized.token &&
          originTarget?.pid === normalizedOriginTarget?.pid &&
          originTarget?.socketPath === normalizedOriginTarget?.socketPath &&
          child
        ) {
          return state;
        }
        generation += 1;
        desired = Boolean(normalized);
        access = normalized;
        originTarget = normalizedOriginTarget;
        retryAttempt = 0;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        const existing = child;
        child = null;
        if (existing) await terminateChild(existing, stopGraceMs);
        removeTokenFile();
        if (!access) {
          return publish({
            status: "unconfigured",
            ready: false,
            error: "Sign in to enable a secure connection from any network.",
          });
        }
        return attempt(generation);
      });
    },

    stop() {
      // Stop intent must not wait behind the 15-second startup probe.
      const requestedRevision = ++intentRevision;
      desired = false;
      generation += 1;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      activeAttempt?.cancel();
      const existing = child;
      child = null;
      const existingTokenFile = tokenFile;
      removeTokenFile(existingTokenFile);
      const terminated = existing
        ? terminateChild(existing, stopGraceMs)
        : Promise.resolve();

      return serialize(async () => {
        await terminated;
        if (requestedRevision !== intentRevision) return state;
        return publish({ status: "stopped", ready: false });
      });
    },

    shutdown() {
      return tunnel.stop();
    },
  });
  return tunnel;
}
