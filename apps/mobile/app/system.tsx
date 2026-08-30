import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Spacing, FontSize, BorderRadius } from "../lib/theme";
import { fetchSystemStatus } from "../lib/api";
import type { SystemStatus } from "../lib/types";

// ── Status Card ─────────────────────────────────────────────────────

function StatusCard({
  icon,
  label,
  value,
  color,
  subtitle,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string | number;
  color: string;
  subtitle?: string;
}) {
  return (
    <View style={styles.statusCard}>
      <View style={[styles.statusIcon, { backgroundColor: color + "15" }]}>
        <Ionicons name={icon} size={22} color={color} />
      </View>
      <Text style={styles.statusValue}>{value}</Text>
      <Text style={styles.statusLabel}>{label}</Text>
      {subtitle && <Text style={styles.statusSubtitle}>{subtitle}</Text>}
    </View>
  );
}

// ── System Screen ───────────────────────────────────────────────────

export default function SystemScreen() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchSystemStatus();
      setStatus(data);
    } catch {
      // Silent fail
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const id = setInterval(loadStatus, 10000);
    return () => clearInterval(id);
  }, [loadStatus]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadStatus();
    setRefreshing(false);
  }, [loadStatus]);

  const uptime = status?.uptime ?? 0;
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const uptimeStr =
    hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

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
      <View style={styles.connectionBanner}>
        <View
          style={[
            styles.connectionDot,
            { backgroundColor: status ? Colors.success : Colors.error },
          ]}
        />
        <Text style={styles.connectionText}>
          {status ? "Connected to SanRemes" : "Disconnected"}
        </Text>
      </View>

      {/* Overview grid */}
      <View style={styles.statsGrid}>
        <StatusCard
          icon="time"
          label="Uptime"
          value={uptimeStr}
          color={Colors.gold}
        />
        <StatusCard
          icon="hardware-chip"
          label="Model"
          value={status?.model ?? "—"}
          color={Colors.info}
          subtitle={status?.provider ?? ""}
        />
        <StatusCard
          icon="flash"
          label="Tokens"
          value={
            status?.total_tokens
              ? `${Math.round(status.total_tokens / 1000)}k`
              : "—"
          }
          color={Colors.success}
        />
        <StatusCard
          icon="wallet"
          label="Cost"
          value={
            status?.total_cost
              ? `$${status.total_cost.toFixed(2)}`
              : "—"
          }
          color={Colors.warning}
        />
      </View>

      {/* Agent info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Agent</Text>
        <View style={styles.infoCard}>
          <InfoRow label="Version" value={status?.sanremes_version ?? "—"} />
          <InfoRow label="Python" value={status?.python_version ?? "—"} />
          <InfoRow label="Platform" value={status?.platform ?? "—"} />
          <InfoRow label="PID" value={String(status?.pid ?? "—")} />
          <InfoRow
            label="Gateway"
            value={status?.gateway_connected ? "Connected" : "Disconnected"}
            valueColor={status?.gateway_connected ? Colors.success : Colors.error}
          />
        </View>
      </View>

      {/* Quick actions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Actions</Text>
        <View style={styles.actionsCard}>
          <TouchableOpacity
            style={styles.actionRow}
            onPress={() =>
              Alert.alert(
                "Restart Gateway",
                "This will restart the SanRemes gateway process.",
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Restart", style: "destructive" },
                ]
              )
            }
          >
            <Ionicons name="refresh" size={20} color={Colors.warning} />
            <Text style={styles.actionLabel}>Restart Gateway</Text>
            <Ionicons name="chevron-forward" size={16} color={Colors.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ── Info Row ────────────────────────────────────────────────────────

function InfoRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, valueColor && { color: valueColor }]}>
        {value}
      </Text>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  connectionBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  connectionText: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  statusCard: {
    width: "48%",
    flexGrow: 1,
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
  },
  statusIcon: {
    width: 36,
    height: 36,
    borderRadius: BorderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.sm,
  },
  statusValue: {
    fontSize: FontSize.xl,
    fontWeight: "700",
    color: Colors.textPrimary,
  },
  statusLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  statusSubtitle: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },
  section: {
    padding: Spacing.lg,
    paddingTop: Spacing.xl,
  },
  sectionTitle: {
    fontSize: FontSize.lg,
    fontWeight: "600",
    color: Colors.textPrimary,
    marginBottom: Spacing.md,
  },
  infoCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    overflow: "hidden",
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  infoLabel: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  infoValue: {
    fontSize: FontSize.sm,
    fontWeight: "500",
    color: Colors.textPrimary,
  },
  actionsCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    overflow: "hidden",
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  actionLabel: {
    flex: 1,
    fontSize: FontSize.md,
    color: Colors.textPrimary,
  },
});
