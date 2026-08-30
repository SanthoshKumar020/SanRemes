import { useCallback, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Colors, Spacing, FontSize, BorderRadius } from "../lib/theme";

// ── Settings Row ──────────────────────────────────────────────────────

function SettingsRow({
  icon,
  label,
  value,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value?: string;
  onPress?: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onPress}
      disabled={!onPress}
    >
      <View style={styles.rowLeft}>
        <Ionicons name={icon} size={20} color={Colors.textSecondary} />
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
      <View style={styles.rowRight}>
        {value && <Text style={styles.rowValue}>{value}</Text>}
        {onPress && (
          <Ionicons
            name="chevron-forward"
            size={16}
            color={Colors.textMuted}
          />
        )}
      </View>
    </TouchableOpacity>
  );
}

// ── Settings Screen ───────────────────────────────────────────────────

export default function SettingsScreen() {
  const [serverUrl, setServerUrl] = useState(
    "http://localhost:8787"
  );
  const [editing, setEditing] = useState(false);

  const handleSave = useCallback(() => {
    // In production, save to AsyncStorage
    setEditing(false);
    Alert.alert("Saved", `Server URL: ${serverUrl}`);
  }, [serverUrl]);

  return (
    <ScrollView style={styles.container}>
      {/* Connection */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Connection</Text>
        <View style={styles.sectionCard}>
          {editing ? (
            <View style={styles.editRow}>
              <TextInput
                style={styles.input}
                value={serverUrl}
                onChangeText={setServerUrl}
                placeholder="http://localhost:8787"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.editActions}>
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={() => setEditing(false)}
                >
                  <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
                  <Text style={styles.saveText}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <SettingsRow
              icon="globe"
              label="Server URL"
              value={serverUrl}
              onPress={() => setEditing(true)}
            />
          )}
          <SettingsRow
            icon="checkmark-circle"
            label="Status"
            value="Connected"
          />
        </View>
      </View>

      {/* Agent */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Agent</Text>
        <View style={styles.sectionCard}>
          <SettingsRow icon="person" label="Profile" value="default" />
          <SettingsRow icon="key" label="API Keys" onPress={() => {}} />
          <SettingsRow icon="server" label="Models" onPress={() => {}} />
        </View>
      </View>

      {/* Features */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Features</Text>
        <View style={styles.sectionCard}>
          <SettingsRow
            icon="shield-checkmark"
            label="Permission Engine"
            value="Enabled"
          />
          <SettingsRow
            icon="rocket"
            label="Autopilot"
            value="Enabled"
          />
          <SettingsRow
            icon="storefront"
            label="Marketplace"
            value="Enabled"
          />
        </View>
      </View>

      {/* About */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>About</Text>
        <View style={styles.sectionCard}>
          <SettingsRow icon="information-circle" label="Version" value="1.0.0" />
          <SettingsRow
            icon="logo-github"
            label="GitHub"
            onPress={() => {}}
          />
          <SettingsRow icon="document-text" label="Documentation" onPress={() => {}} />
        </View>
      </View>

      {/* Brand footer */}
      <View style={styles.footer}>
        <View style={styles.footerLogo}>
          <Text style={styles.footerSR}>SR</Text>
        </View>
        <Text style={styles.footerBrand}>SanRemes Agent</Text>
        <Text style={styles.footerSubtext}>
          Open-source autonomous agent platform
        </Text>
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
  section: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xl,
  },
  sectionTitle: {
    fontSize: FontSize.sm,
    fontWeight: "600",
    color: Colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: Spacing.sm,
  },
  sectionCard: {
    backgroundColor: Colors.surface,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.borderLight,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.borderLight,
  },
  rowLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.md,
  },
  rowLabel: {
    fontSize: FontSize.md,
    color: Colors.textPrimary,
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.xs,
  },
  rowValue: {
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  editRow: {
    padding: Spacing.lg,
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    padding: Spacing.md,
    fontSize: FontSize.md,
    color: Colors.textPrimary,
    backgroundColor: Colors.background,
    marginBottom: Spacing.md,
  },
  editActions: {
    flexDirection: "row",
    gap: Spacing.sm,
    justifyContent: "flex-end",
  },
  cancelBtn: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
  },
  cancelText: {
    fontSize: FontSize.md,
    color: Colors.textSecondary,
  },
  saveBtn: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.gold,
  },
  saveText: {
    fontSize: FontSize.md,
    fontWeight: "600",
    color: Colors.navy,
  },
  footer: {
    alignItems: "center",
    paddingVertical: Spacing.xxl,
    marginTop: Spacing.xxl,
  },
  footerLogo: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Colors.navy,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.sm,
  },
  footerSR: {
    fontSize: FontSize.lg,
    fontWeight: "700",
    color: Colors.gold,
  },
  footerBrand: {
    fontSize: FontSize.lg,
    fontWeight: "600",
    color: Colors.textPrimary,
  },
  footerSubtext: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginTop: 2,
  },
});
