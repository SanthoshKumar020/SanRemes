import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";

import { writeFileAtomic } from "./atomic.ts";
import { RefIndex } from "./browser-steps.ts";
import { loadNotesDoc, MemoryNotesError, patchSkill, saveNotesDoc, saveSkill } from "./memory-notes.ts";
import { resolveMemoryFile, stageProposal, type MemoryActor, type PendingProposal } from "./memory-trust.ts";

/** Browser errands: procedures learned from completed errands, and scheduled page watches.
 *
 * A procedure is a learned skill (Phase 1 memory) whose body lists the errand's steps. The bot
 * records one when an errand completes; when a step fails because the site changed its layout, the
 * runner re-derives the step from a fresh snapshot instead of failing, and the updated procedure
 * waits as a proposal — a bot never rewrites a procedure on its own. A watch is a page checked on
 * a schedule: its digest only moves when a check's run is kept, so the owner hears about a change
 * exactly once. */

export interface BrowserDriver {
  navigate(url: string): Promise<void>;
  readText(): Promise<string>;
  snapshot(): Promise<string>;
}

export interface ErrandStep {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

export interface ErrandProcedure {
  name: string;
  description: string;
  steps: ErrandStep[];
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "errand";

/** The skill name for an errand: a slug the skill store accepts, one procedure per task and site. */
export function procedureSkillName(task: string, site: string): string {
  return `browser-errand-${slug(task)}-${slug(site)}`.slice(0, 64);
}

export function procedureBody(procedure: ErrandProcedure): string {
  return procedure.steps.map((step, index) => `${index + 1}. ${step.tool} ${JSON.stringify(step.args)} — ${step.label}`).join("\n");
}

/** Record a completed errand's steps as a procedure. The owner applies it at once; a bot's
 * version waits as a save-skill proposal, like every other bot change. */
export function recordProcedure(
  root: string,
  actor: MemoryActor,
  procedure: ErrandProcedure,
): { skill: string } | { proposal: PendingProposal } {
  const input = { name: procedure.name, description: procedure.description, body: procedureBody(procedure), task: null };
  if (actor === "owner") {
    const doc = loadNotesDoc(root);
    saveNotesDoc(root, saveSkill(doc, input), doc.version);
    return { skill: procedure.name };
  }
  return { proposal: stageProposal(root, { kind: "save-skill", input }, actor) };
}

/** Record an updated procedure after a re-learn. The owner applies it at once; a bot's version
 * waits as a patch-skill proposal — a changed procedure is never auto-applied. */
export function patchProcedure(
  root: string,
  actor: MemoryActor,
  procedure: ErrandProcedure,
): { skill: string } | { proposal: PendingProposal } {
  if (actor === "owner") {
    const doc = loadNotesDoc(root);
    saveNotesDoc(root, patchSkill(doc, procedure.name, procedureBody(procedure)), doc.version);
    return { skill: procedure.name };
  }
  return { proposal: stageProposal(root, { kind: "patch-skill", name: procedure.name, body: procedureBody(procedure) }, actor) };
}

const comparable = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Re-derive a failed step from a fresh snapshot: find the element the step meant, by the role and
 * name it had when it worked. An exact match wins; then a name that contains the old one (or the
 * old one contains it); then the same role with the same leading word, for a rename such as
 * "Cancel subscription" to "Cancel plan". Null when the page no longer has anything like it. */
export function relearnStep(
  intended: { role: string; name: string },
  snapshotText: string,
): { ref: string; role: string; name: string } | null {
  const refs = new RefIndex();
  refs.replace([snapshotText]);
  const entries = refs.entries();
  const wanted = comparable(intended.name);
  const role = intended.role.toLowerCase();
  const exact = entries.find((entry) => entry.role.toLowerCase() === role && comparable(entry.name) === wanted);
  if (exact) return { ref: exact.ref, role: exact.role, name: exact.name };
  if (wanted !== "") {
    const contained = entries.find(
      (entry) =>
        entry.role.toLowerCase() === role &&
        (comparable(entry.name).includes(wanted) || wanted.includes(comparable(entry.name))),
    );
    if (contained) return { ref: contained.ref, role: contained.role, name: contained.name };
    const firstWord = wanted.split(" ")[0];
    if (firstWord !== undefined && firstWord.length >= 3) {
      const renamed = entries.find((entry) => entry.role.toLowerCase() === role && comparable(entry.name).split(" ")[0] === firstWord);
      if (renamed) return { ref: renamed.ref, role: renamed.role, name: renamed.name };
    }
  }
  const named = entries.find((entry) => comparable(entry.name) === wanted && wanted !== "");
  return named ? { ref: named.ref, role: named.role, name: named.name } : null;
}

export interface BrowserWatch {
  id: string;
  name: string;
  url: string;
  routineId: string;
  digest: string;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
}

export const BROWSER_WATCHES_FILE = "memory/browser-watches.json";
const BROWSER_WATCHES_MAX_BYTES = 64 * 1024;

interface BrowserWatchesDoc {
  version: 1;
  watches: BrowserWatch[];
}

function validWatchesDoc(value: unknown): value is BrowserWatchesDoc {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as BrowserWatchesDoc).version === 1 &&
    Array.isArray((value as BrowserWatchesDoc).watches)
  );
}

