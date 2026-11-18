"""T-250: the desktop plugin's local daemon self-sight is a direct read.

Contract:
- `node-cli daemon status` no longer exists (iowap-cli carries no daemon
  code since iowap-node 2.3.40 — argparse usage error, exit 2). The
  plugin therefore reads worker_status.json directly and probes BOTH daemon
  pid files (SSE node-daemon.pid, poll node-cli.pid) with the same
  mode preference as the node's own status: poll wins when both are alive.
- The dict shape consumed by desktop/plugin.js (running / heartbeat_status
  / tasks_completed) must stay stable; `mode` is additive.
"""
import importlib
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch as mock_patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dashboard"))

import pytest

plugin_api = importlib.import_module("plugin_api")


class TestPidAlive:
    def test_alive_pid(self, tmp_path):
        pid_file = tmp_path / "d.pid"
        pid_file.write_text(f"{os.getpid()}\n", encoding="utf-8")  # this process is alive
        assert plugin_api._pid_alive(pid_file) == os.getpid()

    def test_dead_pid(self, tmp_path):
        pid_file = tmp_path / "d.pid"
        pid_file.write_text("999999\n", encoding="utf-8")
        with mock_patch.object(plugin_api.os, "kill", side_effect=ProcessLookupError):
            assert plugin_api._pid_alive(pid_file) is None

    def test_missing_file(self, tmp_path):
        assert plugin_api._pid_alive(tmp_path / "nope.pid") is None

    def test_garbage_content(self, tmp_path):
        pid_file = tmp_path / "d.pid"
        pid_file.write_text("not-a-pid\n", encoding="utf-8")
        assert plugin_api._pid_alive(pid_file) is None

    def test_zero_and_negative_rejected(self, tmp_path):
        for bad in ("0\n", "-5\n"):
            pid_file = tmp_path / "d.pid"
            pid_file.write_text(bad, encoding="utf-8")
            assert plugin_api._pid_alive(pid_file) is None


class TestLocalDaemonStatus:
    def test_running_sse_daemon_visible(self, tmp_path):
        """Acceptance: the running SSE daemon (node-daemon.pid) is seen —
        running True, mode sse (this was invisible via the removed CLI)."""
        (tmp_path / "node-daemon.pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
        status_file = tmp_path / "worker_status.json"
        status_file.write_text(json.dumps({
            "pid": os.getpid(),
            "daemon": "node-daemon",
            "last_heartbeat": "2026-11-18T15:26:29+00:00",
            "heartbeat_status": "ok",
            "active_profile": "default",
            "tasks_completed": 3,
            "tasks_failed": 1,
        }), encoding="utf-8")
        with mock_patch.object(plugin_api, "_SSE_PID_FILE", tmp_path / "node-daemon.pid"), \
             mock_patch.object(plugin_api, "_POLL_PID_FILE", tmp_path / "node-cli.pid"), \
             mock_patch.object(plugin_api, "_WORKER_STATUS_FILE", status_file):
            d = plugin_api._local_daemon_status()
        assert d["running"] is True
        assert d["mode"] == "sse"
        assert d["pid"] == os.getpid()
        assert d["heartbeat_status"] == "ok"
        assert d["tasks_completed"] == 3
        assert d["tasks_failed"] == 1
        assert d["active_profile"] == "default"

    def test_not_running_shape(self, tmp_path):
        """No pid files, no status file → the old none-shape plus mode None."""
        with mock_patch.object(plugin_api, "_SSE_PID_FILE", tmp_path / "node-daemon.pid"), \
             mock_patch.object(plugin_api, "_POLL_PID_FILE", tmp_path / "node-cli.pid"), \
             mock_patch.object(plugin_api, "_WORKER_STATUS_FILE", tmp_path / "worker_status.json"):
            d = plugin_api._local_daemon_status()
        assert d["running"] is False
        assert d["pid"] is None
        assert d["mode"] is None
        assert d["heartbeat_status"] is None
        assert d["tasks_completed"] is None

    def test_poll_mode_wins_when_both_alive(self, tmp_path):
        """Both pid files alive → mode poll (same preference as the node's
        mode-aware status; T-137b forbids this state in production)."""
        (tmp_path / "node-daemon.pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
        (tmp_path / "node-cli.pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
        with mock_patch.object(plugin_api, "_SSE_PID_FILE", tmp_path / "node-daemon.pid"), \
             mock_patch.object(plugin_api, "_POLL_PID_FILE", tmp_path / "node-cli.pid"), \
             mock_patch.object(plugin_api, "_WORKER_STATUS_FILE", tmp_path / "worker_status.json"):
            d = plugin_api._local_daemon_status()
        assert d["running"] is True
        assert d["mode"] == "poll"
        assert d["pid"] == os.getpid()

    def test_corrupt_status_file_degrades(self, tmp_path):
        """A corrupt worker_status.json never crashes self-sight — pid/mode
        come from the pid files, the counters degrade to None."""
        (tmp_path / "node-daemon.pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
        status_file = tmp_path / "worker_status.json"
        status_file.write_text("{not json", encoding="utf-8")
        with mock_patch.object(plugin_api, "_SSE_PID_FILE", tmp_path / "node-daemon.pid"), \
             mock_patch.object(plugin_api, "_POLL_PID_FILE", tmp_path / "node-cli.pid"), \
             mock_patch.object(plugin_api, "_WORKER_STATUS_FILE", status_file):
            d = plugin_api._local_daemon_status()
        assert d["running"] is True
        assert d["mode"] == "sse"
        assert d["tasks_completed"] is None

    def test_non_int_counters_degrade(self, tmp_path):
        status_file = tmp_path / "worker_status.json"
        status_file.write_text(json.dumps({"tasks_completed": "many", "tasks_failed": None}), encoding="utf-8")
        with mock_patch.object(plugin_api, "_SSE_PID_FILE", tmp_path / "node-daemon.pid"), \
             mock_patch.object(plugin_api, "_POLL_PID_FILE", tmp_path / "node-cli.pid"), \
             mock_patch.object(plugin_api, "_WORKER_STATUS_FILE", status_file):
            d = plugin_api._local_daemon_status()
        assert d["running"] is False  # no pid file → not running
        assert d["tasks_completed"] is None
        assert d["tasks_failed"] is None
