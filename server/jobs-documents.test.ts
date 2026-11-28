import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { JobsProfile } from "../shared/jobs.ts";
import { estimateResumeLines } from "./jobs-resume.ts";
import {
  buildCoverLetterText,
  buildInterviewPrep,
  coverLetterDocument,
  LINKEDIN_RESUME_MAX_LINES,
  tailorResumeVariant,
  writeDocumentFiles,
} from "./jobs-documents.ts";

const profile: JobsProfile = {
  name: "Santhoshkumar",
  title: "Data Engineer",
  location: "Chennai",
  noticePeriod: "Immediate",
  skills: ["Databricks", "PySpark", "SQL", "AWS Glue"],
  experience: [{
    org: "Swache Technologies", role: "Software Developer", start: "Nov 2025", end: "Aug 2026",
    bullets: [
      "Built ETL pipelines in PySpark for hospital data.",
      "Wrote SQL queries for daily reports.",
      "Fixed bugs in the billing module.",
    ],
  }],
  education: "B.Tech, Adhiyamaan College of Engineering",
  links: ["https://example.com/portfolio"],
  updatedAt: 1,
};

const job = {
  title: "Data Engineer",
  company: "Acme",
  jdKeywords: ["Databricks", "PySpark", "Kafka"],
  jdText: "We need Databricks and PySpark. Kafka is a plus.",
};

const unmatchedProfile: JobsProfile = {
  ...profile,
  skills: ["Excel", "PowerPoint"],
  experience: [{
    org: "Swache Technologies", role: "Software Developer", start: "Nov 2025", end: "Aug 2026",
    bullets: ["Prepared weekly status slides for the team."],
  }],
};

describe("buildCoverLetterText", () => {
  it("names the role and company and uses only matched profile facts", () => {
    const letter = buildCoverLetterText(profile, job);
    expect(letter).toContain("Data Engineer role at Acme");
    expect(letter).toContain("Databricks");
    expect(letter).toContain("PySpark");
    expect(letter).toContain("Chennai");
    expect(letter).toContain("Immediate");
    expect(letter).not.toContain("Kafka");
    expect(letter.length).toBeLessThanOrEqual(2500);
  });

  it("says plainly when nothing matches instead of claiming a skill", () => {
    const letter = buildCoverLetterText(unmatchedProfile, job);
    expect(letter).toContain("My recent work is in Data Engineer at Swache Technologies.");
    expect(letter).not.toContain("Kafka");
    expect(letter).not.toContain("Databricks");
    expect(letter).not.toContain("PySpark");
  });

  it("produces the same letter every time", () => {
    expect(buildCoverLetterText(profile, job)).toBe(buildCoverLetterText(profile, job));
  });
});

describe("coverLetterDocument", () => {
  it("titles the document after the role and company and signs it with the profile name", () => {
    const doc = coverLetterDocument(profile, job);
    expect(doc.title).toBe("Cover letter — Data Engineer at Acme");
    expect(doc.author).toBe("Santhoshkumar");
    expect(doc.blocks.length).toBeGreaterThan(0);
    expect(doc.blocks.every((block) => block.type === "paragraph")).toBe(true);
    expect(doc.blocks.map((block) => (block.type === "paragraph" ? block.text : "")).join("\n\n")).toBe(buildCoverLetterText(profile, job));
  });
});

