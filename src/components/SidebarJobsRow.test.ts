import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  advanced: false,
  dispatch: vi.fn(),
  state: {} as Record<string, unknown>,
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/use-feature", () => ({ useFeature: (name: string) => (name === "jobBot" ? (fixture.state.config as { features?: { jobBot?: boolean } } | undefined)?.features?.jobBot === true : false) }));

import { SidebarJobsRow } from "./SidebarJobsRow";

type Props = { children?: ReactNode; [key: string]: unknown };
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as ReactElement<Props>;
    return [node, ...nodes(node.props.children)];
  });
}
function render(props: { icons: boolean; large: boolean; simple: boolean }) {
  let tree!: ReturnType<typeof SidebarJobsRow>;
  function Capture() { tree = SidebarJobsRow(props); return tree; }
  return { html: renderToStaticMarkup(createElement(Capture)), nodes: nodes(tree) };
}

beforeEach(() => {
  setLocale("en");
  fixture.advanced = false;
  fixture.dispatch.mockReset();
  fixture.state = { activeView: "chat", config: { features: { jobBot: true } }, bots: [] };
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("SidebarJobsRow", () => {
  it("shows Jobs in Simple mode, with a setup dot until a bot is filed under Jobs", () => {
    const { html } = render({ icons: false, large: true, simple: true });
    expect(html).toContain('data-sidebar-jobs=""');
    expect(html).toContain(">Jobs</span>");
    expect(html).toContain('data-jobs-setup="pending"');
    fixture.state.bots = [{ id: "r", name: "Resume Bot", section: "Jobs" }];
    expect(render({ icons: false, large: true, simple: true }).html).not.toContain('data-jobs-setup="pending"');
  });

  it("opens Jobs through the store and marks it current while open", () => {
    const { nodes: tree } = render({ icons: false, large: true, simple: true });
    (tree.find((node) => node.props["data-sidebar-jobs"] === "" && typeof node.props.onClick === "function")!.props.onClick as () => void)();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "showJobs" });
    fixture.state.activeView = "jobs";
    expect(render({ icons: false, large: true, simple: true }).html).toContain('aria-pressed="true"');
  });

  it("stays out of Advanced mode and of the icons column, where the footer nav holds Jobs, and stays hidden while the switch is off", () => {
    expect(render({ icons: false, large: true, simple: false }).html).toBe("");
    expect(render({ icons: true, large: true, simple: false }).html).toBe("");
    fixture.state.config = { features: { jobBot: false } };
    expect(render({ icons: false, large: true, simple: true }).html).toBe("");
  });
});
