// The environment a boxed process gets: an allow-list, never the server's whole environment. The drivers already strip
// the workspace credentials and every SANREMES_CLOUD_ setting before a spawn (server/config.ts stripWorkspaceCredentialEnv);
// this is the second gate, applied at the box boundary, so a name a driver forgot never reaches a bot's shell.

/** Names a bot's engine, its tools and the proxies SanRemes starts inside the box may read. */
export const BOX_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "HOSTNAME", "PWD",
  "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "TMPDIR", "NO_COLOR", "FORCE_COLOR", "CI", "DEBUG",
  "NODE_ENV", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY",
  "AGENT_BROWSER_EXECUTABLE_PATH", "BROWSER", "BASH_MAX_TIMEOUT_MS", "ELECTRON_RUN_AS_NODE", "PYTHONUNBUFFERED", "PYTHONDONTWRITEBYTECODE",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  // Antigravity's native CLI keeps each profile's Google sign-in in that profile's own file only while this is set
  // (server/drivers/antigravity-acp.ts sets a fixed value); without it, it waits on an OS keyring the box does not have.
  "SSH_CONNECTION",
]);

/** The one SSH_CONNECTION value a box may see (server/drivers/antigravity-acp.ts starts the native CLI with it). */
export const BOX_SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0";

/** SanRemes's own variables a boxed process reads: what the harness sets for a bot's engine, its hooks and the MCP
 * proxies it starts. Security: no other `SANREMES_` name passes, whatever the operator set on the server (an SMTP URL, a
 * token); env.test.ts lists every `SANREMES_` name the server knows, so a new one needs a decision. */
export const BOX_ENV_SANREMES_NAMES: ReadonlySet<string> = new Set([
  "SANREMES_HARNESS_URL", "SANREMES_BOT_ID", "SANREMES_THREAD_ID", "SANREMES_COMMS_TOKEN", "SANREMES_EXTERNAL_RUNTIME",
  "SANREMES_CHIEF_OF_STAFF", "SANREMES_SANREMES", "SANREMES_SKILL_AUTHORING_ENABLED", "SANREMES_SKILL_BURGER", "SANREMES_MEMORY_ENABLED", "SANREMES_SHARED_COMPUTERS_ENABLED",
  "SANREMES_VOICE_NOTES", "SANREMES_X_RESEARCH", "SANREMES_RESEARCH", "SANREMES_TEAM_PEOPLE", "SANREMES_COMPUTER_SELECTION", "SANREMES_ROOM",
  "SANREMES_IMAGE_GENERATION", "SANREMES_MEETINGS", "SANREMES_APP_HOSTING", "SANREMES_TOOLS_OFF", "SANREMES_LOCAL_VM", "SANREMES_AGENTS_TOOL_BRIDGE", "SANREMES_AGENTS_DEFER_TOOLS", "SANREMES_TOOL_LIMIT", "SANREMES_TOOL_SCHEMA_PROFILE",
  "SANREMES_MCP_CONFIG", "SANREMES_MCP_RESTART", "SANREMES_MCP_RESULT_BUDGET",
  "SANREMES_HOOK_URL", "SANREMES_HOOK_TOKEN_FILE", "SANREMES_HOOK_TIMEOUT_MS", "SANREMES_PERMISSION_TOOL_SCOPE",
  "SANREMES_CONNECTOR_UPSTREAM_URL", "SANREMES_CONNECTOR_UPSTREAM_HEADERS", "SANREMES_CONNECTOR_TOKEN", "SANREMES_CONNECTOR_ALLOWED_TOOLS",
  "SANREMES_CONNECTOR_SERVICE_SLUGS", "SANREMES_CONNECTOR_APP_TOOLS", "SANREMES_CONNECTOR_APP_TOOL_NAMES",
  "SANREMES_GATE_NAME", "SANREMES_GATE_UPSTREAM", "SANREMES_GATE_BUDGET", "SANREMES_GATE_SPILL_DIR", "SANREMES_GATE_SPILL_HINT", "SANREMES_GATE_TOOL_SCOPE",
  "SANREMES_GATE_DIRECTORY", "SANREMES_GATE_APPS", "SANREMES_REMOTE_MCP_SERVER", "SANREMES_REMOTE_MCP_DIRECTORY", "SANREMES_REMOTE_MCP_APPS",
  "SANREMES_CONTROL_URL", "SANREMES_CONTROL_TOKEN", "SANREMES_COMPUTER_JOURNAL", "SANREMES_CUA_ARGS", "SANREMES_CUA_COMMAND", "SANREMES_CUA_PLATFORM", "SANREMES_HOST_FILES",
  "SANREMES_PHONE_TOKEN", "SANREMES_ADB_PATH", "SANREMES_RESOURCES_PATH", "SANREMES_CODEX_AUTH_SOCKET", "SANREMES_CODEX_AUTH_SECRET",
  "SANREMES_COPILOT_MCP_CONFIG", "SANREMES_BROWSER_PROFILE", "SANREMES_BOX_PROBE", "SANREMES_EXTRA_PATH", "SANREMES_TEST_SEALED_PATH",
]);
/** Families of the same, one variable per server or kind: a harness MCP server's token, a gated or remote server's config,
 * and a saved Skill Burger's inputs, which its shell steps read as SANREMES_ARG_<NAME> (set per step, never from the server's own environment). */
