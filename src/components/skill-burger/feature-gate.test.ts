// Settings → Features: Skill Burger off takes its chat card, its menu entries, its page and the bot panel's saved list
// away. Nothing saved is touched, so on brings it all back.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { skillBurgerEnabled, threadTabsEnabled } from "@/lib/feature-flags";
import { toolMenuItems } from "../SidebarProfileMenu";

const fixture = { config: {} as Record<string, unknown> };

beforeEach(() => {
  fixture.config = {};
  setLocale("en");
});
afterEach(() => {});

/** The tools menu as the sidebar builds it, with the Skill Burger entry only while the flag is on. */
const phoneTools = () => toolMenuItems({
  activeView: "chat", automationsNeedYou: false, onAutomations: () => {}, onTeamMap: () => {},
  onPublishedApps: () => {}, onSkillBurgers: skillBurgerEnabled(fixture.config as never) ? () => {} : undefined,
}).map((item) => item.key);

describe("the Skill Burger switch", () => {
  it("is on, and thread tabs off, until the place's config.json says otherwise", () => {
    expect(skillBurgerEnabled(null)).toBe(true);
    expect(skillBurgerEnabled({ features: { skillBurger: false } })).toBe(false);
    expect(threadTabsEnabled(null)).toBe(false);
    expect(threadTabsEnabled({ features: { threadTabs: true } })).toBe(true);
  });

  it("shows Skill Burgers in the tools menu by default, hides it while off, and brings it back on", () => {
    expect(phoneTools()).toContain("skill-burgers");
    fixture.config = { features: { skillBurger: false } };
    expect(phoneTools()).not.toContain("skill-burgers");
    fixture.config = { features: { skillBurger: true } };
    expect(phoneTools()).toContain("skill-burgers");
  });

  it("gates every other way in at its call site", () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source("../ChatView.tsx")).toMatch(/\{skillBurger && <SkillBurgerSlot /);
    expect(source("../../App.tsx")).toContain('state.activeView === "skill-burgers" && skillBurger ? (');
    expect(source("../SidebarProfileMenu.tsx")).toContain('onSkillBurgers: skillBurger ? () => dispatch({ type: "showSkillBurgers" }) : undefined,');
    expect(source("../bot-panel/pages.tsx")).toMatch(/\{skillBurger && <SavedWorkflowsCard /);
    for (const path of ["../ChatView.tsx", "../../App.tsx", "../SidebarProfileMenu.tsx", "../bot-panel/pages.tsx"]) {
      expect(source(path), path).toContain('skillBurger = useFeature("skillBurger")');
    }
  });
});
