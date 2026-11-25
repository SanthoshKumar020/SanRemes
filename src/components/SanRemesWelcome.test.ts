import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/i18n";
import { StoreProvider, type Bot } from "@/state/store";
import { draftOf, SanRemesWelcomeCard, sanRemesWelcomeDue, welcomeName, welcomePatch } from "./SanRemesWelcome";

const sanremes = { id: "sanremes", threadId: "t1", name: "SanRemes", title: "", description: "", notifications: true, color: "chrome", mascotBody: null,
  avatarUrl: null, unread: false, modelSelection: { instanceId: "claude", model: "sonnet" }, createdAt: 1, defaultBot: {} } as unknown as Bot;

describe("SanRemes's first-launch welcome", () => {
  it("shows once, after onboarding and its tour, and never again after either choice", () => {
    const due = (bot: Pick<Bot, "welcomed" | "hidden"> | undefined, more: Partial<Parameters<typeof sanRemesWelcomeDue>[0]> = {}) =>
      sanRemesWelcomeDue({ bot, onboardingDue: false, welcomeOpen: false, tourOpen: false, ...more });
    expect(due({})).toBe(true);
    expect(due({ welcomed: true })).toBe(false);
    expect(due({}, { onboardingDue: true })).toBe(false);
    expect(due({}, { welcomeOpen: true })).toBe(false);
    expect(due({}, { tourOpen: true })).toBe(false);
    expect(due(undefined)).toBe(false);
    expect(due({ hidden: true })).toBe(false);
  });

  it("Add saves the person's changes, pins SanRemes and keeps it in the sidebar", () => {
    expect(welcomePatch(sanremes, { ...draftOf(sanremes), name: " Jarvis ", color: "blue", mascotBody: "blob" }, true))
      .toEqual({ name: "Jarvis", color: "blue", mascotBody: "blob", welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("Add with the panel never opened keeps the chrome-steel defaults", () => {
    expect(welcomePatch(sanremes, draftOf(sanremes), true)).toEqual({ welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("Not now turns Show SanRemes in the sidebar off, keeping what was changed, and nothing unchanged is sent", () => {
    expect(welcomePatch(sanremes, draftOf(sanremes), false)).toEqual({ welcomed: true, sidebarHidden: true });
    expect(welcomePatch(sanremes, { ...draftOf(sanremes), mascotBody: "star" }, false)).toEqual({ mascotBody: "star", welcomed: true, sidebarHidden: true });
  });

  it("saves an empty name as SanRemes and caps a long one at the bot-name limit", () => {
    const jarvis = { ...sanremes, name: "Jarvis" };
    expect(welcomePatch(jarvis, { ...draftOf(jarvis), name: "   " }, true).name).toBe("SanRemes");
    expect(welcomeName("x".repeat(300))).toHaveLength(100);
    expect(welcomeName("  Ada ")).toBe("Ada");
  });

  it("saves an uploaded picture as the bot's own edit screen would, and a colour picked after it goes back to the shape", () => {
    const uploaded = { ...draftOf(sanremes), avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle" as const };
    expect(welcomePatch(sanremes, uploaded, true)).toEqual({ avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle", welcomed: true, sidebarHidden: false, pinned: true });
    expect(welcomePatch(sanremes, { ...uploaded, color: "blue", avatarCrop: "mascot" }, true))
      .toEqual({ avatarUrl: "/api/attachments/abc.png", color: "blue", welcomed: true, sidebarHidden: false, pinned: true });
    const pictured = { ...sanremes, avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle" } as Bot;
    expect(welcomePatch(pictured, { ...draftOf(pictured), avatarUrl: null, avatarCrop: "mascot" }, true))
      .toEqual({ avatarUrl: null, avatarCrop: "mascot", welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("opens on SanRemes's picture alone: the customise panel stays closed until the picture is clicked", () => {
    const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(SanRemesWelcomeCard, { bot: sanremes, onClose: () => {} })));
    expect(html).toContain(`aria-label="${t("sanremesWelcome.customize", { name: "SanRemes" })}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-sanremes-welcome-panel="closed"');
    expect(html).toMatch(/data-sanremes-welcome-panel="closed"[^>]*|inert=""[^>]*data-sanremes-welcome-panel="closed"/);
    expect(html).toContain(t("sanremesWelcome.title", { name: "SanRemes" }));
    expect(html).toContain(t("sanremesWelcome.add", { name: "SanRemes" }));
  });
});
