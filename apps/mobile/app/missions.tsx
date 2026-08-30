import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Modal,
  TextInput,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Colors,
  Spacing,
  FontSize,
  BorderRadius,
  getStateColor,
} from "../lib/theme";
import {
  fetchMissions,
  createMission,
  missionAction,
} from "../lib/api";
import type { Mission } from "../lib/types";

// ── Mission Card ──────────────────────────────────────────────────────

function MissionCard({
  mission,
  onPress,
  onStart,
  onPause,
  onResume,
}: {
  mission: Mission;
  onPress: () => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const stateColor = getStateColor(mission.state);
  const done = mission.subtasks.filter(
    (s) => s.state === "completed" || s.state === "skipped"
  ).length;
  const pct = mission.subtasks.length
    ? Math.round((100 * done) / mission.subtasks.length)
    : 0;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {mission.title}
        </Text>
        <View style={[styles.badge, { backgroundColor: stateColor + "20" }]}>
          <Text style={[styles.badgeText, { color: stateColor }]}>
            {mission.state}
          </Text>
        </View>
      </View>

      <Text style={styles.cardGoal} numberOfLines={2}>
        {mission.goal}
      </Text>

      {mission.subtasks.length > 0 && (
        <View style={styles.progressRow}>
          <View style={styles.progressBar}>
            <View
              style={[
                styles.progressFill,
                { width: `${pct}%`, backgroundColor: stateColor },
              ]}
            />
          </View>
          <Text style={styles.progressText}>
            {pct}% · {done}/{mission.subtasks.length}
          </Text>
        </View>
      )}

      <View style={styles.cardFooter}>
        <Text style={styles.cardMeta}>
          {new Date(mission.created_at * 1000).toLocaleDateString()}
        </Text>
        <View style={styles.cardActions}>
          {mission.state === "planning" && (
            <TouchableOpacity style={styles.smallBtn} onPress={onStart}>
              <Ionicons name="play" size={14} color={Colors.success} />
            </TouchableOpacity>
          )}
          {mission.state === "executing" && (
            <TouchableOpacity style={styles.smallBtn} onPress={onPause}>
              <Ionicons name="pause" size={14} color={Colors.warning} />
            </TouchableOpacity>
          )}
          {mission.state === "paused" && (
            <TouchableOpacity style={styles.smallBtn} onPress={onResume}>
              <Ionicons name="play" size={14} color={Colors.info} />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ── Missions Screen ───────────────────────────────────────────────────

export default function MissionsScreen() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<string>("");
  const [createVisible, setCreateVisible] = useState(false);
  const [newGoal, setNewGoal] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const loadMissions = useCallback(async () => {
    try {
      const data = await fetchMissions(filter || undefined);
      setMissions(data);
    } catch {
      // Silent fail
    }
  }, [filter]);

  useEffect(() => {
    loadMissions();
    const id = setInterval(loadMissions, 5000);
    return () => clearInterval(id);
  }, [loadMissions]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadMissions();
    setRefreshing(false);
  }, [loadMissions]);

  const handleCreate = useCallback(async () => {
    if (!newGoal.trim()) return;
    setCreating(true);
    try {
      await createMission({
        goal: newGoal.trim(),
        title: newTitle.trim() || undefined,
      });
      setCreateVisible(false);
      setNewGoal("");
      setNewTitle("");
      await loadMissions();
    } catch (err: any) {
      Alert.alert("Error", err.message);
    } finally {
      setCreating(false);
    }
  }, [newGoal, newTitle, loadMissions]);

  const handleAction = useCallback(
    async (id: string, action: "start" | "pause" | "resume") => {
      try {
        await missionAction(id, action);
        await loadMissions();
      } catch (err: any) {
        Alert.alert("Error", err.message);
      }
    },
    [loadMissions]
  );

  const filters = [
    { key: "", label: "All" },
    { key: "executing", label: "Active" },
    { key: "planning", label: "Planning" },
    { key: "completed", label: "Done" },
    { key: "failed", label: "Failed" },
  ];

  return (
    <View style={styles.container}>
      {/* Filter bar */}
      <View style={styles.filterBar}>
        {filters.map((f) => (
          <TouchableOpacity
            key={f.key}
            style={[
              styles.filterBtn,
              filter === f.key && styles.filterBtnActive,
            ]}
            onPress={() => setFilter(f.key)}
          >
            <Text
              style={[
                styles.filterText,
                filter === f.key && styles.filterTextActive,
              ]}
            >
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Mission list */}
      <FlatList
        data={missions}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <MissionCard
            mission={item}
            onPress={() => {}}
            onStart={() => handleAction(item.id, "start")}
            onPause={() => handleAction(item.id, "pause")}
            onResume={() => handleAction(item.id, "resume")}
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors.gold}
          />
        }
        contentContainerStyle={
          missions.length === 0 ? styles.emptyContainer : undefined
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons
              name="rocket-outline"
              size={48}
              color={Colors.textMuted}
            />
            <Text style={styles.emptyText}>No missions yet</Text>
            <Text style={styles.emptySubtext}>
              Create a mission to get started
            </Text>
          </View>
        }
      />

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setCreateVisible(true)}
      >
        <Ionicons name="add" size={28} color={Colors.white} />
      </TouchableOpacity>

      {/* Create modal */}
      <Modal visible={createVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>New Mission</Text>
              <TouchableOpacity onPress={() => setCreateVisible(false)}>
                <Ionicons name="close" size={24} color={Colors.textSecondary} />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>Goal</Text>
            <TextInput
              style={styles.input}
              value={newGoal}
              onChangeText={setNewGoal}
              placeholder="What should SanRemes accomplish?"
              placeholderTextColor={Colors.textMuted}
              multiline
              numberOfLines={3}
            />

            <Text style={styles.inputLabel}>Title (optional)</Text>
            <TextInput
              style={styles.input}
              value={newTitle}
              onChangeText={setNewTitle}
              placeholder="Short display name"
              placeholderTextColor={Colors.textMuted}
            />

            <TouchableOpacity
              style={[
                styles.createBtn,
                (!newGoal.trim() || creating) && styles.createBtnDisabled,
              ]}
              onPress={handleCreate}
              disabled={!newGoal.trim() || creating}
            >
              <Text style={styles.createBtnText}>
                {creating ? "Creating..." : "Create Mission"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  filterBar: {
    flexDirection: "row",
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: Spacing.xs,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  filterBtn: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs,
    borderRadius: BorderRadius.full,
  },
  filterBtnActive: {
    backgroundColor: Colors.navy,
  },
  filterText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  filterTextActive: {
    color: Colors.white,
    fontWeight: "600",
  },
  card: {
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: Spacing.xs,
  },
  cardTitle: {
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
  cardGoal: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginBottom: Spacing.md,
    lineHeight: 18,
  },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
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
  cardFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardMeta: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  cardActions: {
    flexDirection: "row",
    gap: Spacing.xs,
  },
  smallBtn: {
    width: 32,
    height: 32,
    borderRadius: BorderRadius.sm,
    backgroundColor: Colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyState: {
    alignItems: "center",
    gap: Spacing.sm,
  },
  emptyText: {
    fontSize: FontSize.lg,
    fontWeight: "600",
    color: Colors.textPrimary,
  },
  emptySubtext: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  fab: {
    position: "absolute",
    right: Spacing.lg,
    bottom: Spacing.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.gold,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Colors.gold,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalContent: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: BorderRadius.xl,
    borderTopRightRadius: BorderRadius.xl,
    padding: Spacing.xl,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: Spacing.xl,
  },
  modalTitle: {
    fontSize: FontSize.xl,
    fontWeight: "600",
    color: Colors.textPrimary,
  },
  inputLabel: {
    fontSize: FontSize.sm,
    fontWeight: "500",
    color: Colors.textSecondary,
    marginBottom: Spacing.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    fontSize: FontSize.md,
    color: Colors.textPrimary,
    backgroundColor: Colors.background,
    marginBottom: Spacing.lg,
    minHeight: 44,
  },
  createBtn: {
    backgroundColor: Colors.gold,
    borderRadius: BorderRadius.md,
    padding: Spacing.lg,
    alignItems: "center",
  },
  createBtnDisabled: {
    opacity: 0.5,
  },
  createBtnText: {
    fontSize: FontSize.md,
    fontWeight: "600",
    color: Colors.navy,
  },
});
