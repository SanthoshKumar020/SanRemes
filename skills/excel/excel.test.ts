import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadBundledSkills, parseSkillManifest } from "../../server/skill-library.ts";
import { generateSample, sampleWorkbook } from "./generate-sample.ts";
import { evaluateTab } from "../../shared/spreadsheet/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("excel skill", () => {
  it("has a valid manifest whose id matches its folder", () => {
    const manifest = parseSkillManifest(
      JSON.parse(readFileSync(join(process.cwd(), "skills", "excel", "manifest.json"), "utf8")),
      join(process.cwd(), "skills", "excel"),
    );
    expect(manifest.id).toBe("excel");
    expect(manifest.defaultEnabled).toBe(true);
    expect(manifest.triggerTerms).toContain("xlsx");
  });

  it("is discovered as a bundled skill and triggers on a spreadsheet request", () => {
    const skills = loadBundledSkills(join(process.cwd(), "skills"));
    const found = skills.find((skill) => skill.manifest.id === "excel");
    expect(found?.instructions).toContain("data_export");
    expect(found?.instructions).toContain("---\nname: excel");
  });

  it("evaluates the sample workbook's formulas to 450 and 330", () => {
    const workbook = sampleWorkbook();
    const tab = workbook.tabs[0]!;
    const evaluated = evaluateTab(workbook, tab.id);
    expect(evaluated[4]?.[1]).toBe(450);
    expect(evaluated[4]?.[2]).toBe(330);
  });

  it("generates a sample spreadsheet that parses back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sanremes-excel-test-"));
    dirs.push(dir);
    const result = await generateSample(dir);
    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.rows).toBe(5);
    expect(result.revenueTotal).toBe(450);
    expect(result.expensesTotal).toBe(330);
  }, 120_000);
});
