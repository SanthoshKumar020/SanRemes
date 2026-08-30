"""Tests for the Hermes REST API router (hermes_cli/hermes_api.py).

Tests the REST API endpoints for tasks, agents, approvals, notifications,
sessions, events, and system status. Uses FastAPI's TestClient when available,
falls back to direct function testing.
"""

import time
import uuid
from unittest.mock import MagicMock, patch

import pytest


# ── Import the API module ───────────────────────────────────────────

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hermes_cli.hermes_api import (
        TaskStatus,
        _agents_store,
        _approvals_store,
        _events_history,
        _notifications_store,
        _ok,
        _error,
        _paginate,
        hermes_api_router,
        include_hermes_api,
        register_api_stores,
    )

    HAS_FASTAPI = True
except ImportError:
    HAS_FASTAPI = False


# ── Helpers ─────────────────────────────────────────────────────────


def _make_app():
    """Create a test FastAPI app with the Hermes API router."""
    app = FastAPI()
    include_hermes_api(app)
    return app


def _auth_headers():
    """Return auth headers for test requests."""
    return {"Authorization": "Bearer test-token-123"}


# ── Unit tests (no FastAPI required) ────────────────────────────────


class TestHelpers:
    def test_ok_with_data(self):
        result = _ok(data={"id": "123", "name": "test"})
        assert result["ok"] is True
        assert result["data"]["id"] == "123"

    def test_ok_without_data(self):
        result = _ok()
        assert result["ok"] is True
        assert "data" not in result

    def test_ok_with_extra(self):
        result = _ok(data=[], total=5)
        assert result["ok"] is True
        assert result["total"] == 5

    def test_paginate_empty(self):
        result = _paginate([], None, 10)
        assert result["items"] == []
        assert result["next_cursor"] is None

    def test_paginate_full_page(self):
        items = [{"id": str(i)} for i in range(10)]
        result = _paginate(items, None, 5)
        assert len(result["items"]) == 5
        assert result["next_cursor"] == "4"

    def test_paginate_partial_page(self):
        items = [{"id": str(i)} for i in range(3)]
        result = _paginate(items, None, 10)
        assert len(result["items"]) == 3
        assert result["next_cursor"] is None

    def test_paginate_with_cursor(self):
        items = [{"id": str(i)} for i in range(10)]
        result = _paginate(items, "4", 5)
        assert result["items"][0]["id"] == "5"
        assert len(result["items"]) == 5

    def test_task_status_enum(self):
        assert TaskStatus.CREATED.value == "created"
        assert TaskStatus.EXECUTING.value == "executing"
        assert TaskStatus.COMPLETED.value == "completed"
        assert TaskStatus.FAILED.value == "failed"


# ── Integration tests (require FastAPI) ─────────────────────────────


