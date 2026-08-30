"""Tests for the Hermes Autopilot — Mission model, state machine, orchestrator."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

# Stub sanremes_cli / sanremes_constants for test isolation
_stub = types.ModuleType("sanremes_cli")
_stub.__path__ = []
sys.modules.setdefault("sanremes_cli", _stub)

_stub2 = types.ModuleType("sanremes_constants")
_stub2.get_sanremes_home = lambda: Path("/tmp/_hermes_test")
sys.modules.setdefault("sanremes_constants", _stub2)

sys.path.insert(0, ".")

import pytest
from hermes_cli.autopilot import (
    InvalidTransition,
    Mission,
    MissionEvent,
    MissionOrchestrator,
    MissionState,
    MissionStore,
    Subtask,
    SubtaskState,
)


# ── Fixtures ──────────────────────────────────────────────────────────


@pytest.fixture
def store(tmp_path: Path) -> MissionStore:
    return MissionStore(base_dir=tmp_path)


@pytest.fixture
def orchestrator(store: MissionStore) -> MissionOrchestrator:
    return MissionOrchestrator(store=store)


@pytest.fixture
def mission() -> Mission:
    return Mission(
        title="Test Mission",
        goal="Build a feature",
        subtasks=[
            Subtask(title="Plan", agent_role="architect"),
            Subtask(title="Implement", agent_role="coder", depends_on=[]),
            Subtask(title="Test", agent_role="qa", depends_on=[]),
        ],
    )


# ── State machine tests ──────────────────────────────────────────────


class TestMissionState:
    def test_initial_state(self, mission: Mission):
        assert mission.state == MissionState.CREATED

    def test_created_to_planning(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        assert mission.state == MissionState.PLANNING

    def test_planning_to_executing(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        mission.transition(MissionState.EXECUTING)
        assert mission.state == MissionState.EXECUTING

    def test_executing_to_completed(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        mission.transition(MissionState.EXECUTING)
        mission.transition(MissionState.VERIFYING)
        mission.transition(MissionState.COMPLETED)
        assert mission.state == MissionState.COMPLETED

    def test_executing_to_failed(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        mission.transition(MissionState.EXECUTING)
        mission.transition(MissionState.FAILED)
        assert mission.state == MissionState.FAILED

    def test_failed_to_recovering(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        mission.transition(MissionState.EXECUTING)
        mission.transition(MissionState.FAILED)
        mission.transition(MissionState.RECOVERING)
        assert mission.state == MissionState.RECOVERING

    def test_recovering_to_executing(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        mission.transition(MissionState.EXECUTING)
        mission.transition(MissionState.FAILED)
        mission.transition(MissionState.RECOVERING)
        mission.transition(MissionState.EXECUTING)
        assert mission.state == MissionState.EXECUTING

    def test_executing_to_paused(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        mission.transition(MissionState.EXECUTING)
        mission.transition(MissionState.PAUSED)
        assert mission.state == MissionState.PAUSED

    def test_paused_to_executing(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        mission.transition(MissionState.EXECUTING)
        mission.transition(MissionState.PAUSED)
        mission.transition(MissionState.EXECUTING)
        assert mission.state == MissionState.EXECUTING

    def test_cancel_from_any_active(self, mission: Mission):
        for state in [
            MissionState.CREATED,
            MissionState.PLANNING,
            MissionState.EXECUTING,
            MissionState.VERIFYING,
            MissionState.FAILED,
            MissionState.PAUSED,
        ]:
            m = Mission(title="test", goal="test")
            # Fast-forward to the target state
            if state == MissionState.PLANNING:
                m.transition(MissionState.PLANNING)
            elif state == MissionState.EXECUTING:
                m.transition(MissionState.PLANNING)
                m.transition(MissionState.EXECUTING)
            elif state == MissionState.VERIFYING:
                m.transition(MissionState.PLANNING)
                m.transition(MissionState.EXECUTING)
                m.transition(MissionState.VERIFYING)
            elif state == MissionState.FAILED:
                m.transition(MissionState.PLANNING)
                m.transition(MissionState.EXECUTING)
                m.transition(MissionState.FAILED)
            elif state == MissionState.PAUSED:
                m.transition(MissionState.PLANNING)
                m.transition(MissionState.EXECUTING)
                m.transition(MissionState.PAUSED)

            assert m.state == state
            m.transition(MissionState.CANCELLED)
            assert m.state == MissionState.CANCELLED

    def test_invalid_transition(self, mission: Mission):
        with pytest.raises(InvalidTransition):
            mission.transition(MissionState.EXECUTING)  # CREATED → EXECUTING

    def test_completed_no_transitions(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        mission.transition(MissionState.EXECUTING)
        mission.transition(MissionState.VERIFYING)
        mission.transition(MissionState.COMPLETED)
        with pytest.raises(InvalidTransition):
            mission.transition(MissionState.EXECUTING)

    def test_event_logged(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        assert len(mission.events) >= 1
        assert mission.events[-1].event_type == "state_change"
        assert "PLANNING" in mission.events[-1].message

    def test_started_at_set(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        mission.transition(MissionState.EXECUTING)
        assert mission.started_at is not None

    def test_completed_at_set(self, mission: Mission):
        mission.transition(MissionState.PLANNING)
        mission.transition(MissionState.EXECUTING)
        mission.transition(MissionState.VERIFYING)
        mission.transition(MissionState.COMPLETED)
        assert mission.completed_at is not None


# ── Progress tests ────────────────────────────────────────────────────


class TestProgress:
    def test_no_subtasks(self, mission: Mission):
        mission.subtasks = []
        assert mission.progress_percent == 0.0

    def test_all_pending(self, mission: Mission):
        assert mission.progress_percent == 0.0

    def test_one_completed(self, mission: Mission):
        mission.subtasks[0].state = SubtaskState.COMPLETED
        assert abs(mission.progress_percent - 33.3) < 0.1

    def test_all_completed(self, mission: Mission):
        for s in mission.subtasks:
            s.state = SubtaskState.COMPLETED
        assert mission.progress_percent == 100.0


# ── Ready subtasks ────────────────────────────────────────────────────


class TestReadySubtasks:
    def test_all_ready_when_no_deps(self, mission: Mission):
        ready = mission.ready_subtasks()
        assert len(ready) == 3

    def test_respects_dependencies(self, mission: Mission):
        # Implement depends on Plan
        mission.subtasks[1].depends_on = [mission.subtasks[0].id]
        ready = mission.ready_subtasks()
        titles = {s.title for s in ready}
        assert "Plan" in titles
        assert "Test" in titles
        assert "Implement" not in titles

    def test_dep_completed_unblocks(self, mission: Mission):
        mission.subtasks[1].depends_on = [mission.subtasks[0].id]
        mission.subtasks[0].state = SubtaskState.COMPLETED
        ready = mission.ready_subtasks()
        titles = {s.title for s in ready}
        assert "Implement" in titles


# ── Serialization ─────────────────────────────────────────────────────


class TestSerialization:
    def test_to_dict(self, mission: Mission):
        d = mission.to_dict()
        assert d["title"] == "Test Mission"
        assert d["state"] == "created"
        assert len(d["subtasks"]) == 3
        assert d["subtasks"][0]["state"] == "pending"

    def test_from_dict(self, mission: Mission):
        d = mission.to_dict()
        m2 = Mission.from_dict(d)
        assert m2.title == mission.title
        assert m2.goal == mission.goal
        assert m2.state == mission.state
        assert len(m2.subtasks) == 3

    def test_save_load(self, mission: Mission, tmp_path: Path):
        path = tmp_path / "test_mission.json"
        mission.save(path)
        loaded = Mission.load(path)
        assert loaded.title == mission.title
        assert loaded.state == mission.state
        assert len(loaded.subtasks) == 3


# ── Orchestrator tests ────────────────────────────────────────────────


class TestOrchestrator:
    def test_create_mission(self, orchestrator: MissionOrchestrator):
        m = orchestrator.create_mission(
            goal="Build auth",
            title="Auth System",
            subtasks=[
                {"title": "Plan", "agent_role": "architect"},
                {"title": "Implement", "agent_role": "coder"},
            ],
        )
        assert m.state == MissionState.PLANNING
        assert m.title == "Auth System"
        assert len(m.subtasks) == 2

    def test_get_mission(self, orchestrator: MissionOrchestrator):
        m = orchestrator.create_mission(goal="Test")
        found = orchestrator.get_mission(m.id)
        assert found is not None
        assert found.id == m.id

    def test_get_nonexistent(self, orchestrator: MissionOrchestrator):
        assert orchestrator.get_mission("nonexistent") is None

    def test_start_mission(self, orchestrator: MissionOrchestrator):
        m = orchestrator.create_mission(goal="Test")
        m2 = orchestrator.start_mission(m.id)
        assert m2.state == MissionState.EXECUTING

    def test_list_missions(self, orchestrator: MissionOrchestrator):
        orchestrator.create_mission(goal="M1")
        orchestrator.create_mission(goal="M2")
        missions = orchestrator.list_missions()
        assert len(missions) == 2

    def test_list_filter_state(self, orchestrator: MissionOrchestrator):
        m1 = orchestrator.create_mission(goal="M1")
        orchestrator.create_mission(goal="M2")
        orchestrator.start_mission(m1.id)
        planning = orchestrator.list_missions(state="planning")
        assert len(planning) == 1
        executing = orchestrator.list_missions(state="executing")
        assert len(executing) == 1

    def test_complete_subtask(self, orchestrator: MissionOrchestrator):
        m = orchestrator.create_mission(
            goal="Test",
            subtasks=[
                {"title": "Step 1", "agent_role": "coder"},
                {"title": "Step 2", "agent_role": "coder"},
            ],
        )
        m = orchestrator.start_mission(m.id)
        m = orchestrator.complete_subtask(m.id, m.subtasks[0].id, result="Done")
        assert m.subtasks[0].state == SubtaskState.COMPLETED
        assert m.subtasks[0].result == "Done"

    def test_fail_subtask(self, orchestrator: MissionOrchestrator):
        m = orchestrator.create_mission(
            goal="Test",
            subtasks=[{"title": "Step 1", "agent_role": "coder"}],
        )
        m = orchestrator.start_mission(m.id)
        m = orchestrator.complete_subtask(
            m.id, m.subtasks[0].id, error="It broke"
        )
        assert m.subtasks[0].state == SubtaskState.FAILED
        assert m.subtasks[0].error == "It broke"

    def test_pause_resume(self, orchestrator: MissionOrchestrator):
        m = orchestrator.create_mission(goal="Test")
        m = orchestrator.start_mission(m.id)
        m = orchestrator.pause_mission(m.id)
        assert m.state == MissionState.PAUSED
        m = orchestrator.resume_mission(m.id)
        assert m.state == MissionState.EXECUTING

    def test_cancel(self, orchestrator: MissionOrchestrator):
        m = orchestrator.create_mission(goal="Test")
        m = orchestrator.cancel_mission(m.id)
        assert m.state == MissionState.CANCELLED

    def test_delete(self, orchestrator: MissionOrchestrator):
        m = orchestrator.create_mission(goal="Test")
        m2 = orchestrator.create_mission(goal="Keep")
        assert orchestrator.delete_mission(m.id) is True
        assert orchestrator.get_mission(m.id) is None
        assert orchestrator.get_mission(m2.id) is not None

    def test_auto_complete(self, orchestrator: MissionOrchestrator):
        m = orchestrator.create_mission(
            goal="Quick task",
            subtasks=[{"title": "Only step", "agent_role": "coder"}],
        )
        m = orchestrator.start_mission(m.id)
        m = orchestrator.complete_subtask(m.id, m.subtasks[0].id, result="Done")
        assert m.state == MissionState.COMPLETED

    def test_decompose_goal(self, orchestrator: MissionOrchestrator):
        subtasks = orchestrator.decompose_goal("Build a web app")
        assert len(subtasks) > 0
        assert all("title" in s for s in subtasks)
        assert all("agent_role" in s for s in subtasks)


# ── Subtask model tests ──────────────────────────────────────────────


class TestSubtask:
    def test_to_dict(self):
        st = Subtask(title="Test", agent_role="coder")
        d = st.to_dict()
        assert d["title"] == "Test"
        assert d["state"] == "pending"
        assert d["agent_role"] == "coder"

    def test_duration(self):
        import time
        st = Subtask(title="Test")
        st.started_at = time.time() - 10
        st.completed_at = time.time()
        assert st.duration_seconds is not None
        assert st.duration_seconds >= 9.9

    def test_duration_running(self):
        import time
        st = Subtask(title="Test")
        st.started_at = time.time() - 5
        dur = st.duration_seconds
        assert dur is not None
        assert dur >= 4.9


# ── API route tests ──────────────────────────────────────────────────


class TestAutopilotApi:
    def test_routes_import(self):
        from hermes_cli.autopilot_api import router

        route_paths = [r.path for r in router.routes]
        assert "/api/v1/missions" in route_paths
        assert "/api/v1/missions/{mission_id}" in route_paths
        assert "/api/v1/missions/stats" in route_paths
        assert "/api/v1/missions/decompose" in route_paths
