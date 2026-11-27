import { describe, expect, it } from "vitest";
import { renderDesign, validateDesignInput } from "./design.ts";

describe("validateDesignInput", () => {
  it("accepts a hero with features", () => {
    const input = { layout: "hero", brand: "Acme", headline: "Ship faster", features: [{ title: "Fast", text: "Nothing to install." }] };
    expect(validateDesignInput(input)).toEqual({ design: input });
  });

  it("rejects an unknown layout and a missing brand", () => {
    expect(validateDesignInput({ layout: "flyer", brand: "A", headline: "H" })).toMatchObject({ error: expect.stringContaining("layout") });
    expect(validateDesignInput({ layout: "hero", headline: "H" })).toMatchObject({ error: expect.stringContaining("brand") });
  });

  it("requires exactly 3 pricing tiers, a project for portfolio and a stat for dashboard", () => {
    expect(validateDesignInput({ layout: "pricing", brand: "A", headline: "H", tiers: [] })).toMatchObject({ error: expect.stringContaining("3 tiers") });
    expect(validateDesignInput({ layout: "portfolio", brand: "A", headline: "H" })).toMatchObject({ error: expect.stringContaining("project") });
    expect(validateDesignInput({ layout: "dashboard", brand: "A", headline: "H" })).toMatchObject({ error: expect.stringContaining("stat") });
  });
});

describe("renderDesign", () => {
  const tiers = [
    { name: "Free", price: "$0", features: ["1 project"] },
    { name: "Pro", price: "$12", features: ["Unlimited"], highlight: true },
    { name: "Team", price: "$29", features: ["SSO"] },
  ];

  it("renders a hero with nav, headline, call to action and features", () => {
    const rendered = renderDesign({ layout: "hero", brand: "Acme", headline: "Ship faster", subhead: "One place.", ctaLabel: "Start free", features: [{ title: "Fast", text: "Quick." }] });
    if ("error" in rendered) throw new Error(rendered.error);
    expect(rendered.html).toContain("Acme");
    expect(rendered.html).toContain("Ship faster");
    expect(rendered.html).toContain("Start free");
    expect(rendered.html).toContain("Fast");
    expect(rendered.title).toContain("Acme");
  });

  it("renders all three pricing tiers with the highlighted one marked", () => {
    const rendered = renderDesign({ layout: "pricing", brand: "Acme", headline: "Pricing", tiers });
    if ("error" in rendered) throw new Error(rendered.error);
    expect(rendered.html).toContain("Free");
    expect(rendered.html).toContain("Pro");
    expect(rendered.html).toContain("Team");
    expect(rendered.html).toContain('class="tier highlight"');
  });

  it("renders a portfolio grid and a dashboard with stats and a chart", () => {
    const portfolio = renderDesign({ layout: "portfolio", brand: "Acme", headline: "Work", projects: [{ title: "Site", text: "A redesign.", tag: "Web" }] });
    if ("error" in portfolio) throw new Error(portfolio.error);
    expect(portfolio.html).toContain("Site");
    expect(portfolio.html).toContain("Web");
    const dashboard = renderDesign({ layout: "dashboard", brand: "Acme", headline: "Overview", stats: [{ label: "Users", value: "1,204", change: "+12%" }] });
    if ("error" in dashboard) throw new Error(dashboard.error);
    expect(dashboard.html).toContain("1,204");
    expect(dashboard.html).toContain("Users");
    expect(dashboard.html).toContain("Weekly activity");
  });

  it("renders a signup mockup whose form never posts", () => {
    const rendered = renderDesign({ layout: "signup", brand: "Acme", headline: "Join us", ctaLabel: "Create account" });
    if ("error" in rendered) throw new Error(rendered.error);
    expect(rendered.html).toContain("Create your account");
    expect(rendered.html).toContain("preventDefault");
    expect(rendered.html).toContain("A mockup: nothing is sent.");
  });

  it("escapes brand and headline", () => {
    const rendered = renderDesign({ layout: "hero", brand: "<Acme>", headline: "Hi <b>" });
    if ("error" in rendered) throw new Error(rendered.error);
    expect(rendered.html).toContain("&lt;Acme&gt;");
    expect(rendered.html).not.toContain("<Acme>");
  });

  it("keeps every layout under the show_html size limit", () => {
    const inputs = [
      { layout: "hero", brand: "A", headline: "H", features: [{ title: "F", text: "T" }] },
      { layout: "pricing", brand: "A", headline: "H", tiers },
      { layout: "portfolio", brand: "A", headline: "H", projects: [{ title: "P", text: "T" }] },
      { layout: "dashboard", brand: "A", headline: "H", stats: [{ label: "L", value: "1" }] },
      { layout: "signup", brand: "A", headline: "H" },
    ];
    for (const input of inputs) {
      const rendered = renderDesign(input);
      if ("error" in rendered) throw new Error(rendered.error);
      expect(new TextEncoder().encode(rendered.html).length).toBeLessThan(256 * 1024);
    }
  });
});
