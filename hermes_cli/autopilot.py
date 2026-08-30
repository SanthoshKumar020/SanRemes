"""Hermes Autopilot — Mission model, state machine, and orchestrator.

A Mission is a high-level goal decomposed into subtasks executed by
coordinated agents. The orchestrator manages the full lifecycle:

    CREATED → PLANNING → EXECUTING → VERIFYING → COMPLETED

Failure/recovery:

    EXECUTING → FAILED → RECOVERING → EXECUTING
    EXECUTING → PAUSED → EXECUTING

Approval gates integrate with the Permission Engine (Phase 7) so that
high-risk actions (deploy, push, production access) require explicit
user approval before execution.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


# ── State machine ─────────────────────────────────────────────────────

class MissionState(str, Enum):
    CREATED = "created"
    PLANNING = "planning"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    PAUSED = "paused"
    CANCELLED = "cancelled"
    RECOVERING = "recovering"


class SubtaskState(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    AWAITING_APPROVAL = "awaiting_approval"


# Valid state transitions
_MISSION_TRANSITIONS: Dict[MissionState, set[MissionState]] = {
    MissionState.CREATED: {MissionState.PLANNING, MissionState.CANCELLED},
    MissionState.PLANNING: {MissionState.EXECUTING, MissionState.CANCELLED},
    MissionState.EXECUTING: {
        MissionState.VERIFYING,
        MissionState.FAILED,
        MissionState.PAUSED,
        MissionState.CANCELLED,
    },
    MissionState.VERIFYING: {
        MissionState.COMPLETED,
        MissionState.FAILED,
        MissionState.EXECUTING,  # back to fix issues
        MissionState.CANCELLED,
    },
    MissionState.FAILED: {MissionState.RECOVERING, MissionState.CANCELLED},
    MissionState.RECOVERING: {MissionState.EXECUTING, MissionState.CANCELLED},
    MissionState.PAUSED: {MissionState.EXECUTING, MissionState.CANCELLED},
    MissionState.COMPLETED: set(),
    MissionState.CANCELLED: set(),
}


class InvalidTransition(Exception):
    pass


# ── Data models ───────────────────────────────────────────────────────

@dataclass
class Subtask:
    """A single unit of work within a mission."""

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    title: str = ""
    description: str = ""
    state: SubtaskState = SubtaskState.PENDING
    agent_role: str = ""  # e.g. "coder", "researcher", "qa", "security"
    agent_id: Optional[str] = None
    # Dependencies: list of subtask IDs that must complete first
    depends_on: List[str] = field(default_factory=list)
    # Result
    result: Optional[str] = None
    error: Optional[str] = None
    # Timing
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    # Approval
    requires_approval: bool = False
    approval_id: Optional[str] = None
    # Retry
    retry_count: int = 0
    max_retries: int = 2
    # Context for the agent
    context: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["state"] = self.state.value
        return d

    @property
    def duration_seconds(self) -> Optional[float]:
        if self.started_at and self.completed_at:
            return self.completed_at - self.started_at
        if self.started_at:
            return time.time() - self.started_at
        return None


@dataclass
class MissionEvent:
    """An event in the mission timeline."""

    timestamp: float = field(default_factory=time.time)
    event_type: str = ""  # state_change, subtask_started, subtask_completed, etc.
    message: str = ""
    data: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Mission:
    """A high-level goal decomposed into subtasks executed by agents."""

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    title: str = ""
    description: str = ""
    goal: str = ""  # The original user goal
    state: MissionState = MissionState.CREATED
    priority: str = "normal"  # low, normal, high, urgent
    # Subtasks
    subtasks: List[Subtask] = field(default_factory=list)
    # Autonomy level
    autonomy_level: str = "agent"  # assist, agent, autonomous, mission
    # Timeline
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    # Events log
    events: List[MissionEvent] = field(default_factory=list)
    # Metadata
    tags: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    # Cost tracking
    total_tokens: int = 0
    total_cost_usd: float = 0.0
    # Error
    error: Optional[str] = None
    # Approval pending count
    pending_approvals: int = 0

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["state"] = self.state.value
        d["subtasks"] = [s.to_dict() for s in self.subtasks]
        d["events"] = [e.to_dict() for e in self.events[-50:]]  # last 50
        return d

    def transition(self, new_state: MissionState) -> None:
        """Transition to a new state, raising InvalidTransition if not allowed."""
        allowed = _MISSION_TRANSITIONS.get(self.state, set())
        if new_state not in allowed:
            raise InvalidTransition(
                f"Cannot transition from {self.state.value} to {new_state.value}. "
                f"Allowed: {[s.value for s in allowed]}"
            )
        old = self.state
        self.state = new_state
        self._add_event(
            "state_change",
            f"Mission {old.value} → {new_state.value}",
        )
        if new_state == MissionState.EXECUTING and not self.started_at:
            self.started_at = time.time()
        if new_state in (MissionState.COMPLETED, MissionState.FAILED, MissionState.CANCELLED):
            self.completed_at = time.time()

    @property
    def progress_percent(self) -> float:
        if not self.subtasks:
            return 0.0
        done = sum(
            1
            for s in self.subtasks
            if s.state in (SubtaskState.COMPLETED, SubtaskState.SKIPPED)
        )
        return round(100 * done / len(self.subtasks), 1)

    @property
    def duration_seconds(self) -> Optional[float]:
        if self.started_at and self.completed_at:
            return self.completed_at - self.started_at
        if self.started_at:
            return time.time() - self.started_at
        return None

    def ready_subtasks(self) -> List[Subtask]:
        """Return subtasks that are pending and whose dependencies are met."""
        completed_ids = {
            s.id for s in self.subtasks if s.state == SubtaskState.COMPLETED
        }
        skipped_ids = {
            s.id for s in self.subtasks if s.state == SubtaskState.SKIPPED
        }
        done = completed_ids | skipped_ids
        return [
            s
            for s in self.subtasks
            if s.state == SubtaskState.PENDING
            and all(dep in done for dep in s.depends_on)
        ]

    def _add_event(self, event_type: str, message: str, data: Optional[Dict] = None):
        self.events.append(MissionEvent(
            event_type=event_type,
            message=message,
            data=data or {},
        ))

    # ----- Serialization -----

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "Mission":
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Mission":
        subtasks = [
            Subtask(
                id=s.get("id", ""),
                title=s.get("title", ""),
                description=s.get("description", ""),
                state=SubtaskState(s.get("state", "pending")),
                agent_role=s.get("agent_role", ""),
                agent_id=s.get("agent_id"),
                depends_on=s.get("depends_on", []),
                result=s.get("result"),
                error=s.get("error"),
                created_at=s.get("created_at", 0),
                started_at=s.get("started_at"),
                completed_at=s.get("completed_at"),
                requires_approval=s.get("requires_approval", False),
                approval_id=s.get("approval_id"),
                retry_count=s.get("retry_count", 0),
                max_retries=s.get("max_retries", 2),
                context=s.get("context", {}),
            )
            for s in data.get("subtasks", [])
        ]
        events = [
            MissionEvent(
                timestamp=e.get("timestamp", 0),
                event_type=e.get("event_type", ""),
                message=e.get("message", ""),
                data=e.get("data", {}),
            )
            for e in data.get("events", [])
        ]
        return cls(
            id=data.get("id", uuid.uuid4().hex[:12]),
            title=data.get("title", ""),
            description=data.get("description", ""),
            goal=data.get("goal", ""),
            state=MissionState(data.get("state", "created")),
            priority=data.get("priority", "normal"),
            subtasks=subtasks,
            autonomy_level=data.get("autonomy_level", "agent"),
            created_at=data.get("created_at", 0),
            started_at=data.get("started_at"),
            completed_at=data.get("completed_at"),
            events=events,
            tags=data.get("tags", []),
            metadata=data.get("metadata", {}),
            total_tokens=data.get("total_tokens", 0),
            total_cost_usd=data.get("total_cost_usd", 0.0),
            error=data.get("error"),
            pending_approvals=data.get("pending_approvals", 0),
        )


# ── Mission Store ─────────────────────────────────────────────────────

class MissionStore:
    """Persistent storage for missions (JSON files in ~/.sanremes/missions/)."""

    def __init__(self, base_dir: Optional[Path] = None):
        import os
        from sanremes_constants import get_sanremes_home
        home = get_sanremes_home() if base_dir is None else base_dir
        self._dir = Path(home) / "missions"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._cache: Dict[str, Mission] = {}

    def save(self, mission: Mission) -> None:
        mission.save(self._dir / f"{mission.id}.json")
        self._cache[mission.id] = mission

    def get(self, mission_id: str) -> Optional[Mission]:
        if mission_id in self._cache:
            return self._cache[mission_id]
        path = self._dir / f"{mission_id}.json"
        if path.exists():
            m = Mission.load(path)
            self._cache[m.id] = m
            return m
        return None

    def list_all(
        self,
        state: Optional[MissionState] = None,
        limit: int = 50,
    ) -> List[Mission]:
        missions = []
        for p in sorted(self._dir.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True):
            try:
                m = Mission.load(p)
                self._cache[m.id] = m
                if state is None or m.state == state:
                    missions.append(m)
                    if len(missions) >= limit:
                        break
            except Exception as e:
                logger.warning("Failed to load mission %s: %s", p, e)
        return missions

    def delete(self, mission_id: str) -> bool:
        path = self._dir / f"{mission_id}.json"
        if path.exists():
            path.unlink()
            self._cache.pop(mission_id, None)
            return True
        return False


# ── Mission Orchestrator ──────────────────────────────────────────────

class MissionOrchestrator:
    """Coordinates multi-agent execution of a mission.

    The orchestrator:
    1. Takes a Mission with subtasks
    2. Determines which subtasks are ready (dependencies met)
    3. Delegates each to the appropriate agent role
    4. Monitors completion and advances the mission
    5. Handles failures, retries, and approval gates
    """

    def __init__(
        self,
        store: Optional[MissionStore] = None,
        permission_engine: Any = None,
    ):
        self._store = store or MissionStore()
        self._permission_engine = permission_engine
        self._active_agents: Dict[str, str] = {}  # subtask_id → agent_id

    @property
    def store(self) -> MissionStore:
        return self._store

    def create_mission(
        self,
        goal: str,
        title: str = "",
        subtasks: Optional[List[Dict[str, Any]]] = None,
        autonomy_level: str = "agent",
        priority: str = "normal",
        tags: Optional[List[str]] = None,
    ) -> Mission:
        """Create a new mission from a goal description."""
        mission = Mission(
            title=title or goal[:80],
            description=goal,
            goal=goal,
            autonomy_level=autonomy_level,
            priority=priority,
            tags=tags or [],
        )
        if subtasks:
            for st in subtasks:
                mission.subtasks.append(Subtask(
                    title=st.get("title", ""),
                    description=st.get("description", ""),
                    agent_role=st.get("agent_role", "coder"),
                    depends_on=st.get("depends_on", []),
                    requires_approval=st.get("requires_approval", False),
                    context=st.get("context", {}),
                ))

        mission.transition(MissionState.PLANNING)
        self._store.save(mission)
        logger.info("Created mission %s: %s", mission.id, mission.title)
        return mission

    def start_mission(self, mission_id: str) -> Mission:
        """Transition a mission from PLANNING to EXECUTING."""
        mission = self._store.get(mission_id)
        if not mission:
            raise ValueError(f"Mission {mission_id} not found")
        mission.transition(MissionState.EXECUTING)
        self._store.save(mission)
        return mission

    def get_mission(self, mission_id: str) -> Optional[Mission]:
        return self._store.get(mission_id)

    def list_missions(
        self,
        state: Optional[str] = None,
        limit: int = 50,
    ) -> List[Mission]:
        s = MissionState(state) if state else None
        return self._store.list_all(state=s, limit=limit)

    def advance_mission(self, mission_id: str) -> Mission:
        """Check all subtasks and advance the mission state if appropriate.

        This is called after a subtask completes to see if the mission
        should move to VERIFYING, COMPLETED, or keep EXECUTING.
        """
        mission = self._store.get(mission_id)
        if not mission:
            raise ValueError(f"Mission {mission_id} not found")

        if mission.state != MissionState.EXECUTING:
            return mission

        # Check for failed subtasks
        failed = [s for s in mission.subtasks if s.state == SubtaskState.FAILED]
        if failed:
            # Check if retries are exhausted
            unrecoverable = [
                s for s in failed if s.retry_count >= s.max_retries
            ]
            if unrecoverable:
                mission.error = f"Subtask(s) failed: {', '.join(s.title for s in unrecoverable)}"
                mission.transition(MissionState.FAILED)
                self._store.save(mission)
                return mission
            else:
                # Retry failed subtasks
                for s in failed:
                    if s.retry_count < s.max_retries:
                        s.retry_count += 1
                        s.state = SubtaskState.PENDING
                        s.error = None
                        mission._add_event(
                            "subtask_retry",
                            f"Retrying subtask '{s.title}' (attempt {s.retry_count})",
                            {"subtask_id": s.id},
                        )
                self._store.save(mission)
                return mission

        # Check if all subtasks are done
        all_done = all(
            s.state
            in (SubtaskState.COMPLETED, SubtaskState.SKIPPED)
            for s in mission.subtasks
        )
        if all_done and mission.subtasks:
            mission.transition(MissionState.VERIFYING)
            # Auto-complete if no verification needed
            mission.transition(MissionState.COMPLETED)
            self._store.save(mission)
            return mission

        # Check for pending approvals blocking progress
        awaiting = [
            s for s in mission.subtasks if s.state == SubtaskState.AWAITING_APPROVAL
        ]
        mission.pending_approvals = len(awaiting)

        self._store.save(mission)
        return mission

    def complete_subtask(
        self,
        mission_id: str,
        subtask_id: str,
        result: str = "",
        error: Optional[str] = None,
    ) -> Mission:
        """Mark a subtask as completed or failed, then advance the mission."""
        mission = self._store.get(mission_id)
        if not mission:
            raise ValueError(f"Mission {mission_id} not found")

        subtask = next(
            (s for s in mission.subtasks if s.id == subtask_id), None
        )
        if not subtask:
            raise ValueError(f"Subtask {subtask_id} not found in mission {mission_id}")

        if error:
            subtask.state = SubtaskState.FAILED
            subtask.error = error
            mission._add_event(
                "subtask_failed",
                f"Subtask '{subtask.title}' failed: {error}",
                {"subtask_id": subtask_id},
            )
        else:
            subtask.state = SubtaskState.COMPLETED
            subtask.result = result
            subtask.completed_at = time.time()
            mission._add_event(
                "subtask_completed",
                f"Subtask '{subtask.title}' completed",
                {"subtask_id": subtask_id},
            )

        self._store.save(mission)
        return self.advance_mission(mission_id)

    def pause_mission(self, mission_id: str) -> Mission:
        mission = self._store.get(mission_id)
        if not mission:
            raise ValueError(f"Mission {mission_id} not found")
        mission.transition(MissionState.PAUSED)
        self._store.save(mission)
        return mission

    def resume_mission(self, mission_id: str) -> Mission:
        mission = self._store.get(mission_id)
        if not mission:
            raise ValueError(f"Mission {mission_id} not found")
        mission.transition(MissionState.EXECUTING)
        self._store.save(mission)
        return mission

    def cancel_mission(self, mission_id: str) -> Mission:
        mission = self._store.get(mission_id)
        if not mission:
            raise ValueError(f"Mission {mission_id} not found")
        mission.transition(MissionState.CANCELLED)
        self._store.save(mission)
        return mission

    def delete_mission(self, mission_id: str) -> bool:
        return self._store.delete(mission_id)

    # ----- Decomposition helper -----

    def decompose_goal(self, goal: str) -> List[Dict[str, Any]]:
        """Simple heuristic decomposition of a goal into subtasks.

        In production this would call the LLM planner. For now we provide
        a deterministic template that the planner step can override.
        """
        # This is a placeholder — the real decomposition happens via
        # the LLM planner in the agent runtime.
        return [
            {
                "title": "Understand the goal",
                "description": f"Analyze requirements for: {goal}",
                "agent_role": "researcher",
            },
            {
                "title": "Plan the approach",
                "description": "Create an implementation plan",
                "agent_role": "architect",
                "depends_on": ["0"],  # depends on first subtask
            },
            {
                "title": "Implement",
                "description": "Execute the implementation plan",
                "agent_role": "coder",
                "depends_on": ["1"],
            },
            {
                "title": "Test and verify",
                "description": "Run tests and verify the implementation",
                "agent_role": "qa",
                "depends_on": ["2"],
            },
            {
                "title": "Review",
                "description": "Final review and documentation",
                "agent_role": "reviewer",
                "depends_on": ["3"],
            },
        ]