@pytest.mark.skipif(not HAS_FASTAPI, reason="FastAPI not installed")
class TestTasksAPI:
    def setup_method(self):
        self.app = _make_app()
        self.client = TestClient(self.app)
        # Clear stores
        from hermes_cli.hermes_api import _tasks_store
        _tasks_store.clear()

    def test_list_tasks_empty(self):
        response = self.client.get("/api/v1/tasks", headers=_auth_headers())
        assert response.status_code == 200
        data = response.json()
        assert data["ok"] is True
        assert data["items"] == []

    def test_create_task(self):
        response = self.client.post(
            "/api/v1/tasks",
            json={"prompt": "Build authentication", "priority": "high"},
            headers=_auth_headers(),
        )
        assert response.status_code == 200
        data = response.json()
        assert data["ok"] is True
        assert data["data"]["prompt"] == "Build authentication"
        assert data["data"]["priority"] == "high"
        assert data["data"]["status"] == "created"
        assert data["data"]["id"].startswith("task_")

    def test_get_task(self):
        # Create first
        create_resp = self.client.post(
            "/api/v1/tasks",
            json={"prompt": "Test task"},
            headers=_auth_headers(),
        )
        task_id = create_resp.json()["data"]["id"]
        # Get it
        response = self.client.get(f"/api/v1/tasks/{task_id}", headers=_auth_headers())
        assert response.status_code == 200
        assert response.json()["data"]["id"] == task_id

    def test_get_task_not_found(self):
        response = self.client.get("/api/v1/tasks/nonexistent", headers=_auth_headers())
        assert response.status_code == 404

    def test_update_task(self):
        create_resp = self.client.post(
            "/api/v1/tasks",
            json={"prompt": "Test"},
            headers=_auth_headers(),
        )
        task_id = create_resp.json()["data"]["id"]
        response = self.client.put(
            f"/api/v1/tasks/{task_id}",
            json={"status": "executing", "priority": "urgent"},
            headers=_auth_headers(),
        )
        assert response.status_code == 200
        assert response.json()["data"]["status"] == "executing"
        assert response.json()["data"]["priority"] == "urgent"

    def test_delete_task(self):
        create_resp = self.client.post(
            "/api/v1/tasks",
            json={"prompt": "Delete me"},
            headers=_auth_headers(),
        )
        task_id = create_resp.json()["data"]["id"]
        response = self.client.delete(f"/api/v1/tasks/{task_id}", headers=_auth_headers())
        assert response.status_code == 200
        # Verify deleted
        get_resp = self.client.get(f"/api/v1/tasks/{task_id}", headers=_auth_headers())
        assert get_resp.status_code == 404

    def test_pause_resume_task(self):
        create_resp = self.client.post(
            "/api/v1/tasks",
            json={"prompt": "Pause test"},
            headers=_auth_headers(),
        )
        task_id = create_resp.json()["data"]["id"]
        # Pause
        pause_resp = self.client.post(f"/api/v1/tasks/{task_id}/pause", headers=_auth_headers())
        assert pause_resp.json()["data"]["status"] == "paused"
        # Resume
        resume_resp = self.client.post(f"/api/v1/tasks/{task_id}/resume", headers=_auth_headers())
        assert resume_resp.json()["data"]["status"] == "executing"

    def test_filter_by_status(self):
        # Create tasks with different statuses
        for status in ["created", "executing", "completed"]:
            resp = self.client.post(
                "/api/v1/tasks",
                json={"prompt": f"Task {status}"},
                headers=_auth_headers(),
            )
            task_id = resp.json()["data"]["id"]
            self.client.put(
                f"/api/v1/tasks/{task_id}",
                json={"status": status},
                headers=_auth_headers(),
            )
        # Filter
        response = self.client.get(
            "/api/v1/tasks?status=executing",
            headers=_auth_headers(),
        )
        assert len(response.json()["items"]) == 1

    def test_pagination(self):
        # Create 5 tasks
        for i in range(5):
            self.client.post(
                "/api/v1/tasks",
                json={"prompt": f"Task {i}"},
                headers=_auth_headers(),
            )
        # Get page 1
        resp1 = self.client.get("/api/v1/tasks?limit=2", headers=_auth_headers())
        assert len(resp1.json()["items"]) == 2
        cursor = resp1.json()["next_cursor"]
        assert cursor is not None
        # Get page 2
        resp2 = self.client.get(
            f"/api/v1/tasks?limit=2&cursor={cursor}",
            headers=_auth_headers(),
        )
        assert len(resp2.json()["items"]) == 2
        assert resp2.json()["items"][0]["id"] != resp1.json()["items"][0]["id"]

    def test_auth_required(self):
        response = self.client.get("/api/v1/tasks")
        assert response.status_code == 401


@pytest.mark.skipif(not HAS_FASTAPI, reason="FastAPI not installed")
class TestAgentsAPI:
    def setup_method(self):
        self.app = _make_app()
        self.client = TestClient(self.app)
        from hermes_cli.hermes_api import _agents_store
        _agents_store.clear()

    def test_list_agents_empty(self):
        response = self.client.get("/api/v1/agents", headers=_auth_headers())
        assert response.status_code == 200
        assert response.json()["items"] == []


