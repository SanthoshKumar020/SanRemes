import { toolsOffFromEnv, type ToolGroup } from "../../shared/tool-groups.ts";

// The SANREMES_* switches the harness gives the agents proxy, read into the profile agents-catalog.ts lists tools for.

/** Which tools a conversation is shown, the same on every one of its turns. Presentation only: the server still
 * authenticates and scopes every call. */
export interface CatalogProfile {
  skillAuthoring: boolean;
  /** Skill Burgers are on here: run_workflow and workflow_edit are mounted. Absent means on. */
  skillBurger?: boolean;
  sharedComputers: boolean;
  voiceNotes: boolean;
  /** A treg key or a Cloud plan's research credential is held and this bot's research switch is on: x_search is mounted.
   * Absent means off. */
  xResearch?: boolean;
  /** As xResearch, and research works for that credential (the person's treg key, or a plan whose relay has research
   * on): research_search, research_endpoint and research_call are mounted too. Absent means off. */
  research?: boolean;
  cloudHome: boolean;
  memoryEnabled?: boolean;
  /** The section's Chief of Staff; the server refuses Chief-only tools to every other bot. */
  chief: boolean;
  /** Only for Watcher's own tool. Never written into a schema: a list that names its bot can't share a prompt cache with other bots. */
  botId: string;
  /** A Team Cloud: message_person is mounted. */
  team?: boolean;
  /** The person's SanRemes with a Chief's powers: its notification tools are mounted. */
  sanremes?: boolean;
  /** A direct chat whose bot may pick where it works (Works on is not Off and no team computer is its own): select_computer
   * is mounted, and the harness refuses a pick on any turn but a person's own message. */
  computerSelection?: boolean;
  /** This server can give a bot a Local VM: a supported container runtime is installed on the host.
   * Absent means it can. */
  localVm?: boolean;
  /** A room's thread: the wait tools are not mounted, since a room holds no wait. */
  room?: boolean;
  imageGeneration?: boolean;
  /** A cloud computer can be had here (Boat): the meeting tools and reset_cloud_computer are mounted. */
  meetings?: boolean;
  /** The plan's included app hosting reaches this server: publish_app is mounted. */
  appHosting?: boolean;
  /** The tool groups this bot's person turned off: none of their tools is mounted. */
  toolsOff?: readonly ToolGroup[];
}

/** Everything is off unless the harness says "1". */
export function catalogProfileFromEnv(env: NodeJS.ProcessEnv): CatalogProfile {
  return {
    skillAuthoring: env.SANREMES_SKILL_AUTHORING_ENABLED === "1",
    skillBurger: env.SANREMES_SKILL_BURGER !== "0",
    sharedComputers: env.SANREMES_SHARED_COMPUTERS_ENABLED === "1",
    voiceNotes: env.SANREMES_VOICE_NOTES === "1",
    xResearch: env.SANREMES_X_RESEARCH === "1",
    research: env.SANREMES_RESEARCH === "1",
    cloudHome: env.SANREMES_CLOUD_HOME === "1",
    memoryEnabled: env.SANREMES_MEMORY_ENABLED !== "0",
    chief: env.SANREMES_CHIEF_OF_STAFF === "1",
    botId: env.SANREMES_BOT_ID ?? "",
    team: env.SANREMES_TEAM_PEOPLE === "1",
    sanremes: env.SANREMES_SANREMES === "1",
    computerSelection: env.SANREMES_COMPUTER_SELECTION === "1",
    localVm: env.SANREMES_LOCAL_VM !== "0",
    room: env.SANREMES_ROOM === "1",
    imageGeneration: env.SANREMES_IMAGE_GENERATION === "1",
    meetings: env.SANREMES_MEETINGS === "1",
    appHosting: env.SANREMES_APP_HOSTING === "1",
    toolsOff: toolsOffFromEnv(env.SANREMES_TOOLS_OFF),
  };
}
