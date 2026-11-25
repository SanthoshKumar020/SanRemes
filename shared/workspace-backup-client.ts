// Exact app-owned browser state that belongs in an encrypted full backup.
// Never include cookies, authentication tokens, connection caches or unknown keys.
export const WORKSPACE_BACKUP_CLIENT_KEYS = [
  "sanremes-drafts",
  "sanremes-draft-attachments",
  "sanremes-draft-send-ids",
  "sanremes-draft-channel-modes",
  "sanremes-skin",
  "sanremes-show-threads",
  "sanremes-show-run-card",
  "sanremes-send-key",
  "sanremes-color-user-bubbles",
  "sanremes-chat-width",
  "sanremes.sidebarDensity",
  "sanremes.sidebarToolsLayout",
  "sanremes.sidebarCollapsedSections.v1",
  "sanremes.sidebarSectionOrder.v1",
  "sanremes-analytics-opt-out",
  "sanremes.remote-voice.v1",
] as const;

export type WorkspaceBackupClientState = Partial<Record<(typeof WORKSPACE_BACKUP_CLIENT_KEYS)[number], string>>;
