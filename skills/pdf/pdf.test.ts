import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadBundledSkills, parseSkillManifest } from "../../server/skill-library.ts";
import { generateSample, SAMPLE_DOCUMENT } from "./generate-sample.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("pdf skill", () => {
  it("has a valid manifest whose id matches its folder", () => {
    const manifest = parseSkillManifest(
      JSON.parse(readFileSync(join(process.cwd(), "skills", "pdf", "manifest.json"), "utf8")),
      join(process.cwd(), "skills", "pdf"),
    );
    expect(manifest.id).toBe("pdf");
    expect(manifest.defaultEnabled).toBe(true);
    expect(manifest.triggerTerms).toContain("pdf");
  });

  it("is discovered as a bundled skill and triggers on a PDF request", () => {
    const skills = loadBundledSkills(join(process.cwd(), "skills"));
    const found = skills.find((skill) => skill.manifest.id === "pdf");
    expect(found?.instructions).toContain("filegen_pdf");
    expect(found?.instructions).toContain("---\nname: pdf");
  });

  it("generates a sample PDF that parses back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanremes-pdf-test-"));
    dirs.push(dir);
    const result = await generateSample(dir);
    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.pages).toBeGreaterThanOrEqual(1);
    expect(result.blocks).toBe(SAMPLE_DOCUMENT.blocks.length);
  });
});
