import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitBranch,
  Pause,
  Play,
  Plus,
  Rocket,
  StopCircle,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { Input } from "@nous-research/ui/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@nous-research/ui/ui/components/dialog";
import { api } from "@/lib/api";
import { useToast } from "@nous-research/ui/hooks/use-toast";

// ── Types ────────────────────────────────────────────────────────────

interface Subtask {
  id: string;
  title: string;
  description: string;
  state: string;
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

interface MissionEvent {
  timestamp: number;
  event_type: string;
  message: string;
  data: Record<string, unknown>;
}

interface Mission {
  id: string;
  title: string;
  description: string;
  goal: string;
  state: string;
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

interface MissionStats {
  total: number;
  by_state: Record<string, number>;
  active: number;
  pending_approval: number;
}

// ── API helpers ──────────────────────────────────────────────────────

async function fetchMissions(state?: string): Promise<Mission[]> {
  const sp = state ? `?state=${state}` : "";
  const r = await fetch(`${api.baseUrl}/api/v1/missions${sp}`);
  if (!r.ok) throw new Error("Failed to load missions");
  const data = await r.json();
  return data.missions ?? [];
}

async function fetchMissionStats(): Promise<MissionStats> {
  const r = await fetch(`${api.baseUrl}/api/v1/missions/stats`);
  if (!r.ok) throw new Error("Failed to load stats");
  return r.json();
}

async function createMission(body: {
  goal: string;
  title?: string;
  autonomy_level?: string;
  priority?: string;
}): Promise<Mission> {
  const r = await fetch(`${api.baseUrl}/api/v1/missions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Create failed" }));
    throw new Error(err.detail || "Create failed");
  }
  return r.json();
}

async function missionAction(
  id: string,
  action: "start" | "pause" | "resume" | "cancel" | "advance"
): Promise<Mission> {
  const r = await fetch(`${api.baseUrl}/api/v1/missions/${id}/${action}`, {
    method: "POST",
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Action failed" }));
    throw new Error(err.detail || "Action failed");
  }
  return r.json();
}

async function deleteMission(id: string): Promise<void> {
  const r = await fetch(`${api.baseUrl}/api/v1/missions/${id}`, {
    method: "DELETE",
  });
  if (!r.ok) throw new Error("Delete failed");
}

// ── State helpers ────────────────────────────────────────────────────

const STATE_CONFIG: Record<string, { color: string; icon: typeof Rocket; label: string }> = {
  created: { color: "secondary", icon: Clock, label: "Created" },
  planning: { color: "outline", icon: GitBranch, label: "Planning" },
  executing: { color: "default", icon: Play, label: "Executing" },
  verifying: { color: "secondary", icon: CheckCircle2, label: "Verifying" },
  completed: { color: "default", icon: CheckCircle2, label: "Completed" },
  failed: { color: "destructive", icon: AlertTriangle, label: "Failed" },
  paused: { color: "secondary", icon: Pause, label: "Paused" },
  cancelled: { color: "destructive", icon: XCircle, label: "Cancelled" },
  recovering: { color: "secondary", icon: AlertTriangle, label: "Recovering" },
};

function StateBadge({ state }: { state: string }) {
  const cfg = STATE_CONFIG[state] ?? { color: "secondary", icon: Clock, label: state };
  return <Badge variant={cfg.color as any}>{cfg.label}</Badge>;
}

function PriorityBadge({ priority }: { priority: string }) {
  if (priority === "urgent") return <Badge variant="destructive">urgent</Badge>;
  if (priority === "high") return <Badge variant="secondary">high</Badge>;
  if (priority === "low") return <Badge variant="outline">low</Badge>;
  return null;
}

// ── Progress Bar ─────────────────────────────────────────────────────

function ProgressBar({ subtasks }: { subtasks: Subtask[] }) {
  if (!subtasks.length) return null;
  const done = subtasks.filter(
    (s) => s.state === "completed" || s.state === "skipped"
  ).length;
  const pct = Math.round((100 * done) / subtasks.length);
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground">
        {done}/{subtasks.length}
      </span>
    </div>
  );
}

// ── Create Mission Dialog ────────────────────────────────────────────

function CreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (m: Mission) => void;
}) {
  const [goal, setGoal] = useState("");
  const [title, setTitle] = useState("");
  const [autonomy, setAutonomy] = useState("agent");
  const [priority, setPriority] = useState("normal");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const handleCreate = useCallback(async () => {
    if (!goal.trim()) return;
    setBusy(true);
    try {
      const m = await createMission({
        goal: goal.trim(),
        title: title.trim() || undefined,
        autonomy_level: autonomy,
        priority,
      });
      toast({ title: `Mission created: ${m.title}` });
      onCreated(m);
      onClose();
      setGoal("");
      setTitle("");
    } catch (err: any) {
      toast({ title: "Failed to create mission", description: err.message });
    } finally {
      setBusy(false);
    }
  }, [goal, title, autonomy, priority, toast, onCreated, onClose]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5" />
            New Mission
          </DialogTitle>
          <DialogDescription>
            Describe the goal and SanRemes will decompose it into subtasks.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Goal</label>
            <Input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder='e.g. "Build a REST API for user management with auth"'
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Title (optional)</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short display name"
              className="mt-1"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Autonomy Level</label>
              <select
                value={autonomy}
                onChange={(e) => setAutonomy(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              >
                <option value="assist">🟢 Assist — suggest only</option>
                <option value="agent">🔵 Agent — execute, ask when needed</option>
                <option value="autonomous">🟣 Autonomous — execute & verify</option>
                <option value="mission">🔴 Mission — full workflow</option>
              </select>
            </div>

            <div>
              <label className="text-sm font-medium">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!goal.trim() || busy} onClick={handleCreate}>
            {busy ? <Spinner className="mr-2 h-4 w-4" /> : <Plus className="mr-2 h-4 w-4" />}
            Create Mission
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Mission Detail Dialog ────────────────────────────────────────────

function MissionDetailDialog({
  mission,
  open,
  onClose,
}: {
  mission: Mission | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!mission) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="h-5 w-5" />
            {mission.title}
          </DialogTitle>
          <DialogDescription>{mission.goal}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Status row */}
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge state={mission.state} />
            <PriorityBadge priority={mission.priority} />
            <Badge variant="outline">{mission.autonomy_level}</Badge>
            {mission.progress_percent > 0 && (
              <span className="text-sm text-muted-foreground">
                {mission.progress_percent}% complete
              </span>
            )}
          </div>

          {/* Subtasks */}
          {mission.subtasks.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-semibold">Subtasks</h4>
              <ProgressBar subtasks={mission.subtasks} />
              <div className="mt-2 space-y-2">
                {mission.subtasks.map((st) => (
                  <div
                    key={st.id}
                    className="flex items-center gap-2 rounded-md border p-2 text-sm"
                  >
                    <StateBadge state={st.state} />
                    <span className="flex-1 truncate">{st.title}</span>
                    {st.agent_role && (
                      <Badge variant="outline" className="text-xs">
                        {st.agent_role}
                      </Badge>
                    )}
                    {st.requires_approval && (
                      <Badge variant="secondary" className="text-xs">
                        approval needed
                      </Badge>
                    )}
                    {st.error && (
                      <span className="max-w-[200px] truncate text-xs text-destructive">
                        {st.error}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Events */}
          {mission.events.length > 0 && (
            <div>
              <h4 className="mb-2 text-sm font-semibold">Timeline</h4>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {mission.events.slice(-20).reverse().map((ev, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 text-xs text-muted-foreground"
                  >
                    <span className="shrink-0">
                      {new Date(ev.timestamp * 1000).toLocaleTimeString()}
                    </span>
                    <span>{ev.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Error */}
          {mission.error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {mission.error}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Overview Stats ───────────────────────────────────────────────────

function OverviewStats({ stats }: { stats: MissionStats | null }) {
  if (!stats) return null;
  const cards = [
    { label: "Total Missions", value: stats.total, icon: Rocket },
    { label: "Active", value: stats.active, icon: Play },
    { label: "Pending Approval", value: stats.pending_approval, icon: AlertTriangle },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="flex items-center gap-3 p-4">
            <c.icon className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="text-2xl font-bold">{c.value}</p>
              <p className="text-xs text-muted-foreground">{c.label}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ── Mission Card ─────────────────────────────────────────────────────

function MissionCard({
  mission,
  onSelect,
  onStart,
  onPause,
  onResume,
  onCancel,
  onDelete,
}: {
  mission: Mission;
  onSelect: () => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <Card
      className="cursor-pointer transition-colors hover:border-primary/50"
      onClick={onSelect}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold">{mission.title}</h3>
              <StateBadge state={mission.state} />
              <PriorityBadge priority={mission.priority} />
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {mission.goal}
            </p>
          </div>
        </div>

        {mission.subtasks.length > 0 && (
          <div className="mt-3">
            <ProgressBar subtasks={mission.subtasks} />
          </div>
        )}

        <div className="mt-2 flex items-center justify-between">
          <div className="flex gap-1 text-xs text-muted-foreground">
            <span>{mission.subtasks.length} subtasks</span>
            {mission.events.length > 0 && (
              <span>• {mission.events.length} events</span>
            )}
            <span>• {new Date(mission.created_at * 1000).toLocaleDateString()}</span>
          </div>

          <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
            {mission.state === "planning" && (
              <Button size="sm" variant="outline" onClick={onStart}>
                <Play className="h-3 w-3" />
              </Button>
            )}
            {mission.state === "executing" && (
              <Button size="sm" variant="outline" onClick={onPause}>
                <Pause className="h-3 w-3" />
              </Button>
            )}
            {mission.state === "paused" && (
              <Button size="sm" variant="outline" onClick={onResume}>
                <Play className="h-3 w-3" />
              </Button>
            )}
            {(mission.state === "executing" || mission.state === "paused") && (
              <Button size="sm" variant="outline" onClick={onCancel}>
                <StopCircle className="h-3 w-3" />
              </Button>
            )}
            <Button size="sm" variant="destructive" onClick={onDelete}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

export default function AutopilotPage() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [stats, setStats] = useState<MissionStats | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedMission, setSelectedMission] = useState<Mission | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const { toast } = useToast();

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [missionsData, statsData] = await Promise.all([
        fetchMissions(filter || undefined),
        fetchMissionStats(),
      ]);
      setMissions(missionsData);
      setStats(statsData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Poll every 5s for live updates
  useEffect(() => {
    const id = setInterval(loadData, 5000);
    return () => clearInterval(id);
  }, [loadData]);

  const handleAction = useCallback(
    async (id: string, action: "start" | "pause" | "resume" | "cancel") => {
      try {
        await missionAction(id, action);
        toast({ title: `Mission ${action}ed` });
        loadData();
      } catch (err: any) {
        toast({ title: `Failed to ${action}`, description: err.message });
      }
    },
    [toast, loadData]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteMission(id);
        toast({ title: "Mission deleted" });
        loadData();
      } catch (err: any) {
        toast({ title: "Delete failed", description: err.message });
      }
    },
    [toast, loadData]
  );

  const handleSelectMission = useCallback(async (m: Mission) => {
    setSelectedMission(m);
    setDetailOpen(true);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden p-4">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <H2>Autopilot</H2>
          {stats && (
            <span className="text-sm text-muted-foreground">
              {stats.active} active • {stats.total} total
            </span>
          )}
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" />
          New Mission
        </Button>
      </div>

      {/* Stats */}
      <div className="mb-4">
        <OverviewStats stats={stats} />
      </div>

      {/* Filter */}
      <div className="mb-4 flex gap-2">
        {["", "executing", "planning", "completed", "failed", "paused"].map(
          (f) => (
            <Button
              key={f}
              variant={filter === f ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(f)}
            >
              {f || "All"}
            </Button>
          )
        )}
      </div>

      {/* Mission list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner className="h-8 w-8" />
          </div>
        ) : error ? (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={loadData}>
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : missions.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Rocket className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                {filter
                  ? `No ${filter} missions`
                  : "No missions yet — create one to get started"}
              </p>
              {!filter && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="mr-1 h-3 w-3" />
                  New Mission
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {missions.map((m) => (
              <MissionCard
                key={m.id}
                mission={m}
                onSelect={() => handleSelectMission(m)}
                onStart={() => handleAction(m.id, "start")}
                onPause={() => handleAction(m.id, "pause")}
                onResume={() => handleAction(m.id, "resume")}
                onCancel={() => handleAction(m.id, "cancel")}
                onDelete={() => handleDelete(m.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <CreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => loadData()}
      />
      <MissionDetailDialog
        mission={selectedMission}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setSelectedMission(null);
          loadData();
        }}
      />
    </div>
  );
}
