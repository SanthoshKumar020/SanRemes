// Credential env names and the strippers that keep them out of child processes. Lives apart from
// config.ts so the lists can grow (one name per engine) without that file growing with them.

/** Workspace credential env names; spawned engine CLIs must never inherit them. */
export const WORKSPACE_CREDENTIAL_ENV = [
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "SANREMES_GROQ_API_KEY",
  "SANREMES_GREENFERENCE_API_KEY",
  "SANREMES_MODELGO_API_KEY",
  "SANREMES_META_API_KEY",
  "SANREMES_DEEPSEEK_API_KEY",
  "SANREMES_ANTHROPIC_API_KEY",
  "SANREMES_ANTHROPIC_API_URL",
  "SANREMES_HOSTED_MODEL_TOKEN",
  "SANREMES_HOSTED_MODELS",
  "OPENAI_COMPAT_API_KEY",
  "OPENAI_COMPAT_URL",
  "SANREMES_OPENAI_API_KEY",
  "SANREMES_OPENROUTER_API_KEY",
  "BOX_TOKEN",
  "OPENCODE_API_KEY",
  "SANREMES_TTS_KEY",
  "SANREMES_FISH_AUDIO_API_KEY",
  "SANREMES_GEMINI_API_KEY",
  "SANREMES_JEV_API_KEY",
  "SANREMES_OPENROUTER_DECIDER_KEY",
  "SANREMES_WORKERS_AI_TOKEN",
  "SANREMES_CUSTOM_DECIDER_KEY",
  "SANREMES_OPENAI_IMAGE_KEY",
  "SANREMES_CUSTOM_IMAGE_KEY",
  "SANREMES_GEMINI_IMAGE_KEY",
  "SANREMES_OPENAI_LIVE_KEY", "SANREMES_TREG_KEY", "SANREMES_POSTIZ_API_KEY",
  "COMPOSIO_API_KEY",
  "SANREMES_COMPOSIO_BROKER_TOKEN",
  "SANREMES_CLOUD_BOAT_TOKEN",
  "SANREMES_CLOUD_VOICE_TOKEN",
  "SANREMES_CLOUD_DECIDER_TOKEN",
  "SANREMES_CLOUD_AI_TOKEN", "SANREMES_CLOUD_X_TOKEN", "SANREMES_CLOUD_HOSTING_TOKEN", "SANREMES_CLOUD_CONNECTED_APPS_GRANT",
  // Not credentials, but they point a shell-capable agent at app-owned state.
  "SANREMES_BROWSER_CONNECTION", "SANREMES_USER_DATA", "SANREMES_BOAT_API",
] as const;

/** Operator secrets only this process reads, plus every `SANREMES_CLOUD_` var (the underscore leaves out SANREMES_CLOUDFLARED_PATH). */
export const CONTROL_PLANE_ENV = ["SANREMES_LICENSE_KEY", "SANREMES_INSTALLATION_CREDENTIAL"] as const;
export const CONTROL_PLANE_ENV_PREFIX = "SANREMES_CLOUD_";

/** Names compare case-insensitively because Windows environments do. */
export function stripControlPlaneEnv(env: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) {
    const name = key.toUpperCase();
    if (name.startsWith(CONTROL_PLANE_ENV_PREFIX) || (CONTROL_PLANE_ENV as readonly string[]).includes(name)) delete env[key];
  }
}

export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
  stripControlPlaneEnv(env);
}

const DESKTOP_STORE_KEY_ENV: ReadonlySet<string> = new Set(["MISTRAL_API_KEY", "CEREBRAS_API_KEY", "OPENAI_COMPAT_API_KEY", "SANREMES_OPENAI_API_KEY", "SANREMES_OPENROUTER_API_KEY"]);

/** A key an operator set on the server. Security: under the desktop app these variables hold workspace keys from its
 * encrypted store, which reach only the instances the workspace routes, never one with a URL of its own. */
export function operatorEnvKey(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.SANREMES_DESKTOP_PARENT === "1" && DESKTOP_STORE_KEY_ENV.has(name) ? undefined : env[name];
}

/** Env a provider CLI may read as its billing identity; a foreign key must never move a subscription CLI onto API billing. */
export const PROVIDER_CREDENTIAL_ENV = [
  "CLINE_API_KEY",
  "ANTHROPIC_API_KEY",
  "FACTORY_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "CEREBRAS_API_KEY",
  "GROQ_API_KEY",
  "GREENFERENCE_API_KEY",
  "MODELGO_API_KEY",
  "META_API_KEY",
  "DEEPSEEK_API_KEY",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
] as const;

/** Provider keys OpenCode reads from its environment (with ANTHROPIC_API_KEY set it lists Anthropic's models). */
export const OPENCODE_PROVIDER_ENV = [
  "CLINE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "KIMI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;
