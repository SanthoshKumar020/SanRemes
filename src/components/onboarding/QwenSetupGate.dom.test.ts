// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigStatus } from "@/state/config-status";

const fixture = vi.hoisted(() => ({ localQwen: undefined as ConfigStatus["localQwen"] }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { localQwen: fixture.localQwen } }, dispatch: () => {} }) }));

import { setLocale } from "@/lib/i18n";
import { QwenSetupGate } from "./QwenSetupGate";

const GiB = 2 ** 30;
const NOTE = "free API key";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  fixture.localQwen = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

async function show(localQwen: ConfigStatus["localQwen"]) {
  fixture.localQwen = localQwen;
  await act(async () => { root.render(createElement(QwenSetupGate)); });
}

describe("QwenSetupGate low-memory note", () => {
  it("shows the note while the install runs on a low-memory machine, keeping progress", async () => {
    await show({ state: "pulling", percent: 25, totalMemoryBytes: 4 * GiB });
    expect(container.textContent).toContain(NOTE);
    expect(container.textContent).toContain("Manage AI accounts");
    expect(container.querySelector("[role='progressbar']")?.getAttribute("aria-valuenow")).toBe("25");
  });

  it("shows the note while starting on a low-memory machine", async () => {
    await show({ state: "starting", totalMemoryBytes: 7.2 * GiB });
    expect(container.textContent).toContain(NOTE);
    expect(container.textContent).toContain("Starting the free AI");
  });

  it("shows the note in the failure state, with the way through intact", async () => {
    await show({ state: "failed", error: "no Ollama binary", totalMemoryBytes: 4 * GiB });
    expect(container.textContent).toContain(NOTE);
    expect(container.textContent).toContain("no Ollama binary");
    const button = [...container.querySelectorAll("button")].find((button) => button.textContent === "Continue without Qwen");
    expect(button).toBeTruthy();
    await act(async () => { button!.click(); });
    expect(container.textContent).toBe("");
  });

  it("shows no note on a machine with enough memory, in either state", async () => {
    await show({ state: "pulling", percent: 50, totalMemoryBytes: 16 * GiB });
    expect(container.textContent).not.toContain(NOTE);
    expect(container.querySelector("[role='progressbar']")).toBeTruthy();
    await show({ state: "failed", error: "no Ollama binary", totalMemoryBytes: 16 * GiB });
    expect(container.textContent).not.toContain(NOTE);
    expect(container.textContent).toContain("Continue without Qwen");
  });

  it("shows no note when the server does not report memory yet", async () => {
    await show({ state: "pulling", percent: 10 });
    expect(container.textContent).not.toContain(NOTE);
  });
});
