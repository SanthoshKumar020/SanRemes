// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { PRIMARY_RAIL_PINNED_KEY, PrimaryRail, type PrimaryRailDestination } from "./PrimaryRail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root | null = null;

async function mount(props: { active: PrimaryRailDestination; onSelect?: (destination: PrimaryRailDestination) => void; pinned?: boolean; onPinnedChange?: (pinned: boolean) => void }) {
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(PrimaryRail, { onSelect: () => {}, ...props }));
  });
  await act(async () => { await Promise.resolve(); });
}

const rail = () => host.querySelector<HTMLElement>("[data-primary-rail]");
const destinations = () => [...host.querySelectorAll<HTMLButtonElement>("[data-primary-rail-destination]")];
const pin = () => host.querySelector<HTMLButtonElement>("[data-primary-rail-pin]");
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => { (element as HTMLElement).click(); await Promise.resolve(); });
};

beforeEach(() => {
  setLocale("en");
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  document.body.innerHTML = "";
  window.localStorage.clear();
});

describe("PrimaryRail", () => {
  it("renders only Home, Team, Needs you, Chats, Computer and Settings, each a 36px button with a 16px icon, a title and an aria-label, and no badges", async () => {
    await mount({ active: "chat" });
    expect(destinations().map((button) => [button.getAttribute("data-primary-rail-destination"), button.getAttribute("aria-label"), button.getAttribute("title")])).toEqual([
      ["home", "Home", "Home"],
      ["team", "Team", "Team"],
      ["needs-you", "Needs you", "Needs you"],
      ["chat", "Chats", "Chats"],
      ["computer", "Computer", "Computer"],
      ["settings", "Settings", "Settings"],
    ]);
    for (const button of destinations()) {
      expect(button.className).toContain("size-9");
      expect(button.querySelector("svg")?.getAttribute("width")).toBe("16");
      expect(button.textContent).toBe("");
    }
    expect(host.querySelectorAll("button")).toHaveLength(7);
    expect(host.textContent).toBe("");
  });

  it("marks the active destination with aria-current and the selected state, and no other", async () => {
    await mount({ active: "computer" });
    const selected = destinations().find((button) => button.getAttribute("aria-current") === "page");
    expect(selected?.getAttribute("data-primary-rail-destination")).toBe("computer");
    expect(selected?.className).toContain("bg-accent/12");
    expect(destinations().filter((button) => button.getAttribute("aria-current") === "page")).toHaveLength(1);
    expect(destinations().filter((button) => button.className.includes("bg-accent/12"))).toHaveLength(1);
  });

  it("calls onSelect with the destination clicked, including Home, Team and Needs you", async () => {
    const onSelect = vi.fn();
    await mount({ active: "chat", onSelect });
    await click(destinations()[4]);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("computer");
    await click(destinations()[2]);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenLastCalledWith("needs-you");
    await click(destinations()[1]);
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenLastCalledWith("team");
    await click(destinations()[0]);
    expect(onSelect).toHaveBeenCalledTimes(4);
    expect(onSelect).toHaveBeenLastCalledWith("home");
  });

  it("is icon-only at rest and shows labels once pinned, remembering the choice", async () => {
    await mount({ active: "home" });
    expect(rail()?.className).toContain("w-16");
    expect(rail()?.hasAttribute("data-primary-rail-pinned")).toBe(false);
    expect(pin()?.getAttribute("aria-label")).toBe("Pin rail");
    expect(pin()?.getAttribute("aria-pressed")).toBe("false");
    await click(pin());
    expect(rail()?.className).toContain("w-40");
    expect(rail()?.hasAttribute("data-primary-rail-pinned")).toBe(true);
    expect(destinations().map((button) => button.textContent)).toEqual(["Home", "Team", "Needs you", "Chats", "Computer", "Settings"]);
    expect(pin()?.getAttribute("aria-label")).toBe("Unpin rail");
    expect(pin()?.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(PRIMARY_RAIL_PINNED_KEY)).toBe("true");
    await click(pin());
    expect(rail()?.className).toContain("w-16");
    expect(window.localStorage.getItem(PRIMARY_RAIL_PINNED_KEY)).toBe("false");
  });

  it("starts pinned when that was remembered", async () => {
    window.localStorage.setItem(PRIMARY_RAIL_PINNED_KEY, "true");
    await mount({ active: "settings" });
    expect(rail()?.className).toContain("w-40");
    expect(destinations().map((button) => button.textContent)).toEqual(["Home", "Team", "Needs you", "Chats", "Computer", "Settings"]);
  });

  it("in controlled mode reports the toggle instead of remembering it", async () => {
    const onPinnedChange = vi.fn();
    await mount({ active: "home", pinned: true, onPinnedChange });
    expect(rail()?.className).toContain("w-40");
    await click(pin());
    expect(onPinnedChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(window.localStorage.getItem(PRIMARY_RAIL_PINNED_KEY)).toBeNull();
  });
});
