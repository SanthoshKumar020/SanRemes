// Inside a bot's own shell the CLI acts as that bot: it never uses the person's saved sign-in, and it signs nothing in.
// Security: this keeps one bot from deleting or stopping the others by accident through the person's session. It is not
// a boundary against a bot with Full access, which runs as the person and can read whatever they can.

/** What SanRemes's server puts in the environment of the engines it starts, and so of every bot's shell: the run tag
 * spawnCli gives each engine (engine-records.ts), the desktop app's mark on its server's children, and a turn's
 * per-turn capability. A person's terminal has none of them. */
const TURN_VARIABLES = ["SANREMES_ENGINE_TAG", "SANREMES_COMMS_TOKEN", "SANREMES_HOOK_TOKEN_FILE", "SANREMES_HOOK_URL", "SANREMES_HARNESS_URL", "SANREMES_BOT_ID"] as const;

export function inBotShell(env: NodeJS.ProcessEnv): boolean {
  return env.SANREMES_DESKTOP_PARENT === "1" || TURN_VARIABLES.some((name) => Boolean(env[name]?.trim()));
}

export const BOT_SHELL_REFUSAL = "inside a bot's shell the sanremes command acts as that bot, so it does not sign in or use your saved sign-in";
export const BOT_SHELL_HINT = "run this in your own terminal, or ask the person to do it";