describe("buildInterviewPrep", () => {
  it("asks about matched skills, stays honest about the rest, and keeps the talking points real", () => {
    const { text, document } = buildInterviewPrep(profile, job);
    expect(text).toContain("Tell me about your work with Databricks.");
    expect(text).toContain("Tell me about your work with PySpark.");
    expect(text).toContain("Be ready to say you have not used Kafka yet.");
    expect(text).toContain("Built ETL pipelines in PySpark for hospital data.");
    expect(text).not.toContain("I have used Kafka");
    expect(document.title).toBe("Interview prep — Data Engineer at Acme");
    expect(document.author).toBe("Santhoshkumar");
  });

  it("caps the questions at five", () => {
    const manySkills = { ...profile, skills: ["A", "B", "C", "D", "E", "F", "G"] };
    const manyKeywords = { ...job, jdKeywords: ["A", "B", "C", "D", "E", "F", "G"] };
    const { text } = buildInterviewPrep(manySkills, manyKeywords);
    expect(text.match(/Tell me about your work with/g)?.length).toBe(5);
  });

  it("includes company notes from research, trimmed and cited", () => {
    const research = `Acme builds tools. ${"Acme is a large company with offices everywhere. ".repeat(40)}`;
    const { text } = buildInterviewPrep(profile, job, research);
    expect(text).toContain("Company notes (from web research)");
    expect(text).toContain("Acme builds tools.");
    const notes = text.split("Company notes (from web research)\n")[1] ?? "";
    expect(notes.length).toBeLessThanOrEqual(800);
  });

  it("says plainly when nothing matches", () => {
    const { text } = buildInterviewPrep(unmatchedProfile, job);
    expect(text).toContain("Be ready to say you have not used Kafka yet.");
    expect(text).toContain("No experience bullets mention the job's keywords.");
  });
});

describe("tailorResumeVariant", () => {
  const wordyProfile: JobsProfile = {
    ...profile,
    experience: [
      {
        org: "Swache Technologies", role: "Software Developer", start: "Nov 2025", end: "Aug 2026",
        bullets: Array.from({ length: 16 }, (_, i) => `Built data pipeline step number ${i} for hospital records.`),
      },
      {
        org: "Yogic Connection", role: "Developer", start: "Jul 2024", end: "Oct 2025",
        bullets: Array.from({ length: 16 }, (_, i) => `Maintained reporting job number ${i} for daily extracts.`),
      },
    ],
  };

  it("keeps the LinkedIn variant shorter than the default and inside its line budget", () => {
    const linkedIn = tailorResumeVariant(wordyProfile, job, "linkedin");
    const standard = tailorResumeVariant(wordyProfile, job, "default");
    const naukri = tailorResumeVariant(wordyProfile, job, "naukri");
    expect(estimateResumeLines(standard)).toBeGreaterThan(LINKEDIN_RESUME_MAX_LINES);
    expect(estimateResumeLines(standard)).toBeLessThanOrEqual(48);
    expect(estimateResumeLines(linkedIn)).toBeLessThanOrEqual(LINKEDIN_RESUME_MAX_LINES);
    expect(estimateResumeLines(linkedIn)).toBeLessThan(estimateResumeLines(standard));
    expect(naukri).toBe(standard);
  });

  it("never invents a skill on any platform", () => {
    for (const platform of ["naukri", "linkedin", "default"] as const) {
      const text = tailorResumeVariant(profile, job, platform);
      expect(text).not.toContain("Kafka");
      expect(text).toContain("Santhoshkumar");
    }
  });

  it("is deterministic", () => {
    expect(tailorResumeVariant(profile, job, "linkedin")).toBe(tailorResumeVariant(profile, job, "linkedin"));
  });
});

describe("writeDocumentFiles", () => {
  it("writes a real .docx and a real .pdf", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobs-documents-"));
    try {
      const { docxPath, pdfPath } = await writeDocumentFiles(dir, "cover-letter", coverLetterDocument(profile, job));
      expect(docxPath).toBe(join(dir, "cover-letter.docx"));
      expect(pdfPath).toBe(join(dir, "cover-letter.pdf"));
      expect(readFileSync(docxPath).subarray(0, 2).toString("latin1")).toBe("PK");
      expect(readFileSync(pdfPath).subarray(0, 4).toString("latin1")).toBe("%PDF");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a base name with a separator or parent traversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobs-documents-"));
    try {
      await expect(writeDocumentFiles(dir, "a/b", coverLetterDocument(profile, job))).rejects.toThrow("not allowed");
      await expect(writeDocumentFiles(dir, "../escape", coverLetterDocument(profile, job))).rejects.toThrow("not allowed");
      await expect(writeDocumentFiles(dir, "..", coverLetterDocument(profile, job))).rejects.toThrow("not allowed");
      await expect(writeDocumentFiles(dir, "", coverLetterDocument(profile, job))).rejects.toThrow("not allowed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
