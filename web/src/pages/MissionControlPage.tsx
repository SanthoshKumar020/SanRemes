/**
 * Mission Control — live agent dashboard.
 *
 * A single-page view that surfaces the agent's operational state:
 *   • Active tasks with progress and controls (pause/resume/stop)
 *   • Running agents/subagents with status
 *   • Pending approvals with approve/deny actions
 *   • Permission engine status and policy summary
 *   • Recent notifications
 *
 * Polls the SanRemes REST API (/api/v1/*) every few seconds for live updates.
 * Falls back gracefully when the API is unavailable (e.g. older runtimes).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Approve,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Eye,
  EyeOff,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Shield,
  ShieldCheck,
  ShieldOff,
  StopCircle,
  Trash2,
  Zap,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { api } from "@/lib/api";

// ── Types ──────────────────────────────────────────────────────────

interface Task {
  id: string;
  prompt: string;
  status: string;
  priority: string;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
  result: string | null;
  error: string | null;
}

interface Agent {
  id: string;
  name: string;
  status: string;
  role: string;
  created_at: number;
  updated_at: number;
}

interface Approval {
  id: string;
  status: string;
  command: string;
  description: string;
  created_at: number;
}

interface Notification {
  id: string;
  title: string;
  message: string;
  read: boolean;
  created_at: number;
  type: string;
}

interface SystemStatus {
  tasks_active: number;
  agents_active: number;
  approvals_pending: number;
  notifications_unread: number;
}

interface Capabilities {
  tasks: boolean;
  agents: boolean;
  approvals: boolean;
  notifications: boolean;
  permissions_engine: boolean;
  memory_provider: string;
  approval_mode: string;
}

interface PermissionRule {
  pattern: string;
  level: string;
  reason: string;
  context?: string;
}

interface PermissionsConfig {
  enabled: boolean;
  default: string;
  tools: PermissionRule[];
  toolsets: PermissionRule[];
  contexts: Record<string, PermissionRule[]>;
}

// ── API helpers ────────────────────────────────────────────────────

const V1 = "/api/v1";

async function v1Fetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await api.authedFetch(`${V1}${path}`, init);
    if (!res.ok) return null;
    const json = await res.json();
    return json.data ?? json;
  } catch {
    return null;
  }
}

async function v1List<T>(path: string): Promise<T[]> {
  try {
    const res = await api.authedFetch(`${V1}${path}`);
    if (!res.ok) return [];
    const json = await res.json();
    return json.items ?? [];
  } catch {
    return [];
  }
}

// ── Status badge helper ────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const variant = useMemo(() => {
    switch (status) {
      case "completed":
      case "approved":
      case "approved":
        return "default" as const;
      case "executing":
      case "running":
      case "planning":
      case "verifying":
        return "secondary" as const;
      case "created":
      case "pending":
        return "outline" as const;
      case "failed":
      case "denied":
      case "error":
        return "destructive" as const;
      case "paused":
      case "cancelled":
        return "outline" as const;
      default:
        return "outline" as const;
    }
  }, [status]);

  return <Badge variant={variant}>{status}</Badge>;
}

function PriorityBadge({ priority }: { priority: string }) {
  if (priority === "urgent") {
    return <Badge variant="destructive">urgent</Badge>;
  }
  if (priority === "high") {
    return <Badge variant="secondary">high</Badge>;
  }
  return null;
}

function timeAgo(ts: number): string {
  const seconds = Math.floor(Date.now() / 1000 - ts);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ── Overview Cards ─────────────────────────────────────────────────

function OverviewCards({ status }: { status: SystemStatus | null }) {
  if (!status) {
    return (
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Card key={i} className="animate-pulse">
            <CardContent className="p-4">
              <div className="h-8 w-16 rounded bg-muted" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const cards = [
    {
      label: "Active Tasks",
      value: status.tasks_active,
      icon: Activity,
      color: status.tasks_active > 0 ? "text-blue-500" : "text-muted-foreground",
    },
    {
      label: "Running Agents",
      value: status.agents_active,
      icon: Cpu,
      color: status.agents_active > 0 ? "text-green-500" : "text-muted-foreground",
    },
    {
      label: "Pending Approvals",
      value: status.approvals_pending,
      icon: ShieldCheck,
      color: status.approvals_pending > 0 ? "text-yellow-500" : "text-muted-foreground",
    },
    {
      label: "Unread Notifications",
      value: status.notifications_unread,
      icon: Zap,
      color: status.notifications_unread > 0 ? "text-purple-500" : "text-muted-foreground",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardContent className="flex items-center gap-3 p-4">
            <card.icon className={`h-5 w-5 ${card.color}`} />
            <div>
              <p className="text-2xl font-bold">{card.value}</p>
              <p className="text-xs text-muted-foreground">{card.label}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Tasks Panel ────────────────────────────────────────────────────

function TasksPanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const items = await v1List<Task>("/tasks");
      setTasks(items);
    } catch {
      // API unavailable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const action = useCallback(
    async (taskId: string, method: string, path: string) => {
      try {
        await api.authedFetch(`${V1}/tasks/${taskId}/${path}`, { method });
        refresh();
      } catch {
        // ignore
      }
    },
    [refresh],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Activity className="h-4 w-4" />
          Tasks
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={refresh}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : tasks.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No active tasks</p>
        ) : (
          <div className="space-y-2">
            {tasks.slice(0, 10).map((task) => (
              <div
                key={task.id}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={task.status} />
                    <PriorityBadge priority={task.priority} />
                    <span className="truncate text-sm font-medium">
                      {task.prompt.slice(0, 60)}
                      {task.prompt.length > 60 ? "…" : ""}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {task.id} · {timeAgo(task.updated_at)}
                  </p>
                  {task.error && (
                    <p className="mt-1 text-xs text-destructive">{task.error}</p>
                  )}
                </div>
                <div className="ml-2 flex items-center gap-1">
                  {task.status === "created" || task.status === "paused" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => action(task.id, "POST", "resume")}
                    >
                      <Play className="h-3 w-3" />
                    </Button>
                  ) : task.status === "executing" || task.status === "planning" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => action(task.id, "POST", "pause")}
                    >
                      <Pause className="h-3 w-3" />
                    </Button>
                  ) : null}
                  {task.status !== "completed" && task.status !== "cancelled" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => action(task.id, "DELETE", "")}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Agents Panel ───────────────────────────────────────────────────

function AgentsPanel() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const items = await v1List<Agent>("/agents");
      setAgents(items);
    } catch {
      // API unavailable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const cancelAgent = useCallback(
    async (agentId: string) => {
      try {
        await api.authedFetch(`${V1}/agents/${agentId}/cancel`, { method: "POST" });
        refresh();
      } catch {
        // ignore
      }
    },
    [refresh],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Cpu className="h-4 w-4" />
          Agents
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={refresh}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : agents.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No active agents</p>
        ) : (
          <div className="space-y-2">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={agent.status} />
                    <span className="text-sm font-medium">{agent.name || agent.id}</span>
                    {agent.role && (
                      <Badge variant="outline" className="text-xs">
                        {agent.role}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {agent.id} · {timeAgo(agent.updated_at)}
                  </p>
                </div>
                {(agent.status === "running" || agent.status === "starting") && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => cancelAgent(agent.id)}
                  >
                    <StopCircle className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Approvals Panel ────────────────────────────────────────────────

function ApprovalsPanel() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const items = await v1List<Approval>("/approvals");
      setApprovals(items);
    } catch {
      // API unavailable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  const approve = useCallback(
    async (id: string) => {
      try {
        await api.authedFetch(`${V1}/approvals/${id}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Approved from Mission Control" }),
        });
        refresh();
      } catch {
        // ignore
      }
    },
    [refresh],
  );

  const deny = useCallback(
    async (id: string) => {
      try {
        await api.authedFetch(`${V1}/approvals/${id}/deny`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Denied from Mission Control" }),
        });
        refresh();
      } catch {
        // ignore
      }
    },
    [refresh],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck className="h-4 w-4" />
          Approvals
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={refresh}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : approvals.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No pending approvals
          </p>
        ) : (
          <div className="space-y-2">
            {approvals.map((approval) => (
              <div
                key={approval.id}
                className="rounded-md border border-yellow-500/20 bg-yellow-500/5 p-3"
              >
                <div className="flex items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-yellow-500" />
                      <span className="text-sm font-medium">
                        {approval.command || approval.description || approval.id}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {approval.id} · {timeAgo(approval.created_at)}
                    </p>
                  </div>
                  <div className="ml-2 flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-green-600 hover:text-green-700"
                      onClick={() => approve(approval.id)}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      <span className="ml-1 text-xs">Approve</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:text-red-700"
                      onClick={() => deny(approval.id)}
                    >
                      <Ban className="h-4 w-4" />
                      <span className="ml-1 text-xs">Deny</span>
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Permissions Panel ──────────────────────────────────────────────

function PermissionsPanel() {
  const [config, setConfig] = useState<PermissionsConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.authedFetch("/api/config");
      if (res.ok) {
        const json = await res.json();
        const permissions = json?.permissions || json?.data?.permissions;
        if (permissions) {
          setConfig(permissions);
        }
      }
    } catch {
      // API unavailable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Shield className="h-4 w-4" />
          Permissions
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={refresh}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : !config ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Permission engine not configured
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Engine:</span>
              {config.enabled ? (
                <Badge variant="default" className="bg-green-600">
                  Enabled
                </Badge>
              ) : (
                <Badge variant="outline">Disabled</Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Default:</span>
              <Badge
                variant={
                  config.default === "allow"
                    ? "default"
                    : config.default === "deny"
                      ? "destructive"
                      : "secondary"
                }
              >
                {config.default}
              </Badge>
            </div>
            {config.tools.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  Tool Rules ({config.tools.length})
                </p>
                <div className="space-y-1">
                  {config.tools.map((rule, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1 text-xs"
                    >
                      <code className="font-mono">{rule.pattern}</code>
                      <span>→</span>
                      <Badge variant={rule.level === "deny" ? "destructive" : "secondary"}>
                        {rule.level}
                      </Badge>
                      {rule.reason && (
                        <span className="text-muted-foreground">— {rule.reason}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {config.toolsets.length > 0 && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  Toolset Rules ({config.toolsets.length})
                </p>
                <div className="space-y-1">
                  {config.toolsets.map((rule, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1 text-xs"
                    >
                      <code className="font-mono">{rule.pattern}</code>
                      <span>→</span>
                      <Badge variant={rule.level === "deny" ? "destructive" : "secondary"}>
                        {rule.level}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Notifications Panel ────────────────────────────────────────────

function NotificationsPanel() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRead, setShowRead] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const items = await v1List<Notification>(
        `/notifications${showRead ? "" : "?unread_only=true"}`,
      );
      setNotifications(items);
    } catch {
      // API unavailable
    } finally {
      setLoading(false);
    }
  }, [showRead]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);

  const markRead = useCallback(
    async (id: string) => {
      try {
        await api.authedFetch(`${V1}/notifications/${id}/read`, { method: "POST" });
        refresh();
      } catch {
        // ignore
      }
    },
    [refresh],
  );

  const markAllRead = useCallback(async () => {
    try {
      await api.authedFetch(`${V1}/notifications/read-all`, { method: "POST" });
      refresh();
    } catch {
      // ignore
    }
  }, [refresh]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Zap className="h-4 w-4" />
          Notifications
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowRead(!showRead)}
          >
            {showRead ? (
              <EyeOff className="h-3 w-3" />
            ) : (
              <Eye className="h-3 w-3" />
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={markAllRead}>
            <CheckCircle2 className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" onClick={refresh}>
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner />
          </div>
        ) : notifications.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {showRead ? "No notifications" : "No unread notifications"}
          </p>
        ) : (
          <div className="space-y-1">
            {notifications.map((n) => (
              <div
                key={n.id}
                className="flex items-center justify-between rounded-md border p-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{n.title || n.type || "Notification"}</p>
                  {n.message && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{n.message}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{timeAgo(n.created_at)}</p>
                </div>
                {!n.read && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => markRead(n.id)}
                  >
                    <CheckCircle2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Page ──────────────────────────────────────────────────────

export default function MissionControlPage() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshStatus = useCallback(async () => {
    try {
      const [statusData, capsData] = await Promise.all([
        v1Fetch<SystemStatus>("/system/status"),
        v1Fetch<Capabilities>("/system/capabilities"),
      ]);
      if (statusData) setStatus(statusData);
      if (capsData) setCapabilities(capsData);
    } catch {
      // API unavailable — older runtime
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 5000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  // Check if the SanRemes API is available
  const apiAvailable = status !== null || capabilities !== null;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <H2>Mission Control</H2>
          <p className="text-sm text-muted-foreground">
            Live agent dashboard — tasks, agents, approvals, and permissions
          </p>
        </div>
        {!apiAvailable && (
          <Badge variant="outline" className="text-xs">
            API unavailable — upgrade runtime for live data
          </Badge>
        )}
      </div>

      {/* Overview cards */}
      <OverviewCards status={status} />

      {/* Two-column layout for main panels */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Left column */}
        <div className="space-y-6">
          <TasksPanel />
          <ApprovalsPanel />
        </div>

        {/* Right column */}
        <div className="space-y-6">
          <AgentsPanel />
          <PermissionsPanel />
          <NotificationsPanel />
        </div>
      </div>
    </div>
  );
}
