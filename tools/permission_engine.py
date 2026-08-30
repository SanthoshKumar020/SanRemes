"""Permission Engine — per-tool allow/ask/deny policy enforcement.

This module implements the Phase 7 permission system: a policy engine that
controls which tools the agent can invoke, under what conditions, and whether
user approval is required.

Permission levels:
  ALLOW  — tool executes without prompt (default for most tools)
  ASK    — tool requires user approval before execution
  DENY   — tool is blocked entirely; agent sees an error

Policies are evaluated in priority order:
  1. User deny rules (approvals.deny) — always win, even over ALLOW
  2. Context-specific rules (cron, subagent, etc.)
  3. Per-tool overrides
  4. Per-toolset overrides
  5. Global default mode

The engine is designed to be called from handle_function_call() in model_tools.py,
before the actual tool dispatch. It integrates with the existing approval system
(tools/approval.py) for ASK-level decisions.
"""

import fnmatch
import logging
import threading
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


class PermissionLevel(str, Enum):
    """Three-state permission level for tool execution."""

    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"


# ── Policy data structures ──────────────────────────────────────────


class ToolPolicy:
    """A single permission rule for a tool or tool pattern.

    Attributes:
        pattern: fnmatch-style glob (e.g. "browser_*", "terminal", "write_file").
        level: PermissionLevel for this rule.
        reason: Optional human-readable explanation shown to the agent/user.
        context: Optional context filter (e.g. "cron", "subagent", "remote").
                 None means the rule applies in all contexts.
    """

    __slots__ = ("pattern", "level", "reason", "context")

    def __init__(
        self,
        pattern: str,
        level: PermissionLevel,
        reason: str = "",
        context: Optional[str] = None,
    ):
        self.pattern = pattern
        self.level = level
        self.reason = reason
        self.context = context

    def matches(self, tool_name: str) -> bool:
        """Check if this policy's pattern matches the given tool name."""
        return fnmatch.fnmatch(tool_name, self.pattern)

    def to_dict(self) -> dict:
        d: dict[str, str] = {"pattern": self.pattern, "level": self.level.value}
        if self.reason:
            d["reason"] = self.reason
        if self.context:
            d["context"] = self.context
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "ToolPolicy":
        return cls(
            pattern=d["pattern"],
            level=PermissionLevel(d["level"]),
            reason=d.get("reason", ""),
            context=d.get("context"),
        )


class PermissionDecision:
    """Result of a permission evaluation.

    Attributes:
        level: The resolved PermissionLevel.
        reason: Why this decision was made (for auditing / user display).
        matched_by: Which policy rule produced this decision (for debugging).
    """

    __slots__ = ("level", "reason", "matched_by")

    def __init__(
        self,
        level: PermissionLevel,
        reason: str = "",
        matched_by: str = "",
    ):
        self.level = level
        self.reason = reason
        self.matched_by = matched_by

    def __repr__(self) -> str:
        return f"PermissionDecision({self.level.value!r}, reason={self.reason!r})"


# ── Permission Engine ───────────────────────────────────────────────


