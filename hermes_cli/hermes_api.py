"""Hermes REST API — clean external-facing endpoints for mobile, desktop, and third-party clients.

This module provides a FastAPI router with REST endpoints that complement
the existing WebSocket-based TUI gateway (tui_gateway/server.py) and the
dashboard web server (hermes_cli/web_server.py).

Design principles:
  - REST endpoints for CRUD operations (tasks, agents, approvals, notifications)
  - Pagination via cursor/limit for list endpoints
  - Structured error responses with error codes
  - Session-scoped authentication via Bearer tokens
  - Real-time events via the existing /api/events WebSocket (not duplicated here)

The router is included in the main FastAPI app via:
    from hermes_cli.hermes_api import hermes_api_router
    app.include_router(hermes_api_router)
"""

import asyncio
import logging
import time
import uuid
from enum import Enum
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Lazy FastAPI import to match the existing web_server.py pattern
try:
    from fastapi import APIRouter, HTTPException, Query, Request, Response
    from fastapi.responses import JSONResponse
except ImportError:
    logger.warning("FastAPI not available; hermes_api router will not be registered.")
    APIRouter = None  # type: ignore

if APIRouter is not None:
    hermes_api_router = APIRouter(prefix="/api/v1", tags=["hermes-api"])
else:
    hermes_api_router = None  # type: ignore


# ── Response models ─────────────────────────────────────────────────


def _ok(data: Any = None, **extra) -> dict:
    """Wrap a successful response."""
    resp: dict[str, Any] = {"ok": True}
    if data is not None:
        resp["data"] = data
    resp.update(extra)
    return resp


def _error(message: str, code: str = "error", status: int = 400) -> JSONResponse:
    """Wrap an error response."""
    return JSONResponse(
        status_code=status,
        content={"ok": False, "error": {"code": code, "message": message}},
    )


def _paginate(items: list, cursor: Optional[str], limit: int) -> dict:
    """Apply cursor-based pagination to a list."""
    if cursor:
        # Find the starting index
        start = 0
        for i, item in enumerate(items):
            if item.get("id") == cursor:
                start = i + 1
                break
        items = items[start:]
    page = items[:limit]
    next_cursor = page[-1]["id"] if len(page) == limit and page else None
    return {
        "items": page,
        "next_cursor": next_cursor,
        "total": len(items) if not cursor else None,
    }


# ── Auth helper ─────────────────────────────────────────────────────


