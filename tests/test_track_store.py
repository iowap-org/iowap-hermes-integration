"""Tests for the shared task-track store (T-006-tracking v2).

The track file is shared between the backend (dashboard/plugin_api) and the
session-side submit bridge (tools/iowap-task) — same schema, same flock
protocol. v2 adds per-id meta ({"ids": [...], "meta": {...}}) so
owner-scoped (delegated) tasks can be rendered as honest placeholder rows
instead of fetch_errors, despite server-side T-005g owner scoping.
"""

import importlib
import importlib.machinery
import importlib.util
import json
import pathlib
import sys
import time

import pytest

_HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "dashboard"))
plugin_api = importlib.import_module("plugin_api")


@pytest.fixture()
def track_file(tmp_path, monkeypatch):
    path = tmp_path / "task-track-iowap.json"
    monkeypatch.setattr(plugin_api, "_TRACK_FILE", path)
    return path


def test_merge_adds_and_keeps_order(track_file):
    assert plugin_api._track_store_merge("t2") is True
    assert plugin_api._track_store_merge("t1") is True
    assert plugin_api._track_store_merge("t1") is False  # duplicate
    assert plugin_api._tracked_list() == ["t1", "t2"]


def test_merge_with_meta_and_dedupe(track_file):
    plugin_api._track_store_merge("t1", {"capability": "code.ai"})
    plugin_api._track_store_merge("t1", {"delegated": True})  # refresh, not dup
    store = plugin_api._track_store_read()
    assert store["ids"] == ["t1"]
    assert store["meta"]["t1"] == {"capability": "code.ai", "delegated": True}


def test_merge_caps_at_50_and_prunes_orphan_meta(track_file):
    for i in range(55):
        plugin_api._track_store_merge(f"t{i:02d}")
    ids = plugin_api._tracked_list()
    assert len(ids) == 50
    assert "t00" not in ids and "t54" in ids
    store = plugin_api._track_store_read()
    assert set(store["meta"]) <= set(ids)


def test_legacy_layout_loads(track_file):
    track_file.write_text(json.dumps({"ids": ["a", "b"]}), encoding="utf-8")
    store = plugin_api._track_store_read()
    assert store == {"ids": ["a", "b"], "meta": {}}
    assert plugin_api._tracked_list() == ["a", "b"]


def test_corrupt_file_treated_as_empty(track_file):
    track_file.write_text("{not json", encoding="utf-8")
    assert plugin_api._tracked_list() == []
    # and a merge recovers the file
    plugin_api._track_store_merge("t9")
    assert plugin_api._tracked_list() == ["t9"]


def test_delegated_pruned_after_24h(track_file):
    old = time.time() - 25 * 3600
    plugin_api._track_store_merge("old_d", {"delegated": True, "submitted_at": old,
                                            "capability": "mc.list.players"})
    plugin_api._track_store_merge("fresh_d", {"delegated": True, "submitted_at": time.time()})
    ids = plugin_api._tracked_list()
    assert ids == ["fresh_d"]
    store = plugin_api._track_store_read()
    assert "old_d" not in store["meta"] and "fresh_d" in store["meta"]


def test_delegated_kept_before_24h_even_unfetchable(track_file):
    # delegated rows never hit _fetch_task — even a fresh task the node
    # cannot read stays tracked
    plugin_api._track_store_merge("d1", {"delegated": True, "submitted_at": time.time()})
    assert plugin_api._tracked_list() == ["d1"]


def test_tracked_list_evicts_stale_cache_entries(track_file):
    # _tasks_state is process-lifetime otherwise: entries for ids the store
    # pruned must be evicted on the next _tracked_list() sweep
    plugin_api._track_store_merge("t1", {"submitted_at": time.time()})
    plugin_api._tasks_state["t1"] = (time.monotonic(), {"task": {"status": "completed"}})
    plugin_api._tasks_state["ghost"] = (time.monotonic(), {"task": {"status": "completed"}})
    assert plugin_api._tracked_list() == ["t1"]
    assert "ghost" not in plugin_api._tasks_state
    assert "t1" in plugin_api._tasks_state  # still tracked → cache kept


