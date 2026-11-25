import { z } from "zod";
import type { ServerResponse } from "node:http";

import { loadWatches, newWatch, saveWatches } from "../browser-errands.ts";
import { json } from "../harness/http.ts";
import { MemoryNotesError } from "../memory-notes.ts";
import { memoryActorForAuth } from "../memory-trust.ts";
import type { RequestAuth } from "../request-auth.ts";
import { workspaceDir } from "../workspace.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BrowserWatchesRouteDeps {
  bot(id: string): { id: string } | null | undefined;
  ownersWrite?: <T>(auth: RequestAuth, botId: string, write: () => T) => T;
}

const watchInput = z.object({
  name: z.string().trim().min(1).max(200),
  url: z.string().trim().url().max(2000),
  routineId: z.string().trim().min(1).max(100),
});

export function createBrowserWatchesRoutes(deps: BrowserWatchesRouteDeps): RouteHandler {
  function replyWatchesError(res: ServerResponse, error: unknown) {
    if (!(error instanceof MemoryNotesError)) throw error;
    return json(res, error.status, { error: error.message, code: error.code });
  }

  return async ({ req, res, path, method, auth, readBody }) => {
    const m = path.match(/^\/api\/bots\/([\w-]+)\/browser-watches(?:\/([\w-]+))?$/);
    if (!m) return PASS;
    const botId = m[1]!;
    if (!deps.bot(botId)) return json(res, 404, { error: "no such bot" });
    const root = workspaceDir(botId);
    const write = <T>(change: () => T): T => (deps.ownersWrite ? deps.ownersWrite(auth, botId, change) : change());
    const ownerOnly = (): boolean => {
      if (memoryActorForAuth(auth) === "owner") return false;
      json(res, 403, { error: "only the owner can change page watches directly", code: "owner-only" });
      return true;
    };
    try {
      if (method === "GET" && !m[2]) {
        return json(res, 200, { watches: loadWatches(root) });
      }
      if (method === "POST" && !m[2]) {
        if (ownerOnly()) return;
        const parsed = watchInput.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "a watch needs a name, a URL and the routine it reports into" });
        const watch = newWatch(parsed.data.name, parsed.data.url, parsed.data.routineId);
        const watches = write(() => saveWatches(root, [...loadWatches(root), watch]));
        return json(res, 200, { ok: true, watch, watches });
      }
      if (method === "DELETE" && m[2]) {
        if (ownerOnly()) return;
        const watchId = m[2]!;
        const kept = write(() => {
          const all = loadWatches(root);
          if (!all.some((watch) => watch.id === watchId)) return null;
          return saveWatches(root, all.filter((watch) => watch.id !== watchId));
        });
        if (!kept) return json(res, 404, { error: "no such watch" });
        return json(res, 200, { ok: true, watches: kept });
      }
    } catch (error) {
      return replyWatchesError(res, error);
    }
    return PASS;
  };
}
