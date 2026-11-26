// Pure helpers for the Job Bot's resume tailoring and search reporting. Tailoring only reorders and rewords
// what the stored profile already says; it never adds a skill, employer, salary or certificate.
import { z } from "zod";

import { jobPlatformSchema, type JobsJob, type JobsProfile } from "../shared/jobs.ts";

/** A search turn reports its matches in one fenced block at the end of its reply; the server records it. */
export const SEARCH_REPORT_FENCE = "sanremes-jobs";
/** An apply turn reports a submitted application with this marker so the server can mark it applied. */
export const APPLIED_MARKER = "SANREMES-APPLIED";

const foundJobSchema = z.object({
  platform: jobPlatformSchema,
  url: z.string().url().max(2048),
  title: z.string().min(1).max(300),
  company: z.string().min(1).max(300),
  location: z.string().max(200).optional(),
  salaryText: z.string().max(200).optional(),
  jdText: z.string().max(50_000).optional(),
  jdKeywords: z.array(z.string().max(100)).max(100).optional(),
}).strict();
export type FoundJobReport = z.infer<typeof foundJobSchema>;

/** Pulls the reported matches out of a turn's final text; anything unparseable records nothing. */
export function parseSearchReport(text: string): FoundJobReport[] {
  const match = new RegExp(`\`\`\`${SEARCH_REPORT_FENCE}\n([\\s\\S]*?)\n\`\`\``, "u").exec(text);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: FoundJobReport[] = [];
  for (const row of parsed) {
    const checked = foundJobSchema.safeParse(row);
    if (checked.success) rows.push(checked.data);
  }
  return rows;
}

export function searchReportApplied(text: string, jobId: string): boolean {
  return text.includes(`${APPLIED_MARKER} ${jobId}`);
}

/** One page at a typical resume layout: 90 characters a line, 48 lines. */
export const RESUME_LINE_WIDTH = 90;
export const RESUME_PAGE_MAX_LINES = 48;

export function estimateResumeLines(text: string): number {
  let lines = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) { lines += 1; continue; }
    lines += Math.max(1, Math.ceil(line.length / RESUME_LINE_WIDTH));
  }
  return lines;
}

function containsKeyword(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((keyword) => keyword.trim() && lower.includes(keyword.trim().toLowerCase()));
}

/** Builds a single-page tailored resume from the stored profile and the job, reordering matched material first. */
export function tailorResumeText(profile: JobsProfile, job: Pick<JobsJob, "title" | "company" | "jdKeywords" | "jdText">): string {
  const keywords = job.jdKeywords ?? [];
  const matchedSkills = profile.skills.filter((skill) => keywords.some((keyword) => keyword.trim().toLowerCase() === skill.trim().toLowerCase()));
  const otherSkills = profile.skills.filter((skill) => !matchedSkills.includes(skill));
  const orderedSkills = [...matchedSkills, ...otherSkills];
  const lines: string[] = [profile.name];
  const headline = [profile.title, profile.location].filter(Boolean).join(" · ");
  if (headline) lines.push(headline);
  if (profile.links.length) lines.push(profile.links.join(" · "));
  lines.push("");
  if (orderedSkills.length) {
    lines.push("Skills");
    lines.push(orderedSkills.join(", "));
    lines.push("");
  }
  for (const role of profile.experience) {
    lines.push(`${role.role} — ${role.org} (${role.start}${role.end ? `–${role.end}` : ""})`);
    const matched = role.bullets.filter((bullet) => containsKeyword(bullet, keywords));
    const rest = role.bullets.filter((bullet) => !matched.includes(bullet));
    for (const bullet of [...matched, ...rest]) lines.push(`• ${bullet}`);
    lines.push("");
  }
  if (profile.education) {
    lines.push("Education");
    lines.push(profile.education);
    lines.push("");
  }
  let text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  while (estimateResumeLines(text) > RESUME_PAGE_MAX_LINES) {
    const bulletLines = text.split("\n").map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith("• "));
    const droppable = [...bulletLines].reverse().find(({ line }) => !containsKeyword(line, keywords))
      ?? [...bulletLines].reverse()[0];
    if (!droppable) throw new Error("That tailored resume does not fit on one page.");
    const next = text.split("\n");
    next.splice(droppable.index, 1);
    text = next.join("\n").trim();
  }
  if (estimateResumeLines(text) > RESUME_PAGE_MAX_LINES) throw new Error("That tailored resume does not fit on one page.");
  return text;
}

/** The search prompt's recording contract, so a turn's matches land in the store instead of only in chat. */
export function searchReportInstructions(): string {
  return `End your reply with one fenced block listing every match you found, nothing else inside it: \`\`\`${SEARCH_REPORT_FENCE}\n[{"platform":"naukri","url":"...","title":"...","company":"...","location":"...","salaryText":"...","jdText":"...","jdKeywords":["..."]}]\n\`\`\``;
}

/** The prompt for a search turn: the stored keywords, locations and platforms, plus the company career pages. */
export function searchPrompt(settings: { search: { keywords: string[]; locations: string[]; minSalary?: string }; platforms: Record<string, { enabled: boolean }>; dailyCap: number; companyPages: string[] }): string {
  const lines = ["Search for Data Engineer jobs and record each match in the Jobs store."];
  if (settings.search.keywords.length) lines.push(`Keywords: ${settings.search.keywords.join(", ")}.`);
  if (settings.search.locations.length) lines.push(`Locations: ${settings.search.locations.join(", ")}.`);
  const platforms = Object.entries(settings.platforms).filter(([, platform]) => platform.enabled).map(([name]) => name);
  if (platforms.length) lines.push(`Platforms: ${platforms.join(", ")}.`);
  if (settings.companyPages.length) lines.push(`Also check these company career pages: ${settings.companyPages.join(", ")}.`);
  if (settings.search.minSalary) lines.push(`Minimum salary: ${settings.search.minSalary}.`);
  lines.push(`Apply to nothing yet: an application goes out only from a queue item the person approved, and at most ${settings.dailyCap} applications a day.`);
  lines.push(searchReportInstructions());
  return lines.join(" ");
}

/** The prompt for one approved application: the bot submits it in its own browser and reports the outcome. */
export function applyPrompt(job: Pick<JobsJob, "id" | "title" | "company" | "url">, resumePath: string): string {
  return [
    `Submit the application for "${job.title}" at ${job.company} (${job.url}) in your own browser profile.`,
    `Upload the tailored resume at ${resumePath} with the existing agent_browser_upload tool.`,
    "Fill every field only from the stored job profile; never invent skills, experience, salary, or certificates.",
    "Never try to solve a human check or CAPTCHA: stop and hand sign-in to the person instead.",
    `If the application is submitted, end your reply with a line: ${APPLIED_MARKER} ${job.id}`,
    "If it is not submitted, say plainly what stopped it.",
  ].join(" ");
}
