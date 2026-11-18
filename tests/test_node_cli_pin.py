"""node.yaml cli-pin resolution (T-012).

iowap-cli self-stamps its absolute path as the top-level ``node_cli_path``
key in ``~/.relay/node.yaml`` (T-226, iowap-node 2.3.20). The desktop
gateway inherits no login-shell PATH and the known-candidates list cannot
enumerate every install layout (live mac case: the binary lives in
``~/iowap-node/.venv/bin/node-cli`` — none of the candidates, and the
desktop-spawned PATH finds nothing).

Contract for EVERY iowap-cli consumer in this repo — the backend
(``_resolve_node_cli``, ``_check_setup``) and the session bridge
(``tools/iowap-task``):

* the node.yaml pin is the FIRST link of the resolution chain — an
  executable pin wins even when PATH finds another binary;
* the pin is read-only: a stale/nonexistent pin FALLS THROUGH (which →
  known candidates) instead of blocking the backend;
* only a top-level (column-0) ``node_cli_path:`` counts; indented keys
  inside capability blocks are never picked up;
* quoted and bare scalars both parse;
* T-250 shim sunset: the known-candidates list probes ONLY the
  ``iowap-cli`` binary — the legacy ``node-cli`` console script is gone
  (iowap-node 2.3.43 removed the shims), its known locations are dead
  candidates (the pin stays the first link and records the stamped
  iowap-cli path).
"""

import importlib.machinery
import importlib.util
import json
import pathlib
import sys
from pathlib import Path

import pytest

_HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "dashboard"))
import plugin_api  # noqa: E402