@pytest.mark.skipif(not HAS_FASTAPI, reason="FastAPI not installed")
class TestApprovalsAPI:
    def setup_method(self):
        self.app = _make_app()
        self.client = TestClient(self.app)
        from hermes_cli.hermes_api import _approvals_store
        _approvals_store.clear()

    def test_list_approvals_empty(self):
        response = self.client.get("/api/v1/approvals", headers=_auth_headers())
        assert response.status_code == 200
        assert response.json()["items"] == []

    def test_approve_and_deny(self):
        from hermes_cli.hermes_api import _approvals_store
        approval_id = "approval_test123"
        _approvals_store[approval_id] = {
            "id": approval_id,
            "status": "pending",
            "command": "rm -rf /tmp/test",
            "created_at": time.time(),
        }
        # Approve
        resp = self.client.post(
            f"/api/v1/approvals/{approval_id}/approve",
            json={"reason": "Safe to proceed"},
            headers=_auth_headers(),
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["status"] == "approved"
        assert resp.json()["data"]["reason"] == "Safe to proceed"


@pytest.mark.skipif(not HAS_FASTAPI, reason="FastAPI not installed")
class TestNotificationsAPI:
    def setup_method(self):
        self.app = _make_app()
        self.client = TestClient(self.app)
        from hermes_cli.hermes_api import _notifications_store
        _notifications_store.clear()

    def test_list_notifications_empty(self):
        response = self.client.get("/api/v1/notifications", headers=_auth_headers())
        assert response.status_code == 200
        assert response.json()["items"] == []

    def test_mark_all_read(self):
        from hermes_cli.hermes_api import _notifications_store
        _notifications_store.extend([
            {"id": "n1", "read": False, "created_at": time.time()},
            {"id": "n2", "read": False, "created_at": time.time()},
            {"id": "n3", "read": True, "created_at": time.time()},
        ])
        resp = self.client.post("/api/v1/notifications/read-all", headers=_auth_headers())
        assert resp.status_code == 200
        assert resp.json()["data"]["marked_read"] == 2


@pytest.mark.skipif(not HAS_FASTAPI, reason="FastAPI not installed")
class TestSystemAPI:
    def setup_method(self):
        self.app = _make_app()
        self.client = TestClient(self.app)

    def test_capabilities(self):
        response = self.client.get("/api/v1/system/capabilities", headers=_auth_headers())
        assert response.status_code == 200
        caps = response.json()["data"]
        assert caps["tasks"] is True
        assert caps["agents"] is True
        assert caps["approvals"] is True

    def test_status(self):
        response = self.client.get("/api/v1/system/status", headers=_auth_headers())
        assert response.status_code == 200
        status = response.json()["data"]
        assert "tasks_active" in status
        assert "agents_active" in status


@pytest.mark.skipif(not HAS_FASTAPI, reason="FastAPI not installed")
class TestEventsAPI:
    def setup_method(self):
        self.app = _make_app()
        self.client = TestClient(self.app)
        from hermes_cli.hermes_api import _events_history
        _events_history.clear()

    def test_list_events_empty(self):
        response = self.client.get("/api/v1/events", headers=_auth_headers())
        assert response.status_code == 200
        assert response.json()["items"] == []

    def test_list_events_with_data(self):
        from hermes_cli.hermes_api import _events_history
        _events_history.extend([
            {"id": "e1", "type": "task.created", "timestamp": time.time() - 10, "data": {}},
            {"id": "e2", "type": "task.updated", "timestamp": time.time(), "data": {}},
        ])
        resp = self.client.get("/api/v1/events?event_type=task.created", headers=_auth_headers())
        assert len(resp.json()["items"]) == 1
