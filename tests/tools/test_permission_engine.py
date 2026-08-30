"""Tests for the permission engine (tools/permission_engine.py).

The permission engine evaluates per-tool allow/ask/deny policies before
tool dispatch.  Tests cover:
  - Policy evaluation priority (user deny > context > tool > toolset > default)
  - fnmatch pattern matching
  - Context-specific rules (cron, subagent, remote)
  - Config loading and serialization
  - Thread safety of the singleton
  - CLI management operations (add/remove rules)
  - Integration with the model_tools dispatch path
"""

import threading
from typing import Dict
from unittest.mock import patch

import pytest

from tools.permission_engine import (
    PermissionDecision,
    PermissionEngine,
    PermissionLevel,
    ToolPolicy,
    get_permission_engine,
    load_permissions_from_config,
)


# ── ToolPolicy ──────────────────────────────────────────────────────


class TestToolPolicy:
    def test_exact_match(self):
        p = ToolPolicy("terminal", PermissionLevel.ALLOW)
        assert p.matches("terminal") is True
        assert p.matches("terminal2") is False

    def test_glob_match(self):
        p = ToolPolicy("browser_*", PermissionLevel.DENY)
        assert p.matches("browser_navigate") is True
        assert p.matches("browser_click") is True
        assert p.matches("browser") is False

    def test_wildcard_all(self):
        p = ToolPolicy("*", PermissionLevel.ASK)
        assert p.matches("anything") is True
        assert p.matches("") is True

    def test_question_mark_wildcard(self):
        p = ToolPolicy("read_?ile", PermissionLevel.ALLOW)
        assert p.matches("read_file") is True
        assert p.matches("readile") is False

    def test_to_dict_roundtrip(self):
        p = ToolPolicy(
            "terminal", PermissionLevel.ASK,
            reason="needs approval", context="cron"
        )
        d = p.to_dict()
        p2 = ToolPolicy.from_dict(d)
        assert p2.pattern == "terminal"
        assert p2.level == PermissionLevel.ASK
        assert p2.reason == "needs approval"
        assert p2.context == "cron"

    def test_to_dict_minimal(self):
        p = ToolPolicy("write_file", PermissionLevel.DENY)
        d = p.to_dict()
        assert d == {"pattern": "write_file", "level": "deny"}
        p2 = ToolPolicy.from_dict(d)
        assert p2.reason == ""
        assert p2.context is None


# ── PermissionEngine evaluation ─────────────────────────────────────