def _fake_exe(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n")
    path.chmod(0o755)
    return path


@pytest.fixture()
def fake_home(tmp_path, monkeypatch):
    """Path.home() → isolated home with ~/.relay; no other host state."""
    home = tmp_path / "home"
    (home / ".relay").mkdir(parents=True)
    monkeypatch.setattr(
        pathlib.Path, "home", classmethod(lambda cls: home)
    )
    return home


@pytest.fixture()
def fake_home_no_relay(tmp_path, monkeypatch):
    home = tmp_path / "noshow"
    home.mkdir(parents=True)
    monkeypatch.setattr(
        pathlib.Path, "home", classmethod(lambda cls: home)
    )
    return home


# ------------------------------------------------------------ backend chain


def test_pin_beats_path_and_candidates(fake_home, monkeypatch):
    pin = _fake_exe(fake_home / "iowap" / "bin" / "iowap-cli")
    (fake_home / ".relay" / "node.yaml").write_text(
        f'node_cli_path: "{pin}"\n', encoding="utf-8"
    )

    resolved = plugin_api._resolve_node_cli()

    assert resolved == str(pin)


def test_stale_pin_falls_through_to_which(fake_home, monkeypatch):
    (fake_home / ".relay" / "node.yaml").write_text(
        'node_cli_path: "/gone/away/node-cli"\n', encoding="utf-8"
    )
    monkeypatch.setattr(plugin_api.shutil, "which", lambda _p: "/which/one/cli")

    assert plugin_api._resolve_node_cli() == "/which/one/cli"


def test_stale_pin_and_dead_which_fall_through_to_candidates(
    fake_home, monkeypatch
):
    (fake_home / ".relay" / "node.yaml").write_text(
        'node_cli_path: "/gone/away/node-cli"\n', encoding="utf-8"
    )
    monkeypatch.setattr(plugin_api.shutil, "which", lambda _p: None)
    candidate = _fake_exe(
        fake_home / ".hermes" / "hermes-agent" / "venv" / "bin" / "iowap-cli"
    )
    # _NODE_CLI_CANDIDATES is import-time baked against the real HOME —
    # point it at the isolated home so only the isolated inventory counts
    monkeypatch.setattr(
        plugin_api, "_NODE_CLI_CANDIDATES", (candidate,)
    )

    assert plugin_api._resolve_node_cli() == str(candidate)


def test_bare_scalar_and_spaces_stripped(fake_home):
    pin = _fake_exe(fake_home / ".local" / "bin" / "iowap-cli")
    (fake_home / ".relay" / "node.yaml").write_text(
        f"node_cli_path:  {pin}  \n", encoding="utf-8"
    )
    assert plugin_api._resolve_node_cli() == str(pin)


def test_indented_key_inside_capability_ignored(fake_home, monkeypatch):
    (fake_home / ".relay" / "node.yaml").write_text(
        "capabilities:\n"
        "  - name: probe.cap\n"
        "    node_cli_path: /evil/inside/cap\n"
        "    handler: /bin/true\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(plugin_api.shutil, "which", lambda _p: "/which/one/cli")

    assert plugin_api._resolve_node_cli() == "/which/one/cli"


def test_missing_node_yaml_falls_through(fake_home_no_relay, monkeypatch):
    monkeypatch.setattr(plugin_api.shutil, "which", lambda _p: "/which/one/cli")
    assert plugin_api._resolve_node_cli() == "/which/one/cli"


def test_check_setup_uses_the_pin(fake_home, monkeypatch):
    pin = _fake_exe(fake_home / "iowap" / "bin" / "iowap-cli")
    (fake_home / ".relay" / "node.yaml").write_text(
        f'node_cli_path: "{pin}"\n', encoding="utf-8"
    )
    (fake_home / ".relay" / "iowap-agent.json").write_text(
        json.dumps({"node_id": "NODE23A4", "node_name": "node-23a"})
    )

    setup = plugin_api._check_setup(force=True)

    assert setup["ready"] is True
    assert setup["node_cli"] == str(pin)


# ------------------------------------------------------------ T-250 shim sunset


def test_backend_candidates_are_iowap_cli_only():
    """T-250 shim sunset: the legacy node-cli console script is gone — the
    known-locations list probes exactly the three iowap-cli directories,
    order preserved (venv bin → .local/bin → /usr/local/bin)."""
    cands = [str(c) for c in plugin_api._NODE_CLI_CANDIDATES]
    home = Path.home()
    assert cands == [
        str(home / ".hermes/hermes-agent/venv/bin/iowap-cli"),
        str(home / ".local/bin/iowap-cli"),
        "/usr/local/bin/iowap-cli",
    ]
    assert not any("node-cli" in c for c in cands)


def test_backend_candidate_reached_with_dead_pin_and_path(
    fake_home, monkeypatch
):
    """Stale pin, dead PATH — the binary in a known location still resolves
    the runner (candidates are fallback depth of the chain; the pin stays
    the first link when a live one exists)."""
    (fake_home / ".relay" / "node.yaml").write_text(
        'node_cli_path: "/gone/away/node-cli"\n', encoding="utf-8"
    )
    monkeypatch.setattr(plugin_api.shutil, "which", lambda _p: None)
    rebrand = _fake_exe(
        fake_home / ".hermes" / "hermes-agent" / "venv" / "bin" / "iowap-cli"
    )
    # mirror the real list shape against the isolated home (the production
    # tuple is import-time baked against the real HOME)
    monkeypatch.setattr(
        plugin_api,
        "_NODE_CLI_CANDIDATES",
        (
            fake_home / ".hermes/hermes-agent/venv/bin/iowap-cli",
            fake_home / ".local/bin/iowap-cli",
            "/usr/local/bin/iowap-cli",
        ),
    )

    assert plugin_api._resolve_node_cli() == str(rebrand)


def test_backend_first_candidate_directory_wins(fake_home, monkeypatch):
    """Order guarantee among the remaining candidates: the first listed
    known location (venv bin) beats later ones."""
    monkeypatch.setattr(plugin_api.shutil, "which", lambda _p: None)
    bin_dir = fake_home / ".hermes" / "hermes-agent" / "venv" / "bin"
    local_bin = fake_home / ".local" / "bin"
    first = _fake_exe(bin_dir / "iowap-cli")
    _fake_exe(local_bin / "iowap-cli")
    monkeypatch.setattr(
        plugin_api,
        "_NODE_CLI_CANDIDATES",
        (bin_dir / "iowap-cli", local_bin / "iowap-cli"),
    )

    assert plugin_api._resolve_node_cli() == str(first)


def test_check_setup_ready_via_iowap_cli_candidate(fake_home, monkeypatch):
    """Setups pass the setup gate through the iowap-cli candidate —
    _check_setup and _resolve_node_cli share the same list."""
    monkeypatch.setattr(plugin_api.shutil, "which", lambda _p: None)
    rebrand = _fake_exe(
        fake_home / ".hermes" / "hermes-agent" / "venv" / "bin" / "iowap-cli"
    )
    (fake_home / ".relay" / "iowap-agent.json").write_text(
        json.dumps({"node_id": "NODE23A4", "node_name": "node-23a"})
    )
    monkeypatch.setattr(plugin_api, "_NODE_CLI_CANDIDATES", (rebrand,))

    setup = plugin_api._check_setup(force=True)

    assert setup["ready"] is True
    assert setup["node_cli"] == str(rebrand)


# ------------------------------------------------------------ session bridge


def _load_bridge(tmp_path, monkeypatch):
    """Load tools/iowap-task as a module with isolated HERMES_HOME."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    loader = importlib.machinery.SourceFileLoader(
        "iowap_task_bridge", str(_HERE.parent / "tools" / "iowap-task")
    )
    spec = importlib.util.spec_from_loader(loader.name, loader)
    bridge = importlib.util.module_from_spec(spec)
    loader.exec_module(bridge)
    return bridge


def test_bridge_pin_beats_path(fake_home, tmp_path, monkeypatch):
    pin = _fake_exe(fake_home / "iowap" / "bin" / "iowap-cli")
    (fake_home / ".relay" / "node.yaml").write_text(
        f"node_cli_path: {pin}\n", encoding="utf-8"
    )
    bridge = _load_bridge(tmp_path, monkeypatch)

    assert bridge.find_node_cli() == str(pin)


def test_bridge_stale_pin_falls_through(fake_home, tmp_path, monkeypatch):
    (fake_home / ".relay" / "node.yaml").write_text(
        'node_cli_path: "/gone/away/node-cli"\n', encoding="utf-8"
    )
    monkeypatch.setattr(plugin_api.shutil, "which", lambda _p: "/which/one/cli")
    bridge = _load_bridge(tmp_path, monkeypatch)

    assert bridge.find_node_cli() == "/which/one/cli"


def test_bridge_candidates_are_iowap_cli_only(tmp_path, monkeypatch):
    """T-250 shim sunset: tools/iowap-task mirrors the backend list —
    exactly the three iowap-cli paths, order preserved, no node-cli."""
    bridge = _load_bridge(tmp_path, monkeypatch)
    cands = [str(c) for c in bridge._NODE_CLI_CANDIDATES]
    home = Path.home()
    assert cands == [
        str(home / ".hermes/hermes-agent/venv/bin/iowap-cli"),
        str(home / ".local/bin/iowap-cli"),
        "/usr/local/bin/iowap-cli",
    ]
    assert not any("node-cli" in c for c in cands)


def test_bridge_candidate_reached_with_dead_pin_and_path(
    fake_home, tmp_path, monkeypatch
):
    """No usable pin, dead PATH — the bridge still finds the binary in a
    known location (fallback depth)."""
    (fake_home / ".relay" / "node.yaml").write_text(
        'node_cli_path: "/gone/away/node-cli"\n', encoding="utf-8"
    )
    monkeypatch.setattr(plugin_api.shutil, "which", lambda _p: None)
    bridge = _load_bridge(tmp_path, monkeypatch)
    rebrand = _fake_exe(
        fake_home / ".hermes" / "hermes-agent" / "venv" / "bin" / "iowap-cli"
    )
    monkeypatch.setattr(bridge, "_NODE_CLI_CANDIDATES", (rebrand,))

    assert bridge.find_node_cli() == str(rebrand)