// Pure builders for the Job Bot's documents: cover letters, interview prep and per-platform resume
// variants, plus writing the finished documents to .docx and .pdf files. Every word comes from the
// stored profile or the job description; nothing here invents a skill, employer, salary or certificate.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { JobsJob, JobsProfile } from "../shared/jobs.ts";
import { writeFileAtomic } from "./atomic.ts";
import { generateDocument, generatePdf, type FilegenDocument } from "./filegen/index.ts";
import { RESUME_PAGE_MAX_LINES, tailorResumeText } from "./jobs-resume.ts";

export type JobsDocumentJob = Pick<JobsJob, "title" | "company" | "jdKeywords" | "jdText">;
export type ResumePlatform = "naukri" | "linkedin" | "default";

/** A LinkedIn Easy Apply resume gets a tighter page than the standard one-page budget. */
export const LINKEDIN_RESUME_MAX_LINES = 36;
export const COVER_LETTER_MAX_CHARS = 2500;
export const INTERVIEW_PREP_MAX_QUESTIONS = 5;
export const INTERVIEW_PREP_MAX_TALKING_POINTS = 5;
export const INTERVIEW_PREP_MAX_UNMATCHED = 10;
export const COMPANY_NOTES_MAX_CHARS = 800;

const sameWord = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function cleanKeywords(job: JobsDocumentJob): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const keyword of job.jdKeywords ?? []) {
    const trimmed = keyword.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    keywords.push(trimmed);
  }
  return keywords;
}

function matchedSkills(profile: JobsProfile, keywords: readonly string[]): string[] {
  return profile.skills.filter((skill) => keywords.some((keyword) => sameWord(keyword, skill)));
}

function unmatchedKeywords(keywords: readonly string[], matched: readonly string[]): string[] {
  return keywords.filter((keyword) => !matched.some((skill) => sameWord(keyword, skill)));
}

function mentionsKeyword(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => keyword.trim() && lower.includes(keyword.trim().toLowerCase()));
}

function matchedBullets(profile: JobsProfile, keywords: readonly string[]): string[] {
  const bullets: string[] = [];
  for (const role of profile.experience) {
    for (const bullet of role.bullets) {
      if (mentionsKeyword(bullet, keywords)) bullets.push(bullet);
    }
  }
  return bullets;
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
  if (lastSentence > maxChars / 2) return cut.slice(0, lastSentence + 1);
  return cut.trimEnd();
}

function recentWorkLine(profile: JobsProfile): string {
  const field = profile.title?.trim() || "software";
  const firstRole = profile.experience[0];
  if (firstRole) return `My recent work is in ${field} at ${firstRole.org}.`;
  return `My recent work is in ${field}.`;
}

/** A cover letter built only from the profile and the job: the role, the matched facts, a plain close. */
export function buildCoverLetterText(profile: JobsProfile, job: JobsDocumentJob): string {
  const keywords = cleanKeywords(job);
  const matched = matchedSkills(profile, keywords);
  const bullets = matchedBullets(profile, keywords).slice(0, 2);
  const paragraphs: string[] = [
    "Dear hiring team,",
    `I am applying for the ${job.title} role at ${job.company}.`,
  ];
  if (matched.length) {
    const facts = [`My work includes ${matched.slice(0, 3).join(", ")}.`];
    for (const bullet of bullets) facts.push(bullet);
    paragraphs.push(facts.join(" "));
  } else {
    paragraphs.push(`${recentWorkLine(profile)} I do not have direct experience with the tools this role lists, and I would rather say that plainly than claim a match I do not have.`);
  }
  const close: string[] = [];
  if (profile.location?.trim()) close.push(`I am based in ${profile.location.trim()}.`);
  if (profile.noticePeriod?.trim()) close.push(`My notice period is ${profile.noticePeriod.trim()}.`);
  close.push("Thank you for considering my application. I would welcome the chance to discuss the role.");
  paragraphs.push(close.join(" "));
  paragraphs.push(profile.title ? `${profile.name}\n${profile.title}` : profile.name);
  return capText(paragraphs.join("\n\n"), COVER_LETTER_MAX_CHARS);
}

/** The same cover letter as filegen blocks, so it can be written out as a .docx or .pdf. */
export function coverLetterDocument(profile: JobsProfile, job: JobsDocumentJob): FilegenDocument {
  return {
    title: `Cover letter — ${job.title} at ${job.company}`,
    author: profile.name,
    blocks: buildCoverLetterText(profile, job).split("\n\n").map((text) => ({ type: "paragraph" as const, text })),
  };
}

