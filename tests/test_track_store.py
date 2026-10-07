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


@pytest.mark.asyncio
async def test_tasks_endpoint_renders_delegated_row(track_file, monkeypatch):
    plugin_api._track_store_merge("dX", {
        "capability": "mc.list.players", "owner": "AMKJA9AE",
        "delegated": True, "submitted_at": time.time(), "name": "probe",
    })
    # make sure the delegated row never triggers a node-cli fetch
    async def _boom(task_id):  # pragma: no cover - must not be called
        raise AssertionError(f"_fetch_task called for delegated row {task_id}")
    monkeypatch.setattr(plugin_api, "_fetch_task", _boom)

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
    # same file, backend reads it
    store = plugin_api._track_store_read()
    assert store["ids"] == ["bt1"]
    assert store["meta"]["bt1"]["capability"] == "code.ai"
    # and backend merge appends to a bridge-written file
    plugin_api._track_store_merge("bt2")
    assert plugin_api._tracked_list() == ["bt2", "bt1"]