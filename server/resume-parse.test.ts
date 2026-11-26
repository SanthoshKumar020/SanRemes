import { describe, expect, it } from "vitest";

import { parseResumeText } from "./resume-parse.ts";

const FULL_RESUME = [
  "Test Person",
  "Data Engineer",
  "test.person@example.com · +91 90000 00000 · Chennai",
  "",
  "Summary",
  "Data Engineer with 2.5 years of experience building ETL pipelines.",
  "",
  "Skills",
  "Databricks, PySpark, SQL, AWS Glue, Airflow, Delta Lake",
  "Python • Spark SQL",
  "",
  "Experience",
  "Junior Data Engineer — Example Corp (Jan 2024 – Present)",
  "Built pipelines in PySpark for 2.5 years of experience.",
  "",
  "Education",
  "B.Tech, Example Institute of Technology, 2024",
  "",
  "Current Salary: ₹3,60,000",
  "Expected Salary: ₹6,00,000",
  "Location: Chennai, Bengaluru",
  "Notice Period: 15 days",
].join("\n");

describe("parseResumeText", () => {
  it("fills every confident field from a complete resume", () => {
    const parsed = parseResumeText(FULL_RESUME);
    expect(parsed.name).toBe("Test Person");
    expect(parsed.title).toBe("Data Engineer");
    expect(parsed.skills).toEqual(["Databricks", "PySpark", "SQL", "AWS Glue", "Airflow", "Delta Lake", "Python", "Spark SQL"]);
    expect(parsed.yearsOfExperience).toBe(2.5);
    expect(parsed.salaryCurrent).toBe("₹3,60,000");
    expect(parsed.salaryExpected).toBe("₹6,00,000");
    expect(parsed.education).toBe("B.Tech, Example Institute of Technology, 2024");
    expect(parsed.educationLines).toEqual(["B.Tech, Example Institute of Technology, 2024"]);
    expect(parsed.locations).toEqual(["Chennai", "Bengaluru"]);
    expect(parsed.noticePeriod).toBe("15 days");
  });

  it("leaves uncertain fields blank instead of guessing", () => {
    const parsed = parseResumeText([
      "Example Candidate",
      "Open to work",
      "CTC: ₹6,00,000",
      "I have built data pipelines for several years.",
      "Worked at Example Corp from 2022 to 2024.",
    ].join("\n"));
    expect(parsed.name).toBe("Example Candidate");
    expect(parsed.title).toBeUndefined();
    expect(parsed.skills).toBeUndefined();
    expect(parsed.yearsOfExperience).toBeUndefined();
    expect(parsed.salaryCurrent).toBeUndefined();
    expect(parsed.salaryExpected).toBeUndefined();
    expect(parsed.education).toBeUndefined();
    expect(parsed.locations).toBeUndefined();
    expect(parsed.noticePeriod).toBeUndefined();
  });

  it("returns nothing for empty or gibberish text", () => {
    expect(parseResumeText("")).toEqual({});
    expect(parseResumeText("   \n\n  ")).toEqual({});
    expect(parseResumeText("asdf qwer zxcv 1234 !@#$")).toEqual({});
  });

  it("does not take a role line or a resume header as the name", () => {
    const parsed = parseResumeText([
      "Resume",
      "Data Engineer",
      "Test Person",
      "Skills",
      "SQL, Python",
    ].join("\n"));
    expect(parsed.name).toBe("Test Person");
    expect(parsed.title).toBe("Data Engineer");
  });

  it("takes skills only from the skills section, not from later sections", () => {
    const parsed = parseResumeText([
      "Test Person",
      "Skills",
      "SQL, Python",
      "Projects",
      "Kafka, Airflow, Snowflake",
    ].join("\n"));
    expect(parsed.skills).toEqual(["SQL", "Python"]);
  });

  it("dedupes skills without changing their wording", () => {
    const parsed = parseResumeText("Test Person\nSkills\nSQL, sql, Python, SQL\n");
    expect(parsed.skills).toEqual(["SQL", "Python"]);
  });

  it("reads a labeled target role and total experience", () => {
    const parsed = parseResumeText([
      "Test Person",
      "Target Role: Data Analyst",
      "Total Experience: 3 years",
    ].join("\n"));
    expect(parsed.title).toBe("Data Analyst");
    expect(parsed.yearsOfExperience).toBe(3);
  });

  it("does not derive years from date ranges alone", () => {
    const parsed = parseResumeText([
      "Test Person",
      "Example Corp, Jan 2022 – Dec 2024",
    ].join("\n"));
    expect(parsed.yearsOfExperience).toBeUndefined();
  });

  it("rejects an implausible years figure", () => {
    const parsed = parseResumeText("Test Person\nExperience: 99 years\n");
    expect(parsed.yearsOfExperience).toBeUndefined();
  });

  it("reads education lines only from the education section", () => {
    const parsed = parseResumeText([
      "Test Person",
      "Education",
      "MCA, Example University, 2022",
      "B.Sc, Example College, 2020",
      "Experience",
      "B.Tech, Somewhere Else, 2019",
    ].join("\n"));
    expect(parsed.educationLines).toEqual(["MCA, Example University, 2022", "B.Sc, Example College, 2020"]);
  });

  it("drops work-mode words from locations and keeps real places", () => {
    const parsed = parseResumeText("Test Person\nPreferred Location: Chennai, Remote, Hybrid\n");
    expect(parsed.locations).toEqual(["Chennai"]);
  });

  it("reads an immediate notice period", () => {
    expect(parseResumeText("Test Person\nNotice Period: Immediate\n").noticePeriod).toBe("Immediate");
    expect(parseResumeText("Test Person\nImmediate Joiner\n").noticePeriod).toBe("Immediate");
  });

  it("keeps a labeled salary only when it carries a number", () => {
    expect(parseResumeText("Test Person\nCurrent Salary: To be discussed\n").salaryCurrent).toBeUndefined();
    expect(parseResumeText("Test Person\nExpected CTC: 6 LPA\n").salaryExpected).toBe("6 LPA");
  });
});
