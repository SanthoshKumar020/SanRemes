import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boxUploadsDir, planBox } from "./bot-box/plan.ts";
import { attachmentTextForTurn, attachmentsForBox } from "./box-attachments.ts";
import { extractTurnImages } from "./turn-images.ts";
import { codexImageInputs } from "./drivers/codex-images.ts";

vi.mock("./attachments.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./attachments.ts")>()),
  ocrAttachmentText: vi.fn(async (path: string, mime: string) => {
    if (path.endsWith("markup.png")) return { ok: true, text: "a <b> & c", confidence: 90 };
    if (path.endsWith(".png")) return { ok: true, text: "Hello OCR", confidence: 95 };
    if (mime === "application/pdf") return { ok: true, text: "PDF words", confidence: 100 };
    return { ok: false, reason: "unsupported-type" as const };
  }),
}));

describe("attachmentsForBox", () => {
  let root: string, dataDir: string, uploads: string, cwd: string, shown: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "box-attachments-"));
    dataDir = join(root, "data");
    uploads = join(dataDir, "attachments");
    cwd = join(dataDir, "task-workspaces", "bot", "thread");
    shown = boxUploadsDir(dataDir, "bot", "thread");
    mkdirSync(uploads, { recursive: true });
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const run = (text: string, at: string | undefined = cwd, boxed = true) => attachmentsForBox(text, at, undefined, boxed, dataDir, uploads);

  it("puts each upload in the conversation's read-only uploads folder and points the engine there", () => {
    const upload = join(uploads, "1f0c2a.md");
    writeFileSync(upload, "# notes\n");
    writeFileSync(join(uploads, "9b7e.png"), "png");
    const text = `Read this\n<attached-file path="${upload}" name="notes.md" />\n<attached-image path="${join(uploads, "9b7e.png")}" name="shot.png" />`;

    const out = run(text);

    expect(out).toBe(`Read this\n<attached-file path="${join(shown, "1f0c2a.md")}" name="notes.md" />\n<attached-image path="${join(shown, "9b7e.png")}" name="shot.png" />`);
    expect(readFileSync(join(shown, "1f0c2a.md"), "utf8")).toBe("# notes\n");
    // Nothing is written into the working folder, which the bot controls.
    expect(existsSync(join(cwd, ".attachments"))).toBe(false);
    expect(run(text)).toBe(out);
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])("keeps an image usable by a file CLI and by vision (boxed=%s, nonCanonical=%s)", async (boxed, nonCanonical) => {
    const name = "123e4567-e89b-42d3-a456-426614174000.png";
    const upload = join(uploads, name);
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=", "base64");
    writeFileSync(upload, bytes);
    writeFileSync(join(uploads, "other-conversation.png"), "private");
    const inputPath = nonCanonical ? `${uploads}/missing/../${name}` : upload;
    const extracted = extractTurnImages(`Upload this photo\n\n<attached-image path="${inputPath}" name="mug.png" />`, { attachmentsDir: uploads });
    const text = run(extracted.text, cwd, boxed);
    const file = /<attached-file path="([^"]+)" name="mug.png" \/>/.exec(text)?.[1];

    expect(file).toBe(boxed ? join(shown, name) : upload);
    expect(execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", file!])).toEqual(bytes);
    expect(await codexImageInputs(extracted.images)).toEqual([{ type: "image", url: `data:image/png;base64,${bytes.toString("base64")}` }]);
    expect(existsSync(join(shown, "other-conversation.png"))).toBe(false);
    expect(existsSync(join(boxUploadsDir(dataDir, "bot", "other"), name))).toBe(false);
    expect(extractTurnImages(extracted.text, { attachmentsDir: uploads }).images).toEqual([]);
  });

  it("finds an upload whose path the tag escaped", () => {
    const dir = join(root, "a&b", "attachments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.md"), "x");
    const out = attachmentsForBox(`<attached-file path="${join(root, "a&amp;b", "attachments", "x.md")}" name="x.md" />`, cwd, undefined, true, dataDir, dir);
    expect(out).toBe(`<attached-file path="${join(shown, "x.md")}" name="x.md" />`);
  });

  it("does not point at an upload that was deleted, even if an earlier turn linked it", () => {
    const upload = join(uploads, "gone.md");
    writeFileSync(upload, "x");
    const text = `<attached-file path="${upload}" name="g.md" />`;
    expect(run(text)).not.toBe(text);
    rmSync(upload);
    expect(run(text)).toBe(text);
  });

  it("changes nothing with the box off, without a working folder, or outside a conversation's own folder", () => {
    const upload = join(uploads, "a.md");
    writeFileSync(upload, "x");
    const text = `<attached-file path="${upload}" name="a.md" />`;
    expect(run(text, cwd, false)).toBe(text);
    expect(attachmentsForBox(text, undefined, undefined, true, dataDir, uploads)).toBe(text);
    expect(run(text, join(dataDir, "workspaces", "bot"))).toBe(text);
    expect(existsSync(shown)).toBe(false);
  });

  it("leaves paths outside the uploads folder, odd names and missing files as they are", () => {
    writeFileSync(join(root, "elsewhere.md"), "x");
    writeFileSync(join(dataDir, "secret.md"), "x");
    const text = [
      `<attached-file path="${join(root, "elsewhere.md")}" name="e.md" />`,
      `<attached-file path="${uploads}/../secret.md" name="s.md" />`,
      `<attached-file path="${join(uploads, "missing.md")}" name="m.md" />`,
      `<attached-file path="${join(uploads, ".sanremes-upload-x.partial")}" name="p" />`,
    ].join("\n");
    expect(run(text)).toBe(text);
  });

  it("is bound read-only into that conversation's boxes only, after its working folder", () => {
    const setup = { dataDir, home: root, codeRoots: [], engineRoots: [], bridges: [] };
    const targets = (at: string) => planBox(setup, { command: "/usr/bin/true", args: [], cwd: at, env: {} }).mounts.map((mount) => ("target" in mount ? mount.target : null));
    const plan = planBox(setup, { command: "/usr/bin/true", args: [], cwd, env: {} });
    const at = targets(cwd).indexOf(shown);
    expect(plan.mounts[at]).toEqual({ kind: "ro", source: shown, target: shown, optional: true });
    expect(at).toBeGreaterThan(targets(cwd).indexOf(cwd));
    expect(targets(join(dataDir, "task-workspaces", "bot", "other"))).not.toContain(shown);
  });

  it("gives a turn in its bot's own folder (a room's) its own conversation's uploads, and no other's", () => {
    const own = join(dataDir, "workspaces", "bot"), room = boxUploadsDir(dataDir, "bot", "room");
    mkdirSync(own, { recursive: true });
    const upload = join(uploads, "r1.md");
    writeFileSync(upload, "room notes");
    const text = `<attached-file path="${upload}" name="r1.md" />`;

    expect(attachmentsForBox(text, own, { botId: "bot", threadId: "room" }, true, dataDir, uploads)).toBe(`<attached-file path="${join(room, "r1.md")}" name="r1.md" />`);
    expect(readFileSync(join(room, "r1.md"), "utf8")).toBe("room notes");
    expect(attachmentsForBox(text, join(dataDir, "workspaces", "other"), { botId: "bot", threadId: "room" }, true, dataDir, uploads)).toBe(text);

    const setup = { dataDir, home: root, codeRoots: [], engineRoots: [], bridges: [] };
    const mounts = (more: object) => planBox(setup, { command: "/usr/bin/true", args: [], cwd: own, env: {}, botId: "bot", conversationFolder: join(dataDir, "task-workspaces", "bot", "room"), ...more }).mounts;
    expect(mounts({})).toContainEqual({ kind: "ro", source: room, target: room, optional: true });
    expect(mounts({}).map((mount) => ("target" in mount ? mount.target : null))).not.toContain(shown);
    // A process started for several conversations there serves only this one (procs.ts sharedBoxScope), so it gets the
    // same, never every conversation's; a box of another bot gets none.
    expect(mounts({ botThreads: true })).toContainEqual({ kind: "ro", source: room, target: room, optional: true });
    expect(mounts({ botThreads: true })).not.toContainEqual(expect.objectContaining({ target: join(dataDir, "box-uploads", "bot") }));
    expect(mounts({ botId: "other" })).not.toContainEqual(expect.objectContaining({ target: room }));
  });

  describe("attachmentTextForTurn", () => {
    const run = (text: string) => attachmentTextForTurn(text, cwd, undefined, dataDir, uploads);

    it("appends the read text after image and PDF tags, and nothing for other files", async () => {
      writeFileSync(join(uploads, "shot.png"), "png");
      writeFileSync(join(uploads, "doc.pdf"), "pdf");
      writeFileSync(join(uploads, "notes.md"), "md");
      const text = [
        `<attached-image path="${join(uploads, "shot.png")}" name="shot.png" />`,
        `<attached-file path="${join(uploads, "doc.pdf")}" name="doc.pdf" />`,
        `<attached-file path="${join(uploads, "notes.md")}" name="notes.md" />`,
      ].join("\n");
      expect(await run(text)).toBe([
        `<attached-image path="${join(uploads, "shot.png")}" name="shot.png" />`,
        `<attached-image-text name="shot.png">Hello OCR</attached-image-text>`,
        `<attached-file path="${join(uploads, "doc.pdf")}" name="doc.pdf" />`,
        `<attached-image-text name="doc.pdf">PDF words</attached-image-text>`,
        `<attached-file path="${join(uploads, "notes.md")}" name="notes.md" />`,
      ].join("\n"));
    });

    it("escapes markup in the read text so it cannot close its own tag", async () => {
      writeFileSync(join(uploads, "markup.png"), "png");
      const out = await run(`<attached-image path="${join(uploads, "markup.png")}" name="markup.png" />`);
      expect(out).toContain(`<attached-image-text name="markup.png">a &lt;b&gt; &amp; c</attached-image-text>`);
    });

    it("adds nothing without a tag, outside the uploads folder, or for a missing file", async () => {
      writeFileSync(join(root, "elsewhere.png"), "png");
      const text = [
        "no tags here",
        `<attached-image path="${join(root, "elsewhere.png")}" name="elsewhere.png" />`,
        `<attached-image path="${join(uploads, "missing.png")}" name="missing.png" />`,
      ].join("\n");
      expect(await run(text)).toBe(text);
    });
  });
});
