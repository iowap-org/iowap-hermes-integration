"""Tests for the relay health probe (T-007).

The health probe must go through node-cli (`server health`, T-178) — the
only relay client of this backend (plugin_api docstring rule). The former
httpx implementation hand-parsed base_url out of ~/.relay/iowap-agent.json,
which the T-198 wheel release no longer carries: live on 2026-10-10 the
deployed probe reported "relay not configured" while the relay itself was
healthy (9/10 nodes online). These tests pin the node-cli contract.
"""

import asyncio
import importlib
import json
import pathlib
import sys

import pytest

_HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "dashboard"))
plugin_api = importlib.import_module("plugin_api")

# node-cli `server health --json` (verified live against the T-178 wheel):
# both outcomes arrive as JSON on stdout — ok=true carries the health body,
# ok=false carries the error string, the latter with exit code 1.
_OK_BODY = {
    "ok": True, "error": "", "version": "2.0.0", "mode": "core",
    "database": "ok", "scheduler": "ok",
    "nodes_total": 10.0, "nodes_online": 9.0, "queue_depth": 0.0,
}
_ERR_BODY = {"ok": False, "error": "health: [Errno 111] Connection refused"}


@pytest.fixture(autouse=True)
def _fresh_health_cache():
    """Every test starts and ends with an empty health cache (TTL otherwise
    leaks results across tests — same class of pitfall as _tasks_state)."""
    plugin_api._health_state.pop("v", None)
    yield
    plugin_api._health_state.pop("v", None)


def _fake_run(calls, raw=None, exc=None):
    """Async _run_node_cli stand-in that records argv and returns `raw`."""

    async def fake(args, **kwargs):
        calls.append(list(args))
        if exc is not None:
            raise exc
        return raw if raw is not None else ""

    return fake


def test_health_uses_node_cli_server_health(monkeypatch):
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli", _fake_run(calls, raw=json.dumps(_OK_BODY))
    )
    data = asyncio.run(plugin_api._relay_health())
    assert calls == [["server", "health"]]
    assert data["ok"] is True
    assert data["via"] == "node-cli"
    assert data["body"]["version"] == "2.0.0"
    assert "error" not in data


def test_health_maps_unreachable_output_to_error(monkeypatch):
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli", _fake_run(calls, raw=json.dumps(_ERR_BODY))
    )
    data = asyncio.run(plugin_api._relay_health())
    assert calls == [["server", "health"]]
    assert data["via"] == "node-cli"
    assert "Connection refused" in data["error"]
    assert "body" not in data


def test_health_survives_node_cli_exception(monkeypatch):
    calls = []
    monkeypatch.setattr(
        plugin_api,
        "_run_node_cli",
        _fake_run(calls, exc=RuntimeError("node-cli exit 2: boom")),
    )
    data = asyncio.run(plugin_api._relay_health())
    assert calls == [["server", "health"]]
    assert "RuntimeError" in data["error"]


def test_health_is_cached_within_ttl(monkeypatch):
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli", _fake_run(calls, raw=json.dumps(_OK_BODY))
    )
    asyncio.run(plugin_api._relay_health())
    asyncio.run(plugin_api._relay_health())
    assert len(calls) == 1


def test_health_never_touches_local_files(monkeypatch):
    """Regression pin for the live finding: the probe must not resolve its
    target from ~/.relay/* (agent.json has carried no base_url since the
    T-198 wheel release moved the pin to relay_config.json) — node-cli owns
    target resolution, so this backend must not consult HOME or config files
    inside the health path."""

    class _NoHome:
        @classmethod
        def home(cls):
            raise AssertionError("health probe must not consult HOME/config files")

    monkeypatch.setattr(plugin_api, "Path", _NoHome)
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli", _fake_run(calls, raw=json.dumps(_OK_BODY))
    )
    data = asyncio.run(plugin_api._relay_health())
    assert data["ok"] is True
    assert calls == [["server", "health"]]