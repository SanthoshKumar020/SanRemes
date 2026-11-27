import { describe, expect, it } from "vitest";

import type { JobsProfile } from "../shared/jobs.ts";
import { applyPrompt, estimateResumeLines, HUMAN_CHECK_MARKER, parseSearchReport, RESUME_PAGE_MAX_LINES, searchReportApplied, tailorResumeText } from "./jobs-resume.ts";

const profile: JobsProfile = {
  name: "Santhoshkumar",
  title: "Data Engineer",
  location: "Chennai",
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

describe("tailorResumeText", () => {
  it("reorders matched skills and bullets first and stays on one page", () => {
    const text = tailorResumeText(profile, job);
    expect(estimateResumeLines(text)).toBeLessThanOrEqual(RESUME_PAGE_MAX_LINES);
    expect(text).toContain("Santhoshkumar");
    expect(text).toContain("Databricks, PySpark, SQL, AWS Glue");
    expect(text.indexOf("Built ETL pipelines in PySpark")).toBeLessThan(text.indexOf("Fixed bugs in the billing module."));
  });

  it("never invents a skill the profile does not have", () => {
    const text = tailorResumeText(profile, job);
    expect(text).not.toContain("Kafka");
    expect(text).not.toContain("Airflow");
    expect(text).not.toContain("₹");
  });

  it("drops low-priority bullets before giving up, and fails visibly when the resume cannot fit", () => {
    const wordy: JobsProfile = {
      ...profile,
      skills: Array.from({ length: 200 }, (_, i) => `SkillNumber${i}WithALongName`),
      experience: [{
        org: "Swache Technologies", role: "Software Developer", start: "Nov 2025", end: "Aug 2026",
        bullets: Array.from({ length: 60 }, (_, i) => `Did detailed work item number ${i} across several systems and teams.`),
      }],
    };
    expect(() => tailorResumeText(wordy, job)).toThrow("does not fit on one page");
    const droppable: JobsProfile = {
      ...profile,
      experience: [{
        org: "Swache Technologies", role: "Software Developer", start: "Nov 2025", end: "Aug 2026",
        bullets: [
          "Built ETL pipelines in PySpark for hospital data.",
          ...Array.from({ length: 60 }, (_, i) => `Routine maintenance task ${i}.`),
        ],
      }],
    };
    const text = tailorResumeText(droppable, job);
    expect(estimateResumeLines(text)).toBeLessThanOrEqual(RESUME_PAGE_MAX_LINES);
    expect(text).toContain("Built ETL pipelines in PySpark");
  });
});

describe("parseSearchReport", () => {
  it("reads the fenced block a search turn ends with", () => {
    const text = [
      "Found two matches.",
      "```sanremes-jobs",
      JSON.stringify([
        { platform: "naukri", url: "https://www.naukri.com/job/1", title: "Data Engineer", company: "Acme", jdKeywords: ["Databricks"] },
        { platform: "linkedin", url: "https://www.linkedin.com/jobs/2", title: "Data Engineer", company: "Beta" },
      ]),
      "```",
    ].join("\n");
    const rows = parseSearchReport(text);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ platform: "naukri", title: "Data Engineer", company: "Acme" });
  });

  it("records nothing when there is no block, a broken block, or only invalid rows", () => {
    expect(parseSearchReport("Found nothing worth recording.")).toEqual([]);
    expect(parseSearchReport("```sanremes-jobs\n{not json\n```")).toEqual([]);
    expect(parseSearchReport("```sanremes-jobs\n[{\"platform\": \"naukri\"}]\n```")).toEqual([]);
  });
});

describe("searchReportApplied", () => {
  it("only matches the marker for the job it names", () => {
    expect(searchReportApplied("Done.\nSANREMES-APPLIED job-1", "job-1")).toBe(true);
    expect(searchReportApplied("Done.\nSANREMES-APPLIED job-1", "job-2")).toBe(false);
    expect(searchReportApplied("The application is still in progress.", "job-1")).toBe(false);
  });
});

describe("applyPrompt", () => {
  it("tells the bot to open its closing message with the human-check marker and never solve one", () => {
    const prompt = applyPrompt({ id: "job-1", title: "Data Engineer", company: "Acme", url: "https://www.naukri.com/job/1" }, "/resumes/job-1.txt");
    expect(prompt).toContain(`start your closing message with ${HUMAN_CHECK_MARKER}`);
    expect(prompt).toContain("Never try to solve a human check or CAPTCHA");
  });
});
