import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  Colors,
  Spacing,
  FontSize,
  BorderRadius,
  getStateColor,
} from "../lib/theme";
import { fetchMissions, fetchApprovals, fetchSystemStatus } from "../lib/api";
import type { Mission, Approval, SystemStatus } from "../lib/types";

// ── Stat Card ─────────────────────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <View style={styles.statCard}>
      <View style={[styles.statIcon, { backgroundColor: color + "15" }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ── Mission Row ───────────────────────────────────────────────────────

function MissionRow({
  mission,
  onPress,
}: {
  mission: Mission;
  onPress: () => void;
}) {
  const stateColor = getStateColor(mission.state);
  const done = mission.subtasks.filter(
    (s) => s.state === "completed" || s.state === "skipped"
  ).length;
  const pct = mission.subtasks.length
    ? Math.round((100 * done) / mission.subtasks.length)
    : 0;

  return (
    <TouchableOpacity style={styles.missionRow} onPress={onPress}>
      <View style={styles.missionHeader}>
        <Text style={styles.missionTitle} numberOfLines={1}>
          {mission.title}
        </Text>
        <View style={[styles.badge, { backgroundColor: stateColor + "20" }]}>
          <Text style={[styles.badgeText, { color: stateColor }]}>
            {mission.state}
          </Text>
        </View>
      </View>
      <Text style={styles.missionGoal} numberOfLines={1}>
        {mission.goal}
      </Text>
      {mission.subtasks.length > 0 && (
        <View style={styles.progressContainer}>
          <View style={styles.progressBar}>
            <View
              style={[
                styles.progressFill,
                { width: `${pct}%`, backgroundColor: stateColor },
              ]}
            />
          </View>
          <Text style={styles.progressText}>
            {done}/{mission.subtasks.length}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── Approval Row ──────────────────────────────────────────────────────

function ApprovalRow({
  approval,
  onApprove,
  onDeny,
}: {
  approval: Approval;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <View style={styles.approvalRow}>
      <View style={styles.approvalHeader}>
        <Ionicons name="warning" size={16} color={Colors.warning} />
        <Text style={styles.approvalTool}>{approval.tool_name}</Text>
      </View>
      <Text style={styles.approvalReason} numberOfLines={2}>
        {approval.reason}
      </Text>
      <View style={styles.approvalActions}>
        <TouchableOpacity
          style={[styles.actionBtn, styles.approveBtn]}
          onPress={onApprove}
        >
          <Ionicons name="checkmark" size={16} color={Colors.success} />
          <Text style={[styles.actionText, { color: Colors.success }]}>
            Approve
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, styles.denyBtn]}
          onPress={onDeny}
        >
          <Ionicons name="close" size={16} color={Colors.error} />
          <Text style={[styles.actionText, { color: Colors.error }]}>
            Deny
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Home Screen ───────────────────────────────────────────────────────

export default function HomeScreen() {
  const router = useRouter();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [connected, setConnected] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [m, a, s] = await Promise.allSettled([
        fetchMissions(),
        fetchApprovals(),
        fetchSystemStatus(),
      ]);
      if (m.status === "fulfilled") setMissions(m.value);
      if (a.status === "fulfilled") setApprovals(a.value);
      if (s.status === "fulfilled") setStatus(s.value);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const id = setInterval(loadData, 5000);
    return () => clearInterval(id);
  }, [loadData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const activeMissions = missions.filter(
    (m) => m.state === "executing" || m.state === "planning"
  );
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const completedMissions = missions.filter(
    (m) => m.state === "completed"
  );

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={Colors.gold}
        />
      }
    >
      {/* Connection status */}
      {!connected && (
        <View style={styles.connectionBanner}>
          <Ionicons name="cloud-offline" size={14} color={Colors.error} />
          <Text style={styles.connectionText}>
            Unable to connect to SanRemes
          </Text>
        </View>
      )}

      {/* Stats */}
      <View style={styles.statsGrid}>
        <StatCard
          icon="rocket"
          label="Active"
          value={activeMissions.length}
          color={Colors.info}
        />
        <StatCard
          icon="shield-checkmark"
          label="Pending"
          value={pendingApprovals.length}
          color={Colors.warning}
        />
        <StatCard
          icon="checkmark-circle"
          label="Completed"
          value={completedMissions.length}
          color={Colors.success}
        />
        <StatCard
          icon="time"
          label="Uptime"
          value={status ? `${Math.floor(status.uptime / 3600)}h` : "—"}
          color={Colors.gold}
        />
      </View>

      {/* Active Missions */}
      {activeMissions.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Active Missions</Text>
            <TouchableOpacity onPress={() => router.push("/missions")}>
              <Text style={styles.seeAll}>See All</Text>
            </TouchableOpacity>
          </View>
          {activeMissions.slice(0, 3).map((m) => (
            <MissionRow
              key={m.id}
              mission={m}
              onPress={() => router.push("/missions")}
            />
          ))}
        </View>
      )}

      {/* Pending Approvals */}
      {pendingApprovals.length > 0 && (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Pending Approvals</Text>
            <TouchableOpacity onPress={() => router.push("/approvals")}>
              <Text style={styles.seeAll}>See All</Text>
            </TouchableOpacity>
          </View>
          {pendingApprovals.slice(0, 3).map((a) => (
            <ApprovalRow
              key={a.id}
              approval={a}
              onApprove={() => {}}
              onDeny={() => {}}
            />
          ))}
        </View>
      )}

      {/* Quick Actions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Quick Actions</Text>
        <View style={styles.actionsGrid}>
          <TouchableOpacity
            style={styles.actionCard}
            onPress={() => router.push("/missions")}
          >
            <Ionicons name="add-circle" size={28} color={Colors.gold} />
            <Text style={styles.actionCardText}>New Mission</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionCard}
            onPress={() => router.push("/chat")}
          >
            <Ionicons name="chatbubble" size={28} color={Colors.info} />
            <Text style={styles.actionCardText}>Chat</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionCard}
            onPress={() => router.push("/settings")}
          >
            <Ionicons name="settings" size={28} color={Colors.textSecondary} />
            <Text style={styles.actionCardText}>Settings</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  connectionBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Colors.errorBg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  connectionText: {
    color: Colors.error,
    fontSize: FontSize.sm,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  statCard: {
    width: "48%",
    flexGrow: 1,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  statIcon: {
    width: 36,
    height: 36,
    borderRadius: BorderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.sm,
  },
  statValue: {
    fontSize: FontSize.xxl,
    fontWeight: "700",
    color: Colors.textPrimary,
  },
  statLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  section: {
    padding: Spacing.lg,
    paddingTop: Spacing.xl,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: Spacing.md,
  },
  sectionTitle: {
    fontSize: FontSize.lg,
    fontWeight: "600",
    color: Colors.textPrimary,
  },
  seeAll: {
    fontSize: FontSize.sm,
    color: Colors.gold,
  },
  missionRow: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  missionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: Spacing.xs,
  },
  missionTitle: {
    fontSize: FontSize.md,
    fontWeight: "600",
    color: Colors.textPrimary,
    flex: 1,
    marginRight: Spacing.sm,
  },
  badge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: BorderRadius.sm,
  },
  badgeText: {
    fontSize: FontSize.xs,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  missionGoal: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.sm,
  },
  progressContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  progressBar: {
    flex: 1,
    height: 4,
    backgroundColor: Colors.border,
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
  },
  progressText: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  approvalRow: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.warning + "40",
  },
  approvalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  approvalTool: {
    fontSize: FontSize.md,
    fontWeight: "600",
    color: Colors.textPrimary,
  },
  approvalReason: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
  },
  approvalActions: {
    flexDirection: "row",
    gap: Spacing.sm,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
  },
  approveBtn: {
    backgroundColor: Colors.successBg,
  },
  denyBtn: {
    backgroundColor: Colors.errorBg,
  },
  actionText: {
    fontSize: FontSize.sm,
    fontWeight: "600",
  },
  actionsGrid: {
    flexDirection: "row",
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  actionCard: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    alignItems: "center",
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  actionCardText: {
    fontSize: FontSize.sm,
    color: Colors.textPrimary,
    fontWeight: "500",
  },
});