def _get_session_token(request: Request) -> Optional[str]:
    """Extract the session token from the Authorization header or query param."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    # Fallback to query param for WebSocket-originating REST calls
    return request.query_params.get("token")


def _require_auth(request: Request) -> str:
    """Require a valid session token. Raises HTTPException 401 if missing."""
    token = _get_session_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    return token


# ── In-memory stores (populated by the gateway at runtime) ──────────
# These are populated by hooks from the TUI gateway. In production,
# these would be backed by the session database (sanremes_state.py).

_tasks_store: Dict[str, dict] = {}
_agents_store: Dict[str, dict] = {}
_notifications_store: List[dict] = []
_events_history: List[dict] = []
_approvals_store: Dict[str, dict] = {}


def register_api_stores(stores: dict) -> None:
    """Register shared stores from the gateway runtime.

    Called once at gateway startup to connect the API layer to the
    live state managed by tui_gateway/server.py.
    """
    global _tasks_store, _agents_store, _notifications_store, _events_history, _approvals_store
    _tasks_store = stores.get("tasks", _tasks_store)
    _agents_store = stores.get("agents", _agents_store)
    _notifications_store = stores.get("notifications", _notifications_store)
    _events_history = stores.get("events", _events_history)
    _approvals_store = stores.get("approvals", _approvals_store)


# ── Tasks API ───────────────────────────────────────────────────────


class TaskStatus(str, Enum):
    CREATED = "created"
    PLANNING = "planning"
    EXECUTING = "executing"
    VERIFYING = "verifying"
    COMPLETED = "completed"
    FAILED = "failed"
    PAUSED = "paused"
    CANCELLED = "cancelled"


if hermes_api_router is not None:

    @hermes_api_router.get("/tasks")
    async def list_tasks(
        request: Request,
        status: Optional[str] = Query(None, description="Filter by task status"),
        limit: int = Query(50, ge=1, le=200),
        cursor: Optional[str] = Query(None, description="Pagination cursor"),
    ):
        """List all tasks with optional status filter and cursor pagination."""
        _require_auth(request)
        items = list(_tasks_store.values())
        if status:
            items = [t for t in items if t.get("status") == status]
        items.sort(key=lambda t: t.get("created_at", 0), reverse=True)
        return _ok(**_paginate(items, cursor, limit))

    @hermes_api_router.get("/tasks/{task_id}")
    async def get_task(request: Request, task_id: str):
        """Get a specific task by ID."""
        _require_auth(request)
        task = _tasks_store.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
        return _ok(data=task)

    @hermes_api_router.post("/tasks")
    async def create_task(request: Request, body: dict):
        """Create a new task.

        Body:
          - prompt: str — the task description
          - agent_id: str (optional) — assign to a specific agent
          - priority: str (optional) — "low", "normal", "high", "urgent"
          - metadata: dict (optional) — arbitrary metadata
        """
        _require_auth(request)
        task_id = f"task_{uuid.uuid4().hex[:12]}"
        now = time.time()
        task = {
            "id": task_id,
            "prompt": body.get("prompt", ""),
            "status": TaskStatus.CREATED.value,
            "agent_id": body.get("agent_id"),
            "priority": body.get("priority", "normal"),
            "metadata": body.get("metadata", {}),
            "created_at": now,
            "updated_at": now,
            "subtasks": [],
            "result": None,
            "error": None,
        }
        _tasks_store[task_id] = task
        _emit_event("task.created", {"task": task})
        return JSONResponse(status_code=201, content=_ok(data=task))

    @hermes_api_router.put("/tasks/{task_id}")
    async def update_task(request: Request, task_id: str, body: dict):
        """Update a task's status, priority, or metadata.

        Body (all optional):
          - status: str — new task status
          - priority: str — new priority
          - metadata: dict — merge into existing metadata
          - result: str — task result (set on completion)
          - error: str — error message (set on failure)
        """
        _require_auth(request)
        task = _tasks_store.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
        if "status" in body:
            task["status"] = body["status"]
        if "priority" in body:
            task["priority"] = body["priority"]
        if "metadata" in body:
            task["metadata"].update(body["metadata"])
        if "result" in body:
            task["result"] = body["result"]
        if "error" in body:
            task["error"] = body["error"]
        task["updated_at"] = time.time()
        _emit_event("task.updated", {"task": task})
        return _ok(data=task)

    @hermes_api_router.delete("/tasks/{task_id}")
    async def delete_task(request: Request, task_id: str):
        """Cancel and remove a task."""
        _require_auth(request)
        task = _tasks_store.pop(task_id, None)
        if not task:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
        task["status"] = TaskStatus.CANCELLED.value
        _emit_event("task.cancelled", {"task": task})
        return _ok(data={"deleted": task_id})

    @hermes_api_router.post("/tasks/{task_id}/pause")
    async def pause_task(request: Request, task_id: str):
        """Pause a running task."""
        _require_auth(request)
        task = _tasks_store.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
        task["status"] = TaskStatus.PAUSED.value
        task["updated_at"] = time.time()
        _emit_event("task.paused", {"task": task})
        return _ok(data=task)

    @hermes_api_router.post("/tasks/{task_id}/resume")
    async def resume_task(request: Request, task_id: str):
        """Resume a paused task."""
        _require_auth(request)
        task = _tasks_store.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
        task["status"] = TaskStatus.EXECUTING.value
        task["updated_at"] = time.time()
        _emit_event("task.resumed", {"task": task})
        return _ok(data=task)

    @hermes_api_router.post("/tasks/{task_id}/stop")
    async def stop_task(request: Request, task_id: str):
        """Stop a running task (cancel without deleting)."""
        _require_auth(request)
        task = _tasks_store.get(task_id)
        if not task:
            raise HTTPException(status_code=404, detail=f"Task {task_id} not found")
        task["status"] = TaskStatus.CANCELLED.value
        task["updated_at"] = time.time()
        _emit_event("task.stopped", {"task": task})
        return _ok(data=task)


# ── Agents API ──────────────────────────────────────────────────────

if hermes_api_router is not None:

    @hermes_api_router.get("/agents")
    async def list_agents(
        request: Request,
        status: Optional[str] = Query(None, description="Filter by agent status"),
        limit: int = Query(50, ge=1, le=200),
        cursor: Optional[str] = Query(None),
    ):
        """List all agents (subagents and the main agent)."""
        _require_auth(request)
        items = list(_agents_store.values())
        if status:
            items = [a for a in items if a.get("status") == status]
        items.sort(key=lambda a: a.get("created_at", 0), reverse=True)
        return _ok(**_paginate(items, cursor, limit))

    @hermes_api_router.get("/agents/{agent_id}")
    async def get_agent(request: Request, agent_id: str):
        """Get a specific agent by ID."""
        _require_auth(request)
        agent = _agents_store.get(agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")
        return _ok(data=agent)

    @hermes_api_router.post("/agents/{agent_id}/cancel")
    async def cancel_agent(request: Request, agent_id: str):
        """Cancel a running agent."""
        _require_auth(request)
        agent = _agents_store.get(agent_id)
        if not agent:
            raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")
        agent["status"] = "cancelled"
        agent["updated_at"] = time.time()
        _emit_event("agent.cancelled", {"agent": agent})
        return _ok(data=agent)


# ── Approvals API ───────────────────────────────────────────────────

if hermes_api_router is not None:

    @hermes_api_router.get("/approvals")
    async def list_pending_approvals(
        request: Request,
        limit: int = Query(50, ge=1, le=200),
    ):
        """List all pending approval requests."""
        _require_auth(request)
        pending = [
            a for a in _approvals_store.values()
            if a.get("status") == "pending"
        ]
        pending.sort(key=lambda a: a.get("created_at", 0), reverse=True)
        return _ok(data=pending[:limit])

    @hermes_api_router.get("/approvals/{approval_id}")
    async def get_approval(request: Request, approval_id: str):
        """Get a specific approval request."""
        _require_auth(request)
        approval = _approvals_store.get(approval_id)
        if not approval:
            raise HTTPException(status_code=404, detail=f"Approval {approval_id} not found")
        return _ok(data=approval)

    @hermes_api_router.post("/approvals/{approval_id}/approve")
    async def approve_request(request: Request, approval_id: str, body: dict = None):
        """Approve a pending request.

        Body (optional):
          - reason: str — explanation for the approval
          - permanent: bool — if true, add to permanent allowlist
        """
        _require_auth(request)
        body = body or {}
        approval = _approvals_store.get(approval_id)
        if not approval:
            raise HTTPException(status_code=404, detail=f"Approval {approval_id} not found")
        if approval.get("status") != "pending":
            raise HTTPException(status_code=409, detail="Approval already resolved")
        approval["status"] = "approved"
        approval["resolved_at"] = time.time()
        approval["resolved_by"] = "api"
        approval["reason"] = body.get("reason", "")
        approval["permanent"] = body.get("permanent", False)
        # Signal the waiting approval callback
        if approval.get("_event"):
            approval["_event"].set()
        _emit_event("approval.approved", {"approval": approval})
        return _ok(data=approval)

    @hermes_api_router.post("/approvals/{approval_id}/deny")
    async def deny_request(request: Request, approval_id: str, body: dict = None):
        """Deny a pending request.

        Body (optional):
          - reason: str — explanation for the denial
        """
        _require_auth(request)
        body = body or {}
        approval = _approvals_store.get(approval_id)
        if not approval:
            raise HTTPException(status_code=404, detail=f"Approval {approval_id} not found")
        if approval.get("status") != "pending":
            raise HTTPException(status_code=409, detail="Approval already resolved")
        approval["status"] = "denied"
        approval["resolved_at"] = time.time()
        approval["resolved_by"] = "api"
        approval["reason"] = body.get("reason", "")
        if approval.get("_event"):
            approval["_event"].set()
        _emit_event("approval.denied", {"approval": approval})
        return _ok(data=approval)


# ── Notifications API ───────────────────────────────────────────────

if hermes_api_router is not None:

    @hermes_api_router.get("/notifications")
    async def list_notifications(
        request: Request,
        unread_only: bool = Query(False),
        limit: int = Query(50, ge=1, le=200),
        cursor: Optional[str] = Query(None),
    ):
        """List notifications with optional unread filter."""
        _require_auth(request)
        items = list(_notifications_store)
        if unread_only:
            items = [n for n in items if not n.get("read")]
        items.sort(key=lambda n: n.get("created_at", 0), reverse=True)
        return _ok(**_paginate(items, cursor, limit))

    @hermes_api_router.post("/notifications/{notification_id}/read")
    async def mark_notification_read(request: Request, notification_id: str):
        """Mark a notification as read."""
        _require_auth(request)
        for n in _notifications_store:
            if n.get("id") == notification_id:
                n["read"] = True
                n["read_at"] = time.time()
                return _ok(data=n)
        raise HTTPException(status_code=404, detail=f"Notification {notification_id} not found")

    @hermes_api_router.post("/notifications/read-all")
    async def mark_all_notifications_read(request: Request):
        """Mark all notifications as read."""
        _require_auth(request)
        now = time.time()
        count = 0
        for n in _notifications_store:
            if not n.get("read"):
                n["read"] = True
                n["read_at"] = now
                count += 1
        return _ok(data={"marked_read": count})


# ── Sessions API (REST complement to WebSocket session.* methods) ───

if hermes_api_router is not None:

    @hermes_api_router.get("/sessions")
    async def list_sessions(
        request: Request,
        limit: int = Query(50, ge=1, le=200),
        cursor: Optional[str] = Query(None),
    ):
        """List all active sessions."""
        _require_auth(request)
        # Delegate to the TUI gateway's session store
        try:
            from tui_gateway.server import _sessions
            items = [
                {
                    "id": sid,
                    "title": s.get("title", ""),
                    "status": s.get("status", "unknown"),
                    "created_at": s.get("created_at", 0),
                    "last_active": s.get("last_active", 0),
                    "platform": s.get("platform", "unknown"),
                }
                for sid, s in _sessions.items()
            ]
        except (ImportError, AttributeError):
            items = []
        items.sort(key=lambda s: s.get("last_active", 0), reverse=True)
        return _ok(**_paginate(items, cursor, limit))

    @hermes_api_router.get("/sessions/{session_id}")
    async def get_session(request: Request, session_id: str):
        """Get a specific session's metadata."""
        _require_auth(request)
        try:
            from tui_gateway.server import _sessions
            session = _sessions.get(session_id)
            if not session:
                raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
            return _ok(data={
                "id": session_id,
                "title": session.get("title", ""),
                "status": session.get("status", "unknown"),
                "created_at": session.get("created_at", 0),
                "last_active": session.get("last_active", 0),
                "platform": session.get("platform", "unknown"),
                "message_count": len(session.get("messages", [])),
            })
        except ImportError:
            raise HTTPException(status_code=503, detail="Session store unavailable")


