import { incognitoThreadIds } from "../incognito-threads.ts";
import { buildRecap, collectRecapInput, formatRecap, type RecapPeriod } from "../recaps/recaps.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface RecapRouteDeps {
  dataDir: string;
  now?: () => Date;
}

/** Weekly and monthly recaps: usage and memory changes, with incognito threads left out. */
export function createRecapRoutes(deps: RecapRouteDeps): RouteHandler {
  return async ({ res, url, path, method, auth, json }) => {
    if (method !== "GET") return PASS;
    const match = /^\/api\/recaps\/(weekly|monthly)$/.exec(path);
    if (!match) return PASS;
    if (auth.kind === "session" && !auth.scopes.includes("admin")) return json(res, 403, { error: "Recaps are for the owner." });
    const period = match[1] as RecapPeriod;
    const recap = buildRecap(collectRecapInput(deps.dataDir, period, deps.now?.() ?? new Date(), undefined, new Set(incognitoThreadIds())));
    res.setHeader("cache-control", "no-store");
    if (url.searchParams.get("format") === "text") {
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(formatRecap(recap));
      return;
    }
    return json(res, 200, recap);
  };
}