def test_fetch_error_tombstones_pruned_after_ttl(track_file):
    # a task whose fetches leave NO _tasks_state entry (relay 404s → the
    # /tasks row renders "fetch_error" forever) must fall out of the store
    # after the same TTL as finished task caches — otherwise dead rows
    # feed the watcher's longrun logic and bloat the Tasks page
    old = time.time() - (plugin_api._TASKS_TTL + 600)
    plugin_api._track_store_merge("dead404", {"submitted_at": old, "capability": "x.ai"})
    plugin_api._track_store_merge("fresh404", {"submitted_at": time.time(), "capability": "x.ai"})
    assert plugin_api._tracked_list() == ["fresh404"]
    store = plugin_api._track_store_read()
    assert "dead404" not in store["meta"] and "fresh404" in store["meta"]


def test_fetch_error_tombstones_kept_before_ttl(track_file):
    # without any cache entry but still fresh: keep — a mid-flight task
    # that has simply not been fetched yet must not be dropped
    plugin_api._track_store_merge("f1", {"submitted_at": time.time(), "capability": "x.ai"})
    assert plugin_api._tracked_list() == ["f1"]


@pytest.mark.asyncio
async def test_tasks_endpoint_renders_delegated_row(track_file, monkeypatch):
    plugin_api._track_store_merge("dX", {
        "capability": "mc.list.players", "owner": "NODE23A4",
        "delegated": True, "submitted_at": time.time(), "name": "probe",
    })
    # T-237: the refresh tick runs the bulk `task list` first; with the row
    # ABSENT the delegated id gets a probe fetch (T-227: the sender may read
    # owner-directed results) — a failed probe renders the placeholder row,
    # never a per-reload fetch_error.
    async def _run_node_cli(args, **kwargs):
        if args[:2] == ["task", "list"]:
            return json.dumps({"tasks": [], "viewer": "NODE"})
        raise AssertionError(f"unexpected node-cli argv {args}")  # probe fails

    async def _boom(task_id):
        raise RuntimeError("node-cli exit 4: task not found")  # probe → placeholder

    monkeypatch.setattr(plugin_api, "_run_node_cli", _run_node_cli)
    monkeypatch.setattr(plugin_api, "_fetch_task", _boom)
    monkeypatch.setattr(plugin_api, "_check_setup",
                        lambda *a, **k: {"ready": True, "reasons": []})

    out = await plugin_api.tasks()
    row = next(t for t in out["tasks"] if t["task_id"] == "dX")
    assert row["status"] == "delegated"
    assert row["delegated"] is True
    assert row["name"] == "probe"
    assert out["errors"] == []


