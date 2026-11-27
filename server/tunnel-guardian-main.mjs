// node tunnel-guardian-main.mjs <cloudflared> <tokenFile> <socketPath> <pid> <originPort>
// Runs unconditionally: nothing imports this file.
// On this process's death the stdin pipe hits EOF: the guardian invalidates
// forwarding, kills cloudflared, and only then releases port 8812, so an
// orphan connector never exposes whatever binds that port later.
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

const TUNNEL_ORIGIN_HOST = "127.0.0.1";
const TUNNEL_ORIGIN_PORT = 8812;

const RUNTIME_PREFIX = "sanremes-tunnel-origin-";
const SOCKET_NAME = "origin.sock";

function validOriginTarget(target, platform = process.platform) {
  if (!Number.isSafeInteger(target?.pid) || target.pid <= 0) return false;
  if (Object.prototype.toString.call(target?.socketPath) !== "[object String]") return false;
  if (platform === "win32") {
    return /^\\\\\.\\pipe\\sanremes-tunnel-origin-[1-9][0-9]*-[0-9a-f-]{36}$/i.test(
      target.socketPath,
    );
  }
  return (
    path.isAbsolute(target.socketPath) &&
    path.basename(target.socketPath) === SOCKET_NAME &&
    path.basename(path.dirname(target.socketPath)).startsWith(RUNTIME_PREFIX)
  );
}

const copyEnvironmentValue = (source, target, names) => {
  const entries = Object.entries(source);
  for (const name of names) {
    const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (found) target[found[0]] = found[1];
  }
};

/** An allowlist of OS process plumbing: every TUNNEL_*, CF_*, CLOUDFLARED_*, proxy, config and secret variable is stripped. */
function minimalCloudflaredEnvironment(environment = process.env, platform = process.platform) {
  const minimal = {};
  copyEnvironmentValue(environment, minimal, ["PATH"]);
  if (platform === "win32") {
    copyEnvironmentValue(environment, minimal, ["SystemRoot", "WINDIR", "TEMP", "TMP"]);
  }
  return minimal;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

const delay = (milliseconds) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });

async function terminateConnector(child, graceMs = 250) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let exited = false;
  const exit = new Promise((resolve) => {
    const finish = () => {
      if (exited) return;
      exited = true;
      resolve();
    };
    child.once("exit", finish);
    child.once("error", () => {
      // Once a pid exists an `error` event does not prove the process died: keep the gateway until `exit`.
      if (!Number.isSafeInteger(child.pid)) finish();
    });
  });
  try {
    child.kill("SIGTERM");
  } catch {}
  await Promise.race([exit, delay(graceMs)]);
  if (exited || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {}
  // Never release the gateway on a timer: holding the port is the fail-closed state until cloudflared is dead.
  await exit;
}

function ownerLoss(ownerInput, signalSource) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ kind: "owner" });
    };
    ownerInput.once("end", finish);
    ownerInput.once("close", finish);
    ownerInput.once("error", finish);
    signalSource.once("SIGINT", finish);
    signalSource.once("SIGTERM", finish);
    ownerInput.resume?.();
  });
}

