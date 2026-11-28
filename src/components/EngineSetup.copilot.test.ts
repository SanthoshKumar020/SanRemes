// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { BotEditorStore, type InstanceInfo, type useStore } from "@/state/store";
import { EngineSetup } from "./EngineSetup";

const copilot = (snapshot: InstanceInfo["snapshot"]): InstanceInfo => ({
  instanceId: "copilot", driverKind: "copilotAgent", displayName: "GitHub Copilot",
  models: { default: "auto", options: [] }, snapshot,
  authentication: { method: "device-code", signOut: false },
  install: {
    command: { darwin: "npm install -g @github/copilot", linux: "npm install -g @github/copilot" },
    docsUrl: "https://docs.github.com/en/copilot/reference/acp-server", signInCommand: "copilot login",
  },
});
const signedOut = copilot({ state: "available", authenticated: false, version: "GitHub Copilot CLI 1.0.117." });
const signedIn = copilot({ state: "available", authenticated: true, version: "GitHub Copilot CLI 1.0.117." });

const desktop = { platform: "darwin", openInstallTerminal: vi.fn(async () => true), remoteClient: { active: false } };

let host: HTMLDivElement;
let root: Root;
const dispatch = vi.fn();
function render(engine: InstanceInfo, ogb: object | undefined): string {
  vi.stubGlobal("ogb", ogb);
  const store = { state: { config: {} }, dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn() } as unknown as ReturnType<typeof useStore>;
  flushSync(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EngineSetup, { instance: engine }) })));
  return host.innerHTML;
}

beforeEach(() => {
  setLocale("en");
  dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("signed out: the in-app code", () => {
  it("signs in with GitHub's code on GitHub's page, with no terminal command", () => {
    const html = render(signedOut, undefined);
    expect(html).toContain('data-device-sign-in="copilot"');
    expect(html).toContain("Sign in with your GitHub account so your bots can use Copilot");
    expect(html).toContain("Sign in with GitHub");
    expect(html).not.toContain("copilot login");
    expect(html).not.toContain("Prefer a terminal?");
  });

  it("keeps `copilot login` behind Prefer a terminal? in the desktop app's own window", () => {
    const html = render(signedOut, desktop);
    expect(html).toContain('data-device-sign-in="copilot"');
    expect(html).toContain("Prefer a terminal?");
    expect(html).toContain("copilot login");
  });
});

describe("signed in: no sign-in shown", () => {
  it("does not offer the device flow once the snapshot says signed in", () => {
    const html = render(signedIn, undefined);
    expect(html).not.toContain('data-device-sign-in="copilot"');
    expect(html).not.toContain("Sign in with GitHub");
  });
});
