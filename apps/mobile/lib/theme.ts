// ── SanRemes Agent Mobile Theme ───────────────────────────────────────

export const Colors = {
  // Brand
  navy: "#1B2A4A",
  gold: "#C4A265",
  goldLight: "#D4B87A",
  goldDark: "#A88B4A",

  // UI
  white: "#FFFFFF",
  background: "#F8F9FA",
  surface: "#FFFFFF",
  surfaceElevated: "#FFFFFF",
  border: "#E5E7EB",
  borderLight: "#F0F0F0",

  // Text
  textPrimary: "#1B2A4A",
  textSecondary: "#6B7280",
  textMuted: "#9CA3AF",
  textInverse: "#FFFFFF",

  // Status
  success: "#10B981",
  successBg: "#ECFDF5",
  warning: "#F59E0B",
  warningBg: "#FFFBEB",
  error: "#EF4444",
  errorBg: "#FEF2F2",
  info: "#3B82F6",
  infoBg: "#EFF6FF",

  // Autonomy levels
  assist: "#10B981",
  agent: "#3B82F6",
  autonomous: "#8B5CF6",
  mission: "#EF4444",
};

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const FontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 24,
  title: 28,
};

export const BorderRadius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  full: 999,
};

// ── Status helpers ────────────────────────────────────────────────────

export function getStateColor(state: string): string {
  switch (state) {
    case "executing":
    case "running":
      return Colors.info;
    case "completed":
      return Colors.success;
    case "failed":
      return Colors.error;
    case "paused":
    case "pending":
    case "awaiting_approval":
      return Colors.warning;
    case "planning":
    case "created":
    case "recovering":
      return Colors.gold;
    case "cancelled":
    case "skipped":
      return Colors.textMuted;
    default:
      return Colors.textSecondary;
  }
}

export function getStateBgColor(state: string): string {
  switch (state) {
    case "executing":
    case "running":
      return Colors.infoBg;
    case "completed":
      return Colors.successBg;
    case "failed":
      return Colors.errorBg;
    case "paused":
    case "pending":
    case "awaiting_approval":
      return Colors.warningBg;
    case "planning":
    case "created":
    case "recovering":
      return "#FDF8EE";
    default:
      return Colors.background;
  }
}

export function getPriorityColor(priority: string): string {
  switch (priority) {
    case "urgent":
      return Colors.error;
    case "high":
      return Colors.warning;
    case "low":
      return Colors.textMuted;
    default:
      return Colors.textSecondary;
  }
}
