"""T-237 — bulk status refresh via `node-cli task list` (one subprocess per tick).

The pre-T-237 /tasks handler fanned out one `task result <id>` subprocess per
tracked task per poll tick. With node-cli ≥ 2.3.37 `task list` returns task
rows (status/updated_at/owner deltas) in ONE call — the plan pins:

- Refresh path: exactly one `node-cli --json task list --status <csv>` per
  tick. The plan names `--status pending,running`; this suite pins
  ``pending,running,cancelled`` because `cancelled` IS listable (server
  _LISTABLE_TASK_STATUSES) and its exclusion would either freeze a tracked
  cancelled task on its last running/pending status forever or force a
  per-tick `task result` fallback — both worse than one extra status value.
- Detail `task result` fetches happen ONLY on a terminal transition (once,
  for stages/artifacts) or on the explicit detail route. Terminal tasks keep
  the existing cache-permanent pattern ("never refetch terminal").
- /tasks gains passthrough filters (T-268 server params): status (csv) →
  --status, sender → --submitted-by, since/until → --since/--until (ISO →
  created_since/created_until server-side). Without params the request shape
  is identical to today.
"""

import asyncio
import importlib
import json
import pathlib
import sys
import time

import pytest

_HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "dashboard"))
plugin_api = importlib.import_module("plugin_api")


@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch):
    """Host-independent tests: setup gate forced ready, task cache emptied."""
    monkeypatch.setattr(
        plugin_api, "_check_setup",
        lambda *a, **k: {"ready": True, "node_cli": "/fake/cli", "reasons": []},
    )
    plugin_api._tasks_state.clear()
    yield
    plugin_api._tasks_state.clear()


@pytest.fixture()
def track_file(tmp_path, monkeypatch):
    path = tmp_path / "task-track-iowap.json"
    monkeypatch.setattr(plugin_api, "_TRACK_FILE", path)
    return path


def _track(task_id, **meta):
    base = {"capability": "mc.status", "submitted_at": time.time(), "session_id": "sess_X"}
    base.update(meta)
    plugin_api._track_store_merge(task_id, base)


def _row(task_id, status="running", **kw):
    d = {
        "task_id": task_id, "task_name": f"task-{task_id}", "status": status,
        "priority": 0, "owner_node_id": kw.pop("owner_node_id", None),
        "submitted_by": "NODE_LOCAL", "timeout_seconds": 300,
        "created_at": "2026-11-12T10:00:00+00:00",
        "updated_at": "2026-11-12T10:05:00+00:00", "completed_at": None,
    }
    d.update(kw)
    return d


def _full(task_id, status="completed"):
    return {
        "task": {
            "task_id": task_id, "task_name": f"task-{task_id}", "status": status,
            "priority": 0, "owner_node_id": None,
            "created_at": "2026-11-12T10:00:00+00:00",
            "updated_at": "2026-11-12T10:09:00+00:00",
            "completed_at": "2026-11-12T10:09:00+00:00",
        },
        "stages": [{
            "stage_id": f"st-{task_id}", "stage_name": "s1", "capability": "mc.status",
            "status": "completed", "claimed_by": "NODE_A",
            "claimed_at": "2026-11-12T10:01:00+00:00",
            "completed_at": "2026-11-12T10:09:00+00:00", "retry_count": 0,
            "result": {"answer": "ok"},
        }],
        "artifacts": [], "notes": [],
    }


def _fake_run(calls, list_rows=None, results=None, list_error=None):
    """Record argv, answer `task list` with rows and `task result` per id."""

    async def fake(args, **kwargs):
        calls.append(list(args))
        if args[:2] == ["task", "list"]:
            if list_error is not None:
                raise list_error
            return json.dumps({"tasks": list(list_rows or []), "viewer": "NODE_LOCAL"})
        if args[:2] == ["task", "result"]:
            tid = args[2]
            body = (results or {}).get(tid)
            if body is None:
                raise RuntimeError("node-cli exit 4: task not found")
            return json.dumps(body)
        raise AssertionError(f"unexpected node-cli argv {args}")

    return fake


