import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkWatch,
  checkWatchWithDriver,
  loadWatches,
  newWatch,
  pageDigest,
  patchProcedure,
  procedureBody,
  procedureSkillName,
  recordProcedure,
  relearnStep,
  saveWatches,
  type BrowserWatch,
  type ErrandProcedure,
} from "./browser-errands.ts";
import { loadNotesDoc } from "./memory-notes.ts";
import { listProposals } from "./memory-trust.ts";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function root(): string {
  dir = mkdtempSync(join(tmpdir(), "sanremes-browser-errands-"));
  return dir;
}

function procedure(): ErrandProcedure {
  return {
    name: procedureSkillName("cancel trial", "example.com"),
    description: "Cancel the free trial on example.com",
    steps: [
      { tool: "agent_browser_open", args: { url: "https://example.com/account" }, label: "Opened the account page" },
      { tool: "agent_browser_click", args: { ref: "e3" }, label: "Clicked Cancel subscription" },
    ],
  };
}

describe("procedureSkillName", () => {
  it("is a slug the skill store accepts", () => {
    expect(procedureSkillName("Cancel Trial!", "Example.COM")).toBe("browser-errand-cancel-trial-example-com");
    expect(procedureSkillName("cancel trial", "example.com").length).toBeLessThanOrEqual(64);
  });
});

describe("recordProcedure and patchProcedure", () => {
  it("a bot's procedure waits as a save-skill proposal; the owner's applies at once", () => {
    const base = root();
    const staged = recordProcedure(base, "agent", procedure());
    expect("proposal" in staged).toBe(true);
    if (!("proposal" in staged)) return;
    expect(staged.proposal.kind).toBe("save-skill");
    expect(listProposals(base)).toHaveLength(1);
    const applied = recordProcedure(base, "owner", procedure());
    expect(applied).toEqual({ skill: procedure().name });
    const doc = loadNotesDoc(base);
    expect(doc.skills.some((skill) => skill.name === procedure().name)).toBe(true);
    expect(doc.skills.find((skill) => skill.name === procedure().name)?.body).toContain("Cancel subscription");
  });

  it("a bot's updated procedure waits as a patch-skill proposal, never auto-applied", () => {
    const base = root();
    recordProcedure(base, "owner", procedure());
    const updated: ErrandProcedure = { ...procedure(), steps: [{ tool: "agent_browser_click", args: { ref: "e7" }, label: "Clicked Cancel plan" }] };
    const staged = patchProcedure(base, "agent", updated);
    expect("proposal" in staged).toBe(true);
    if (!("proposal" in staged)) return;
    expect(staged.proposal.kind).toBe("patch-skill");
    expect(loadNotesDoc(base).skills.find((skill) => skill.name === procedure().name)?.body).toContain("Cancel subscription");
  });

  it("a procedure whose body holds a shaped secret is refused", () => {
    const base = root();
    const leaky: ErrandProcedure = {
      ...procedure(),
      steps: [{ tool: "agent_browser_fill", args: { ref: "e1", text: "sk-live-abc1234567890" }, label: "Filled the key field" }],
    };
    expect(() => recordProcedure(base, "owner", leaky)).toThrow();
    expect(procedureBody(leaky)).toContain("sk-live-abc1234567890");
  });
});

describe("relearnStep", () => {
  const snapshot = [
    "- button \"Cancel plan\" [ref=e7]",
    "- link \"Billing\" [ref=e2]",
    "- button \"Save\" [ref=e9]",
  ].join("\n");

  it("finds the renamed control by role and name, exact first", () => {
    expect(relearnStep({ role: "button", name: "Cancel subscription" }, snapshot)).toEqual({ ref: "e7", role: "button", name: "Cancel plan" });
    expect(relearnStep({ role: "button", name: "Save" }, snapshot)).toEqual({ ref: "e9", role: "button", name: "Save" });
    expect(relearnStep({ role: "link", name: "Billing" }, snapshot)).toEqual({ ref: "e2", role: "link", name: "Billing" });
  });

  it("returns null when the page no longer has anything like the control", () => {
    expect(relearnStep({ role: "button", name: "Delete everything" }, snapshot)).toBeNull();
    expect(relearnStep({ role: "button", name: "" }, snapshot)).toBeNull();
  });
});

describe("pageDigest and checkWatch", () => {
  it("the digest ignores whitespace but not a changed word", () => {
    expect(pageDigest("Price:  99\n")).toBe(pageDigest("Price: 99"));
    expect(pageDigest("Price: 99")).not.toBe(pageDigest("Price: 109"));
  });

  it("a first read is not a change; the same page is not a change; a changed page is", async () => {
    const watch: BrowserWatch = newWatch("Price page", "https://example.com/price", "r1");
    const first = await checkWatch(watch, async () => ({ ok: true, text: "Price: 99" }));
    expect(first.changed).toBe(false);
    const seeded: BrowserWatch = { ...watch, digest: first.digest };
    const same = await checkWatch(seeded, async () => ({ ok: true, text: "Price:  99\n" }));
    expect(same.changed).toBe(false);
    const changed = await checkWatch(seeded, async () => ({ ok: true, text: "Price: 109" }));
    expect(changed.changed).toBe(true);
    expect(changed.excerpt).toContain("Price: 109");
  });

  it("an unreachable page is not a change", async () => {
    const watch: BrowserWatch = { ...newWatch("Price page", "https://example.com/price", "r1"), digest: pageDigest("Price: 99") };
    const result = await checkWatch(watch, async () => ({ ok: false, status: 503, error: "the page answered 503" }));
    expect(result.changed).toBe(false);
    expect(result.error).toContain("503");
  });

  it("the driver variant reads through a live browser and reports a failure as no change", async () => {
    const watch: BrowserWatch = { ...newWatch("Price page", "https://example.com/price", "r1"), digest: pageDigest("Price: 99") };
    const seen: string[] = [];
    const changed = await checkWatchWithDriver(watch, {
      navigate: async (url) => {
        seen.push(url);
      },
      readText: async () => "Price: 109",
      snapshot: async () => "",
    });
    expect(seen).toEqual(["https://example.com/price"]);
    expect(changed.changed).toBe(true);
    const failed = await checkWatchWithDriver(watch, {
      navigate: async () => {
        throw new Error("the browser closed");
      },
      readText: async () => "",
      snapshot: async () => "",
    });
    expect(failed.changed).toBe(false);
    expect(failed.error).toContain("the browser closed");
  });
});

describe("watch store", () => {
  it("round-trips watches in the bot workspace", () => {
    const base = root();
    expect(loadWatches(base)).toEqual([]);
    const watch = newWatch("Price page", "https://example.com/price", "r1");
    saveWatches(base, [watch]);
    expect(loadWatches(base)).toEqual([watch]);
  });
});
