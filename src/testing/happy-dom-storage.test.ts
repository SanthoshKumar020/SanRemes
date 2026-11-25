// @vitest-environment happy-dom
import { expect, it } from "vitest";

it("reads a key written on localStorage back through window.localStorage", () => {
  localStorage.setItem("sanremes", "kept");
  expect(window.localStorage.getItem("sanremes")).toBe("kept");
  localStorage.removeItem("sanremes");
  expect(window.localStorage.getItem("sanremes")).toBeNull();
});
