// Conservative parsing of extracted resume text into profile fields. A field is filled only when the text
// states it plainly: a label, a skills or education section, or an explicit "N years of experience".
// Anything uncertain stays blank; this parser never guesses a skill, year, salary, or credential.
export interface ParsedResumeProfile {
  name?: string;
  title?: string;
  skills?: string[];
  yearsOfExperience?: number;
  salaryCurrent?: string;
  salaryExpected?: string;
  education?: string;
  educationLines?: string[];
  locations?: string[];
  noticePeriod?: string;
}

const MAX_TEXT_CHARS = 200_000;
const MAX_SKILLS = 60;
const MAX_EDUCATION_CHARS = 500;
const MAX_LOCATIONS = 10;

const SECTION_NAMES = new Set([
  "skills", "technical skills", "core skills", "key skills", "technologies", "tech stack",
  "education", "academic background", "academics", "qualifications",
  "experience", "work experience", "professional experience", "employment history",
  "projects", "summary", "profile", "objective", "contact", "contact details",
  "certifications", "certificates", "achievements", "awards", "languages", "hobbies", "interests",
]);

const ROLE_TITLES = [
  "data engineer", "software engineer", "software developer", "frontend developer",
  "front-end developer", "backend developer", "back-end developer",
  "full stack developer", "full-stack developer", "data analyst", "data scientist",
  "qa engineer", "test engineer", "devops engineer", "cloud engineer",
  "product manager", "project manager", "system analyst", "support engineer",
  "machine learning engineer", "ai engineer",
];

const DEGREE_PATTERN = /\b(b\.?\s*tech|b\.?\s*e\.?|m\.?\s*tech|m\.?\s*e\.?|mca|mba|b\.?\s*sc|m\.?\s*sc|bca|b\.?\s*com|bachelor|master|diploma|ph\.?\s*d)\b/i;
const PLACE_MODES = new Set(["remote", "hybrid", "onsite", "on-site", "work from home", "anywhere", "pan india"]);

function linesOf(text: string): string[] {
  return text.slice(0, MAX_TEXT_CHARS).replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
}

function isSectionHeader(line: string): string | null {
  const cleaned = line.replace(/[:\s]+$/u, "").toLowerCase();
  return SECTION_NAMES.has(cleaned) ? cleaned : null;
}

function isLabeledField(line: string): boolean {
  return /^(?:current|expected)\s+(?:salary|ctc|pay|compensation)\s*[:-]/i.test(line)
    || /^notice\s*period\s*[:-]/i.test(line)
    || /^(?:current\s+|preferred\s+|job\s+)?locations?\s*[:-]/i.test(line)
    || /^(?:target role|title|applying for|position|role)\s*[:-]/i.test(line);
}

function sectionLines(lines: readonly string[], wanted: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const header = isSectionHeader(line);
    if (header) {
      if (inside) break;
      inside = wanted.has(header);
      continue;
    }
    if (inside && isLabeledField(line)) break;
    if (inside && line) out.push(line);
  }
  return out;
}

function looksLikeContact(line: string): boolean {
  return line.includes("@") || /https?:\/\//i.test(line) || /www\./i.test(line)
    || /(\+?\d[\d\s()-]{7,}\d)/.test(line) || /^(resume|curriculum vitae|cv)\b/i.test(line);
}

function looksLikeRole(line: string): boolean {
  const lower = line.toLowerCase();
  return ROLE_TITLES.some((role) => lower.includes(role))
    || /\b(engineer|developer|analyst|manager|designer|intern|consultant|architect)\b/i.test(line);
}