# ---------------------------------------------------------------------------
# (a) bulk refresh — one subprocess per tick
# ---------------------------------------------------------------------------

def test_no_tracked_tasks_runs_zero_node_cli_calls(track_file, monkeypatch):
    calls = []
    monkeypatch.setattr(plugin_api, "_run_node_cli", _fake_run(calls))
    out = asyncio.run(plugin_api.tasks())
    assert calls == []
    assert out["tasks"] == []


def test_bulk_refresh_is_exactly_one_subprocess(track_file, monkeypatch):
    for i in range(3):
        _track(f"t{i}")
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli",
        _fake_run(calls, list_rows=[_row(f"t{i}") for i in range(3)]),
    )
    out = asyncio.run(plugin_api.tasks())
    # ONE node-cli call, exact argv — no --submitted-by without a filter,
    # no per-task `task result` fan-out on the refresh path.
    assert calls == [["task", "list", "--status", "pending,running,cancelled"]]
    assert len(out["tasks"]) == 3
    assert [t["status"] for t in out["tasks"]] == ["running"] * 3
    assert out["errors"] == []


def test_bulk_rows_build_summaries_without_full_fetch(track_file, monkeypatch):
    submitted = time.time() - 30  # fresh: must survive the tombstone prune
    _track("t1", submitted_at=submitted, session_id="sess_ABC", name="probe")
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli", _fake_run(calls, list_rows=[_row("t1")])
    )
    out = asyncio.run(plugin_api.tasks())
    row = next(t for t in out["tasks"] if t["task_id"] == "t1")
    assert row["status"] == "running"
    assert row["name"] == "probe"  # meta name wins over the relay row label
    assert row["updated_at"] == "2026-11-12T10:05:00+00:00"
    assert row["created_at"] == "2026-11-12T10:00:00+00:00"
    assert row["capability"] == "mc.status"
    assert row["session_id"] == "sess_ABC"       # T-016 watcher contract holds
    assert row["submitted_at"] == submitted      # T-248 freshness gate rides
    assert row["stages"] == []                   # bulk-only: no detail fetch
    assert row["stages_fetched"] is False        # frontend detail affordance


def test_owner_flip_and_updated_at_ride_the_delta(track_file, monkeypatch):
    _track("t4")
    # prior full snapshot: pending, owner None — the row owns now (T-227 flip)
    plugin_api._tasks_state["t4"] = (
        time.monotonic(),
        {
            "task": {"task_id": "t4", "task_name": "task-t4", "status": "pending",
                     "owner_node_id": None, "created_at": "c", "updated_at": "u"},
            "stages": [], "artifacts": [], "notes": [], "_full": True,
        },
    )
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli",
        _fake_run(calls, list_rows=[_row("t4", owner_node_id="NODE_B")]),
    )
    out = asyncio.run(plugin_api.tasks())
    row = next(t for t in out["tasks"] if t["task_id"] == "t4")
    assert row["owner_node_id"] == "NODE_B"
    assert row["status"] == "running"
    # non-terminal delta: no detail fetch happened
    assert len(calls) == 1


def test_terminal_transition_fetches_full_once_then_cache_permanent(
    track_file, monkeypatch,
):
    _track("t5")
    plugin_api._tasks_state["t5"] = (
        time.monotonic() - 60,  # stale: past _fetch_task's 3 s TTL gate
        {"task": {"task_id": "t5", "status": "pending", "owner_node_id": None},
         "stages": [], "artifacts": [], "notes": [], "_full": True},
    )
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli",
        _fake_run(calls, list_rows=[_row("t5", status="completed")],
                  results={"t5": _full("t5")}),
    )
    out = asyncio.run(plugin_api.tasks())
    # terminal transition: ONE extra task result for stages/artifacts
    assert calls == [
        ["task", "list", "--status", "pending,running,cancelled"],
        ["task", "result", "t5"],
    ]
    row = next(t for t in out["tasks"] if t["task_id"] == "t5")
    assert row["status"] == "completed"
    assert row["stages_fetched"] is True
    assert row["stages"][0]["result_preview"] == "ok"

    calls.clear()
    out = asyncio.run(plugin_api.tasks())
    # second tick: cache-permanent terminal — the list call only
    assert calls == [["task", "list", "--status", "pending,running,cancelled"]]
    row = next(t for t in out["tasks"] if t["task_id"] == "t5")
    assert row["status"] == "completed" and row["stages_fetched"] is True


