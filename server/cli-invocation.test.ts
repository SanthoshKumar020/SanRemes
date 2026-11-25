import { describe, expect, it } from "vitest";

import { cliCommand, cliPrefix } from "./cli-invocation.ts";

describe("cliPrefix", () => {
  it("prints commands the way the CLI was started", () => {
    expect(cliPrefix({}, "/home/me/.npm/_npx/1a2b/node_modules/sanremes/dist-server/sanremes.js")).toBe("npx sanremes");
    expect(cliPrefix({ npm_command: "exec" }, "/repo/node_modules/vitest/vitest.mjs"), "another tool run by npx").toBe("sanremes");
    expect(cliPrefix({ npm_lifecycle_event: "sanremes" }, "/repo/server/sanremes.ts")).toBe("pnpm sanremes");
    expect(cliPrefix({ SANREMES_CLI_PREFIX: "docker compose exec sanremes sanremes" }, "/app/dist-server/sanremes.js")).toBe("docker compose exec sanremes sanremes");
    expect(cliPrefix({}, "/usr/lib/node_modules/sanremes/dist-server/sanremes.js")).toBe("sanremes");
    expect(cliCommand("pair", {}, "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\9\\node_modules\\sanremes\\x.js")).toBe("npx sanremes pair");
  });
});
