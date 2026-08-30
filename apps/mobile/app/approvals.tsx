import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Colors,
  Spacing,
  FontSize,
  BorderRadius,
} from "../lib/theme";
import { fetchApprovals, approveRequest, denyRequest } from "../lib/api";
import type { Approval } from "../lib/types";

// ── Approval Card ─────────────────────────────────────────────────────

function ApprovalCard({
  approval,
  onApprove,
  onDeny,
}: {
  approval: Approval;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.toolBadge}>
          <Ionicons name="code-working" size={14} color={Colors.gold} />
          <Text style={styles.toolName}>{approval.tool_name}</Text>
        </View>
        <Text style={styles.timeText}>
          {new Date(approval.created_at * 1000).toLocaleTimeString()}
        </Text>
      </View>

      <Text style={styles.reason}>{approval.reason}</Text>

      {Object.keys(approval.tool_args).length > 0 && (
        <View style={styles.argsContainer}>
          <Text style={styles.argsLabel}>Arguments:</Text>
          <Text style={styles.argsText} numberOfLines={3}>
            {JSON.stringify(approval.tool_args, null, 2)}
          </Text>
        </View>
      )}

      <View style={styles.actions}>
        <TouchableOpacity style={styles.approveBtn} onPress={onApprove}>
          <Ionicons name="checkmark-circle" size={18} color={Colors.success} />
          <Text style={styles.approveText}>Approve</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.denyBtn} onPress={onDeny}>
          <Ionicons name="close-circle" size={18} color={Colors.error} />
          <Text style={styles.denyText}>Deny</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Approvals Screen ──────────────────────────────────────────────────

export default function ApprovalsScreen() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadApprovals = useCallback(async () => {
    try {
      const data = await fetchApprovals();
      setApprovals(data.filter((a) => a.status === "pending"));
    } catch {
      // Silent fail
    }
  }, []);

  useEffect(() => {
    loadApprovals();
    const id = setInterval(loadApprovals, 3000);
    return () => clearInterval(id);
  }, [loadApprovals]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadApprovals();
    setRefreshing(false);
  }, [loadApprovals]);

  const handleApprove = useCallback(
    async (id: string) => {
      try {
        await approveRequest(id);
        await loadApprovals();
      } catch (err: any) {
        Alert.alert("Error", err.message);
      }
    },
    [loadApprovals]
  );

  const handleDeny = useCallback(
    async (id: string) => {
      Alert.alert("Deny Request", "Are you sure you want to deny this?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Deny",
          style: "destructive",
          onPress: async () => {
            try {
              await denyRequest(id);
              await loadApprovals();
            } catch (err: any) {
              Alert.alert("Error", err.message);
            }
          },
        },
      ]);
    },
    [loadApprovals]
  );

  return (
    <View style={styles.container}>
      {approvals.length > 0 && (
        <View style={styles.countBar}>
          <Ionicons name="alert-circle" size={16} color={Colors.warning} />
          <Text style={styles.countText}>
            {approvals.length} pending approval{approvals.length !== 1 ? "s" : ""}
          </Text>
        </View>
      )}

      <FlatList
        data={approvals}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ApprovalCard
            approval={item}
            onApprove={() => handleApprove(item.id)}
            onDeny={() => handleDeny(item.id)}
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
          approvals.length === 0 ? styles.emptyContainer : undefined
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons
              name="shield-checkmark-outline"
              size={48}
              color={Colors.textMuted}
            />
            <Text style={styles.emptyText}>All clear</Text>
            <Text style={styles.emptySubtext}>
              No pending approvals right now
            </Text>
          </View>
        }
      />
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  countBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    backgroundColor: Colors.warningBg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  countText: {
    fontSize: FontSize.sm,
    color: Colors.warning,
    fontWeight: "500",
  },
  card: {
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.warning + "40",
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: Spacing.sm,
  },
  toolBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
    backgroundColor: Colors.gold + "15",
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: BorderRadius.sm,
  },
  toolName: {
    fontSize: FontSize.sm,
    fontWeight: "600",
    color: Colors.gold,
  },
  timeText: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },
  reason: {
    fontSize: FontSize.md,
    color: Colors.textPrimary,
    marginBottom: Spacing.md,
    lineHeight: 20,
  },
  argsContainer: {
    backgroundColor: Colors.background,
    borderRadius: BorderRadius.sm,
    padding: Spacing.sm,
    marginBottom: Spacing.md,
  },
  argsLabel: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginBottom: 2,
  },
  argsText: {
    fontSize: FontSize.xs,
    fontFamily: "monospace",
    color: Colors.textSecondary,
  },
  actions: {
    flexDirection: "row",
    gap: Spacing.sm,
  },
  approveBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.xs,
    backgroundColor: Colors.successBg,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
  },
  approveText: {
    fontSize: FontSize.md,
    fontWeight: "600",
    color: Colors.success,
  },
  denyBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.xs,
    backgroundColor: Colors.errorBg,
    paddingVertical: Spacing.md,
    borderRadius: BorderRadius.md,
  },
  denyText: {
    fontSize: FontSize.md,
    fontWeight: "600",
    color: Colors.error,
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
});
