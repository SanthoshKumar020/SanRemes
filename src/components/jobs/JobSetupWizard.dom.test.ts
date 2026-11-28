// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  ensureJobBots: vi.fn(),
  savePlatformLogin: vi.fn(),
  extractResume: vi.fn(),
  onDone: vi.fn(),
}));
vi.mock("@/lib/jobs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/jobs")>(),
  saveProfile: (...args: unknown[]) => fixture.saveProfile(...args),
  ensureJobBots: (...args: unknown[]) => fixture.ensureJobBots(...args),
  savePlatformLogin: (...args: unknown[]) => fixture.savePlatformLogin(...args),
  extractResume: (...args: unknown[]) => fixture.extractResume(...args),
}));

import { JobSetupWizard } from "./JobSetupWizard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
const resumeBot = { id: "resume-1", name: "Resume Bot", section: "Jobs" };
const applyBot = { id: "apply-1", name: "Job Apply Bot", section: "Jobs" };
const savedState = { version: 1, profile: { name: "Santhoshkumar" }, resumes: [], jobs: [], queue: [], settings: { platforms: {}, dailyCap: 10, search: { keywords: [], locations: [] } } };

async function render() {
  root = createRoot(host);
  await act(async () => root.render(createElement(JobSetupWizard, {
    existingBots: [], initialProfile: null, initialSettings: undefined, onDone: fixture.onDone,
  })));
}
async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
function input(name: string) {
  return host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find((el) => el.textContent?.trim() === text)!;
}
async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

beforeEach(() => {
  setLocale("en");
  fixture.saveProfile.mockReset().mockResolvedValue(savedState);
  fixture.ensureJobBots.mockReset().mockResolvedValue({ resumeBot, applyBot });
  fixture.savePlatformLogin.mockReset().mockResolvedValue({ id: "login-1", username: "san@example.com" });
  fixture.extractResume.mockReset().mockResolvedValue({ text: "Santhoshkumar\nDatabricks, SQL", pages: 1, kind: "pdf" });
  fixture.onDone.mockReset();
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("JobSetupWizard", () => {
  it("walks profile, platforms, review: creates the bots, saves the login scoped to the Apply Bot, and never shows the password back", async () => {
    await render();
    expect(host.querySelector("[data-jobs-wizard]")).toBeTruthy();
    expect(host.textContent).toContain("Profile");
    setValue(input("profileName"), "Santhoshkumar");
    setValue(input("profileLocation"), "Chennai");
    setValue(input("profileSkills"), "Databricks, PySpark, SQL");
    await click(button("Continue"));
    expect(fixture.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({ name: "Santhoshkumar", location: "Chennai", skills: ["Databricks", "PySpark", "SQL"] }),
    }));
    expect(fixture.ensureJobBots).toHaveBeenCalledWith([]);
    expect(host.textContent).toContain("Automated applying can look like bot activity");
    expect(host.textContent).toContain("Stored encrypted in this app's Vault on this computer (logins.json.enc); only the Job Apply Bot can use it");
    expect(host.textContent).toContain("cannot use your own signed-in browser");

    const naukri = host.querySelector('[data-jobs-platform="naukri"]')!;
    const enable = naukri.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(enable);
    setValue(input("naukriUsername"), "san@example.com");
    setValue(input("naukriPassword"), "s3cret-pass");
    await click(button("Save login"));
    expect(fixture.savePlatformLogin).toHaveBeenCalledWith("naukri.com", { username: "san@example.com", password: "s3cret-pass", totp: "" }, "apply-1");
    expect(input("naukriPassword").value).toBe("");
    expect(host.innerHTML).not.toContain("s3cret-pass");
    expect(host.textContent).toContain("Saved for san@example.com.");
    expect(host.textContent).toContain("The password is never shown back.");

    await click(button("Continue"));
    expect(fixture.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ dailyCap: 10, applyBotId: "apply-1", resumeBotId: "resume-1" }),
    }));
    expect(host.textContent).toContain("Review your setup");
    expect(host.textContent).toContain("Resume Bot and Job Apply Bot are ready");
    await click(button("Finish setup"));
    expect(fixture.onDone).toHaveBeenCalledWith(savedState);
  });

  it("asks for the risk warning again before the daily cap can rise above 10", async () => {
    await render();
    setValue(input("profileName"), "Santhoshkumar");
    setValue(input("profileLocation"), "Chennai");
    await click(button("Continue"));
    expect(button("Continue").disabled).toBe(false);
    setValue(input("dailyCap"), "20");
    expect(host.textContent).toContain("Above 10 a day, the chance of an account restriction rises");
    expect(button("Continue").disabled).toBe(true);
    const confirm = [...host.querySelectorAll('input[type="checkbox"]')].find((el) => el.closest("label")?.textContent?.includes("I understand the risk"))!;
    await click(confirm);
    expect(button("Continue").disabled).toBe(false);
  });

  it("persists both bot ids as soon as the bots are created, before step 2 is finished", async () => {
    await render();
    setValue(input("profileName"), "Santhoshkumar");
    setValue(input("profileLocation"), "Chennai");
    await click(button("Continue"));
    expect(fixture.saveProfile).toHaveBeenCalledWith(
      { profile: {}, settings: { applyBotId: "apply-1", resumeBotId: "resume-1" } },
    );
  });

  it("extracts a PDF resume into the editable text field and says to check it", async () => {
    await render();
    const fileInput = input("resumeFile");
    const file = new File(["%PDF"], "resume.pdf", { type: "application/pdf" });
    Object.defineProperty(fileInput, "files", { value: [file] });
    await act(async () => { fileInput.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(fixture.extractResume).toHaveBeenCalledWith(file);
    expect((input("resumeText") as HTMLTextAreaElement).value).toBe("Santhoshkumar\nDatabricks, SQL");
    expect(host.textContent).toContain("Extracted from resume.pdf");
    expect(host.textContent).toContain("check the text below and correct anything wrong");
  });

  it("shows an extraction failure instead of silently keeping old text", async () => {
    fixture.extractResume.mockRejectedValue(new Error("That file could not be read."));
    await render();
    const fileInput = input("resumeFile");
    Object.defineProperty(fileInput, "files", { value: [new File(["bad"], "resume.pdf", { type: "application/pdf" })] });
    await act(async () => { fileInput.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(host.textContent).toContain("That file could not be read.");
  });

  it("warns that two-factor sign-in may need the person each session", async () => {
    await render();
    setValue(input("profileName"), "Santhoshkumar");
    setValue(input("profileLocation"), "Chennai");
    await click(button("Continue"));
    const linkedin = host.querySelector('[data-jobs-platform="linkedin"]')!;
    await click(linkedin.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    const twoFactor = [...linkedin.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][1]!;
    await click(twoFactor);
    expect(host.textContent).toContain("With two-factor authentication on, sign-in may need you each session.");
  });
});
