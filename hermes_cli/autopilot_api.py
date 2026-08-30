"""Hermes Autopilot API — mission lifecycle management.

REST endpoints under ``/api/v1/missions/`` for creating, managing,
and monitoring autonomous missions via the Autopilot orchestrator.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from hermes_cli.autopilot import (
    MissionOrchestrator,
    MissionState,
    MissionStore,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/missions", tags=["missions"])


# ── Request / response models ─────────────────────────────────────────

class CreateMissionRequest(BaseModel):
    goal: str = Field(..., description="The high-level goal to accomplish")
    title: Optional[str] = Field(None, description="Short mission title")
    subtasks: Optional[List[Dict[str, Any]]] = Field(
        None, description="Pre-defined subtasks (optional)"
    )
    autonomy_level: str = Field(
        "agent",
        description="Assist, agent, autonomous, or mission",
    )
    priority: str = Field("normal", description="low, normal, high, urgent")
    tags: Optional[List[str]] = Field(None, description="Tags for the mission")


class SubtaskResultRequest(BaseModel):
    result: str = Field("", description="Result text on success")
    error: Optional[str] = Field(None, description="Error message on failure")


class DecomposeRequest(BaseModel):
    goal: str = Field(..., description="Goal to decompose into subtasks")


# ── Orchestrator singleton ────────────────────────────────────────────

_orchestrator: Optional[MissionOrchestrator] = None


def get_orchestrator() -> MissionOrchestrator:
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = MissionOrchestrator()
    return _orchestrator


# ── Endpoints ─────────────────────────────────────────────────────────

@router.get("")
async def list_missions(
    state: Optional[str] = Query(None, description="Filter by state"),
    limit: int = Query(50, ge=1, le=200),
) -> Dict[str, Any]:
    """List all missions with optional state filter."""
    orch = get_orchestrator()
    missions = orch.list_missions(state=state, limit=limit)
    return {
        "missions": [m.to_dict() for m in missions],
        "total": len(missions),
    }


@router.post("")
async def create_mission(body: CreateMissionRequest) -> Dict[str, Any]:
    """Create a new mission from a goal."""
    orch = get_orchestrator()
    mission = orch.create_mission(
        goal=body.goal,
        title=body.title or "",
        subtasks=body.subtasks,
        autonomy_level=body.autonomy_level,
        priority=body.priority,
        tags=body.tags,
    )
    return mission.to_dict()


@router.get("/stats")
async def mission_stats() -> Dict[str, Any]:
    """Get aggregate mission statistics."""
    orch = get_orchestrator()
    all_missions = orch.list_missions(limit=200)
    state_counts: Dict[str, int] = {}
    for m in all_missions:
        s = m.state.value
        state_counts[s] = state_counts.get(s, 0) + 1
    return {
        "total": len(all_missions),
        "by_state": state_counts,
        "active": state_counts.get("executing", 0),
        "pending_approval": state_counts.get("paused", 0),
    }


@router.get("/{mission_id}")
async def get_mission(mission_id: str) -> Dict[str, Any]:
    """Get mission details including subtasks and events."""
    orch = get_orchestrator()
    mission = orch.get_mission(mission_id)
    if not mission:
        raise HTTPException(status_code=404, detail=f"Mission {mission_id} not found")
    return mission.to_dict()


@router.post("/{mission_id}/start")
async def start_mission(mission_id: str) -> Dict[str, Any]:
    """Transition a mission from PLANNING to EXECUTING."""
    orch = get_orchestrator()
    try:
        mission = orch.start_mission(mission_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return mission.to_dict()


@router.post("/{mission_id}/pause")
async def pause_mission(mission_id: str) -> Dict[str, Any]:
    """Pause a running mission."""
    orch = get_orchestrator()
    try:
        mission = orch.pause_mission(mission_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return mission.to_dict()


@router.post("/{mission_id}/resume")
async def resume_mission(mission_id: str) -> Dict[str, Any]:
    """Resume a paused mission."""
    orch = get_orchestrator()
    try:
        mission = orch.resume_mission(mission_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return mission.to_dict()


@router.post("/{mission_id}/cancel")
async def cancel_mission(mission_id: str) -> Dict[str, Any]:
    """Cancel a mission."""
    orch = get_orchestrator()
    try:
        mission = orch.cancel_mission(mission_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return mission.to_dict()


@router.delete("/{mission_id}")
async def delete_mission(mission_id: str) -> Dict[str, Any]:
    """Delete a mission."""
    orch = get_orchestrator()
    deleted = orch.delete_mission(mission_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Mission {mission_id} not found")
    return {"ok": True, "id": mission_id}


@router.post("/{mission_id}/advance")
async def advance_mission(mission_id: str) -> Dict[str, Any]:
    """Check subtask states and advance the mission if appropriate."""
    orch = get_orchestrator()
    try:
        mission = orch.advance_mission(mission_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return mission.to_dict()


@router.post("/{mission_id}/subtasks/{subtask_id}/complete")
async def complete_subtask(
    mission_id: str,
    subtask_id: str,
    body: SubtaskResultRequest,
) -> Dict[str, Any]:
    """Mark a subtask as completed or failed."""
    orch = get_orchestrator()
    try:
        mission = orch.complete_subtask(
            mission_id,
            subtask_id,
            result=body.result,
            error=body.error,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return mission.to_dict()


@router.post("/decompose")
async def decompose_goal(body: DecomposeRequest) -> Dict[str, Any]:
    """Decompose a goal into suggested subtasks."""
    orch = get_orchestrator()
    subtasks = orch.decompose_goal(body.goal)
    return {"subtasks": subtasks, "count": len(subtasks)}
