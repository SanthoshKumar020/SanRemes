import { isEffortLevel, type BotProject as BotProjectRecord, type ModelSelection } from "../../shared/wire.ts";

/** A text file attached to a project. The bot reads it in every thread in the project. */
export interface ProjectFile {
  id: string;
  name: string;
  text: string;
}

/** The workspace fields on a project. All optional; unset means the project behaves as a plain folder. */
export interface ProjectWorkspace {
  instructions?: string;
  files?: ProjectFile[];
  model?: ModelSelection;
}

export type WorkspaceProject = BotProjectRecord & ProjectWorkspace;

/** Patch values for the workspace fields. Null clears a field; absent leaves it alone. */
export interface ProjectWorkspacePatch {
  instructions?: string | null;
  files?: ProjectFile[] | null;
  model?: ModelSelection | null;
}

export const PROJECT_INSTRUCTIONS_MAX = 8000;
export const PROJECT_FILES_MAX = 8;
export const PROJECT_FILE_TEXT_MAX = 32_000;
export const PROJECT_FILE_NAME_MAX = 120;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isModelSelection(value: unknown): value is ModelSelection {
  if (!isRecord(value)) return false;
  if (typeof value.instanceId !== "string" || !value.instanceId.trim() || value.instanceId.length > 200) return false;
  if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 200) return false;
  if (value.effort !== undefined && !isEffortLevel(value.effort)) return false;
  if (value.variant !== undefined && (typeof value.variant !== "string" || !value.variant.trim() || value.variant.length > 200)) return false;
  return true;
}

function sanitizeModelSelection(value: unknown): ModelSelection | undefined {
  if (!isModelSelection(value)) return undefined;
  const selection: ModelSelection = { instanceId: value.instanceId, model: value.model };
  if (value.effort !== undefined) selection.effort = value.effort;
  if (value.variant !== undefined) selection.variant = value.variant;
  return selection;
}

function sanitizeProjectFile(value: unknown): ProjectFile | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id.trim() || value.id.length > 64) return null;
  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > PROJECT_FILE_NAME_MAX || /[/\\]/.test(value.name)) return null;
  if (typeof value.text !== "string" || value.text.length > PROJECT_FILE_TEXT_MAX) return null;
  return { id: value.id, name: value.name.trim(), text: value.text };
}

/** The workspace fields on a stored project record, dropping anything malformed. */
export function readProjectWorkspace(project: BotProjectRecord | undefined): ProjectWorkspace {
  if (!project) return {};
  const record = project as WorkspaceProject;
  const workspace: ProjectWorkspace = {};
  if (typeof record.instructions === "string" && record.instructions.trim()) {
    workspace.instructions = record.instructions.trim().slice(0, PROJECT_INSTRUCTIONS_MAX);
  }
  if (Array.isArray(record.files)) {
    const files = record.files.map(sanitizeProjectFile)
      .filter((file): file is ProjectFile => file !== null).slice(0, PROJECT_FILES_MAX);
    if (files.length) workspace.files = files;
  }
  const model = sanitizeModelSelection(record.model);
  if (model) workspace.model = model;
  return workspace;
}

/** A patch the store can apply, or null when any workspace field in it is malformed. */
export function sanitizeProjectWorkspacePatch(patch: unknown): ProjectWorkspacePatch | null {
  if (!isRecord(patch)) return null;
  const clean: ProjectWorkspacePatch = {};
  if ("instructions" in patch) {
    if (patch.instructions === null) clean.instructions = null;
    else if (typeof patch.instructions === "string") {
      if (patch.instructions.length > PROJECT_INSTRUCTIONS_MAX) return null;
      clean.instructions = patch.instructions.trim() || null;
    } else return null;
  }
  if ("files" in patch) {
    if (patch.files === null) clean.files = null;
    else if (Array.isArray(patch.files)) {
      if (patch.files.length > PROJECT_FILES_MAX) return null;
      const files = patch.files.map(sanitizeProjectFile);
      if (files.some((file) => file === null)) return null;
      if (new Set(files.map((file) => file!.id)).size !== files.length) return null;
      clean.files = files as ProjectFile[];
    } else return null;
  }
  if ("model" in patch) {
    if (patch.model === null) clean.model = null;
    else {
      const model = sanitizeModelSelection(patch.model);
      if (!model) return null;
      clean.model = model;
    }
  }
  return clean;
}

export function applyProjectWorkspacePatch(project: BotProjectRecord, patch: ProjectWorkspacePatch): void {
  const record = project as WorkspaceProject;
  if (patch.instructions === null) delete record.instructions;
  else if (patch.instructions !== undefined) record.instructions = patch.instructions;
  if (patch.files === null) delete record.files;
  else if (patch.files !== undefined) record.files = patch.files;
  if (patch.model === null) delete record.model;
  else if (patch.model !== undefined) record.model = patch.model;
}

/** A thread's own model wins, then its project's, then the bot default. */
export function resolveThreadModel(taskModel: ModelSelection | undefined, projectModel: ModelSelection | undefined, botModel: ModelSelection): ModelSelection {
  return taskModel ?? projectModel ?? botModel;
}

/** The text prepended to a thread's context: instructions verbatim, then each file's contents. */
export function projectContextText(workspace: ProjectWorkspace): string {
  const parts: string[] = [];
  if (workspace.instructions) parts.push(workspace.instructions);
  for (const file of workspace.files ?? []) parts.push(`--- File: ${file.name} ---\n${file.text}`);
  return parts.join("\n\n");
}
