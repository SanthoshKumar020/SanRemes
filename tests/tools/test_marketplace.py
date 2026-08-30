"""Tests for the Hermes Skill Registry and Marketplace API."""

from __future__ import annotations

import textwrap
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli.skill_registry import (
    McpServer,
    SkillManifest,
    SkillRegistry,
    _parse_yaml_simple,
    get_registry,
    parse_skill_manifest,
    KNOWN_MCP_SERVERS,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def skills_dir(tmp_path: Path) -> Path:
    """Create a temporary skills directory with two mock skills."""
    # Skill 1: plan
    plan_dir = tmp_path / "software-development" / "plan"
    plan_dir.mkdir(parents=True)
    (plan_dir / "SKILL.md").write_text(
        textwrap.dedent("""\
            ---
            name: plan
            description: Write a markdown plan to .hermes/plans/
            version: 2.0.0
            author: Hermes
            license: MIT
            platforms: [linux, macos, windows]
            metadata:
              sanremes:
                tags: [planning, workflow]
                related_skills: [test-driven-development]
            ---

            # Plan Mode

            Use this skill when the user wants a plan instead of execution.
        """)
    )

    # Skill 2: debugging
    debug_dir = tmp_path / "software-development" / "systematic-debugging"
    debug_dir.mkdir(parents=True)
    (debug_dir / "SKILL.md").write_text(
        textwrap.dedent("""\
            ---
            name: systematic-debugging
            description: Systematic debugging methodology
            version: 1.5.0
            author: Hermes Team
            license: Apache-2.0
            platforms: [linux, macos]
            tags: [debugging, testing, diagnostics]
            ---

            # Systematic Debugging

            Follow a structured approach to debugging.
        """)
    )

    # Skill 3: different category
    research_dir = tmp_path / "research" / "deep-research"
    research_dir.mkdir(parents=True)
    (research_dir / "SKILL.md").write_text(
        textwrap.dedent("""\
            ---
            name: deep-research
            description: Deep web research skill
            version: 1.0.0
            author: Research Team
            license: MIT
            tags: [research, web, analysis]
            ---

            # Deep Research

            Conduct thorough web research.
        """)
    )

    return tmp_path


@pytest.fixture
def registry(skills_dir: Path) -> SkillRegistry:
    """Create a registry pointed at the test skills directory."""
    return SkillRegistry(skills_dirs=[skills_dir])


# ---------------------------------------------------------------------------
# YAML Parser tests
# ---------------------------------------------------------------------------


class TestYamlParser:
    def test_parse_string_value(self):
        result = _parse_yaml_simple("name: hello")
        assert result["name"] == "hello"

    def test_parse_quoted_value(self):
        result = _parse_yaml_simple('name: "hello world"')
        assert result["name"] == "hello world"

    def test_parse_list(self):
        result = _parse_yaml_simple("platforms: [linux, macos, windows]")
        assert result["platforms"] == ["linux", "macos", "windows"]

    def test_parse_boolean(self):
        result = _parse_yaml_simple("enabled: true")
        assert result["enabled"] is True

    def test_parse_false(self):
        result = _parse_yaml_simple("disabled: false")
        assert result["disabled"] is False

    def test_parse_multiline(self):
        text = textwrap.dedent("""\
            name: test
            description: A test skill
            version: 1.0.0
        """)
        result = _parse_yaml_simple(text)
        assert result["name"] == "test"
        assert result["description"] == "A test skill"
        assert result["version"] == "1.0.0"


# ---------------------------------------------------------------------------
# SKILL.md Parser tests
# ---------------------------------------------------------------------------


class TestSkillParser:
    def test_parse_plan_skill(self, skills_dir: Path):
        manifest = parse_skill_manifest(
            skills_dir / "software-development" / "plan" / "SKILL.md"
        )
        assert manifest is not None
        assert manifest.name == "plan"
        assert manifest.version == "2.0.0"
        assert manifest.author == "Hermes"
        assert manifest.license == "MIT"
        assert manifest.platforms == ["linux", "macos", "windows"]

    def test_parse_debugging_skill(self, skills_dir: Path):
        manifest = parse_skill_manifest(
            skills_dir / "software-development" / "systematic-debugging" / "SKILL.md"
        )
        assert manifest is not None
        assert manifest.name == "systematic-debugging"
        assert manifest.version == "1.5.0"
        assert "debugging" in manifest.tags

    def test_parse_nonexistent_file(self):
        result = parse_skill_manifest(Path("/nonexistent/SKILL.md"))
        assert result is None

    def test_parse_no_frontmatter(self, tmp_path: Path):
        skill_md = tmp_path / "SKILL.md"
        skill_md.write_text("# Just a heading\n\nSome content.")
        result = parse_skill_manifest(skill_md)
        assert result is None

    def test_skill_id(self, skills_dir: Path):
        manifest = parse_skill_manifest(
            skills_dir / "software-development" / "plan" / "SKILL.md"
        )
        assert manifest is not None
        assert manifest.id == "plan"

    def test_skill_display_name(self, skills_dir: Path):
        manifest = parse_skill_manifest(
            skills_dir / "software-development" / "systematic-debugging" / "SKILL.md"
        )
        assert manifest is not None
        assert manifest.display_name == "Systematic Debugging"


# ---------------------------------------------------------------------------
# Registry tests
# ---------------------------------------------------------------------------


class TestSkillRegistry:
    def test_scan_finds_skills(self, registry: SkillRegistry):
        count = registry.scan(force=True)
        assert count == 3

    def test_list_all(self, registry: SkillRegistry):
        registry.scan(force=True)
        skills = registry.list_all()
        assert len(skills) == 3
        names = {s.name for s in skills}
        assert "plan" in names
        assert "systematic-debugging" in names
        assert "deep-research" in names

    def test_get_by_id(self, registry: SkillRegistry):
        registry.scan(force=True)
        skill = registry.get("plan")
        assert skill is not None
        assert skill.name == "plan"

    def test_get_nonexistent(self, registry: SkillRegistry):
        registry.scan(force=True)
        assert registry.get("nonexistent") is None

    def test_search_by_name(self, registry: SkillRegistry):
        registry.scan(force=True)
        results = registry.search(query="plan")
        assert len(results) >= 1
        assert any(s.name == "plan" for s in results)

    def test_search_by_description(self, registry: SkillRegistry):
        registry.scan(force=True)
        results = registry.search(query="debugging")
        assert len(results) >= 1
        assert any(s.name == "systematic-debugging" for s in results)

    def test_search_by_tag(self, registry: SkillRegistry):
        registry.scan(force=True)
        results = registry.search(tags=["research"])
        assert len(results) >= 1
        assert any(s.name == "deep-research" for s in results)

    def test_search_by_category(self, registry: SkillRegistry):
        registry.scan(force=True)
        results = registry.search(category="Software")
        assert len(results) >= 2
        names = {s.name for s in results}
        assert "plan" in names
        assert "systematic-debugging" in names

    def test_search_combined(self, registry: SkillRegistry):
        registry.scan(force=True)
        results = registry.search(query="plan", category="Software")
        assert len(results) >= 1
        assert results[0].name == "plan"

    def test_search_no_results(self, registry: SkillRegistry):
        registry.scan(force=True)
        results = registry.search(query="xyznonexistent")
        assert len(results) == 0

    def test_categories(self, registry: SkillRegistry):
        registry.scan(force=True)
        cats = registry.categories()
        assert "Software Development" in cats
        assert cats["Software Development"] == 2

    def test_all_tags(self, registry: SkillRegistry):
        registry.scan(force=True)
        tags = registry.all_tags()
        assert "planning" in tags
        assert "debugging" in tags
        assert "research" in tags

    def test_scan_caching(self, registry: SkillRegistry):
        registry.scan(force=True)
        assert len(registry._index) == 3
        # Second scan should use cache (unless force)
        count = registry.scan(force=False)
        assert count == 3

    def test_scan_force_refresh(self, registry: SkillRegistry):
        registry.scan(force=True)
        # Add another skill
        new_dir = registry._skills_dirs[0] / "productivity" / "new-skill"
        new_dir.mkdir(parents=True)
        (new_dir / "SKILL.md").write_text(
            textwrap.dedent("""\
                ---
                name: new-skill
                description: A new skill
                version: 1.0.0
                tags: [productivity]
                ---
                # New Skill
            """)
        )
        count = registry.scan(force=True)
        assert count == 4

    def test_to_index_dict(self, registry: SkillRegistry):
        registry.scan(force=True)
        d = registry.to_index_dict()
        assert "skills" in d
        assert "categories" in d
        assert "tags" in d
        assert "mcp_servers" in d
        assert d["skill_count"] == 3

    def test_limit(self, registry: SkillRegistry):
        registry.scan(force=True)
        results = registry.search(limit=2)
        assert len(results) <= 2


# ---------------------------------------------------------------------------
# MCP Server tests
# ---------------------------------------------------------------------------


class TestMcpServers:
    def test_known_servers_exist(self):
        assert len(KNOWN_MCP_SERVERS) > 0

    def test_list_mcp(self, registry: SkillRegistry):
        servers = registry.list_mcp_servers()
        assert len(servers) > 0

    def test_search_mcp(self, registry: SkillRegistry):
        results = registry.search_mcp(query="github")
        assert len(results) >= 1
        assert any("GitHub" in s.name for s in results)

    def test_search_mcp_no_query(self, registry: SkillRegistry):
        results = registry.search_mcp()
        assert len(results) == len(KNOWN_MCP_SERVERS)

    def test_mcp_to_dict(self):
        server = McpServer(name="test", description="A test server")
        d = server.to_dict()
        assert d["name"] == "test"
        assert d["description"] == "A test server"


# ---------------------------------------------------------------------------
# Singleton tests
# ---------------------------------------------------------------------------


class TestSingleton:
    def test_get_registry_returns_same_instance(self):
        r1 = get_registry()
        r2 = get_registry()
        assert r1 is r2


# ---------------------------------------------------------------------------
# Manifest serialization tests
# ---------------------------------------------------------------------------


class TestManifestSerialization:
    def test_to_dict(self, skills_dir: Path):
        manifest = parse_skill_manifest(
            skills_dir / "software-development" / "plan" / "SKILL.md"
        )
        assert manifest is not None
        d = manifest.to_dict()
        assert d["name"] == "plan"
        assert d["version"] == "2.0.0"
        assert isinstance(d["platforms"], list)
        assert isinstance(d["tags"], list)
