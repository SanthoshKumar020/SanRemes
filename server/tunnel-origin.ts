// The tunnel's origin: a private socket in /tmp that the server listens on,
// and the loopback gateway the connector forwards to. The hosted connector
// never reaches the LAN listener, only this gateway to the exact sidecar's socket.
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

export const TUNNEL_ORIGIN_HOST = "127.0.0.1";
export const TUNNEL_ORIGIN_PORT = 8812;

const RUNTIME_PREFIX = "sanremes-tunnel-origin-";
const SOCKET_NAME = "origin.sock";

const currentUserId = (): number | undefined => {
  if (process.getuid) return process.getuid();
  const uid = userInfo().uid;
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : undefined;
};

export interface TunnelOriginEndpoint {
  readonly pid: number;
  readonly socketPath: string;
  readonly directory: string | null;
}

export function validOriginTarget(target: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const candidate = target as { pid?: unknown; socketPath?: unknown } | null;
  if (!Number.isSafeInteger(candidate?.pid) || (candidate!.pid as number) <= 0) return false;
  if (Object.prototype.toString.call(candidate?.socketPath) !== "[object String]") return false;
  if (platform === "win32") {
    return /^\\\\\.\\pipe\\sanremes-tunnel-origin-[1-9][0-9]*-[0-9a-f-]{36}$/i.test(candidate!.socketPath as string);
  }
  return (
    isAbsolute(candidate!.socketPath as string) &&
    basename(candidate!.socketPath as string) === SOCKET_NAME &&
    basename(dirname(candidate!.socketPath as string)).startsWith(RUNTIME_PREFIX)
  );
}

export function createOriginEndpoint({
  platform = process.platform,
  processId = process.pid,
  identifier = randomUUID,
  temporaryRoot,
  currentUid = currentUserId(),
}: {
  platform?: NodeJS.Platform;
  processId?: number;
  temporaryRoot?: string;
  identifier?: () => string;
  currentUid?: number;
} = {}): TunnelOriginEndpoint {
  if (platform === "win32") {
    return Object.freeze({
      pid: processId,
      socketPath: `\\\\.\\pipe\\sanremes-tunnel-origin-${processId}-${identifier()}`,
      directory: null,
    });
  }

  // Darwin's sockaddr_un path is short; /tmp (realpath /private/tmp) stays below it even with a long userData.
  const root = temporaryRoot ?? realpathSync("/tmp");
  const directory = mkdtempSync(join(root, RUNTIME_PREFIX));
  try {
    chmodSync(directory, 0o700);
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (currentUid !== undefined && stat.uid !== currentUid)
    ) {
      throw new Error("The tunnel origin directory is unsafe");
    }
    const socketPath = join(directory, SOCKET_NAME);
    if (Buffer.byteLength(socketPath) > 96) {
      throw new Error("The tunnel origin socket path is too long");
    }
    return Object.freeze({ pid: processId, socketPath, directory });
  } catch (error) {
    try {
      rmdirSync(directory);
    } catch {
      // The directory is left for the OS temp sweep.
    }
    throw error;
  }
}

/** Clean only the exact socket/directory allocated above. */
export function cleanupOriginEndpoint(
  endpoint: TunnelOriginEndpoint,
  { platform = process.platform, currentUid = currentUserId() }: { platform?: NodeJS.Platform; currentUid?: number } = {},
): void {
  if (platform === "win32" || !endpoint?.directory) return;
  const directory = endpoint.directory;
  if (
    basename(directory).startsWith(RUNTIME_PREFIX) === false ||
    dirname(endpoint.socketPath) !== directory ||
    basename(endpoint.socketPath) !== SOCKET_NAME
  ) {
    return;
  }
  try {
    const directoryStat = lstatSync(directory);
    if (
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      (currentUid !== undefined && directoryStat.uid !== currentUid)
    ) {
      return;
    }
    try {
      const socketStat = lstatSync(endpoint.socketPath);
      if (
        socketStat.isSocket() &&
        !socketStat.isSymbolicLink() &&
        (currentUid === undefined || socketStat.uid === currentUid)
      ) {
        unlinkSync(endpoint.socketPath);
      }
    } catch (error) {
      if ((error as { code?: string })?.code !== "ENOENT") return;
    }
    rmdirSync(directory);
  } catch {
    // A directory that cannot be verified is left alone.
  }
}