function fail(code: "invalid" | "conflict" | "not-found" | "too-large" | "corrupt" | "path", status: number, message: string): never {
  throw new MemoryNotesError(code, status, message);
}

export function loadWatches(root: string): BrowserWatch[] {
  let raw: string;
  try {
    raw = readFileSync(resolveMemoryFile(root, BROWSER_WATCHES_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("corrupt", 500, "the browser watches file is not valid JSON — it needs a hand fix before watches can load");
  }
  if (!validWatchesDoc(parsed)) {
    fail("corrupt", 500, "the browser watches file does not hold a watches document — it needs a hand fix before watches can load");
  }
  return parsed.watches;
}

export function saveWatches(root: string, watches: BrowserWatch[]): BrowserWatch[] {
  const text = JSON.stringify({ version: 1, watches }, null, 2);
  if (Buffer.byteLength(text, "utf8") > BROWSER_WATCHES_MAX_BYTES) {
    fail("too-large", 413, "too many browser watches — remove some first");
  }
  mkdirSync(`${root}/memory`, { recursive: true, mode: 0o700 });
  writeFileAtomic(resolveMemoryFile(root, BROWSER_WATCHES_FILE), text, { mode: 0o600 });
  return watches;
}

export function newWatch(name: string, url: string, routineId: string): BrowserWatch {
  return { id: randomUUID(), name, url, routineId, digest: "", lastCheckedAt: null, lastChangedAt: null };
}

/** A page's fingerprint: its text with whitespace collapsed, so layout shifts do not read as a
 * change but a changed price, date or line does. */
export function pageDigest(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

export interface PageFetch {
  ok: boolean;
  text?: string;
  status?: number;
  error?: string;
}

/** A plain fetch of a page, for scheduled checks: no JavaScript runs, so a page that renders
 * client-side will not change-detect reliably — a watch on one needs the browser driver instead. */
export async function fetchPageText(url: string, timeoutMs = 10_000): Promise<PageFetch> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" },
    });
    if (!response.ok) return { ok: false, status: response.status, error: `the page answered ${response.status}` };
    return { ok: true, status: response.status, text: await response.text() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export interface WatchCheckResult {
  changed: boolean;
  digest: string;
  excerpt: string;
  fetchedAt: string;
  error?: string;
}

/** Check one watch: fetch the page, digest it, compare. A fetch that fails is not a change — the
 * owner is not told the page changed when it was only unreachable. */
export async function checkWatch(
  watch: BrowserWatch,
  fetchText: (url: string) => Promise<PageFetch> = fetchPageText,
): Promise<WatchCheckResult> {
  const fetchedAt = new Date().toISOString();
  const fetched = await fetchText(watch.url);
  if (!fetched.ok || fetched.text === undefined) {
    return { changed: false, digest: watch.digest, excerpt: "", fetchedAt, error: fetched.error ?? "the page could not be read" };
  }
  const digest = pageDigest(fetched.text);
  const changed = watch.digest !== "" && digest !== watch.digest;
  const excerpt = fetched.text.replace(/\s+/g, " ").trim().slice(0, 500);
  return { changed, digest, excerpt, fetchedAt };
}

/** The same check through a live browser, for pages that render client-side. */
export async function checkWatchWithDriver(watch: BrowserWatch, driver: BrowserDriver): Promise<WatchCheckResult> {
  const fetchedAt = new Date().toISOString();
  try {
    await driver.navigate(watch.url);
    const text = await driver.readText();
    const digest = pageDigest(text);
    const changed = watch.digest !== "" && digest !== watch.digest;
    return { changed, digest, excerpt: text.replace(/\s+/g, " ").trim().slice(0, 500), fetchedAt };
  } catch (error) {
    return { changed: false, digest: watch.digest, excerpt: "", fetchedAt, error: error instanceof Error ? error.message : String(error) };
  }
}