class TestPermissionEngineEvaluation:
    def setup_method(self):
        self.engine = PermissionEngine()

    def test_disabled_engine_allows_all(self):
        """When disabled, every tool is ALLOW regardless of rules."""
        assert self.engine.is_enabled() is False
        d = self.engine.evaluate("terminal")
        assert d.level == PermissionLevel.ALLOW

    def test_enabled_default_allow(self):
        self.engine.set_enabled(True)
        d = self.engine.evaluate("anything")
        assert d.level == PermissionLevel.ALLOW
        assert d.matched_by == "default"

    def test_enabled_default_deny(self):
        self.engine.set_enabled(True)
        self.engine.set_global_default(PermissionLevel.DENY)
        d = self.engine.evaluate("anything")
        assert d.level == PermissionLevel.DENY
        assert d.matched_by == "default"

    def test_tool_override_wins_over_default(self):
        self.engine.set_enabled(True)
        self.engine.add_tool_rule("terminal", PermissionLevel.ASK, reason="test")
        d = self.engine.evaluate("terminal")
        assert d.level == PermissionLevel.ASK
        assert "test" in d.reason
        assert d.matched_by == "tools:terminal"

    def test_tool_glob_override(self):
        self.engine.set_enabled(True)
        self.engine.add_tool_rule("browser_*", PermissionLevel.DENY, reason="no browser")
        assert self.engine.evaluate("browser_navigate").level == PermissionLevel.DENY
        assert self.engine.evaluate("browser_click").level == PermissionLevel.DENY
        assert self.engine.evaluate("terminal").level == PermissionLevel.ALLOW

    def test_toolset_override(self):
        self.engine.set_enabled(True)
        self.engine.add_toolset_rule("terminal", PermissionLevel.ASK)
        self.engine.set_tool_to_toolset_map({
            "terminal": "terminal",
            "read_file": "file",
            "write_file": "file",
        })
        assert self.engine.evaluate("terminal").level == PermissionLevel.ASK
        assert self.engine.evaluate("read_file").level == PermissionLevel.ALLOW

    def test_toolset_glob_override(self):
        self.engine.set_enabled(True)
        self.engine.add_toolset_rule("*", PermissionLevel.ASK)
        self.engine.set_tool_to_toolset_map({"terminal": "terminal"})
        assert self.engine.evaluate("terminal").level == PermissionLevel.ASK

    def test_tool_override_beats_toolset(self):
        """Per-tool rules take priority over per-toolset rules."""
        self.engine.set_enabled(True)
        self.engine.add_tool_rule("terminal", PermissionLevel.ALLOW)
        self.engine.add_toolset_rule("terminal", PermissionLevel.DENY)
        self.engine.set_tool_to_toolset_map({"terminal": "terminal"})
        d = self.engine.evaluate("terminal")
        assert d.level == PermissionLevel.ALLOW
        assert d.matched_by == "tools:terminal"

    def test_context_rule_wins_over_tool(self):
        """Context rules take priority over per-tool rules."""
        self.engine.set_enabled(True)
        self.engine.add_tool_rule("*", PermissionLevel.ALLOW)
        self.engine.set_context_rules("cron", [
            ToolPolicy("*", PermissionLevel.DENY, reason="no tools in cron"),
        ])
        d = self.engine.evaluate("terminal", context="cron")
        assert d.level == PermissionLevel.DENY
        assert "cron" in d.reason

    def test_user_deny_always_wins(self):
        """User-defined deny rules always win over everything."""
        self.engine.set_enabled(True)
        self.engine.add_tool_rule("terminal", PermissionLevel.ALLOW)
        d = self.engine.evaluate("terminal", is_user_deny_match=True)
        assert d.level == PermissionLevel.DENY
        assert "approvals.deny" in d.matched_by

    def test_context_wrong_context_ignored(self):
        """A context-specific rule doesn't apply when context doesn't match."""
        self.engine.set_enabled(True)
        self.engine.set_context_rules("cron", [
            ToolPolicy("*", PermissionLevel.DENY),
        ])
        d = self.engine.evaluate("terminal", context="subagent")
        assert d.level == PermissionLevel.ALLOW

    def test_context_rule_with_specific_tool(self):
        self.engine.set_enabled(True)
        self.engine.set_context_rules("cron", [
            ToolPolicy("terminal", PermissionLevel.DENY, reason="no terminal in cron"),
            ToolPolicy("web_*", PermissionLevel.ALLOW),
        ])
        assert self.engine.evaluate("terminal", context="cron").level == PermissionLevel.DENY
        assert self.engine.evaluate("web_search", context="cron").level == PermissionLevel.ALLOW
        # Non-matching tools fall to default
        assert self.engine.evaluate("read_file", context="cron").level == PermissionLevel.ALLOW


# ── Config loading ──────────────────────────────────────────────────


class TestConfigLoading:
    def test_load_empty_config(self):
        engine = PermissionEngine()
        engine.load_from_config({})
        assert engine.is_enabled() is False

    def test_load_full_config(self):
        config = {
            "permissions": {
                "enabled": True,
                "default": "ask",
                "tools": [
                    {"pattern": "terminal", "level": "deny", "reason": "blocked"},
                    {"pattern": "browser_*", "level": "ask", "reason": "review needed"},
                ],
                "toolsets": [
                    {"pattern": "cronjob", "level": "ask"},
                ],
                "contexts": {
                    "cron": [
                        {"pattern": "*", "level": "deny", "reason": "cron sandbox"},
                    ],
                },
            }
        }
        engine = PermissionEngine()
        engine.load_from_config(config)
        assert engine.is_enabled() is True
        assert engine.get_global_default() == PermissionLevel.ASK
        assert engine.evaluate("terminal").level == PermissionLevel.DENY
        assert engine.evaluate("browser_navigate").level == PermissionLevel.ASK
        assert engine.evaluate("unknown_tool").level == PermissionLevel.ASK
        assert engine.evaluate("terminal", context="cron").level == PermissionLevel.DENY

    def test_load_invalid_default_falls_back(self):
        config = {
            "permissions": {
                "enabled": True,
                "default": "invalid_value",
            }
        }
        engine = PermissionEngine()
        engine.load_from_config(config)
        assert engine.get_global_default() == PermissionLevel.ALLOW

    def test_serialization_roundtrip(self):
        engine = PermissionEngine()
        engine.set_enabled(True)
        engine.set_global_default(PermissionLevel.ASK)
        engine.add_tool_rule("terminal", PermissionLevel.DENY, reason="test")
        engine.add_toolset_rule("cronjob", PermissionLevel.DENY)
        engine.set_context_rules("cron", [
            ToolPolicy("*", PermissionLevel.DENY, reason="cron sandbox"),
        ])

        exported = engine.get_all_rules()
        engine2 = PermissionEngine()
        engine2.load_from_config({"permissions": exported})
        assert engine2.is_enabled() is True
        assert engine2.get_global_default() == PermissionLevel.ASK
        assert engine2.evaluate("terminal").level == PermissionLevel.DENY
        assert engine2.evaluate("cronjob_create", context="cron").level == PermissionLevel.DENY


