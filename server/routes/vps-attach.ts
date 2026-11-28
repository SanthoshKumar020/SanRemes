// One-click VPS attach: verify the server answers, then point the bot at it; detach does the reverse.
// The checks run the same Docker-over-SSH commands the docs' manual path uses, and every failure is in
// plain words naming the step to fix. The bot's own computer is never moved while it still lives on the
// old server: detach refuses until the container is gone, and names the command that removes it.
import { z } from "zod";

import type { AppConfig } from "../config.ts";
import type { BotRecord } from "../store.ts";
import { defaultRunner, VpsHostUnreachableError, type VpsCommandRunner } from "../vps-command.ts";
import { vpsContainerName } from "../vps-computer.ts";
import { isValidSshAlias } from "../vps-config.ts";
import { vpsSshAliasForBot } from "../vps-hosts.ts";
import { PASS, type RouteHandler } from "./table.ts";

export type VpsVerifyStage = "unreachable" | "docker" | "ok";

export interface VpsAttachStore {
  bot(id: string): BotRecord | null;
  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null;
}

export interface VpsAttachRouteDeps {
  store: VpsAttachStore;
  cfg: AppConfig;
  run?: VpsCommandRunner;
}

const aliasBody = z.object({ alias: z.string() }).strict();
const attachBody = z.object({ botId: z.string().min(1), alias: z.string() }).strict();
const detachBody = z.object({ botId: z.string().min(1) }).strict();

const isJson = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
  String(req.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() === "application/json";

/** What `docker -H ssh://<alias> info` found: the daemon answered, nothing answered, or Docker refused. */
export async function verifyVps(
  run: VpsCommandRunner,
  alias: string,
): Promise<{ ok: true; stage: "ok"; message: string } | { ok: false; stage: Exclude<VpsVerifyStage, "ok">; message: string }> {
  try {
    await run(["-H", `ssh://${alias}`, "info"], { timeoutMs: 30_000 });
    return { ok: true, stage: "ok", message: `Docker on ${alias} answered.` };
  } catch (error) {
    if (error instanceof VpsHostUnreachableError) {
      return {
        ok: false,
        stage: "unreachable",
        message: `Couldn't reach ${alias}. Check the server is on and the SSH alias is right — try ssh ${alias} true on this computer first.`,
      };
    }
    const detail = error instanceof Error && error.message ? error.message.trim().split("\n").at(-1) ?? "" : "";
    return {
      ok: false,
      stage: "docker",
      message: `Reached ${alias}, but Docker there refused the connection${detail ? `: ${detail}` : ". The SSH user needs to be in the docker group on that server."}`,
    };
  }
}

function removeCommand(alias: string, container: string): string {
  return `docker -H ssh://${alias} rm -f ${container}`;
}

export function createVpsAttachRoutes(deps: VpsAttachRouteDeps): RouteHandler {
  const run = deps.run ?? defaultRunner;
  return async ({ req, res, path, method, json, readBody }) => {
    if (method !== "POST" || !path.startsWith("/api/vps/")) return PASS;
    if (!isJson(req)) return json(res, 415, { error: "content-type must be application/json" });
    if (path === "/api/vps/verify") {
      const parsed = aliasBody.safeParse(await readBody(req, 4096));
      if (!parsed.success) return json(res, 400, { error: "Send the SSH config alias to check." });
      if (!isValidSshAlias(parsed.data.alias)) {
        return json(res, 400, { error: "That is not a simple SSH config alias (letters, numbers, dot, dash, or underscore)." });
      }
      return json(res, 200, await verifyVps(run, parsed.data.alias));
    }
    if (path === "/api/vps/attach") {
      const parsed = attachBody.safeParse(await readBody(req, 4096));
      if (!parsed.success) return json(res, 400, { error: "Send the bot id and the SSH config alias to attach." });
      const { botId, alias } = parsed.data;
      if (!isValidSshAlias(alias)) {
        return json(res, 400, { error: "That is not a simple SSH config alias (letters, numbers, dot, dash, or underscore)." });
      }
      const bot = deps.store.bot(botId);
      if (!bot) return json(res, 404, { error: "No such bot." });
      if (bot.busy) return json(res, 409, { error: `Stop ${bot.name}'s turn before moving its computer.` });
      const current = vpsSshAliasForBot(deps.cfg, bot);
      if (current && current !== alias) {
        return json(res, 409, { error: `${bot.name} is already attached to ${current}. Detach it first.` });
      }
      const verified = await verifyVps(run, alias);
      if (!verified.ok) return json(res, 409, { error: verified.message, stage: verified.stage });
      deps.store.patchBot(botId, { vpsAlias: alias, cloudBackend: "vps" });
      return json(res, 200, {
        botId,
        alias,
        container: vpsContainerName(botId),
        message: `${bot.name} is now attached to ${alias}. Its computer will be set up from the Computer panel.`,
      });
    }
    if (path === "/api/vps/detach") {
      const parsed = detachBody.safeParse(await readBody(req, 4096));
      if (!parsed.success) return json(res, 400, { error: "Send the bot id to detach." });
      const bot = deps.store.bot(parsed.data.botId);
      if (!bot) return json(res, 404, { error: "No such bot." });
      if (bot.busy) return json(res, 409, { error: `Stop ${bot.name}'s turn before moving its computer.` });
      const alias = vpsSshAliasForBot(deps.cfg, bot);
      if (!alias) return json(res, 200, { botId: bot.id, detached: false, message: `${bot.name} isn't attached to a server.` });
      const container = vpsContainerName(bot.id);
      let leftBehind: string | undefined;
      try {
        const listed = await run(["-H", `ssh://${alias}`, "ps", "-a", "--filter", `name=^${container}$`, "--format", "{{.Names}}"], { timeoutMs: 30_000 });
        if (listed.stdout.split("\n").some((name) => name.trim() === container)) {
          return json(res, 409, {
            error: `${bot.name} still has its computer on ${alias}. Remove it first: ${removeCommand(alias, container)}`,
            container,
          });
        }
      } catch (error) {
        if (!(error instanceof VpsHostUnreachableError)) {
          const detail = error instanceof Error && error.message ? error.message.trim().split("\n").at(-1) ?? "" : "";
          return json(res, 409, {
            error: `Couldn't check ${alias} for ${bot.name}'s computer${detail ? `: ${detail}` : ""}. Try again when the server answers.`,
            container,
          });
        }
        leftBehind = removeCommand(alias, container);
      }
      deps.store.patchBot(bot.id, { vpsAlias: undefined, cloudBackend: "box" });
      return json(res, 200, {
        botId: bot.id,
        detached: true,
        alias,
        container,
        ...(leftBehind ? { leftBehind } : {}),
        message: leftBehind
          ? `${bot.name} is detached, but ${alias} couldn't be reached — its computer may still be there. Remove it once the server is back: ${leftBehind}`
          : `${bot.name} is detached from ${alias}. Pick its next computer in the Computer panel.`,
      });
    }
    return PASS;
  };
}
