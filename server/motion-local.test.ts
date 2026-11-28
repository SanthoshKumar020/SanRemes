import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalMotionProvider, localMotionStatus, resolveMotionFont, scenesFor, wrapText } from "./motion-local.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function probeDuration(file: string): number {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  return Number.parseFloat(out.trim());
}

describe("scenesFor", () => {
  it("splits sentences and lines, caps at eight, truncates long scenes", () => {
    expect(scenesFor("First light. Second light!\nThird light?")).toEqual(["First light.", "Second light!", "Third light?"]);
    expect(scenesFor(Array.from({ length: 12 }, (_, i) => `Scene ${i + 1}.`).join(" "))).toHaveLength(8);
    const long = scenesFor(`${"word ".repeat(40)}.`)[0]!;
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
    expect(scenesFor("   \n  ")).toEqual([]);
  });
});

describe("wrapText", () => {
  it("keeps every line within the frame", () => {
    const lines = wrapText("A harbour at dawn, with the boats still asleep and the gulls not yet awake.");
    expect(lines.every((line) => line.length <= 34)).toBe(true);
    expect(lines.join(" ")).toBe("A harbour at dawn, with the boats still asleep and the gulls not yet awake.");
  });
});

describe("local motion provider", () => {
  it("finds ffmpeg and a font on this machine", () => {
    expect(localMotionStatus()).toEqual({ available: true, reason: "" });
    expect(resolveMotionFont()).toContain("DejaVuSans.ttf");
  });

  it("renders a real MP4 from a prompt", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "sanremes-motion-"));
    dirs.push(outDir);
    const provider = createLocalMotionProvider({ outDir, secondsPerScene: 1 });
    expect(provider.id).toBe("local");
    const result = await provider.generate("A harbour at dawn. The boats wake up.");
    expect(result.ok).toBe(true);
    expect(result.file).toBeDefined();
    expect(existsSync(result.file!)).toBe(true);
    expect(statSync(result.file!).size).toBeGreaterThan(1000);
    expect(probeDuration(result.file!)).toBeGreaterThanOrEqual(1.5);
    expect(probeDuration(result.file!)).toBeLessThanOrEqual(2.5);
  });

  it("refuses an empty prompt without rendering", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "sanremes-motion-"));
    dirs.push(outDir);
    const provider = createLocalMotionProvider({ outDir, secondsPerScene: 1 });
    await expect(provider.generate("   ")).resolves.toEqual({ ok: false, reason: "Say what the video should show." });
  });
});
