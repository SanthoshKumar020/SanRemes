import { describe, expect, it } from "vitest";

import { defaultSentinelOut, isInside } from "./paths.ts";

describe("sentinel paths", () => {
  it("keeps Sentinel's files in the platform's state folder, outside the data dir", () => {
    expect(defaultSentinelOut("/Users/sanremes/.sanremes", "darwin", "/Users/sanremes", {})).toBe("/Users/sanremes/Library/Application Support/sanremes-sentinel");
    expect(defaultSentinelOut("/home/sanremes/.sanremes", "linux", "/home/sanremes", {})).toBe("/home/sanremes/.local/state/sanremes-sentinel");
    expect(defaultSentinelOut("/home/sanremes/.sanremes", "linux", "/home/sanremes", { XDG_STATE_HOME: "/var/state/sanremes" })).toBe("/var/state/sanremes/sanremes-sentinel");
    // a relative XDG_STATE_HOME is invalid by the spec and ignored
    expect(defaultSentinelOut("/home/sanremes/.sanremes", "linux", "/home/sanremes", { XDG_STATE_HOME: "state" })).toBe("/home/sanremes/.local/state/sanremes-sentinel");
    expect(defaultSentinelOut("C:\\Users\\sanremes\\.sanremes", "win32", "C:\\Users\\sanremes", { LOCALAPPDATA: "D:\\Local" })).toBe("D:\\Local\\sanremes-sentinel");
  });

  it("gives any other data dir its own subfolder, the same one every time", () => {
    const other = defaultSentinelOut("/srv/sanremes-data", "linux", "/home/sanremes", {});
    expect(other).toMatch(/^\/home\/sanremes\/\.local\/state\/sanremes-sentinel\/data-[0-9a-f]{12}$/);
    expect(defaultSentinelOut("/srv/sanremes-data", "linux", "/home/sanremes", {})).toBe(other);
    expect(defaultSentinelOut("/srv/sanremes-data-2", "linux", "/home/sanremes", {})).not.toBe(other);
  });

  it("knows when a folder is inside another", () => {
    expect(isInside("/d/sanremes/sentinel", "/d/sanremes", "linux")).toBe(true);
    expect(isInside("/d/sanremes", "/d/sanremes", "linux")).toBe(true);
    expect(isInside("/d/sanremes-sentinel", "/d/sanremes", "linux")).toBe(false);
    expect(isInside("/d", "/d/sanremes", "linux")).toBe(false);
    expect(isInside("C:\\d\\sanremes\\x", "C:\\d\\sanremes", "win32")).toBe(true);
  });
});