export const BOX_ENV_SANREMES_PREFIXES: readonly string[] = ["SANREMES_MCP_TOKEN_", "SANREMES_GATE_CONFIG_", "SANREMES_REMOTE_MCP_CONFIG_", "SANREMES_ARG_"];

/** Prefixes of the engines' own settings and keys (T0b replaces the keys with per-turn broker tokens). */
export const BOX_ENV_PREFIXES: readonly string[] = [
  "LC_", "OPENSANREMES_", "NPM_CONFIG_", "npm_config_",
  "ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_", "OPENCODE_", "OPENROUTER_", "GEMINI_", "GOOGLE_", "GROK_", "XAI_",
  "MISTRAL_", "CEREBRAS_", "GROQ_", "GREENFERENCE_", "MODELGO_", "META_", "MINIMAX_", "KIMI_", "MOONSHOT_", "CURSOR_", "FACTORY_", "CLINE_", "HERMES_",
  "MUSE_", "PI_", "DWEB_", "UNSLOTH_", "FAKE_CLAUDE_", "MCP_", "ANTIGRAVITY_", "AGY_",
];

/** Never, whatever the allow-list says: the control plane's settings and secrets, and the server's own placement. The
 * CLI's session token and server address (server/headless/client.ts) too: nothing in a box reads them, and one an
 * operator set on the server would otherwise pass under the engines' OPENSANREMES_ prefix. */
export const BOX_ENV_NEVER: ReadonlySet<string> = new Set([
  "SANREMES_LICENSE_KEY", "SANREMES_INSTALLATION_CREDENTIAL", "SANREMES_LOOPBACK_TRUST", "SANREMES_CLOUD_SECRETS_FD",
  "SANREMES_DATA_DIR", "SANREMES_STATIC_DIR", "SANREMES_DUCKDB_DIR", "SANREMES_PORT", "SANREMES_WEBHOOK_PORT",
  "OPENSANREMES_TOKEN", "OPENSANREMES_URL",
]);
export const BOX_ENV_NEVER_PREFIXES: readonly string[] = ["SANREMES_CLOUD_"];

/** `allow` is what one spawn vouches for: the keys the person saved for its engine, under whatever name that engine reads
 * (NANO_GPT_API_KEY, OPENCODE_API_KEY). Security: it lifts the allow-list and `deny` for that process only, and never for
 * a name of SanRemes's own (`SANREMES_`) or one on the never-list. */
export function boxEnvironmentAllows(name: string, deny: ReadonlySet<string> = new Set(), allow: ReadonlySet<string> = new Set()): boolean {
  if (BOX_ENV_NEVER.has(name) || BOX_ENV_NEVER_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (allow.has(name) && !name.startsWith("SANREMES_")) return true;
  if (deny.has(name)) return false;
  if (name.startsWith("SANREMES_")) return BOX_ENV_SANREMES_NAMES.has(name) || BOX_ENV_SANREMES_PREFIXES.some((prefix) => name.startsWith(prefix));
  return BOX_ENV_NAMES.has(name) || BOX_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The box's environment: the allowed names of `env` with a value, in a fresh object. `deny` adds names (the workspace
 * credentials) that are refused even when a prefix would allow them. */
export function boxEnvironment(
  env: Record<string, string | undefined>,
  deny: ReadonlySet<string> = new Set(),
  allow: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !boxEnvironmentAllows(name, deny, allow)) continue;
    // Security: only the fixed value an engine is started with passes, never the server's own SSH session (its addresses).
    if (name === "SSH_CONNECTION" && value !== BOX_SSH_CONNECTION) continue;
    kept[name] = value;
  }
  return kept;
}

/** The names of `env` that hold the value `instance` gave them: what the environment configured for one engine instance
 * (its saved keys) put in a spawn, for that spawn's `allowEnv`. */
export function instanceEnvNames(instance: Readonly<Record<string, string>>, env: Record<string, string | undefined>): string[] {
  return Object.keys(instance).filter((name) => env[name] !== undefined && env[name] === instance[name]);
}