function unavailable(response) {
  if (response.headersSent) return response.destroy();
  const body = JSON.stringify({ error: "tunnel origin unavailable" });
  response.writeHead(503, {
    "cache-control": "private, no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  response.end(body);
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function endToEndHeaders(headers = {}) {
  const blocked = new Set(HOP_BY_HOP_HEADERS);
  const connection = Array.isArray(headers.connection)
    ? headers.connection.join(",")
    : String(headers.connection ?? "");
  for (const name of connection.split(",")) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => value !== undefined && !blocked.has(name.toLowerCase())),
  );
}

function upgradeHeaders(headers = {}) {
  if (String(headers.upgrade ?? "").toLowerCase() !== "websocket") return null;
  return {
    ...endToEndHeaders(headers),
    connection: "Upgrade",
    upgrade: "websocket",
  };
}

function writeUpgrade(socket, response) {
  const lines = [];
  for (const name of [
    "upgrade",
    "connection",
    "sec-websocket-accept",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]) {
    const value = response.headers[name];
    if (typeof value === "string") lines.push(`${name}: ${value}`);
  }
  socket.write(
    `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`
      + `${lines.join("\r\n")}\r\n\r\n`,
  );
}

function destroySockets(sockets) {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
}

/** The target is immutable for one guardian lifetime and checked again on every request. */
function createOriginGateway({
  target,
  originHost = TUNNEL_ORIGIN_HOST,
  originPort = TUNNEL_ORIGIN_PORT,
  isTargetAlive = () => true,
  createServer = http.createServer,
  request = http.request,
  upstreamTimeoutMs = 30_000,
} = {}) {
  if (!validOriginTarget(target)) {
    throw new Error("The tunnel origin target is invalid");
  }
  let accepting = true;
  let listening = false;
  let transition = Promise.resolve();
  const upgradedSockets = new Set();

  const server = createServer((incoming, outgoing) => {
    if (!accepting || !isTargetAlive(target)) return unavailable(outgoing);
    const upstream = request(
      {
        headers: endToEndHeaders(incoming.headers),
        method: incoming.method,
        path: incoming.url,
        socketPath: target.socketPath,
        timeout: upstreamTimeoutMs,
      },
      (response) => {
        upstream.setTimeout(0);
        if (!accepting || !isTargetAlive(target)) {
          response.destroy();
          return unavailable(outgoing);
        }
        outgoing.writeHead(response.statusCode ?? 502, endToEndHeaders(response.headers));
        // `pipe` does not carry source failures: a sidecar restart mid-response must tear down the client response.
        response.once("error", () => outgoing.destroy());
        response.once("aborted", () => outgoing.destroy());
        response.once("close", () => {
          if (!response.complete) outgoing.destroy();
        });
        response.pipe(outgoing);
      },
    );
    upstream.once("timeout", () => upstream.destroy(new Error("tunnel origin timed out")));
    upstream.once("error", () => unavailable(outgoing));
    incoming.once("aborted", () => upstream.destroy());
    outgoing.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("upgrade", (incoming, socket, head) => {
    // Node removes its own error listener from a socket it hands to `upgrade`.
    socket.on("error", () => socket.destroy());
    if (!accepting || !isTargetAlive(target)) return socket.destroy();
    const headers = upgradeHeaders(incoming.headers);
    if (!headers || incoming.method !== "GET") return socket.destroy();
    upgradedSockets.add(socket);
    let remoteSocket = null;
    const release = () => {
      upgradedSockets.delete(socket);
      if (remoteSocket) upgradedSockets.delete(remoteSocket);
    };
    socket.once("close", release);
    const upstream = request({
      headers,
      method: "GET",
      path: incoming.url,
      socketPath: target.socketPath,
      timeout: upstreamTimeoutMs,
    });
    upstream.once("timeout", () => upstream.destroy(new Error("tunnel origin upgrade timed out")));
    upstream.once("upgrade", (response, remote, remoteHead) => {
      upstream.setTimeout(0);
      remote.setTimeout(0);
      if (!accepting || !isTargetAlive(target)) {
        remote.destroy();
        socket.destroy();
        return;
      }
      writeUpgrade(socket, response);
      remoteSocket = remote;
      upgradedSockets.add(remote);
      // `pipe` forwards no error, so a reset on one end must end the other.
      const teardown = () => {
        socket.destroy();
        remote.destroy();
      };
      socket.on("error", teardown);
      remote.on("error", teardown);
      remote.once("close", release);
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote).pipe(socket);
    });
    upstream.once("response", (response) => {
      response.resume();
      socket.destroy();
    });
    upstream.once("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.end();
  });
  server.on("clientError", (_error, socket) => socket.destroy());

  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  return Object.freeze({
    start() {
      return serialize(async () => {
        if (listening) return server.address();
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen({ exclusive: true, host: originHost, port: originPort });
        });
        listening = true;
        return server.address();
      });
    },

    invalidate() {
      accepting = false;
      server.closeAllConnections?.();
      destroySockets(upgradedSockets);
    },

    close() {
      return serialize(async () => {
        accepting = false;
        server.closeAllConnections?.();
        destroySockets(upgradedSockets);
        if (!listening) return;
        await new Promise((resolve) => server.close(() => resolve()));
        listening = false;
      });
    },
  });
}

async function runGuardian({
  cloudflaredBinary,
  tokenFile,
  target,
  originPort = TUNNEL_ORIGIN_PORT,
  environment = process.env,
  platform = process.platform,
  ownerInput = process.stdin,
  signalSource = process,
  spawnProcess = spawn,
  isTargetAlive = ({ pid }) => processIsAlive(pid),
  createGateway = createOriginGateway,
} = {}) {
  if (!path.isAbsolute(cloudflaredBinary ?? "") || !path.isAbsolute(tokenFile ?? "")) {
    throw new Error("The managed connector paths are invalid");
  }
  if (!validOriginTarget(target, platform)) {
    throw new Error("The tunnel origin target is invalid");
  }
  if (!Number.isInteger(originPort) || originPort < 1 || originPort > 65_535) {
    throw new Error("The tunnel origin port is invalid");
  }

  const gateway = createGateway({
    target,
    originPort,
    isTargetAlive,
  });
  await gateway.start();

  let connector;
  try {
    connector = spawnProcess(
      cloudflaredBinary,
      [
        "tunnel",
        "--no-autoupdate",
        "--loglevel",
        "info",
        "--output",
        "json",
        "run",
        "--token-file",
        tokenFile,
      ],
      {
        env: minimalCloudflaredEnvironment(environment, platform),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
  } catch (error) {
    gateway.invalidate();
    await gateway.close();
    throw error;
  }

  const connectorExit = new Promise((resolve) => {
    connector.once("exit", (code) => resolve({ kind: "connector", code: code ?? 1 }));
    connector.once("error", () => {
      if (!Number.isSafeInteger(connector.pid)) {
        resolve({ kind: "connector", code: 1 });
      }
    });
  });
  const outcome = await Promise.race([connectorExit, ownerLoss(ownerInput, signalSource)]);

  gateway.invalidate();
  if (outcome.kind === "owner") await terminateConnector(connector);
  await gateway.close();
  return outcome.kind === "connector" ? outcome.code : 0;
}

function guardianArguments(argv) {
  if (argv.length !== 5) throw new Error("The tunnel guardian arguments are invalid");
  const [cloudflaredBinary, tokenFile, socketPath, rawPid, rawPort] = argv;
  const pid = Number(rawPid);
  const originPort = Number(rawPort);
  const target = { pid, socketPath };
  if (!validOriginTarget(target)) {
    throw new Error("The tunnel guardian target is invalid");
  }
  return { cloudflaredBinary, tokenFile, target, originPort };
}

runGuardian(guardianArguments(process.argv.slice(2))).then(
  (code) => process.exit(code),
  () => process.exit(1),
);
