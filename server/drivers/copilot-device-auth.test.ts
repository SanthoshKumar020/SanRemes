import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { signInOf } from "../harness/registry.ts";
import { COPILOT_DEVICE_SIGN_IN, CopilotDeviceAuthController, copilotDevicePrompt } from "./copilot-device-auth.ts";
import { CopilotAgentDriver } from "./acp/copilot.ts";

// Every subprocess is this script in a disposable HOME: no real Copilot, network or credentials. The `login
// --device-code` branch prints Copilot CLI 1.0.117's own lines; the `--acp` branch hands the discovery probe to
// the repository's fake ACP CLI, signed out until the login writes its marker, as a stored token would.
const FAKE = `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const home = process.env.HOME;
const mode = process.env.FAKE_AUTH_MODE || 'success';
const args = process.argv.slice(2);
appendFileSync(join(home, 'calls.jsonl'), JSON.stringify({ args }) + '\\n');
if (args[0] === '--version') { console.log('GitHub Copilot CLI 1.0.117.'); process.exit(0); }
else if (args[0] === '--acp') {
  const marker = existsSync(join(home, 'authenticated'));
  const acp = spawn(process.execPath, ['--experimental-strip-types', process.env.FAKE_ACP_CLI_PATH, ...args.slice(1)],
    { stdio: 'inherit', env: { ...process.env, FAKE_ACP_MODE: marker ? 'happy' : 'auth-required' } });
  acp.on('close', (code) => process.exit(code ?? 1));
  acp.on('error', () => process.exit(1));
} else if (args.join(' ') === 'login --device-code') {
  writeFileSync(join(home, 'pid'), String(process.pid));
  if (mode === 'old') { console.error("error: unexpected argument '--device-code' found"); process.exit(2); }
  else if (mode === 'evil') {
    console.error('To authenticate, visit https://evil.example/login/device and enter code ABCD-1234');
    setInterval(() => {}, 1000);
  } else if (mode !== 'no-prompt') {
    console.error('To authenticate, visit https://github.com/login/device and enter code ABCD-1234');
    console.error('Waiting for authorization...');
    if (mode === 'clipboard') console.error('Failed to copy to clipboard. Please visit https://github.com/login/device and enter the code ABCD-1234 manually.');
  }
  if (mode === 'success' || mode === 'clipboard') setTimeout(() => { writeFileSync(join(home, 'authenticated'), 'fake fixture only'); process.exit(0); }, 80);
  else if (mode === 'crash') setTimeout(() => { console.error('access_token=secret-token'); process.exit(1); }, 50);
  else if (mode === 'no-prompt') process.exit(0);
  else { if (mode === 'ignore-term') process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
} else process.exit(4);
`;

const PROMPT = "To authenticate, visit https://github.com/login/device and enter code ABCD-1234\nWaiting for authorization...\n";

describe("Copilot device prompt extraction", () => {
  it("extracts the code from Copilot CLI 1.0.117's own line, clipboard reprint included", () => {
    expect(copilotDevicePrompt(PROMPT)).toEqual({ authorizationUrl: "https://github.com/login/device", userCode: "ABCD-1234" });
    expect(copilotDevicePrompt(`${PROMPT}Failed to copy to clipboard. Please visit https://github.com/login/device and enter the code ABCD-1234 manually.\n`))
      .toEqual({ authorizationUrl: "https://github.com/login/device", userCode: "ABCD-1234" });
    expect(copilotDevicePrompt(`\u001b[36m${PROMPT}\u001b[0m`)).toEqual({ authorizationUrl: "https://github.com/login/device", userCode: "ABCD-1234" });
  });

  it("never reads an unfinished code line", () => {
    expect(copilotDevicePrompt("To authenticate, visit https://github.com/login/device and enter code ABCD-12")).toBeNull();
  });

  it("rejects anything but GitHub's own device page and a well-formed code", () => {
    for (const url of ["http://github.com/login/device", "https://evil.example/login/device", "https://github.com/login/device?token=secret", "https://github.com/login/device#token", "https://user@github.com/login/device", "https://github.com/login/device/extra"]) {
      expect(copilotDevicePrompt(`To authenticate, visit ${url} and enter code ABCD-1234\nWaiting for authorization...\n`)).toBeNull();
    }
    expect(copilotDevicePrompt("To authenticate, visit https://github.com/login/device and enter code ABCD-123\nWaiting for authorization...\n")).toBeNull();
    expect(copilotDevicePrompt("To authenticate, visit https://github.com/login/device and enter code secret-token-value\nWaiting for authorization...\n")).toBeNull();
  });

  it("keeps the newest pair when the CLI prints a new code", () => {
    expect(copilotDevicePrompt(`${PROMPT}To authenticate, visit https://github.com/login/device and enter code WXYZ-9876\nWaiting for authorization...\n`))
      .toEqual({ authorizationUrl: "https://github.com/login/device", userCode: "WXYZ-9876" });
  });
});

