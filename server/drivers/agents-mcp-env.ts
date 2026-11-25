import { TOOL_BRIDGE_ENV } from "./agents-bridge.ts";
import { TOOL_LIMIT_ENV } from "../tool-count-limit.ts";
import { DEFER_TOOLS_ENV } from "./agents-claude-defer.ts";

/** The settings the harness gives the agents MCP server, and the only ones a request may carry over HTTP. */
export const AGENTS_MCP_ENV = ["SANREMES_BOT_ID", "SANREMES_THREAD_ID", "SANREMES_EXTERNAL_RUNTIME", "SANREMES_CHIEF_OF_STAFF",
  "SANREMES_SKILL_AUTHORING_ENABLED", "SANREMES_SKILL_BURGER", "SANREMES_MEMORY_ENABLED", "SANREMES_SHARED_COMPUTERS_ENABLED", "SANREMES_CLOUD_HOME", "SANREMES_VOICE_NOTES",
  "SANREMES_X_RESEARCH", "SANREMES_RESEARCH", "SANREMES_TEAM_PEOPLE", "SANREMES_SANREMES", "SANREMES_COMPUTER_SELECTION", "SANREMES_ROOM", "SANREMES_IMAGE_GENERATION", "SANREMES_MEETINGS", "SANREMES_APP_HOSTING", "SANREMES_TOOLS_OFF", "SANREMES_LOCAL_VM", TOOL_BRIDGE_ENV, TOOL_LIMIT_ENV,
  // Claude's deferred catalog: the URL form carries it as the stdio proxy's environment does.
  DEFER_TOOLS_ENV] as const;