# ── Event History API ───────────────────────────────────────────────

if hermes_api_router is not None:

    @hermes_api_router.get("/events")
    async def list_events(
        request: Request,
        event_type: Optional[str] = Query(None, description="Filter by event type"),
        since: Optional[float] = Query(None, description="Unix timestamp lower bound"),
        limit: int = Query(100, ge=1, le=500),
        cursor: Optional[str] = Query(None),
    ):
        """List historical events (complement to the /api/events WebSocket).

        Use this to fetch events that occurred before a client connected,
        or to poll for events in environments where WebSocket is not available.
        """
        _require_auth(request)
        items = list(_events_history)
        if event_type:
            items = [e for e in items if e.get("type") == event_type]
        if since:
            items = [e for e in items if e.get("timestamp", 0) >= since]
        items.sort(key=lambda e: e.get("timestamp", 0), reverse=True)
        return _ok(**_paginate(items, cursor, limit))


# ── System Info API ─────────────────────────────────────────────────

if hermes_api_router is not None:

    @hermes_api_router.get("/system/capabilities")
    async def get_capabilities(request: Request):
        """Return the agent's current capabilities and enabled features.

        Useful for clients to discover what APIs and features are available.
        """
        _require_auth(request)
        try:
            from hermes_cli.config import load_config_readonly
            config = load_config_readonly()
        except Exception:
            config = {}

        capabilities = {
            "tasks": True,
            "agents": True,
            "approvals": True,
            "notifications": True,
            "sessions": True,
            "events": True,
            "permissions_engine": config.get("permissions", {}).get("enabled", False),
            "memory_provider": config.get("memory", {}).get("provider", "builtin"),
            "approval_mode": config.get("approvals", {}).get("mode", "smart"),
            "cron_enabled": bool(config.get("cron")),
        }
        return _ok(data=capabilities)

    @hermes_api_router.get("/system/status")
    async def get_status(request: Request):
        """Return system status overview."""
        _require_auth(request)
        return _ok(data={
            "tasks_active": sum(
                1 for t in _tasks_store.values()
                if t.get("status") in ("created", "planning", "executing", "verifying")
            ),
            "agents_active": sum(
                1 for a in _agents_store.values()
                if a.get("status") in ("running", "starting")
            ),
            "approvals_pending": sum(
                1 for a in _approvals_store.values()
                if a.get("status") == "pending"
            ),
            "notifications_unread": sum(
                1 for n in _notifications_store
                if not n.get("read")
            ),
        })