describe("Copilot server-owned device authentication", () => {
  let home: string;
  let cli: string;
  let controllers: CopilotDeviceAuthController[];
  const create = (mode = "success", overrides: Partial<ConstructorParameters<typeof CopilotDeviceAuthController>[0]> = {}) => {
    const controller = new CopilotDeviceAuthController({
      cli, environment: () => ({ ...process.env, HOME: home, COPILOT_HOME: join(home, ".copilot"), FAKE_AUTH_MODE: mode }),
      startupTimeoutMs: 10_000, lifetimeMs: 15_000, terminateTimeoutMs: 50,
      ...overrides,
    });
    controllers.push(controller);
    return controller;
  };
  const calls = () => readFileSync(join(home, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sanremes-copilot-device-auth-"));
    cli = join(home, "fake-copilot.mjs");
    writeFileSync(cli, FAKE, { mode: 0o700 });
    chmodSync(cli, 0o700);
    controllers = [];
  });
  afterEach(async () => {
    await Promise.all(controllers.map((controller) => controller.dispose()));
    await removeTempDir(home);
  });

  it("names its own command and confirms on the CLI's exit, with no status probe", () => {
    expect(COPILOT_DEVICE_SIGN_IN.provider).toBe("copilot");
    expect(COPILOT_DEVICE_SIGN_IN.loginArgs).toEqual(["login", "--device-code"]);
    expect(COPILOT_DEVICE_SIGN_IN.loginExitConfirms).toBe(true);
    expect(COPILOT_DEVICE_SIGN_IN.homeEnv).toBe("COPILOT_HOME");
    expect(COPILOT_DEVICE_SIGN_IN.status).toBeUndefined();
    expect(COPILOT_DEVICE_SIGN_IN.logoutArgs).toBeUndefined();
  });

  it("returns the device code, confirms the exit, and clears the code on completion", async () => {
    const controller = create("success");
    const start = await controller.start();
    expect(start).toMatchObject({ phase: "waiting", userCode: "ABCD-1234", authorizationUrl: "https://github.com/login/device" });
    expect(start.flowId).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(() => controller.get(start.flowId!), { timeout: 5_000 })
      .toEqual({ phase: "succeeded", flowId: start.flowId, authorizationUrl: null, expiresAt: null });
    expect(existsSync(join(home, "authenticated"))).toBe(true);
    // No `login status` exists in Copilot CLI 1.0.117: only the login itself runs.
    expect(calls().map((call) => call.args)).toEqual([["login", "--device-code"]]);
    await expect(controller.get("another-user-flow")).rejects.toThrow("no longer available");
  });

  it("keeps the same code through the clipboard reprint", async () => {
    const controller = create("clipboard");
    const start = await controller.start();
    expect(start).toMatchObject({ phase: "waiting", userCode: "ABCD-1234" });
    await expect.poll(() => controller.get(start.flowId!), { timeout: 5_000 }).toMatchObject({ phase: "succeeded" });
  });

  it.each([["old", "needs updating"], ["crash", "did not finish"]])("reports a safe, actionable %s failure", async (mode, message) => {
    const controller = create(mode);
    if (mode === "old") {
      await expect(controller.start()).rejects.toThrow(message);
    } else {
      const start = await controller.start();
      await expect.poll(() => controller.get(start.flowId!), { timeout: 5_000 }).toMatchObject({ phase: "failed" });
      expect(JSON.stringify(await controller.get(start.flowId!))).not.toContain("secret-token");
    }
    await controller.cancel();
    expect(alive(Number(readFileSync(join(home, "pid"), "utf8")))).toBe(false);
  });

  it("fails when the login exits without a code", async () => {
    await expect(create("no-prompt").start()).rejects.toThrow("did not finish");
  });

  it("bounds startup and reaps a process that prints an untrusted page", async () => {
    const controller = create("evil", { startupTimeoutMs: 250 });
    await expect(controller.start()).rejects.toThrow("did not provide a sign-in code in time");
    await controller.cancel();
    expect(alive(Number(readFileSync(join(home, "pid"), "utf8")))).toBe(false);
  });

  it("cancels and escalates shutdown for a CLI that ignores graceful termination", async () => {
    const controller = create("ignore-term");
    const start = await controller.start();
    const pid = Number(readFileSync(join(home, "pid"), "utf8"));
    expect(alive(pid)).toBe(true);
    await controller.cancel();
    expect(alive(pid)).toBe(false);
    expect(await controller.get(start.flowId!)).toMatchObject({ phase: "cancelled", authorizationUrl: null });
    expect((await controller.get(start.flowId!)).userCode).toBeUndefined();
  });

  it("expires and reaps an unattended flow", async () => {
    const controller = create("waiting", { lifetimeMs: 1500 });
    const start = await controller.start();
    await expect.poll(async () => (await controller.get(start.flowId!)).phase, { timeout: 5000 }).toBe("expired");
    await controller.cancel();
    expect(alive(Number(readFileSync(join(home, "pid"), "utf8")))).toBe(false);
  });

  it("fails safely when the configured executable is missing", async () => {
    await expect(create("success", { cli: join(home, "missing-copilot") }).start()).rejects.toThrow("not installed on this server");
  });

  it("locks shared credentials across instances and releases only after cancellation", async () => {
    const one = create("waiting");
    const two = create("waiting");
    const first = await one.start();
    await expect(two.start()).rejects.toThrow("already running for this server account");
    await one.cancel();
    const second = await two.start();
    expect(second.flowId).not.toBe(first.flowId);
    await expect(two.get(first.flowId!)).rejects.toThrow("no longer available");
    await two.dispose();
    await expect(two.start()).rejects.toThrow("provider was removed");
  });
});

