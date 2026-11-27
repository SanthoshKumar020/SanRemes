import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadBundledSkills, parseSkillManifest } from "../../server/skill-library.ts";
import { generateSample, SAMPLE_DECK } from "./generate-sample.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("powerpoint skill", () => {
  it("has a valid manifest whose id matches its folder", () => {
    const manifest = parseSkillManifest(
      JSON.parse(readFileSync(join(process.cwd(), "skills", "powerpoint", "manifest.json"), "utf8")),
      join(process.cwd(), "skills", "powerpoint"),
    );
    expect(manifest.id).toBe("powerpoint");
    expect(manifest.defaultEnabled).toBe(true);
    expect(manifest.triggerTerms).toContain("pptx");
  });

  it("is discovered as a bundled skill and triggers on a deck request", () => {
    const skills = loadBundledSkills(join(process.cwd(), "skills"));
    const found = skills.find((skill) => skill.manifest.id === "powerpoint");
    expect(found?.instructions).toContain("filegen_presentation");
    expect(found?.instructions).toContain("---\nname: powerpoint");
  });

  it("generates a sample deck that parses back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanremes-powerpoint-test-"));
    dirs.push(dir);
    const result = await generateSample(dir);
    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.slides).toBe(SAMPLE_DECK.slides.length + 1);
    expect(result.charts).toBe(2);
  });
});
