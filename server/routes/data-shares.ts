// Live sharing of a bot's data, plus certified views. A share is one stored
// query: anyone with its id re-runs it and sees the current rows, the tables
// it reads, and whether its owner certified it. Revoking a share ends it.
import { z } from "zod";

import type { DataError } from "../../shared/data-surface.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteContext, type RouteHandler } from "../routes/table.ts";
import type { DataSheetRegistry } from "../data/sheet.ts";
import { dataErrorStatus } from "../data/routes.ts";
import { DataShareStore, validateShareSql, type DataShare } from "../data/shares.ts";
import { toDataError } from "../data/tools.ts";
import type { DataEngine } from "../data/types.ts";

export interface DataShareRouteDeps {
  bot(id: string): { id: string; cwd?: string } | null | undefined;
  engine: Pick<DataEngine, "unavailable" | "forBot">;
  sheets: Pick<DataSheetRegistry, "for">;
  store: DataShareStore;
  isOwner(auth: RequestAuth): boolean;
}

const CREATE = /^\/api\/bots\/([\w-]+)\/data\/shares$/;
const LIST = /^\/api\/bots\/([\w-]+)\/data\/shares$/;
const READ = /^\/api\/data-shares\/([\w-]+)$/;
const CERTIFY = /^\/api\/data-shares\/([\w-]+)\/certify$/;
const REVOKE = /^\/api\/data-shares\/([\w-]+)\/revoke$/;
const CARD_ID = /^c_\d+$/;

const createBody = z.object({
  title: z.string().min(1).max(200),
  sql: z.string().min(1).max(100_000).optional(),
  cardId: z.string().regex(CARD_ID).optional(),
}).strict();
const certifyBody = z.object({
  by: z.string().min(1).max(200),
  note: z.string().max(500).optional(),
}).strict();

function publicShare(share: DataShare): Pick<DataShare, "id" | "botId" | "title" | "sources" | "certified" | "createdAt"> {
  return { id: share.id, botId: share.botId, title: share.title, sources: share.sources, certified: share.certified, createdAt: share.createdAt };
}

export function createDataSharesRoutes(deps: DataShareRouteDeps): RouteHandler {
  const replyError = (ctx: RouteContext, error: DataError) => ctx.json(ctx.res, dataErrorStatus(error.code), { error });
  const invalid = (message: string): DataError => ({ code: "invalid_input", message });

  async function body<T>(ctx: RouteContext, schema: z.ZodType<T>): Promise<T | undefined> {
    let raw: unknown;
    try {
      raw = await ctx.readBody(ctx.req, 256_000);
    } catch (error) {
      replyError(ctx, invalid((error as Error).message || "The request body is not JSON."));
      return undefined;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      replyError(ctx, invalid(parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")));
      return undefined;
    }
    return parsed.data;
  }

  return async (ctx) => {
    const { res, method } = ctx;
    const create = CREATE.exec(ctx.path);
    const list = LIST.exec(ctx.path);
    const read = READ.exec(ctx.path);
    const certify = CERTIFY.exec(ctx.path);
    const revoke = REVOKE.exec(ctx.path);
    if (!create && !list && !read && !certify && !revoke) return PASS;

    if (create && method === "POST") {
      if (!deps.isOwner(ctx.auth)) return ctx.json(res, 403, { error: "Only the owner can share a bot's data." });
      const bot = deps.bot(create[1]!);
      if (!bot) return replyError(ctx, { code: "source_not_found", message: "no such bot" });
      const input = await body(ctx, createBody);
      if (!input) return;
      if (Boolean(input.sql) === Boolean(input.cardId)) return replyError(ctx, invalid("Give exactly one of sql or cardId."));
      let sql: string | undefined = input.sql;
      if (input.cardId) {
        const card = deps.sheets.for(bot.id).card(input.cardId);
        if (!card) return replyError(ctx, { code: "card_not_found", message: `No card ${input.cardId} on the sheet.` });
        sql = card.sql;
      }
      if (!sql) return replyError(ctx, invalid("That card has no query to share."));
      const problem = validateShareSql(sql);
      if (problem) return replyError(ctx, invalid(problem));
      const share = deps.store.create({ botId: bot.id, title: input.title, sql });
      return ctx.json(res, 201, { share: publicShare(share) });
    }

    if (list && method === "GET") {
      if (!deps.isOwner(ctx.auth)) return ctx.json(res, 403, { error: "Only the owner can list a bot's shares." });
      const bot = deps.bot(list[1]!);
      if (!bot) return replyError(ctx, { code: "source_not_found", message: "no such bot" });
      return ctx.json(res, 200, { shares: deps.store.list(bot.id).map(publicShare) });
    }

    if (read && method === "GET") {
      const share = deps.store.get(read[1]!);
      if (!share) return ctx.json(res, 404, { error: "No such share." });
      if (share.revokedAt !== null) return ctx.json(res, 410, { error: "This share was revoked." });
      const unavailable = deps.engine.unavailable();
      if (unavailable !== null) return replyError(ctx, { code: "engine_unavailable", message: unavailable });
      const bot = deps.bot(share.botId);
      if (!bot) return replyError(ctx, { code: "source_not_found", message: "no such bot" });
      const abort = new AbortController();
      res.once("close", () => { if (!res.writableEnded) abort.abort(); });
      try {
        const database = await deps.engine.forBot(bot.id);
        const result = await database.run(share.sql, { connection: "panel", maxRows: 500, signal: abort.signal });
        return ctx.json(res, 200, { share: publicShare(share), columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated });
      } catch (error) {
        return replyError(ctx, toDataError(error, undefined, abort.signal));
      }
    }

    if (certify && method === "POST") {
      if (!deps.isOwner(ctx.auth)) return ctx.json(res, 403, { error: "Only the owner can certify a shared view." });
      const input = await body(ctx, certifyBody);
      if (!input) return;
      const share = deps.store.certify(certify[1]!, input.by, input.note);
      if (!share) return ctx.json(res, 404, { error: "No such share, or it was revoked." });
      return ctx.json(res, 200, { share: publicShare(share) });
    }

    if (revoke && method === "POST") {
      if (!deps.isOwner(ctx.auth)) return ctx.json(res, 403, { error: "Only the owner can revoke a share." });
      const share = deps.store.revoke(revoke[1]!);
      if (!share) return ctx.json(res, 404, { error: "No such share, or it was already revoked." });
      return ctx.json(res, 200, { ok: true });
    }

    return replyError(ctx, invalid(`No ${method} ${ctx.path} route.`));
  };
}
