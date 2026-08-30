// ── Mission types ─────────────────────────────────────────────────────

export type MissionState =
  | "created"
  | "planning"
  | "executing"
  | "verifying"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled"
  | "recovering";

export type SubtaskState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "awaiting_approval";

export interface Subtask {
  id: string;
  title: string;
  description: string;
  state: SubtaskState;
  agent_role: string;
  depends_on: string[];
  result?: string;
  error?: string;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  requires_approval: boolean;
  retry_count: number;
}

export interface MissionEvent {
  timestamp: number;
  event_type: string;
  message: string;
}

export interface Mission {
  id: string;
  title: string;
  description: string;
  goal: string;
  state: MissionState;
  priority: string;
  subtasks: Subtask[];
  autonomy_level: string;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  events: MissionEvent[];
  tags: string[];
  total_tokens: number;
  total_cost_usd: number;
  error?: string;
  pending_approvals: number;
}

export interface MissionStats {
  total: number;
  by_state: Record<string, number>;
  active: number;
  pending_approval: number;
}

// ── Approval types ────────────────────────────────────────────────────

export interface Approval {
  id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  reason: string;
  session_id: string;
  created_at: number;
  status: "pending" | "approved" | "denied";
}

// ── Task types ────────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  description: string;
  state: string;
  priority: string;
  agent_role?: string;
  created_at: number;
  started_at?: number;
  completed_at?: number;
  error?: string;
}

// ── Notification types ────────────────────────────────────────────────

export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  created_at: number;
}

// ── System types ──────────────────────────────────────────────────────

export interface SystemStatus {
  version: string;
  uptime: number;
  active_sessions: number;
  active_agents: number;
  memory_usage_mb: number;
}

// ── Skill types ───────────────────────────────────────────────────────

export interface Skill {
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  category: string;
  installed: boolean;
  id: string;
  display_name: string;
}