describe("Copilot driver device sign-in", () => {
  let scratch: string;
  let home: string;
  let instance: ProviderInstance | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "sanremes-copilot-device-driver-"));
    home = join(scratch, "home");
    mkdirSync(home, { recursive: true });
    const cli = join(home, "fake-copilot.mjs");
    writeFileSync(cli, FAKE, { mode: 0o700 });
    chmodSync(cli, 0o700);
  });
  afterEach(async () => {
    await instance?.dispose();
    instance = undefined;
    await removeTempDir(scratch);
  });

  it("exposes the device flow and the sign-in probe reports signed in once it succeeds", async () => {
    instance = await CopilotAgentDriver.create({
      instanceId: `copilot-device-${Math.random().toString(36).slice(2)}`,
      displayName: "GitHub Copilot", enabled: true,
      environment: {
        HOME: home, COPILOT_HOME: join(home, ".copilot"),
        FAKE_ACP_MODELS: "claude-haiku-4.5,auto",
        FAKE_ACP_CLI_PATH: join(dirname(fileURLToPath(import.meta.url)), "../testing/fake-acp-cli.ts"),
        COPILOT_GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_TOKEN: "",
      },
      config: { cli: join(home, "fake-copilot.mjs"), fullAuto: false },
    });
    expect(signInOf(instance)).toMatchObject({ method: "device-code", signOut: false });
    expect(typeof instance.startAuthentication).toBe("function");
    expect((await instance.snapshot()).authenticated).toBe(false);
    const started = await instance.startAuthentication!();
    expect(started).toMatchObject({ phase: "waiting", userCode: "ABCD-1234", authorizationUrl: "https://github.com/login/device" });
    await expect.poll(() => instance!.getAuthentication!(started.flowId!), { timeout: 10_000 })
      .toMatchObject({ phase: "succeeded" });
    // The success refreshes the models, which re-runs the sign-in probe; only then does the snapshot flip.
    await expect.poll(() => instance!.snapshot().then((snapshot) => snapshot.authenticated), { timeout: 15_000 }).toBe(true);
    expect(existsSync(join(home, "authenticated"))).toBe(true);
  });
});
