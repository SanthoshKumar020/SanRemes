// The tools that put something the person sees into the chat: widgets, pages shown inline, and pages published to a link.
import { APP_TOOL_DEFINITIONS } from "./agents-app-tools.ts";
import { PAGE_TOOL_DEFINITIONS } from "./agents-pages-tools.ts";
import { WIDGET_TOOL_DEFINITIONS } from "./agents-widget-tools.ts";
import { ARTIFACT_TEMPLATE_TOOL_DEFINITION } from "../artifacts/templates.ts";
import { WHITEBOARD_TOOL_DEFINITION } from "../whiteboard/tool.ts";
import { SPREADSHEET_TOOL_DEFINITION } from "../spreadsheet/tool.ts";

export const CHAT_CARD_TOOL_DEFINITIONS = [...WIDGET_TOOL_DEFINITIONS, ...APP_TOOL_DEFINITIONS, ...PAGE_TOOL_DEFINITIONS, ARTIFACT_TEMPLATE_TOOL_DEFINITION, WHITEBOARD_TOOL_DEFINITION, SPREADSHEET_TOOL_DEFINITION];