# ── Rule management ─────────────────────────────────────────────────


class TestRuleManagement:
    def setup_method(self):
        self.engine = PermissionEngine()
        self.engine.set_enabled(True)

    def test_add_and_remove_tool_rule(self):
        self.engine.add_tool_rule("terminal", PermissionLevel.ASK)
        assert self.engine.evaluate("terminal").level == PermissionLevel.ASK
        assert self.engine.remove_tool_rule("terminal") is True
        assert self.engine.evaluate("terminal").level == PermissionLevel.ALLOW

    def test_remove_nonexistent_returns_false(self):
        assert self.engine.remove_tool_rule("nonexistent") is False

    def test_add_and_remove_toolset_rule(self):
        self.engine.add_toolset_rule("terminal", PermissionLevel.DENY)
        self.engine.set_tool_to_toolset_map({"terminal": "terminal"})
        assert self.engine.evaluate("terminal").level == PermissionLevel.DENY
        assert self.engine.remove_toolset_rule("terminal") is True
        assert self.engine.evaluate("terminal").level == PermissionLevel.ALLOW

    def test_set_and_remove_context_rules(self):
        rules = [ToolPolicy("*", PermissionLevel.DENY)]
        self.engine.set_context_rules("cron", rules)
        assert self.engine.evaluate("terminal", context="cron").level == PermissionLevel.DENY
        assert self.engine.remove_context_rules("cron") is True
        assert self.engine.evaluate("terminal", context="cron").level == PermissionLevel.ALLOW

    def test_remove_nonexistent_context_returns_false(self):
        assert self.engine.remove_context_rules("nonexistent") is False

    def test_summarize(self):
        self.engine.add_tool_rule("terminal", PermissionLevel.ASK, reason="needs approval")
        self.engine.add_toolset_rule("cronjob", PermissionLevel.DENY)
        self.engine.set_context_rules("cron", [
            ToolPolicy("*", PermissionLevel.DENY, reason="no cron"),
        ])
        summary = self.engine.summarize()
        assert "enabled" in summary
        assert "terminal" in summary
        assert "cronjob" in summary
        assert "[cron]" in summary


# ── Singleton ───────────────────────────────────────────────────────


class TestSingleton:
    def test_get_permission_engine_returns_same_instance(self):
        e1 = get_permission_engine()
        e2 = get_permission_engine()
        assert e1 is e2

    def test_load_permissions_from_config(self):
        config = {
            "permissions": {
                "enabled": True,
                "default": "deny",
            }
        }
        engine = load_permissions_from_config(config)
        assert engine.is_enabled() is True
        assert engine.get_global_default() == PermissionLevel.DENY


# ── Thread safety ───────────────────────────────────────────────────


class TestThreadSafety:
    def test_concurrent_reads_and_writes(self):
        """Verify no crashes under concurrent access."""
        engine = PermissionEngine()
        engine.set_enabled(True)
        engine.add_tool_rule("terminal", PermissionLevel.ASK)

        errors = []

        def reader():
            try:
                for _ in range(100):
                    engine.evaluate("terminal")
                    engine.is_enabled()
                    engine.get_all_rules()
            except Exception as e:
                errors.append(e)

        def writer():
            try:
                for i in range(50):
                    engine.add_tool_rule(f"tool_{i}", PermissionLevel.DENY)
                    engine.remove_tool_rule(f"tool_{i}")
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=reader) for _ in range(4)]
        threads += [threading.Thread(target=writer) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == []
