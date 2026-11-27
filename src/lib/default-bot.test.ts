import { describe, expect, it } from "vitest";

import { chiefChoices, chiefFor, chiefStepFits, createChiefPatch, hiddenFromSidebar, INTRO_CHIPS, introChips, myDefaultBot, setupSteps, someoneElsesDefaultBot } from "./default-bot";
import { partitionSidebarBots } from "./sidebar-layout";
import type { DefaultBotFields } from "../../shared/default-bot";

const bot = (id: string, fields: DefaultBotFields = {}): DefaultBotFields & { id: string } => ({ id, ...fields });

describe("SanRemes in the sidebar", () => {
  it("leaves out a SanRemes whose Show switch is off, and on a Team Cloud other people's, but keeps the viewer's own", () => {
    const bots = [
      bot("sanremes", { defaultBot: {} }),
      bot("ada-sanremes", { defaultBot: { person: "ada@example.com" } }),
      bot("bea-sanremes", { defaultBot: { person: "bea@example.com" } }),
      bot("writer"),
    ];
    const shown = (viewerEmail: string | null) => partitionSidebarBots(bots, { viewerEmail }).unsectionedBots.map((entry) => entry.id);
    expect(shown("ada@example.com")).toEqual(["sanremes", "ada-sanremes", "writer"]);
    expect(shown(null)).toEqual(["sanremes", "writer"]);
    bots[0] = bot("sanremes", { defaultBot: {}, sidebarHidden: true });
    expect(shown(null)).toEqual(["writer"]);
    expect(hiddenFromSidebar(bots[0]!, null)).toBe(true);
    expect(someoneElsesDefaultBot(bots[2]!, "ADA@example.com".toLowerCase())).toBe(true);
  });

  it("keeps a regular bot left with SanRemes's Show switch off (demoted while hidden) in the sidebar", () => {
    const bots = [bot("demoted", { sidebarHidden: true }), bot("writer")];
    expect(hiddenFromSidebar(bots[0]!, null)).toBe(false);
    expect(partitionSidebarBots(bots, { viewerEmail: null }).unsectionedBots.map((entry) => entry.id)).toEqual(["demoted", "writer"]);
  });

  it("finds the viewer's own SanRemes: their own on a team, the place's otherwise, none until the viewer is known", () => {
    const team = [bot("ada-sanremes", { defaultBot: { person: "ada@example.com" } }), bot("writer")];
    expect(myDefaultBot(team, undefined)).toBeUndefined();
    expect(myDefaultBot(team, "ada@example.com")?.id).toBe("ada-sanremes");
    expect(myDefaultBot(team, "bea@example.com")).toBeUndefined();
    const place = [bot("writer"), bot("sanremes", { defaultBot: {} })];
    expect(myDefaultBot(place, null)?.id).toBe("sanremes");
    expect(myDefaultBot(place, "owner@example.com")?.id).toBe("sanremes");
  });
});

describe("SanRemes's identity is its mark, never its name", () => {
  it("keeps finding a renamed SanRemes for the Settings switch and the sidebar, and keeps it out of the list while its welcome is open", () => {
    const bots = [bot("writer"), { ...bot("sanremes", { defaultBot: {} }), name: "Jarvis" }];
    expect(myDefaultBot(bots, null)?.id).toBe("sanremes");
    expect(partitionSidebarBots(bots, { viewerEmail: null }).unsectionedBots.map((entry) => entry.id)).toEqual(["writer", "sanremes"]);
    expect(partitionSidebarBots(bots, { viewerEmail: null, welcoming: "sanremes" }).unsectionedBots.map((entry) => entry.id)).toEqual(["writer"]);
  });
});

