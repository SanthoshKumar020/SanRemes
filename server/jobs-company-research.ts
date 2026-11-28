export interface CompanyResearch {
  company: string;
  summary: string;
  sources: { title: string; url: string }[];
  researchedAt: number;
  searches: number;
  pagesRead: number;
}

export type CompanyResearchOutcome =
  | { ok: true; research: CompanyResearch }
  | { ok: false; company: string; reason: string };

export interface CompanyResearchInput {
  company: string;
  role?: string;
  location?: string;
}

export interface CompanyResearchDeps {
  research: (question: string) => Promise<{
    answer: string;
    sources: { title: string; url: string }[];
    searches: number;
    pagesRead: number;
  }>;
  now?: () => number;
}

const MAX_QUESTION_CHARS = 500;
const MAX_SUMMARY_CHARS = 2000;
const MAX_SOURCES = 10;

const clean = (value: string): string => value.trim().replace(/\s+/g, " ");

/** The deep-research question for one hiring company: what it does, its team for the role, hiring in the location, recent news. */
export function companyResearchQuestion(company: string, role?: string, location?: string): string {
  const name = clean(company);
  if (!name) throw new Error("Company research needs a company name.");
  const parts = [`What does ${name} do`];
  const detail = clean(role ?? "");
  if (detail) parts.push(`what is its ${detail} team like`);
  const place = clean(location ?? "");
  if (place) parts.push(`is it hiring in ${place}`);
  const question = `${parts.join(", ")}? Recent news about ${name}.`;
  return question.length > MAX_QUESTION_CHARS ? question.slice(0, MAX_QUESTION_CHARS).trimEnd() : question;
}

/** Best-effort company research: a failure is a plain-words outcome, never a throw, so applying is never blocked. */
export async function researchCompany(
  input: CompanyResearchInput,
  deps: CompanyResearchDeps,
): Promise<CompanyResearchOutcome> {
  const company = clean(input.company);
  if (!company) {
    return { ok: false, company, reason: "Company research needs a company name." };
  }
  let result: Awaited<ReturnType<CompanyResearchDeps["research"]>>;
  try {
    result = await deps.research(companyResearchQuestion(company, input.role, input.location));
    const summary = (result?.answer ?? "").trim();
    if (!summary) {
      return { ok: false, company, reason: "The research came back empty." };
    }
    const sources = (result.sources ?? []).slice(0, MAX_SOURCES).map((source) => ({
      title: source.title,
      url: source.url,
    }));
    return {
      ok: true,
      research: {
        company,
        summary: summary.length > MAX_SUMMARY_CHARS ? summary.slice(0, MAX_SUMMARY_CHARS).trimEnd() : summary,
        sources,
        researchedAt: (deps.now ?? Date.now)(),
        searches: result.searches ?? 0,
        pagesRead: result.pagesRead ?? 0,
      },
    };
  } catch {
    return { ok: false, company, reason: "The web search did not answer." };
  }
}

/** Per-run memo of company research, keyed by company name: one company is researched once per run. */
export function createCompanyResearchCache(): {
  researchCompanyCached(input: CompanyResearchInput, deps: CompanyResearchDeps): Promise<CompanyResearchOutcome>;
} {
  const byCompany = new Map<string, Promise<CompanyResearchOutcome>>();
  return {
    researchCompanyCached(input, deps) {
      const key = clean(input.company).toLowerCase();
      const cached = byCompany.get(key);
      if (cached) return cached;
      const outcome = researchCompany(input, deps);
      byCompany.set(key, outcome);
      return outcome;
    },
  };
}
