"""Hermes Skill Registry — scan, index, search, and install skills.

Parses SKILL.md frontmatter from installed skill directories, builds a
searchable index, and exposes install/update/remove operations that
delegate to the existing ``sanremes skills`` CLI.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class SkillManifest:
    """Parsed representation of a SKILL.md frontmatter block."""

    name: str
    description: str = ""
    version: str = "0.0.0"
    author: str = ""
    license: str = ""
    platforms: List[str] = field(default_factory=list)
    tags: List[str] = field(default_factory=list)
    related_skills: List[str] = field(default_factory=list)
    homepage: str = ""
    category: str = ""
    # Internal
    path: str = ""
    installed: bool = False
    install_time: Optional[float] = None
    checksum: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @property
    def id(self) -> str:
        return self.name.lower().replace(" ", "-")

    @property
    def display_name(self) -> str:
        return self.name.replace("-", " ").replace("_", " ").title()


@dataclass
class McpServer:
    """Metadata for a discoverable MCP server."""

    name: str
    description: str = ""
    package: str = ""
    command: str = ""
    args: List[str] = field(default_factory=list)
    env: Dict[str, str] = field(default_factory=dict)
    homepage: str = ""
    installed: bool = False
    version: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ---------------------------------------------------------------------------
# Well-known categories derived from the skills/ directory tree
# ---------------------------------------------------------------------------

_CATEGORY_MAP: Dict[str, str] = {
    "apple": "Apple Integration",
    "autonomous-ai-agents": "AI Agents",
    "creative": "Creative",
    "devops": "DevOps",
    "email": "Email & Comms",
    "github": "GitHub",
    "media": "Media",
    "mlops": "MLOps",
    "note-taking": "Note Taking",
    "productivity": "Productivity",
    "research": "Research",
    "smart-home": "Smart Home",
    "social-media": "Social Media",
    "software-development": "Software Development",
}

# Well-known MCP servers for discovery
KNOWN_MCP_SERVERS: List[McpServer] = [
    McpServer(
        name="GitHub MCP Server",
        description="GitHub repository and issue management via MCP",
        package="@modelcontextprotocol/server-github",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-github"],
        homepage="https://github.com/modelcontextprotocol/servers",
    ),
    McpServer(
        name="PostgreSQL MCP Server",
        description="PostgreSQL database access via MCP",
        package="@modelcontextprotocol/server-postgres",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-postgres"],
        homepage="https://github.com/modelcontextprotocol/servers",
    ),
    McpServer(
        name="Slack MCP Server",
        description="Slack workspace integration via MCP",
        package="@modelcontextprotocol/server-slack",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-slack"],
        homepage="https://github.com/modelcontextprotocol/servers",
    ),
    McpServer(
        name="Google Drive MCP Server",
        description="Google Drive file access via MCP",
        package="@modelcontextprotocol/server-gdrive",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-gdrive"],
        homepage="https://github.com/modelcontextprotocol/servers",
    ),
    McpServer(
        name="Filesystem MCP Server",
        description="Local filesystem access via MCP",
        package="@modelcontextprotocol/server-filesystem",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-filesystem"],
        homepage="https://github.com/modelcontextprotocol/servers",
    ),
    McpServer(
        name="Puppeteer MCP Server",
        description="Browser automation via Puppeteer",
        package="@modelcontextprotocol/server-puppeteer",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-puppeteer"],
        homepage="https://github.com/modelcontextprotocol/servers",
    ),
    McpServer(
        name="Fetch MCP Server",
        description="HTTP fetch for web scraping and API calls",
        package="@modelcontextprotocol/server-fetch",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-fetch"],
        homepage="https://github.com/modelcontextprotocol/servers",
    ),
    McpServer(
        name="SQLite MCP Server",
        description="SQLite database access via MCP",
        package="@modelcontextprotocol/server-sqlite",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-sqlite"],
        homepage="https://github.com/modelcontextprotocol/servers",
    ),
    McpServer(
        name="Notion MCP Server",
        description="Notion workspace integration via MCP",
        package="notion-mcp-server",
        command="npx",
        args=["-y", "notion-mcp-server"],
        homepage="https://github.com/makenotion/notion-mcp-server",
    ),
    McpServer(
        name="Sentry MCP Server",
        description="Sentry error tracking integration via MCP",
        package="@sentry/mcp-server",
        command="npx",
        args=["-y", "@sentry/mcp-server"],
        homepage="https://github.com/getsentry/sentry-mcp",
    ),
]

# ---------------------------------------------------------------------------
# SKILL.md parser
# ---------------------------------------------------------------------------

_FRONTMATTER_RE = re.compile(
    r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL
)


def _parse_yaml_simple(text: str) -> Dict[str, Any]:
    """Minimal YAML-ish parser for SKILL.md frontmatter.

    Handles: key: value, key: [list], key: "string", key: 'string'.
    No external dependency — good enough for SKILL.md headers.
    """
    result: Dict[str, Any] = {}
    for line in text.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        # Remove surrounding quotes
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            val = val[1:-1]
        # Parse lists [a, b, c]
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1]
            result[key] = [
                item.strip().strip('"').strip("'")
                for item in inner.split(",")
                if item.strip()
            ]
        elif val.lower() in ("true", "yes"):
            result[key] = True
        elif val.lower() in ("false", "no"):
            result[key] = False
        else:
            result[key] = val
    return result


def parse_skill_manifest(skill_md_path: Path) -> Optional[SkillManifest]:
    """Parse a SKILL.md file and return a SkillManifest."""
    try:
        content = skill_md_path.read_text(encoding="utf-8")
    except Exception as e:
        logger.warning("Cannot read %s: %s", skill_md_path, e)
        return None

    match = _FRONTMATTER_RE.match(content)
    if not match:
        return None

    raw = _parse_yaml_simple(match.group(1))

    # Extract nested sanremes metadata
    sanremes_meta: Dict[str, Any] = {}
    if "metadata" in raw and isinstance(raw["metadata"], dict):
        sanremes_meta = raw["metadata"]
    # Also handle multi-line YAML-like metadata blocks
    # Re-parse from the raw text for nested keys
    in_metadata = False
    for line in match.group(1).splitlines():
        stripped = line.strip()
        if stripped == "sanremes:" or stripped.startswith("sanremes:"):
            in_metadata = True
            continue
        if in_metadata:
            if line.startswith("  ") or line.startswith("\t"):
                subline = stripped
                if ":" in subline:
                    subkey, _, subval = subline.partition(":")
                    subkey = subkey.strip()
                    subval = subval.strip()
                    if subval.startswith("[") and subval.endswith("]"):
                        sanremes_meta[subkey] = [
                            s.strip().strip('"').strip("'")
                            for s in subval[1:-1].split(",")
                            if s.strip()
                        ]
                    else:
                        sanremes_meta[subkey] = subval
            else:
                in_metadata = False

    tags = raw.get("tags", [])
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    if not tags and "tags" in sanremes_meta:
        tags = sanremes_meta["tags"]
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]

    platforms = raw.get("platforms", [])
    if isinstance(platforms, str):
        platforms = [p.strip() for p in platforms.split(",") if p.strip()]

    related = raw.get("related_skills", [])
    if isinstance(related, str):
        related = [r.strip() for r in related.split(",") if r.strip()]

    category = ""
    skill_dir = skill_md_path.parent
    # Walk up to find category from the skills/ tree.
    # Try both the conventional 'skills/' parent and the first subdirectory.
    parts = skill_dir.parts
    for i, part in enumerate(parts):
        if part == "skills" and i + 1 < len(parts):
            category = _CATEGORY_MAP.get(parts[i + 1], parts[i + 1])
            break
    # Fallback: use the immediate parent directory name as category
    if not category:
        # skill_dir is e.g. .../software-development/plan
        # parent.name is 'plan', parent.parent.name is 'software-development'
        parent_name = skill_dir.parent.name
        if parent_name and parent_name not in ("skills", ".", ""):
            category = _CATEGORY_MAP.get(parent_name, parent_name)

    checksum = hashlib.md5(content.encode()).hexdigest()

    return SkillManifest(
        name=raw.get("name", skill_dir.name),
        description=raw.get("description", ""),
        version=raw.get("version", "0.0.0"),
        author=raw.get("author", ""),
        license=raw.get("license", ""),
        platforms=platforms,
        tags=tags,
        related_skills=related,
        homepage=sanremes_meta.get("homepage", raw.get("homepage", "")),
        category=category,
        path=str(skill_dir),
        installed=True,
        checksum=checksum,
    )


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

class SkillRegistry:
    """In-memory skill index with search, browse, and install operations."""

    def __init__(self, skills_dirs: Optional[List[Path]] = None):
        self._skills_dirs = skills_dirs or self._default_skill_dirs()
        self._index: Dict[str, SkillManifest] = {}
        self._mcp_servers: List[McpServer] = list(KNOWN_MCP_SERVERS)
        self._last_scan: float = 0
        self._scan_ttl: float = 300  # 5 min cache

    @staticmethod
    def _default_skill_dirs() -> List[Path]:
        dirs = []
        # Repo-bundled skills
        repo_skills = Path(__file__).resolve().parent.parent / "skills"
        if repo_skills.is_dir():
            dirs.append(repo_skills)
        # User-installed skills
        home = os.environ.get("SANREMES_HOME", Path.home() / ".sanremes")
        user_skills = Path(home) / "skills"
        if user_skills.is_dir():
            dirs.append(user_skills)
        return dirs

    # ----- Scan & index -----

    def scan(self, force: bool = False) -> int:
        """Scan all skill directories and rebuild the index.

        Returns the number of skills indexed.
        """
        now = time.time()
        if not force and (now - self._last_scan) < self._scan_ttl:
            return len(self._index)

        self._index.clear()
        count = 0
        for skills_dir in self._skills_dirs:
            for skill_md in skills_dir.rglob("SKILL.md"):
                manifest = parse_skill_manifest(skill_md)
                if manifest:
                    self._index[manifest.id] = manifest
                    count += 1
        self._last_scan = now
        logger.info("Scanned %d skills from %d dirs", count, len(self._skills_dirs))
        return count

    def _ensure_scanned(self) -> None:
        if not self._index:
            self.scan(force=True)

    # ----- Query -----

    def get(self, skill_id: str) -> Optional[SkillManifest]:
        self._ensure_scanned()
        return self._index.get(skill_id.lower())

    def list_all(self) -> List[SkillManifest]:
        self._ensure_scanned()
        return sorted(self._index.values(), key=lambda s: s.name.lower())

    def search(
        self,
        query: str = "",
        category: str = "",
        tags: Optional[List[str]] = None,
        limit: int = 50,
    ) -> List[SkillManifest]:
        """Search skills by text query, category, and/or tags."""
        self._ensure_scanned()
        results = list(self._index.values())

        if category:
            cat_lower = category.lower()
            results = [
                s for s in results if cat_lower in s.category.lower()
            ]

        if tags:
            tag_set = {t.lower() for t in tags}
            results = [
                s for s in results
                if tag_set & {t.lower() for t in s.tags}
            ]

        if query:
            q = query.lower()
            scored: List[tuple] = []
            for s in results:
                score = 0
                if q in s.name.lower():
                    score += 10
                if q in s.description.lower():
                    score += 5
                if any(q in t.lower() for t in s.tags):
                    score += 3
                if q in s.category.lower():
                    score += 2
                if q in s.author.lower():
                    score += 1
                if score > 0:
                    scored.append((score, s))
            scored.sort(key=lambda x: x[0], reverse=True)
            results = [s for _, s in scored[:limit]]
        else:
            results = results[:limit]

        return results

    def categories(self) -> Dict[str, int]:
        """Return category → count mapping."""
        self._ensure_scanned()
        cats: Dict[str, int] = {}
        for s in self._index.values():
            cat = s.category or "Uncategorized"
            cats[cat] = cats.get(cat, 0) + 1
        return dict(sorted(cats.items()))

    def all_tags(self) -> Dict[str, int]:
        """Return tag → count mapping."""
        self._ensure_scanned()
        tags: Dict[str, int] = {}
        for s in self._index.values():
            for t in s.tags:
                tags[t] = tags.get(t, 0) + 1
        return dict(sorted(tags.items(), key=lambda x: x[1], reverse=True))

    # ----- Install / remove (delegates to CLI) -----

    def install(
        self, identifier: str, profile: Optional[str] = None
    ) -> Dict[str, Any]:
        """Install a skill via ``sanremes skills install``."""
        cmd = ["sanremes", "skills", "install", identifier, "--yes"]
        if profile:
            cmd = ["sanremes", "--profile", profile, "skills", "install", identifier, "--yes"]
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=120
            )
            success = result.returncode == 0
            if success:
                self.scan(force=True)
            return {
                "ok": success,
                "identifier": identifier,
                "stdout": result.stdout[-2000:] if result.stdout else "",
                "stderr": result.stderr[-2000:] if result.stderr else "",
            }
        except FileNotFoundError:
            return {"ok": False, "error": "sanremes CLI not found"}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Install timed out (120s)"}

    def uninstall(
        self, skill_name: str, profile: Optional[str] = None
    ) -> Dict[str, Any]:
        """Uninstall a skill via ``sanremes skills remove``."""
        cmd = ["sanremes", "skills", "remove", skill_name, "--yes"]
        if profile:
            cmd = ["sanremes", "--profile", profile, "skills", "remove", skill_name, "--yes"]
        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=60
            )
            success = result.returncode == 0
            if success:
                self.scan(force=True)
            return {
                "ok": success,
                "name": skill_name,
                "stdout": result.stdout[-2000:] if result.stdout else "",
                "stderr": result.stderr[-2000:] if result.stderr else "",
            }
        except FileNotFoundError:
            return {"ok": False, "error": "sanremes CLI not found"}
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "Uninstall timed out (60s)"}

    # ----- MCP servers -----

    def list_mcp_servers(self) -> List[McpServer]:
        """Return the catalog of known MCP servers."""
        return list(self._mcp_servers)

    def search_mcp(self, query: str = "") -> List[McpServer]:
        """Search MCP servers by name/description."""
        if not query:
            return self._mcp_servers
        q = query.lower()
        return [
            s for s in self._mcp_servers
            if q in s.name.lower() or q in s.description.lower()
        ]

    # ----- Serialization -----

    def to_index_dict(self) -> Dict[str, Any]:
        """Export the full index as a JSON-serializable dict."""
        self._ensure_scanned()
        return {
            "skills": [s.to_dict() for s in self._index.values()],
            "categories": self.categories(),
            "tags": self.all_tags(),
            "mcp_servers": [s.to_dict() for s in self._mcp_servers],
            "last_scan": self._last_scan,
            "skill_count": len(self._index),
        }


# ---------------------------------------------------------------------------
# Singleton (for API layer)
# ---------------------------------------------------------------------------

_registry: Optional[SkillRegistry] = None


def get_registry(skills_dirs: Optional[List[Path]] = None) -> SkillRegistry:
    """Get or create the global skill registry singleton."""
    global _registry
    if _registry is None:
        _registry = SkillRegistry(skills_dirs)
    return _registry