describe("what SanRemes offers to set up", () => {
  const fresh = { aiReady: false, ownBots: 0, onCloud: false, team: false, remote: false };

  it("in Advanced mode, as on a new install before: an AI, bots, apps, and the Cloud", () => {
    expect(setupSteps(fresh)).toEqual(["ai", "bots", "apps", "cloud"]);
    expect(setupSteps({ ...fresh, aiReady: true, onCloud: true })).toEqual(["bots", "apps"]);
    expect(setupSteps({ ...fresh, ownBots: 3 })).toEqual(["ai"]);
    expect(setupSteps({ ...fresh, team: true })).toEqual([]);
  });

  it("in Simple mode, chips for only what its look around found missing, in order: AI, apps, skills, Cloud", () => {
    expect(introChips(fresh)).toEqual(["ai", "apps", "cloud"]);
    expect(introChips({ ...fresh, aiReady: true, importFound: true })).toEqual(["apps", "import", "cloud"]);
    expect(introChips({ ...fresh, aiReady: true, appsConnected: true })).toEqual(["cloud"]);
    expect(introChips({ ...fresh, aiReady: true, remote: true })).toEqual(["apps"]);
    expect(introChips({ ...fresh, aiReady: true, onCloud: true, importFound: false })).toEqual(["apps"]);
    expect(INTRO_CHIPS).toBe(3);
  });

  it("never offers a bot (the sidebar's + adds one), nor nags a person who is set up or a Team Cloud member", () => {
    expect(introChips(fresh)).not.toContain("bots");
    expect(introChips({ ...fresh, aiReady: true, ownBots: 3, importFound: true })).toEqual([]);
    expect(introChips({ ...fresh, ownBots: 3 })).toEqual(["ai"]);
    expect(introChips({ ...fresh, team: true })).toEqual([]);
  });
});

describe("the first run's Chief step", () => {
  const sanremes = { id: "sanremes", defaultBot: {}, chiefOfStaff: true };

  it("shows for a SanRemes not yet introduced, where it is the Chief or there is none", () => {
    expect(chiefStepFits([sanremes], sanremes)).toBe(true);
    expect(chiefStepFits([{ ...sanremes, chiefOfStaff: false }], { ...sanremes, chiefOfStaff: false })).toBe(true);
  });

  it("is skipped where another bot is the Chief, once SanRemes has met the person, and with no SanRemes", () => {
    const other = { ...sanremes, chiefOfStaff: false };
    expect(chiefStepFits([other, { id: "research", chiefOfStaff: true }], other)).toBe(false);
    expect(chiefStepFits([{ ...sanremes, welcomed: true }], { ...sanremes, welcomed: true })).toBe(false);
    expect(chiefStepFits([{ id: "research" }], undefined)).toBe(false);
  });

  it("keeps a Chief in another department out of it", () => {
    const other = { ...sanremes, chiefOfStaff: false };
    expect(chiefStepFits([other, { id: "sales", chiefOfStaff: true, section: "Sales" }], other)).toBe(true);
  });
});

describe("who becomes the Chief of Staff on the first run", () => {
  type Candidate = { id: string; defaultBot?: { person?: string }; chiefOfStaff?: boolean; section?: string; hidden?: boolean };
  const sanremes: Candidate = { id: "sanremes", defaultBot: {}, chiefOfStaff: true };
  const research: Candidate = { id: "research" };

  it("finds the Chief in SanRemes's own department, never a department's or a hidden one", () => {
    expect(chiefFor([sanremes, research], sanremes)?.id).toBe("sanremes");
    expect(chiefFor([{ ...sanremes, chiefOfStaff: false }, { ...research, chiefOfStaff: true }], sanremes)?.id).toBe("research");
    expect(chiefFor([{ ...sanremes, chiefOfStaff: false }, { id: "sales", section: "Sales", chiefOfStaff: true }], sanremes)).toBeUndefined();
    expect(chiefFor([{ ...sanremes, chiefOfStaff: false }, { id: "old", chiefOfStaff: true, hidden: true }], sanremes)).toBeUndefined();
  });

  it("offers the person's own bots there to choose from, never SanRemes, a hidden bot or someone else's", () => {
    const bots: Candidate[] = [sanremes, research, { id: "sales", section: "Sales" }, { id: "gone", hidden: true }, { id: "ada-sanremes", defaultBot: { person: "ada@example.com" } }];
    expect(chiefChoices(bots, sanremes, null).map((bot) => bot.id)).toEqual(["research"]);
    expect(chiefChoices([sanremes], sanremes, null)).toEqual([]);
  });

  it("Create makes SanRemes the Chief only where there is none, and never takes the role from a Chief someone has", () => {
    expect(createChiefPatch({ defaultBot: {} }, undefined)).toEqual({ welcomed: true, chiefOfStaff: true });
    expect(createChiefPatch({ defaultBot: {} }, sanremes)).toEqual({ welcomed: true });
    expect(createChiefPatch({ defaultBot: {}, sidebarHidden: true }, sanremes), "back in the sidebar").toEqual({ welcomed: true, sidebarHidden: false });
  });
});