/** Interview prep from the profile and the job: questions on matched skills, honest gaps, talking points. */
export function buildInterviewPrep(profile: JobsProfile, job: JobsDocumentJob, companyResearch?: string): { text: string; document: FilegenDocument } {
  const keywords = cleanKeywords(job);
  const matched = matchedSkills(profile, keywords);
  const unmatched = unmatchedKeywords(keywords, matched).slice(0, INTERVIEW_PREP_MAX_UNMATCHED);
  const talkingPoints = matchedBullets(profile, keywords).slice(0, INTERVIEW_PREP_MAX_TALKING_POINTS);

  const questionLines: string[] = matched
    .slice(0, INTERVIEW_PREP_MAX_QUESTIONS)
    .map((skill) => `Tell me about your work with ${skill}.`);
  const gapLines: string[] = unmatched.map((keyword) => `Be ready to say you have not used ${keyword} yet.`);

  const textLines: string[] = [`Interview prep — ${job.title} at ${job.company}`, "", "Likely questions"];
  if (questionLines.length) {
    for (const line of questionLines) textLines.push(`- ${line}`);
  } else {
    textLines.push("No matched skills to base questions on — the questions for this interview would come from the job description, not from the profile.");
  }
  for (const line of gapLines) textLines.push(`- ${line}`);
  textLines.push("", "Talking points");
  if (talkingPoints.length) {
    for (const point of talkingPoints) textLines.push(`- ${point}`);
  } else {
    textLines.push("No experience bullets mention the job's keywords.");
  }
  const notes = companyResearch?.trim();
  if (notes) {
    textLines.push("", "Company notes (from web research)");
    textLines.push(notes.slice(0, COMPANY_NOTES_MAX_CHARS));
  }

  const blocks: FilegenDocument["blocks"] = [
    { type: "heading", level: 2, text: "Likely questions" },
  ];
  if (questionLines.length || gapLines.length) {
    blocks.push({ type: "bullets", items: [...questionLines, ...gapLines] });
  } else {
    blocks.push({ type: "paragraph", text: "No matched skills to base questions on — the questions for this interview would come from the job description, not from the profile." });
  }
  blocks.push({ type: "heading", level: 2, text: "Talking points" });
  if (talkingPoints.length) {
    blocks.push({ type: "bullets", items: talkingPoints });
  } else {
    blocks.push({ type: "paragraph", text: "No experience bullets mention the job's keywords." });
  }
  if (notes) {
    blocks.push({ type: "heading", level: 2, text: "Company notes" });
    blocks.push({ type: "paragraph", text: `${notes.slice(0, COMPANY_NOTES_MAX_CHARS)} (from web research)` });
  }

  return {
    text: textLines.join("\n"),
    document: {
      title: `Interview prep — ${job.title} at ${job.company}`,
      author: profile.name,
      blocks,
    },
  };
}

/** Per-platform tuning on top of the tailor: LinkedIn Easy Apply gets the tighter 36-line page. */
export function tailorResumeVariant(profile: JobsProfile, job: JobsDocumentJob, platform: ResumePlatform): string {
  const maxLines = platform === "linkedin" ? LINKEDIN_RESUME_MAX_LINES : RESUME_PAGE_MAX_LINES;
  return tailorResumeText(profile, job, { maxLines });
}

/** Writes the document as `<baseName>.docx` and `<baseName>.pdf` inside `dir`, creating it as needed. */
export async function writeDocumentFiles(dir: string, baseName: string, doc: FilegenDocument): Promise<{ docxPath: string; pdfPath: string }> {
  if (!baseName || baseName.length > 100 || baseName === "." || baseName.includes("/") || baseName.includes("\\") || baseName.includes("..")) {
    throw new Error("That file name is not allowed: use a plain name without folders, at most 100 characters.");
  }
  await mkdir(dir, { recursive: true });
  const docx = await generateDocument(doc);
  const pdf = await generatePdf(doc);
  const docxPath = join(dir, `${baseName}.docx`);
  const pdfPath = join(dir, `${baseName}.pdf`);
  writeFileAtomic(docxPath, docx);
  writeFileAtomic(pdfPath, pdf);
  return { docxPath, pdfPath };
}
