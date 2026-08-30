"""Hermes Marketplace API — browse, search, install skills and MCP servers.

Provides REST endpoints under ``/api/v1/marketplace/`` for the Mission
Control dashboard and any external client to discover, install, and
manage skills and MCP server integrations.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from hermes_cli.skill_registry import get_registry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/marketplace", tags=["marketplace"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class SkillInstallRequest(BaseModel):
    identifier: str = Field(..., description="Skill name or URL to install")
    profile: Optional[str] = Field(None, description="Profile to install into")


class SkillUninstallRequest(BaseModel):
    name: str = Field(..., description="Skill name to uninstall")
    profile: Optional[str] = Field(None, description="Profile scope")


class SkillResponse(BaseModel):
    name: str
    description: str = ""
    version: str = ""
    author: str = ""
    license: str = ""
    platforms: List[str] = Field(default_factory=list)
    tags: List[str] = Field(default_factory=list)
    related_skills: List[str] = Field(default_factory=list)
    homepage: str = ""
    category: str = ""
    path: str = ""
    installed: bool = False
    id: str = ""
    display_name: str = ""


class McpServerResponse(BaseModel):
    name: str
    description: str = ""
    package: str = ""
    command: str = ""
    args: List[str] = Field(default_factory=list)
    homepage: str = ""
    installed: bool = False
    version: str = ""


# ---------------------------------------------------------------------------
# Skills endpoints
# ---------------------------------------------------------------------------

@router.get("/skills")
async def list_skills(
    q: str = Query("", description="Search query"),
    category: str = Query("", description="Filter by category"),
    tags: Optional[str] = Query(None, description="Comma-separated tags"),
    limit: int = Query(50, ge=1, le=200),
) -> Dict[str, Any]:
    """Browse and search installed skills."""
    registry = get_registry()
    tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else None
    skills = registry.search(query=q, category=category, tags=tag_list, limit=limit)
    return {
        "skills": [_skill_to_dict(s) for s in skills],
        "total": len(skills),
        "categories": registry.categories(),
        "popular_tags": dict(list(registry.all_tags().items())[:30]),
    }


@router.get("/skills/categories")
async def list_categories() -> Dict[str, Any]:
    """List all skill categories with counts."""
    registry = get_registry()
    return {"categories": registry.categories()}


@router.get("/skills/tags")
async def list_tags() -> Dict[str, Any]:
    """List all skill tags with counts."""
    registry = get_registry()
    return {"tags": registry.all_tags()}


@router.get("/skills/{skill_id}")
async def get_skill(skill_id: str) -> Dict[str, Any]:
    """Get detailed info for a specific skill."""
    registry = get_registry()
    skill = registry.get(skill_id)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")
    result = _skill_to_dict(skill)
    # Read SKILL.md body for full description
    from pathlib import Path
    skill_md = Path(skill.path) / "SKILL.md"
    if skill_md.exists():
        try:
            content = skill_md.read_text(encoding="utf-8")
            # Everything after the frontmatter closing ---
            parts = content.split("---", 2)
            if len(parts) >= 3:
                result["body"] = parts[2].strip()[:5000]
        except Exception:
            pass
    return result


@router.post("/skills/install")
async def install_skill(body: SkillInstallRequest) -> Dict[str, Any]:
    """Install a skill from the hub or a URL."""
    registry = get_registry()
    result = registry.install(body.identifier, profile=body.profile)
    if not result.get("ok"):
        raise HTTPException(
            status_code=500,
            detail=result.get("stderr") or result.get("error", "Install failed"),
        )
    return {"ok": True, "identifier": body.identifier}


@router.post("/skills/uninstall")
async def uninstall_skill(body: SkillUninstallRequest) -> Dict[str, Any]:
    """Uninstall a skill."""
    registry = get_registry()
    result = registry.uninstall(body.name, profile=body.profile)
    if not result.get("ok"):
        raise HTTPException(
            status_code=500,
            detail=result.get("stderr") or result.get("error", "Uninstall failed"),
        )
    return {"ok": True, "name": body.name}


@router.post("/skills/refresh")
async def refresh_index() -> Dict[str, Any]:
    """Force a re-scan of all skill directories."""
    registry = get_registry()
    count = registry.scan(force=True)
    return {"ok": True, "indexed": count}


# ---------------------------------------------------------------------------
# MCP server endpoints
# ---------------------------------------------------------------------------

@router.get("/mcp")
async def list_mcp_servers(
    q: str = Query("", description="Search query"),
) -> List[Dict[str, Any]]:
    """List known MCP servers for discovery."""
    registry = get_registry()
    servers = registry.search_mcp(query=q)
    return [s.to_dict() for s in servers]


@router.get("/mcp/{server_name}")
async def get_mcp_server(server_name: str) -> Dict[str, Any]:
    """Get details for a specific MCP server."""
    registry = get_registry()
    for s in registry.list_mcp_servers():
        if server_name.lower() in s.name.lower().replace(" ", "-"):
            return s.to_dict()
    raise HTTPException(status_code=404, detail=f"MCP server '{server_name}' not found")


# ---------------------------------------------------------------------------
# Aggregate marketplace overview
# ---------------------------------------------------------------------------

@router.get("/overview")
async def marketplace_overview() -> Dict[str, Any]:
    """Get a high-level overview of the marketplace."""
    registry = get_registry()
    skills = registry.list_all()
    return {
        "total_skills": len(skills),
        "categories": registry.categories(),
        "popular_tags": dict(list(registry.all_tags().items())[:20]),
        "mcp_servers": len(registry.list_mcp_servers()),
        "recent_skills": [_skill_to_dict(s) for s in skills[-10:]],
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _skill_to_dict(skill) -> Dict[str, Any]:
    d = skill.to_dict()
    d["id"] = skill.id
    d["display_name"] = skill.display_name
    return d
