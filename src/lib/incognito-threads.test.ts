import { describe, expect, it } from "vitest";

import { incognitoThreadIdsOf, isIncognitoThread } from "./incognito-threads.ts";

describe("incognitoThreadIdsOf", () => {
  it("reads the server's list and ignores anything else", () => {
    const bot = { incognitoThreadIds: ["t-1", 7, null, "t-2"] };
    expect([...incognitoThreadIdsOf(bot)]).toEqual(["t-1", "t-2"]);
    expect(isIncognitoThread(bot, "t-1")).toBe(true);
    expect(isIncognitoThread(bot, "t-3")).toBe(false);
    expect(isIncognitoThread({}, "t-1")).toBe(false);
  });
});