# ── Event emission helper ───────────────────────────────────────────


def _emit_event(event_type: str, data: dict) -> None:
    """Record an event to the history store and publish to the event bus.

    Called by API handlers to ensure events are both recorded for REST
    polling and published for WebSocket subscribers.
    """
    event = {
        "type": event_type,
        "timestamp": time.time(),
        "data": data,
        "id": f"evt_{uuid.uuid4().hex[:12]}",
    }
    _events_history.append(event)
    # Cap history at 10000 events
    if len(_events_history) > 10000:
        _events_history[:] = _events_history[-10000:]
    # Publish to the existing WebSocket event bus if available
    try:
        from hermes_cli.web_server import _get_event_state
        state = _get_event_state(None)  # type: ignore
        if state and hasattr(state, "broadcast"):
            asyncio.get_event_loop().call_soon(
                lambda: state.broadcast(event_type, data)
            )
    except Exception:
        pass  # Event bus not available; REST history still works


# ── Router registration helper ──────────────────────────────────────


def include_hermes_api(app) -> None:
    """Include the Hermes API router in a FastAPI application.

    Call this from the main web server setup:

        from hermes_cli.hermes_api import include_hermes_api
        include_hermes_api(app)
    """
    if hermes_api_router is None:
        logger.warning("Hermes API router not available (FastAPI not installed)")
        return
    app.include_router(hermes_api_router)
    logger.info("Hermes API router registered at /api/v1")
