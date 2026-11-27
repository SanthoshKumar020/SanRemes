// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  fetchJobs: vi.fn(),
  fetchPlatforms: vi.fn(),
  startJobSearch: vi.fn(),
  tailorResume: vi.fn(),
  approveQueueItem: vi.fn(),
  rejectQueueItem: vi.fn(),
  batchApproveQueue: vi.fn(),
  applyQueueItem: vi.fn(),
  updateJobStatus: vi.fn(),
  saveSettings: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@/lib/jobs", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/jobs")>(),
  fetchJobs: (...args: unknown[]) => fixture.fetchJobs(...args),
  fetchPlatforms: (...args: unknown[]) => fixture.fetchPlatforms(...args),
  startJobSearch: (...args: unknown[]) => fixture.startJobSearch(...args),
  tailorResume: (...args: unknown[]) => fixture.tailorResume(...args),
  approveQueueItem: (...args: unknown[]) => fixture.approveQueueItem(...args),
  rejectQueueItem: (...args: unknown[]) => fixture.rejectQueueItem(...args),
  batchApproveQueue: (...args: unknown[]) => fixture.batchApproveQueue(...args),
  applyQueueItem: (...args: unknown[]) => fixture.applyQueueItem(...args),
  updateJobStatus: (...args: unknown[]) => fixture.updateJobStatus(...args),
  saveSettings: (...args: unknown[]) => fixture.saveSettings(...args),
}));
vi.mock("@/state/store-select", () => ({
  useStoreDispatch: () => fixture.dispatch,
  useStoreSelector: (fn: (state: { bots: never[] }) => never[]) => fn({ bots: [] }),
}));

import { JobBotPage } from "./JobBotPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
const emptyState = {
  version: 1, profile: null, resumes: [], jobs: [], queue: [],
  settings: { platforms: {}, dailyCap: 10, search: { keywords: [], locations: [] }, twoFactor: {}, paused: false },
  appliedToday: 0,
};
const baseState = {
  ...emptyState,
  profile: {
    name: "Santhoshkumar", title: "Data Engineer", location: "Chennai", skills: ["Databricks", "PySpark"],
    experience: [], updatedAt: 1, resumeText: "Santhoshkumar\nDatabricks, SQL",
  },
  jobs: [
    { id: "job-1", platform: "naukri", url: "https://www.naukri.com/job/1", title: "Data Engineer", company: "Acme", location: "Chennai", salaryText: "5-7 LPA", foundAt: 1, jdKeywords: ["Databricks"], matchScore: 90, status: "new", statusAt: 1 },
    { id: "job-2", platform: "linkedin", url: "https://www.linkedin.com/jobs/2", title: "Data Engineer", company: "Beta", foundAt: 1, jdKeywords: ["SQL"], matchScore: 40, status: "approved", statusAt: 1 },
    { id: "job-3", platform: "naukri", url: "https://www.naukri.com/job/3", title: "Data Engineer", company: "Gamma", foundAt: 1, jdKeywords: ["SQL"], matchScore: 30, status: "applied", statusAt: 1, appliedAt: 1 },
    { id: "job-4", platform: "linkedin", url: "https://www.linkedin.com/jobs/4", title: "Data Engineer", company: "Delta", foundAt: 1, jdKeywords: ["SQL"], matchScore: 20, status: "approved", statusAt: 1 },
  ],
  queue: [
    { id: "q-1", jobId: "job-1", tailoredResumeId: "r-1", state: "pending", attempts: [] },
    { id: "q-2", jobId: "job-2", tailoredResumeId: "r-1", state: "pending", attempts: [] },
    { id: "q-3", jobId: "job-4", tailoredResumeId: "r-1", state: "approved", attempts: [] },
  ],
  resumes: [{ id: "r-1", jobId: "job-1", kind: "tailored", path: "/resumes/r-1.txt", createdAt: 1, text: "Santhoshkumar\nDatabricks, SQL, PySpark", note: "Tailored for Data Engineer at Acme" }],
  appliedToday: 1,
};