def test_terminal_cached_serves_without_result_calls(track_file, monkeypatch):
    _track("t6")
    plugin_api._tasks_state["t6"] = (
        time.monotonic(),
        {**_full("t6"), "_full": True},
    )
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli",
        _fake_run(calls, list_rows=[_row("t6", status="completed")]),
    )
    out = asyncio.run(plugin_api.tasks())
    assert calls == [["task", "list", "--status", "pending,running,cancelled"]]
    row = next(t for t in out["tasks"] if t["task_id"] == "t6")
    assert row["stages_fetched"] is True
    assert row["stages"][0]["stage_id"] == "st-t6"


def test_row_absent_falls_back_to_single_result_fetch(track_file, monkeypatch):
    """timed_out is NOT listable (server _LISTABLE_TASK_STATUSES) — an absent
    non-terminal row is resolved by exactly ONE task result fetch, then the
    terminal cache converges the watcher to zero extra calls."""
    _track("t7")
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli",
        _fake_run(calls, list_rows=[], results={"t7": _full("t7", "timed_out")}),
    )
    out = asyncio.run(plugin_api.tasks())
    assert calls == [
        ["task", "list", "--status", "pending,running,cancelled"],
        ["task", "result", "t7"],
    ]
    row = next(t for t in out["tasks"] if t["task_id"] == "t7")
    assert row["status"] == "timed_out"
    assert row["stages_fetched"] is True

    calls.clear()
    asyncio.run(plugin_api.tasks())
    assert calls == [["task", "list", "--status", "pending,running,cancelled"]]


# ---------------------------------------------------------------------------
# delegated rows under the bulk path
# ---------------------------------------------------------------------------

def test_delegated_row_present_renders_bulk_status(track_file, monkeypatch):
    _track("d1", delegated=True, owner="NODE_OTHER")
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli",
        _fake_run(calls, list_rows=[_row("d1", status="running")]),
    )
    out = asyncio.run(plugin_api.tasks())
    row = next(t for t in out["tasks"] if t["task_id"] == "d1")
    assert row["status"] == "running"   # honest relay status, not a placeholder
    assert row["delegated"] is True
    assert len(calls) == 1              # list only — no per-row fetch


def test_delegated_row_absent_gets_placeholder_without_fetch(track_file, monkeypatch):
    _track("d2", delegated=True, owner="NODE_OTHER", name="probe")
    calls = []
    monkeypatch.setattr(plugin_api, "_run_node_cli", _fake_run(calls, list_rows=[]))
    out = asyncio.run(plugin_api.tasks())
    row = next(t for t in out["tasks"] if t["task_id"] == "d2")
    assert row["status"] == "delegated"
    assert row["delegated"] is True
    assert row["name"] == "probe"
    assert out["errors"] == []


# ---------------------------------------------------------------------------
# (c) passthrough filters on GET /tasks
# ---------------------------------------------------------------------------

