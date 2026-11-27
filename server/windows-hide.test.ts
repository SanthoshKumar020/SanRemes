import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");

/** The spawn call starting at `marker` hides its console window on Windows: a console child spawned from the
 * windowless desktop app flashes a command prompt otherwise. */
function expectHidden(path: string, marker: string): void {
  const source = read(path);
  const at = source.indexOf(marker);
  expect(at, `${path}: ${marker}`).toBeGreaterThanOrEqual(0);
  const options = source.slice(at, at + 400);
  expect(options, `${path}: ${marker}`).toContain("windowsHide: true");
  expect(options, `${path}: ${marker}`).not.toContain("windowsHide: false");
}

describe("console children stay hidden on Windows", () => {
  it("hides the tailscale probe and serve children", () => {
    expectHidden("server/tailscale.ts", "{ timeout: timeoutMs, killSignal: \"SIGKILL\", maxBuffer: 16 * 1024 * 1024, env: tailscaleEnvironment()");
    expectHidden("server/tailscale.ts", "[\"serve\", `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`]");
  });
  it("hides the cloudflared preparation child", () => {
    expectHidden("server/tunnel.ts", "[prepareEntry(options.here), \"--current\", \"--root\", options.dataDir]");
  });
  it("hides the server child the serve command starts", () => {
    expectHidden("server/cli.ts", "spawn(entry.command, entry.args");
  });
  it("hides the caddy extraction child", () => {
    expectHidden("server/caddy.ts", "spawnSync(\"tar\"");
  });
  it("hides the npm child that pins a service copy", () => {
    expectHidden("server/service-cli.ts", "spawnSync(npm,");
  });
  it("hides the VPS wake script and ssh children", () => {
    expectHidden("server/vps-ssh.ts", "spawn(file, [alias]");
    expectHidden("server/vps-ssh.ts", "execFile(\"ssh\", args");
  });
  it("hides the host doctor's probe children", () => {
    expectHidden("server/headless/host-doctor.ts", "execFile(command, args, { timeout: 10_000");
  });
});
