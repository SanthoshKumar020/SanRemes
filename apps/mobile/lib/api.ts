import { Platform } from "react-native";
import type {
  Mission,
  MissionStats,
  Approval,
  Task,
  Notification,
  SystemStatus,
  Skill,
} from "./types";

// ── Configuration ─────────────────────────────────────────────────────

const DEFAULT_HOST = "http://localhost:8787";

function getBaseUrl(): string {
  // In development, use the dev server. In production, user configures.
  return process.env.EXPO_PUBLIC_API_URL || DEFAULT_HOST;
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }

  return res.json();
}

// ── Missions API ──────────────────────────────────────────────────────

export async function fetchMissions(state?: string): Promise<Mission[]> {
  const sp = state ? `?state=${state}` : "";
  const data = await request<{ missions: Mission[] }>(
    `/api/v1/missions${sp}`
  );
  return data.missions ?? [];
}

export async function fetchMissionStats(): Promise<MissionStats> {
  return request<MissionStats>("/api/v1/missions/stats");
}

export async function fetchMission(id: string): Promise<Mission> {
  return request<Mission>(`/api/v1/missions/${id}`);
}

export async function createMission(body: {
  goal: string;
  title?: string;
  autonomy_level?: string;
  priority?: string;
}): Promise<Mission> {
  return request<Mission>("/api/v1/missions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function missionAction(
  id: string,
  action: "start" | "pause" | "resume" | "cancel"
): Promise<Mission> {
  return request<Mission>(`/api/v1/missions/${id}/${action}`, {
    method: "POST",
  });
}

// ── Approvals API ─────────────────────────────────────────────────────

export async function fetchApprovals(): Promise<Approval[]> {
  const data = await request<{ approvals: Approval[] }>(
    "/api/v1/approvals"
  );
  return data.approvals ?? [];
}

export async function approveRequest(
  id: string,
  permanent?: boolean
): Promise<{ ok: boolean }> {
  return request(`/api/v1/approvals/${id}/approve`, {
    method: "POST",
    body: JSON.stringify({ permanent: permanent ?? false }),
  });
}

export async function denyRequest(
  id: string,
  reason?: string
): Promise<{ ok: boolean }> {
  return request(`/api/v1/approvals/${id}/deny`, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? "" }),
  });
}

// ── Tasks API ─────────────────────────────────────────────────────────

export async function fetchTasks(
  state?: string,
  limit?: number
): Promise<Task[]> {
  const params = new URLSearchParams();
  if (state) params.set("state", state);
  if (limit) params.set("limit", String(limit));
  const data = await request<{ tasks: Task[] }>(
    `/api/v1/tasks?${params}`
  );
  return data.tasks ?? [];
}

// ── Notifications API ─────────────────────────────────────────────────

export async function fetchNotifications(
  unread?: boolean
): Promise<Notification[]> {
  const sp = unread ? "?unread=true" : "";
  const data = await request<{ notifications: Notification[] }>(
    `/api/v1/notifications${sp}`
  );
  return data.notifications ?? [];
}

export async function markNotificationRead(
  id: string
): Promise<{ ok: boolean }> {
  return request(`/api/v1/notifications/${id}/read`, { method: "POST" });
}

export async function markAllNotificationsRead(): Promise<{ ok: boolean }> {
  return request("/api/v1/notifications/read-all", { method: "POST" });
}

// ── System API ────────────────────────────────────────────────────────

export async function fetchSystemStatus(): Promise<SystemStatus> {
  return request<SystemStatus>("/api/v1/system/status");
}

// ── Skills/Marketplace API ────────────────────────────────────────────

export async function fetchSkills(
  query?: string,
  category?: string
): Promise<{ skills: Skill[]; total: number }> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (category) params.set("category", category);
  return request(`/api/v1/marketplace/skills?${params}`);
}

export async function fetchMarketplaceSkills(
  query?: string,
  category?: string
): Promise<Skill[]> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (category) params.set("category", category);
  const data = await request<{ skills: Skill[] }>(
    `/api/v1/marketplace/skills?${params}`
  );
  return data.skills ?? [];
}

// ── Health check ──────────────────────────────────────────────────────

export async function checkHealth(): Promise<boolean> {
  try {
    await fetch(`${getBaseUrl()}/api/v1/system/status`);
    return true;
  } catch {
    return false;
  }
}
