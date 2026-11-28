import { describe, expect, it } from "vitest";
import { CATEGORY_SECTION_SIZE, catalogSections, connectorDescription, inCategory, isMicrosoft365Card, MICROSOFT_365_CATEGORY, rankCategories } from "./app-catalog";

const card = (slug: string, ...categories: string[]) => ({ slug, categories });

describe("rankCategories", () => {
  it("ranks by how many apps carry a category, ties by name, and folds the rest under More", () => {
    const cards = [card("a", "Productivity", "Files"), card("b", "Productivity"), card("c", "Design"), card("d", "Communication", "Communication"), card("e"), { slug: "f" }];
    expect(rankCategories(cards, 2)).toEqual({ inline: ["Productivity", "Communication"], more: ["Design", "Files"] });
    expect(rankCategories([])).toEqual({ inline: [], more: [] });
  });

  it("keeps a category SanRemes's own app lives in among the inline ones, taking the last place", () => {
    const cards = [card("a", "Productivity"), card("b", "Productivity"), card("c", "Design"), card("d", "Design"), card("e", "Files"), card("postiz", "Social")];
    expect(rankCategories(cards, 2, ["Social"])).toEqual({ inline: ["Design", "Social"], more: ["Productivity", "Files"] });
    expect(rankCategories(cards, 3, ["Social"]).inline).toEqual(["Design", "Productivity", "Social"]);
    expect(rankCategories(cards, 4, ["Social"]).inline).toEqual(["Design", "Productivity", "Files", "Social"]);
    expect(rankCategories(cards, 2, ["Missing"])).toEqual(rankCategories(cards, 2));
  });
});

describe("inCategory", () => {
  it("lets everything through without a category", () => {
    expect(inCategory({ slug: "x" }, null)).toBe(true);
    expect(inCategory(card("x", "Design"), "Design")).toBe(true);
    expect(inCategory({ slug: "x" }, "Design")).toBe(false);
  });
});

describe("isMicrosoft365Card", () => {
  it("recognises the four Microsoft 365 apps by their category, and nothing else", () => {
    expect(MICROSOFT_365_CATEGORY).toBe("Microsoft 365");
    expect(isMicrosoft365Card(card("outlook", "Communication", "Microsoft 365"))).toBe(true);
    expect(isMicrosoft365Card(card("one_drive", "Microsoft 365"))).toBe(true);
    expect(isMicrosoft365Card(card("gmail", "Communication"))).toBe(false);
    expect(isMicrosoft365Card({ slug: "teams" })).toBe(false);
  });
});

describe("connectorDescription", () => {
  it("names the Microsoft 365 apps in plain words, including the work-or-school limit where it applies", () => {
    expect(connectorDescription({ label: "Outlook", blurb: "fallback" })).toBe("Read and send mail, calendar and tasks");
    expect(connectorDescription({ label: "OneDrive", blurb: "fallback" })).toBe("Files and folders, upload and share");
    expect(connectorDescription({ label: "SharePoint", blurb: "fallback" })).toContain("work or school account");
    expect(connectorDescription({ label: "Microsoft Teams", blurb: "fallback" })).toContain("work or school account");
    expect(connectorDescription({ label: "Unknown App", blurb: "fallback" })).toBe("fallback");
  });
});

describe("catalogSections", () => {
  const cards = [
    card("slack", "Communication"),
    card("gmail", "Communication"),
    ...Array.from({ length: 6 }, (_, index) => card(`p${index}`, "Productivity")),
    card("figma", "Design"),
  ];
  const connected = (slug: string) => slug === "slack";

  it("leads with connected apps, previews categories with what is left, then the whole catalog", () => {
    const sections = catalogSections(cards, connected, ["Productivity", "Communication", "Design", "Files"]);
    expect(sections.map((section) => section.kind === "category" ? section.category : section.kind)).toEqual(["connected", "Productivity", "Communication", "Design", "all"]);
    expect(sections[0]!.cards.map((entry) => entry.slug)).toEqual(["slack"]);
    const productivity = sections[1]!;
    expect(productivity.cards).toHaveLength(CATEGORY_SECTION_SIZE);
    expect(productivity.kind === "category" && productivity.more).toBe(true);
    expect(sections[2]!.cards.map((entry) => entry.slug)).toEqual(["gmail"]);
    expect(sections.at(-1)!.cards.some((entry) => entry.slug === "slack")).toBe(false);
  });

  it("keeps the catalog section even when empty, and skips empty ones", () => {
    expect(catalogSections([], connected, ["Design"])).toEqual([{ kind: "all", cards: [] }]);
  });
});