function parseName(lines: readonly string[]): string | undefined {
  const candidates = lines.filter(Boolean).slice(0, 6);
  for (const line of candidates) {
    if (isSectionHeader(line) || looksLikeContact(line) || looksLikeRole(line)) continue;
    const words = line.split(/\s+/u);
    if (words.length < 2 || words.length > 4) continue;
    if (!/^[\p{L}][\p{L} .'-]{1,59}$/u.test(line)) continue;
    if (/\d/u.test(line)) continue;
    const titled = words.every((word) => /^[A-Z\p{Lu}]/u.test(word) || word === word.toUpperCase());
    if (titled) return line;
  }
  return undefined;
}

function parseTitle(lines: readonly string[]): string | undefined {
  for (const line of lines.filter(Boolean).slice(0, 12)) {
    const labeled = /^(?:target role|title|applying for|position|role)\s*[:-]\s*(.+)$/i.exec(line);
    if (labeled) {
      const value = labeled[1]!.trim().replace(/\s*[|;]\s*.*$/u, "").trim();
      if (value && value.length <= 100) return value;
    }
  }
  for (const line of lines.filter(Boolean).slice(0, 10)) {
    const head = line.split(/[|•·]/u)[0]!.trim().toLowerCase();
    const match = /^(?:(senior|junior|lead|principal|associate)\s+)?(.+)$/.exec(head);
    if (match && ROLE_TITLES.includes(match[2]!)) return line.split(/[|•·]/u)[0]!.trim();
  }
  return undefined;
}

function cleanSkillToken(raw: string): string | null {
  const token = raw.replace(/^[-*•·\s]+/u, "").replace(/[.\s]+$/u, "").replace(/\s+/g, " ").trim();
  if (!token || token.length < 2 || token.length > 40) return null;
  if (token.split(/\s+/u).length > 6) return null;
  if (!/^[\p{L}0-9][\p{L}0-9 .+#\-/]*$/u.test(token)) return null;
  if (/\byears?\b/i.test(token)) return null;
  return token;
}

function parseSkills(lines: readonly string[]): string[] | undefined {
  const section = sectionLines(lines, new Set(["skills", "technical skills", "core skills", "key skills", "technologies", "tech stack"]));
  const rows = section.length ? section : [];
  if (!rows.length) {
    for (const line of lines) {
      const labeled = /^skills?\s*[:-]\s*(.+)$/i.exec(line);
      if (labeled) rows.push(labeled[1]!);
    }
  }
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const row of rows) {
    for (const part of row.split(/[,;|•·]/u)) {
      const skill = cleanSkillToken(part);
      if (skill && !seen.has(skill.toLowerCase())) {
        seen.add(skill.toLowerCase());
        skills.push(skill);
      }
    }
    if (skills.length >= MAX_SKILLS) break;
  }
  return skills.length ? skills.slice(0, MAX_SKILLS) : undefined;
}

function parseYears(text: string): number | undefined {
  const patterns = [
    /(?:total\s+)?(?:experience|exp\.?)\s*[:-]?\s*(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)/i,
    /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:experience|exp\.?)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      const years = Number(match[1]);
      if (Number.isFinite(years) && years > 0 && years <= 50) return Math.round(years * 10) / 10;
    }
  }
  return undefined;
}

function parseSalary(lines: readonly string[], kind: "current" | "expected"): string | undefined {
  const pattern = kind === "current"
    ? /^(?:current\s+(?:salary|ctc|pay)|current\s+compensation)\s*[:-]\s*(.+)$/i
    : /^(?:expected\s+(?:salary|ctc|pay)|expected\s+compensation)\s*[:-]\s*(.+)$/i;
  for (const line of lines) {
    const match = pattern.exec(line);
    if (!match) continue;
    const value = match[1]!.trim().replace(/[.;\s]+$/u, "");
    if (value && value.length <= 100 && /\d/u.test(value)) return value;
  }
  return undefined;
}

function parseEducation(lines: readonly string[]): { education?: string; educationLines?: string[] } {
  let rows = sectionLines(lines, new Set(["education", "academic background", "academics", "qualifications"]));
  if (!rows.length) {
    for (const line of lines) {
      const labeled = /^education\s*[:-]\s*(.+)$/i.exec(line);
      if (labeled) rows = [labeled[1]!];
    }
  }
  const cleaned = rows
    .map((row) => row.replace(/^[-*•·\s]+/u, "").trim())
    .filter((row) => row && row.length <= 200 && !isSectionHeader(row));
  if (!cleaned.length) return {};
  return {
    educationLines: cleaned,
    education: cleaned.join("; ").slice(0, MAX_EDUCATION_CHARS),
  };
}

function parseLocations(lines: readonly string[]): string[] | undefined {
  const values: string[] = [];
  for (const line of lines) {
    const match = /(?:current\s+|preferred\s+|job\s+)?locations?\s*[:-]\s*(.+)$/i.exec(line)
      ?? /(?:based in|living in|located in)\s+(.+)$/i.exec(line);
    if (match) values.push(match[1]!);
  }
  const seen = new Set<string>();
  const locations: string[] = [];
  for (const value of values) {
    for (const part of value.split(/[,;/]| and /iu)) {
      const place = part.replace(/[.\s]+$/u, "").trim();
      if (!place || place.length < 2 || place.length > 40) continue;
      if (/\d/u.test(place)) continue;
      if (!/^[\p{L}][\p{L} .'-]*$/u.test(place)) continue;
      if (PLACE_MODES.has(place.toLowerCase())) continue;
      if (!seen.has(place.toLowerCase())) {
        seen.add(place.toLowerCase());
        locations.push(place);
      }
    }
    if (locations.length >= MAX_LOCATIONS) break;
  }
  return locations.length ? locations.slice(0, MAX_LOCATIONS) : undefined;
}

function parseNotice(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const match = /^notice\s*period\s*[:-]\s*(.+)$/i.exec(line);
    if (match) {
      const value = match[1]!.trim().replace(/[.;\s]+$/u, "");
      if (value && value.length <= 100) return value;
    }
  }
  for (const line of lines.filter(Boolean).slice(0, 15)) {
    if (/^(immediate joiner|available immediately|immediate)$/i.test(line)) return "Immediate";
  }
  return undefined;
}

export function parseResumeText(text: string): ParsedResumeProfile {
  if (!text || !text.trim()) return {};
  const lines = linesOf(text);
  const joined = lines.join("\n");
  const name = parseName(lines);
  const title = parseTitle(lines);
  const skills = parseSkills(lines);
  const yearsOfExperience = parseYears(joined);
  const salaryCurrent = parseSalary(lines, "current");
  const salaryExpected = parseSalary(lines, "expected");
  const { education, educationLines } = parseEducation(lines);
  const locations = parseLocations(lines);
  const noticePeriod = parseNotice(lines);
  return {
    ...(name ? { name } : {}),
    ...(title ? { title } : {}),
    ...(skills ? { skills } : {}),
    ...(yearsOfExperience !== undefined ? { yearsOfExperience } : {}),
    ...(salaryCurrent ? { salaryCurrent } : {}),
    ...(salaryExpected ? { salaryExpected } : {}),
    ...(education ? { education, educationLines } : {}),
    ...(locations ? { locations } : {}),
    ...(noticePeriod ? { noticePeriod } : {}),
  };
}

export { DEGREE_PATTERN };