def test_bridge_merge_matches_backend_schema(track_file):
    """The bridge (tools/iowap-task) and the backend must write the same
    store schema — load the bridge module and cross-check a merge."""
    bridge_path = _HERE.parent / "tools" / "iowap-task"
    loader = importlib.machinery.SourceFileLoader("iowap_task_bridge", str(bridge_path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    bridge = importlib.util.module_from_spec(spec)
    loader.exec_module(bridge)
    bridge.TRACK_FILE = track_file  # redirect to the test file

    assert bridge.store_merge("bt1", {"capability": "code.ai", "delegated": False}) is True
    # T-016: the bridge carries the submitting session id in the meta —
    # the backend must read it back unchanged (watcher composer target)
    assert bridge.store_merge("bt3", {"capability": "code.ai", "session_id": "sess_9"}) is True
    store = plugin_api._track_store_read()
    assert store["meta"]["bt3"]["session_id"] == "sess_9"
    # same file, backend reads it
    assert store["ids"] == ["bt3", "bt1"]
    assert store["meta"]["bt1"]["capability"] == "code.ai"
    # and backend merge appends to a bridge-written file
    plugin_api._track_store_merge("bt2")
    assert plugin_api._tracked_list() == ["bt2", "bt3", "bt1"]


@pytest.mark.asyncio
async def test_tasks_endpoint_passes_session_origin(track_file, monkeypatch):
    # T-016: /tasks rows carry the session origin — the watcher addresses
    # its composer posts at exactly this session. T-237: the row rides the
    # bulk `task list` path (synthetic summary), not a per-task fetch.
    plugin_api._track_store_merge("tX", {"capability": "code.ai", "session_id": "sess_ABC"})

    async def fake_run(args, **kwargs):
        if args[:2] == ["task", "list"]:
            return json.dumps({"tasks": [{
                "task_id": "tX", "task_name": "n", "status": "running",
                "priority": 0, "owner_node_id": None, "submitted_by": "NODE",
                "timeout_seconds": 300, "created_at": "c", "updated_at": "u",
                "completed_at": None,
            }], "viewer": "NODE"})
        raise AssertionError(f"unexpected node-cli argv {args}")

    monkeypatch.setattr(plugin_api, "_run_node_cli", fake_run)
    monkeypatch.setattr(plugin_api, "_check_setup",
                        lambda *a, **k: {"ready": True, "reasons": []})
    out = await plugin_api.tasks()
    row = next(t for t in out["tasks"] if t["task_id"] == "tX")
    assert row["session_id"] == "sess_ABC"
    assert row["stages_fetched"] is False  # bulk-only row: no detail fetch


def _load_bridge(track_file, monkeypatch):
    bridge_path = _HERE.parent / "tools" / "iowap-task"
    loader = importlib.machinery.SourceFileLoader("iowap_task_bridge2", str(bridge_path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    bridge = importlib.util.module_from_spec(spec)
    loader.exec_module(bridge)
    bridge.TRACK_FILE = track_file  # redirect to the test file
    return bridge


def test_submit_defaults_session_from_env(track_file, monkeypatch):
    """Agent-session submits must carry the submitting session id WITHOUT an
    explicit --session: HERMES_SESSION_ID is set in every Hermes session env.
    Without it (desktop gateway subprocess), session_id stays null."""
    monkeypatch.setenv("HERMES_SESSION_ID", "20261111_211844_88bd6f")
    bridge = _load_bridge(track_file, monkeypatch)

    async def _noop(*_a, **_k):  # never actually reached — sync cmd path
        raise AssertionError("node-cli must not run in this test")

    def fake_node_cli_json(args):
        cap = str(args[2]).split(":", 1)[0]
        return {"task_id": "envS1", "stage_id": "s1", "capability": cap, "status": "pending"}

    monkeypatch.setattr(bridge, "node_cli_json", fake_node_cli_json)
    ns = type("NS", (), {})()
    ns.stage = "mc.status:{}"
    ns.name = None
    ns.priority = None
    ns.owner = None
    ns.session = None
    bridge.cmd_submit(ns)

    store = bridge.store_read()
    assert store["meta"]["envS1"]["session_id"] == "20261111_211844_88bd6f"


def test_submit_explicit_session_beats_env(track_file, monkeypatch):
    monkeypatch.setenv("HERMES_SESSION_ID", "from_env")
    bridge = _load_bridge(track_file, monkeypatch)

    def fake_node_cli_json(args):
        return {"task_id": "envS2", "capability": "mc.status", "status": "pending"}

    monkeypatch.setattr(bridge, "node_cli_json", fake_node_cli_json)
    ns = type("NS", (), {})()
    ns.stage = "mc.status:{}"
    ns.name = None
    ns.priority = None
    ns.owner = None
    ns.session = "explicit_9"
    bridge.cmd_submit(ns)

    store = bridge.store_read()
    assert store["meta"]["envS2"]["session_id"] == "explicit_9"


def test_submit_session_none_without_env(track_file, monkeypatch):
    monkeypatch.delenv("HERMES_SESSION_ID", raising=False)
    bridge = _load_bridge(track_file, monkeypatch)

    def fake_node_cli_json(args):
        return {"task_id": "envS3", "capability": "mc.status", "status": "pending"}

    monkeypatch.setattr(bridge, "node_cli_json", fake_node_cli_json)
    ns = type("NS", (), {})()
    ns.stage = "mc.status:{}"
    ns.name = None
    ns.priority = None
    ns.owner = None
    ns.session = None
    bridge.cmd_submit(ns)

    store = bridge.store_read()
    assert store["meta"]["envS3"]["session_id"] is None