class PermissionEngine:
    """Evaluates tool invocation policies.

    Thread-safe: policy reads use the GIL (dict/list reads are atomic in CPython)
    and the lock only guards mutation paths.

    Usage::

        engine = PermissionEngine()
        engine.load_from_config(config_dict)
        decision = engine.evaluate("terminal", context="cron")
        if decision.level == PermissionLevel.DENY:
            return tool_error(decision.reason)
        if decision.level == PermissionLevel.ASK:
            # route to approval system
            ...
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._global_default: PermissionLevel = PermissionLevel.ALLOW
        self._tool_overrides: List[ToolPolicy] = []
        self._toolset_overrides: List[ToolPolicy] = []
        self._context_rules: Dict[str, List[ToolPolicy]] = {}
        self._enabled: bool = False
        # Cached tool→toolset mapping (populated by caller or set explicitly)
        self._tool_to_toolset: Dict[str, str] = {}

    # ── Configuration loading ────────────────────────────────────────

    def load_from_config(self, config: dict) -> None:
        """Load permission policies from the ``permissions`` section of config.

        Expected config shape::

            permissions:
              enabled: true
              default: allow
              tools:
                - pattern: "terminal"
                  level: ask
                  reason: "Terminal access requires approval"
                - pattern: "browser_*"
                  level: deny
                  reason: "Browser tools disabled in production"
              toolsets:
                - pattern: "cronjob"
                  level: ask
              contexts:
                cron:
                  - pattern: "*"
                    level: deny
                    reason: "Cron jobs run non-interactively"
                subagent:
                  - pattern: "write_file"
                    level: ask
        """
        perm_cfg = config.get("permissions", {})
        if not perm_cfg:
            return

        with self._lock:
            self._enabled = bool(perm_cfg.get("enabled", False))

            default_str = perm_cfg.get("default", "allow")
            try:
                self._global_default = PermissionLevel(default_str)
            except (ValueError, KeyError):
                self._global_default = PermissionLevel.ALLOW

            self._tool_overrides = [
                ToolPolicy.from_dict(p) for p in perm_cfg.get("tools", [])
            ]
            self._toolset_overrides = [
                ToolPolicy.from_dict(p) for p in perm_cfg.get("toolsets", [])
            ]

            self._context_rules = {}
            for ctx_name, rules in perm_cfg.get("contexts", {}).items():
                self._context_rules[ctx_name] = [
                    ToolPolicy.from_dict(r) for r in rules
                ]

        logger.debug(
            "Permission engine loaded: enabled=%s, default=%s, "
            "tool_rules=%d, toolset_rules=%d, contexts=%s",
            self._enabled,
            self._global_default.value,
            len(self._tool_overrides),
            len(self._toolset_overrides),
            list(self._context_rules.keys()),
        )

    def set_tool_to_toolset_map(self, mapping: Dict[str, str]) -> None:
        """Update the tool→toolset mapping for toolset-level evaluation."""
        with self._lock:
            self._tool_to_toolset = dict(mapping)

    # ── Evaluation ───────────────────────────────────────────────────

    def evaluate(
        self,
        tool_name: str,
        context: Optional[str] = None,
        is_user_deny_match: bool = False,
    ) -> PermissionDecision:
        """Evaluate the permission decision for a tool invocation.

        Args:
            tool_name: The tool being invoked.
            context: Execution context ("cron", "subagent", "remote", etc.).
            is_user_deny_match: True if the tool already matched an
                ``approvals.deny`` user rule (which always wins).

        Returns:
            PermissionDecision with the resolved level and reason.
        """
        if not self._enabled:
            return PermissionDecision(
                level=PermissionLevel.ALLOW,
                reason="Permission engine disabled",
            )

        # 1. User deny rules always win
        if is_user_deny_match:
            return PermissionDecision(
                level=PermissionLevel.DENY,
                reason="Blocked by user-defined deny rule (approvals.deny)",
                matched_by="approvals.deny",
            )

        # 2. Context-specific rules (highest priority after user deny)
        if context and context in self._context_rules:
            for policy in self._context_rules[context]:
                if policy.matches(tool_name):
                    return PermissionDecision(
                        level=policy.level,
                        reason=policy.reason or f"Context rule ({context})",
                        matched_by=f"contexts.{context}:{policy.pattern}",
                    )

        # 3. Per-tool overrides
        for policy in self._tool_overrides:
            if policy.matches(tool_name):
                if policy.context and policy.context != context:
                    continue  # context-specific rule, wrong context
                return PermissionDecision(
                    level=policy.level,
                    reason=policy.reason or f"Tool rule ({policy.pattern})",
                    matched_by=f"tools:{policy.pattern}",
                )

        # 4. Per-toolset overrides
        toolset = self._tool_to_toolset.get(tool_name)
        if toolset:
            for policy in self._toolset_overrides:
                if policy.matches(toolset):
                    return PermissionDecision(
                        level=policy.level,
                        reason=policy.reason or f"Toolset rule ({policy.pattern})",
                        matched_by=f"toolsets:{policy.pattern}",
                    )

        # 5. Global default
        return PermissionDecision(
            level=self._global_default,
            reason="Global default",
            matched_by="default",
        )

    def is_enabled(self) -> bool:
        """Check if the permission engine is active."""
        return self._enabled

    def get_global_default(self) -> PermissionLevel:
        """Return the global default permission level."""
        return self._global_default

    # ── Policy management (for CLI commands) ─────────────────────────

    def add_tool_rule(
        self,
        pattern: str,
        level: PermissionLevel,
        reason: str = "",
        context: Optional[str] = None,
    ) -> None:
        """Add a per-tool permission rule."""
        with self._lock:
            self._tool_overrides.append(
                ToolPolicy(pattern=pattern, level=level, reason=reason, context=context)
            )

    def remove_tool_rule(self, pattern: str) -> bool:
        """Remove the first matching tool rule. Returns True if removed."""
        with self._lock:
            for i, policy in enumerate(self._tool_overrides):
                if policy.pattern == pattern:
                    self._tool_overrides.pop(i)
                    return True
        return False

    def add_toolset_rule(
        self,
        pattern: str,
        level: PermissionLevel,
        reason: str = "",
    ) -> None:
        """Add a per-toolset permission rule."""
        with self._lock:
            self._toolset_overrides.append(
                ToolPolicy(pattern=pattern, level=level, reason=reason)
            )

    def remove_toolset_rule(self, pattern: str) -> bool:
        """Remove the first matching toolset rule."""
        with self._lock:
            for i, policy in enumerate(self._toolset_overrides):
                if policy.pattern == pattern:
                    self._toolset_overrides.pop(i)
                    return True
        return False

    def set_context_rules(
        self, context: str, rules: List[ToolPolicy]
    ) -> None:
        """Replace all rules for a given context."""
        with self._lock:
            self._context_rules[context] = list(rules)

    def remove_context_rules(self, context: str) -> bool:
        """Remove all rules for a context. Returns True if rules existed."""
        with self._lock:
            if context in self._context_rules:
                del self._context_rules[context]
                return True
        return False

    def set_global_default(self, level: PermissionLevel) -> None:
        """Change the global default permission level."""
        with self._lock:
            self._global_default = level

    def set_enabled(self, enabled: bool) -> None:
        """Enable or disable the permission engine."""
        with self._lock:
            self._enabled = enabled

    def get_all_rules(self) -> dict:
        """Export current rules as a serializable dict (for config persistence)."""
        with self._lock:
            return {
                "enabled": self._enabled,
                "default": self._global_default.value,
                "tools": [p.to_dict() for p in self._tool_overrides],
                "toolsets": [p.to_dict() for p in self._toolset_overrides],
                "contexts": {
                    ctx: [p.to_dict() for p in rules]
                    for ctx, rules in self._context_rules.items()
                },
            }

    def summarize(self) -> str:
        """Return a human-readable summary of current rules (for CLI display)."""
        with self._lock:
            lines = [
                f"Permission Engine: {'enabled' if self._enabled else 'disabled'}",
                f"Global default: {self._global_default.value}",
            ]
            if self._tool_overrides:
                lines.append("Tool rules:")
                for p in self._tool_overrides:
                    ctx = f" (context={p.context})" if p.context else ""
                    lines.append(
                        f"  {p.pattern:30s} → {p.level.value:6s}{ctx}"
                        + (f"  # {p.reason}" if p.reason else "")
                    )
            if self._toolset_overrides:
                lines.append("Toolset rules:")
                for p in self._toolset_overrides:
                    lines.append(
                        f"  {p.pattern:30s} → {p.level.value:6s}"
                        + (f"  # {p.reason}" if p.reason else "")
                    )
            if self._context_rules:
                lines.append("Context rules:")
                for ctx, rules in self._context_rules.items():
                    lines.append(f"  [{ctx}]")
                    for p in rules:
                        lines.append(
                            f"    {p.pattern:28s} → {p.level.value:6s}"
                            + (f"  # {p.reason}" if p.reason else "")
                        )
            return "\n".join(lines)


# ── Module-level singleton ──────────────────────────────────────────

_engine: Optional[PermissionEngine] = None
_engine_lock = threading.Lock()


def get_permission_engine() -> PermissionEngine:
    """Return the global PermissionEngine singleton, creating it if needed."""
    global _engine
    if _engine is None:
        with _engine_lock:
            if _engine is None:
                _engine = PermissionEngine()
    return _engine


def load_permissions_from_config(config: dict) -> PermissionEngine:
    """Load permissions from config and return the engine."""
    engine = get_permission_engine()
    engine.load_from_config(config)
    return engine