def test_filter_params_passthrough_exact_argv(track_file, monkeypatch):
    for i in range(2):
        _track(f"f{i}")
    # f1 already has its full view (filter argv pin — the terminal-row
    # transition fetch must not fire and muddy the call sequence)
    plugin_api._tasks_state["f1"] = (
        time.monotonic(),
        {**_full("f1", "failed"), "_full": True},
    )
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli",
        _fake_run(calls, list_rows=[_row("f1", status="failed")]),
    )
    out = asyncio.run(plugin_api.tasks(
        status="failed,cancelled", sender="NODE_A",
        since="2026-11-12T00:00:00Z", until="2026-11-12T23:00:00+01:00",
    ))
    assert calls == [[
        "task", "list",
        "--status", "failed,cancelled",
        "--submitted-by", "NODE_A",
        "--since", "2026-11-12T00:00:00Z",
        "--until", "2026-11-12T23:00:00+01:00",
    ]]
    # only rows matching the narrowed query render
    assert [t["task_id"] for t in out["tasks"]] == ["f1"]


def test_filtered_absence_suppresses_the_fallback(track_file, monkeypatch):
    """With any filter active, absence from the narrowed row set means
    'filtered out' — never a per-task result fetch (that would widen and
    fan out again)."""
    _track("g1")
    calls = []
    monkeypatch.setattr(plugin_api, "_run_node_cli", _fake_run(calls, list_rows=[]))
    out = asyncio.run(plugin_api.tasks(sender="NODE_A"))
    assert len(calls) == 1
    assert all(t["task_id"] != "g1" for t in out["tasks"])


# ---------------------------------------------------------------------------
# bulk failure — serve the cache, never fan out
# ---------------------------------------------------------------------------

def test_bulk_failure_serves_cache_without_fanout(track_file, monkeypatch):
    for tid in ("b1", "b2", "b3"):
        _track(tid)
    plugin_api._tasks_state["b1"] = (time.monotonic(), {**_full("b1"), "_full": True})
    plugin_api._tasks_state["b2"] = (
        time.monotonic(),
        {"task": {"task_id": "b2", "status": "running"}, "stages": [],
         "artifacts": [], "notes": [], "_full": True},
    )
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli",
        _fake_run(calls, list_error=RuntimeError("node-cli exit 7: relay down")),
    )
    out = asyncio.run(plugin_api.tasks())
    assert calls == [["task", "list", "--status", "pending,running,cancelled"]]
    by_id = {t["task_id"]: t for t in out["tasks"]}
    assert by_id["b1"]["stages_fetched"] is True          # cached full served
    assert by_id["b2"]["status"] == "running"             # stale cache served
    assert by_id["b3"]["status"] == "fetch_error"         # nothing to serve
    assert any("task list" in e for e in out["errors"])


# ---------------------------------------------------------------------------
# (b) explicit detail route — full view only on demand
# ---------------------------------------------------------------------------

def test_task_detail_route_fetches_and_caches(track_file, monkeypatch):
    _track("t9")
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli",
        _fake_run(calls, list_rows=[], results={"t9": _full("t9")}),
    )
    out = asyncio.run(plugin_api.task_detail("t9"))
    assert out["ok"] is True
    assert out["task"]["stages_fetched"] is True
    assert out["task"]["session_id"] == "sess_X"
    assert calls == [["task", "result", "t9"]]
    # second detail call: cached — no new subprocess
    asyncio.run(plugin_api.task_detail("t9"))
    assert calls == [["task", "result", "t9"]]


def test_task_detail_rejects_invalid_ids(track_file, monkeypatch):
    calls = []
    monkeypatch.setattr(plugin_api, "_run_node_cli", _fake_run(calls))
    out = asyncio.run(plugin_api.task_detail(""))
    assert out["ok"] is False
    out = asyncio.run(plugin_api.task_detail("x" * 65))
    assert out["ok"] is False
    assert calls == []


def test_fetch_error_row_is_not_fabricated_when_result_fails(track_file, monkeypatch):
    _track("t10")
    calls = []
    monkeypatch.setattr(
        plugin_api, "_run_node_cli",
        _fake_run(calls, list_rows=[], results={}),  # task result → not found
    )
    out = asyncio.run(plugin_api.tasks())
    row = next(t for t in out["tasks"] if t["task_id"] == "t10")
    assert row["status"] == "fetch_error"
    assert "RuntimeError" in row["error"]
    assert any("t10" in e for e in out["errors"])
