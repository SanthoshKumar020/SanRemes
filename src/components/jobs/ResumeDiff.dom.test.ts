// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";

import { ResumeDiff } from "./ResumeDiff";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("ResumeDiff", () => {
  it("shows added and removed lines with the invention warning", async () => {
    root = createRoot(host);
    await act(async () => root.render(createElement(ResumeDiff, {
      base: "Santhoshkumar\nDatabricks, SQL",
      tailored: "Santhoshkumar\nDatabricks, SQL, PySpark",
    })));
    expect(host.textContent).toContain("Every added line must come from your profile");
    expect(host.textContent).toContain("+ Databricks, SQL, PySpark");
    expect(host.textContent).toContain("− Databricks, SQL");
    expect(host.textContent).toContain("Santhoshkumar");
  });
});