async function render() {
  root = createRoot(host);
  await act(async () => root.render(createElement(JobBotPage)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
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
  for (const fn of Object.values(fixture)) fn.mockReset();
  fixture.fetchJobs.mockResolvedValue(baseState);
  fixture.fetchPlatforms.mockResolvedValue({ platforms: [
    { platform: "naukri", enabled: true, signedIn: true },
    { platform: "linkedin", enabled: true, signedIn: false },
  ] });
  fixture.startJobSearch.mockResolvedValue({ started: true, botId: "apply-1", recorded: 2, skipped: 0 });
  fixture.tailorResume.mockResolvedValue({ resume: { id: "r-1" }, job: { id: "job-1" }, queue: null });
  fixture.approveQueueItem.mockResolvedValue({ queue: { id: "q-1", state: "approved" } });
  fixture.rejectQueueItem.mockResolvedValue({ queue: { id: "q-1", state: "rejected" } });
  fixture.batchApproveQueue.mockResolvedValue({ results: [] });
  fixture.applyQueueItem.mockResolvedValue({ started: true, applied: true, botId: "apply-1" });
  fixture.updateJobStatus.mockResolvedValue({ job: { id: "job-1", status: "saved" } });
  fixture.saveSettings.mockResolvedValue({ ...baseState, settings: { ...baseState.settings, paused: true } });
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("JobBotPage", () => {
  it("opens the setup wizard when there is no profile yet", async () => {
    fixture.fetchJobs.mockResolvedValue(emptyState);
    await render();
    expect(host.querySelector("[data-jobs-page]")).toBeTruthy();
    expect(host.textContent).toContain("Set up Jobs once");
    expect(host.querySelector("[data-jobs-wizard]")).toBeTruthy();
    expect(host.textContent).toContain("Your name");
  });

  it("shows the profile, platform sign-in, resumes, matches, queue and tracking once setup is done", async () => {
    await render();
    expect(host.textContent).toContain("Santhoshkumar");
    for (const section of ["Resume versions", "Job matches", "Approval queue", "Tracking", "Platform sign-in"]) {
      expect(host.textContent).toContain(section);
    }
    expect(host.textContent).toContain("naukri: Signed in");
    expect(host.textContent).toContain("linkedin: Needs sign-in");
    expect(host.textContent).toContain("A signed-out platform needs you");
    expect(host.textContent).toContain("1 of 10 applications sent today");
    expect(host.textContent).toContain("Automated applying can look like bot activity");
    expect(host.querySelector("[data-jobs-wizard]")).toBeNull();
    await click(button("Edit setup"));
    expect(host.querySelector("[data-jobs-wizard]")).toBeTruthy();
  });

  it("falls back to setup with a warning when the Jobs store cannot be reached", async () => {
    fixture.fetchJobs.mockRejectedValue(new Error("not found"));
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Could not reach the Jobs store");
    expect(host.querySelector("[data-jobs-wizard]")).toBeTruthy();
  });

  it("goes back to chat from the header", async () => {
    await render();
    await act(async () => { host.querySelector('button[aria-label="Back"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showChat" });
  });

  it("searches, tailors a match, and shows the recorded count once the turn settles", async () => {
    await render();
    expect(host.textContent).toContain("Posted: 5-7 LPA");
    expect(host.textContent).toContain("Match 90%");
    const grown = {
      ...baseState,
      jobs: [...baseState.jobs, { id: "job-5", platform: "naukri", url: "https://www.naukri.com/job/5", title: "Data Engineer", company: "Epsilon", foundAt: 1, jdKeywords: ["SQL"], matchScore: 10, status: "new", statusAt: 1 }],
    };
    fixture.fetchJobs.mockImplementation(() => Promise.resolve(grown));
    await click(button("Search for jobs"));
    expect(fixture.startJobSearch).toHaveBeenCalled();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3500)); });
    await flush();
    expect(host.textContent).toContain("Recorded 1 new matches.");
    await click(button("Tailor resume"));
    expect(fixture.tailorResume).toHaveBeenCalledWith("job-3");
  });

  it("approves and rejects queue rows, batch-approves the pending ones, and applies an approved one", async () => {
    await render();
    await click(button("Approve"));
    expect(fixture.approveQueueItem).toHaveBeenCalledWith("q-1");
    await click(button("Approve all"));
    expect(fixture.batchApproveQueue).toHaveBeenCalledWith(["q-1", "q-2"]);
    await click(button("Reject"));
    expect(fixture.rejectQueueItem).toHaveBeenCalledWith("q-1");
    const attempted = {
      ...baseState,
      queue: baseState.queue.map((item) => item.id === "q-3" ? { ...item, attempts: [{ at: 1, result: "submitted" }] } : item),
    };
    fixture.fetchJobs.mockImplementation(() => Promise.resolve(attempted));
    await click(button("Apply now"));
    expect(fixture.applyQueueItem).toHaveBeenCalledWith("q-3");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 3500)); });
    await flush();
  });

  it("pauses all applying and resumes it", async () => {
    await render();
    await click(button("Pause all applying"));
    expect(fixture.saveSettings).toHaveBeenCalledWith({ paused: true });
    expect(host.textContent).toContain("Applying is paused");
    expect(host.textContent).toContain("Resume applying");
  });

  it("shows the tailored diff against the base resume", async () => {
    await render();
    await click(button("Changed vs base"));
    expect(host.textContent).toContain("Every added line must come from your profile");
    expect(host.textContent).toContain("+ Databricks, SQL, PySpark");
  });

  it("groups tracked jobs by status and lets the status change by hand", async () => {
    await render();
    expect(host.textContent).toContain("Applied");
    const select = host.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("new");
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(select, "saved");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(fixture.updateJobStatus).toHaveBeenCalledWith("job-1", "saved");
  });
});
