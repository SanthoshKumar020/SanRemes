import { describe, expect, it, vi } from "vitest";
import {
  companyResearchQuestion,
  createCompanyResearchCache,
  researchCompany,
  type CompanyResearchDeps,
} from "./jobs-company-research.ts";

const NOW = Date.parse("2026-11-28T10:00:00Z");

function sources(count: number): { title: string; url: string }[] {
  return Array.from({ length: count }, (_value, index) => ({
    title: `Source ${index + 1}`,
    url: `https://example.com/${index + 1}`,
  }));
}

function deps(overrides: Partial<CompanyResearchDeps> = {}): CompanyResearchDeps {
  return {
    research: async () => ({ answer: "Acme builds widgets.", sources: sources(2), searches: 3, pagesRead: 2 }),
    now: () => NOW,
    ...overrides,
  };
}

describe("companyResearchQuestion", () => {
  it("builds the question with role and location", () => {
    expect(companyResearchQuestion("Acme", "Data Engineer", "Bengaluru")).toBe(
      "What does Acme do, what is its Data Engineer team like, is it hiring in Bengaluru? Recent news about Acme.",
    );
  });

  it("builds the question with company only", () => {
    expect(companyResearchQuestion("Acme")).toBe("What does Acme do? Recent news about Acme.");
  });

  it("trims inputs and caps the question at 500 chars", () => {
    const question = companyResearchQuestion(`  ${"Acme ".repeat(100)}  `, "  Data Engineer  ");
    expect(question.length).toBeLessThanOrEqual(500);
    expect(question).toContain("Acme");
  });

  it("refuses an empty company", () => {
    expect(() => companyResearchQuestion("   ")).toThrow("Company research needs a company name.");
  });
});

describe("researchCompany", () => {
  it("maps the answer, sources and counts through", async () => {
    const outcome = await researchCompany({ company: " Acme ", role: "Data Engineer" }, deps());
    expect(outcome).toEqual({
      ok: true,
      research: {
        company: "Acme",
        summary: "Acme builds widgets.",
        sources: [
          { title: "Source 1", url: "https://example.com/1" },
          { title: "Source 2", url: "https://example.com/2" },
        ],
        researchedAt: NOW,
        searches: 3,
        pagesRead: 2,
      },
    });
  });

  it("caps a long summary at 2000 chars and sources at 10", async () => {
    const outcome = await researchCompany(
      { company: "Acme" },
      deps({ research: async () => ({ answer: ` ${"word ".repeat(600)}`, sources: sources(12), searches: 1, pagesRead: 1 }) }),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.research.summary.length).toBeLessThanOrEqual(2000);
    expect(outcome.research.sources).toHaveLength(10);
  });

  it("returns a plain-words failure when the research throws", async () => {
    const outcome = await researchCompany(
      { company: "Acme" },
      deps({
        research: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(outcome).toEqual({ ok: false, company: "Acme", reason: "The web search did not answer." });
  });

  it("returns a plain-words failure for an empty answer", async () => {
    const outcome = await researchCompany(
      { company: "Acme" },
      deps({ research: async () => ({ answer: "   ", sources: [], searches: 1, pagesRead: 0 }) }),
    );
    expect(outcome).toEqual({ ok: false, company: "Acme", reason: "The research came back empty." });
  });

  it("returns a plain-words failure for an empty company instead of throwing", async () => {
    const outcome = await researchCompany({ company: "   " }, deps());
    expect(outcome).toEqual({ ok: false, company: "", reason: "Company research needs a company name." });
  });

  it("passes the built question to the research function", async () => {
    const research = vi.fn(async () => ({ answer: "Yes.", sources: [], searches: 0, pagesRead: 0 }));
    await researchCompany({ company: "Acme", role: "Data Engineer", location: "Chennai" }, deps({ research }));
    expect(research).toHaveBeenCalledWith(
      "What does Acme do, what is its Data Engineer team like, is it hiring in Chennai? Recent news about Acme.",
    );
  });
});

describe("createCompanyResearchCache", () => {
  it("calls the research function once for the same company, case-insensitively", async () => {
    const research = vi.fn(async () => ({ answer: "Acme builds widgets.", sources: sources(1), searches: 1, pagesRead: 1 }));
    const cache = createCompanyResearchCache();
    const first = await cache.researchCompanyCached({ company: "Acme" }, deps({ research }));
    const second = await cache.researchCompanyCached({ company: "  acme " }, deps({ research }));
    expect(research).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("researches two companies independently", async () => {
    const research = vi.fn(async (question: string) => ({
      answer: `Answer for ${question}`,
      sources: [],
      searches: 1,
      pagesRead: 0,
    }));
    const cache = createCompanyResearchCache();
    await cache.researchCompanyCached({ company: "Acme" }, deps({ research }));
    await cache.researchCompanyCached({ company: "Globex" }, deps({ research }));
    await cache.researchCompanyCached({ company: "Acme" }, deps({ research }));
    expect(research).toHaveBeenCalledTimes(2);
  });
});
