"""IOWAP fleet backend for the Hermes desktop plugin (plugin id: iowap).

Mounted at /api/plugins/iowap/* inside the Hermes gateway process. The desktop
renderer reaches it via ctx.rest('/fleet') from plugin.js — see the SDK docs.

Design rules (see repo README):
- node-cli (installed pip package `iowap-node`) is the ONLY relay client here.
  It owns auth, token refresh and token files (~/.relay/*); this backend never
  reads tokens, never talks raw HTTP to the relay.
- node-cli is invoked with the global --json flag *before* the subcommand
  (root-level flag; `node-cli update check --json` fails with
  "unrecognized arguments" — same class of pitfall).
- Run from HOME, not from an iowap checkout: a local `nodes/` package shadowing
  site-packages would silently run repo code instead of the installed wheel.
- Load values from CT nodes are cgroup2/agent-scoped; `load_source` surfaces
  what the value actually means. Values >100 are forwarded as-is (server
  schema clamps/validates elsewhere; never fabricate a 100 here).
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter

log = logging.getLogger("iowap.api")

router = APIRouter()

# ---------------------------------------------------------------------------
# node-cli discovery / execution
# ---------------------------------------------------------------------------

NODE_CLI = shutil.which("node-cli") or "node-cli"


async def _run_node_cli(args: list[str], timeout: float = 20.0) -> str:
    """Run node-cli --json <args>, return stdout (JSON text)."""
    cmd = [NODE_CLI, "--json", *args]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd="/home/felix",  # never an iowap checkout (nodes/ shadow pitfall)
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        body, errb = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError(f"node-cli {' '.join(args)} timed out after {timeout}s")
    if proc.returncode != 0:
        detail = (errb or body).decode("utf-8", "replace").strip()
        raise RuntimeError(f"node-cli exit {proc.returncode}: {detail[:300]}")
    return body.decode("utf-8", "replace")


def _loads_json(raw: str) -> Any:
    return json.loads(raw) if raw.strip() else None


# ---------------------------------------------------------------------------
# Health: unauthenticated /relay/v2/health probe (httpx from the gateway env)
# ---------------------------------------------------------------------------

_health_state: dict[str, tuple[float, dict]] = {}
HEALTH_TTL = 30.0  # cache seconds; the relay health endpoint is trivial load
HEALTH_TIMEOUT = 5.0


async def _relay_health() -> dict:
    import httpx  # gateway process dependency — hermes-agent ships it

    now = time.monotonic()
    cached = _health_state.get("v")
    if cached and now - cached[0] < HEALTH_TTL:
        return cached[1]

    base = None
    cfg_path = "/home/felix/.relay/iowap-agent.json"
    try:
        with open(cfg_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
        base = (meta.get("base_url") or "").rstrip("/")
    except Exception:
        base = None
    if not base:
        base = "http://192.168.2.60:8788"  # documented relay address

    url = f"{base}/health"
    try:
        async with httpx.AsyncClient(timeout=HEALTH_TIMEOUT) as client:
            resp = await client.get(url)
        data: dict = {"status": resp.status_code, "url": url}
        try:
            data["body"] = resp.json()
        except Exception:
            data["body"] = None
    except Exception as exc:  # network down, refused, timeouts — never 500 the UI
        data = {"error": f"{type(exc).__name__}: {exc}", "url": url}

    _health_state["v"] = (now, data)
    return data


# ---------------------------------------------------------------------------
# /fleet — the one endpoint the desktop frontend consumes
# ---------------------------------------------------------------------------

@dataclass
class NodeProbe:
    node_id: str
    name: str
    error: str | None = None
    result: dict | None = None


def _node_errors(errors: list[str]) -> list[str]:
    return errors


@router.get("/fleet")
async def fleet() -> dict:
    """Full fleet snapshot: node list + capability map + relay health.

    Stages: node list (~1s, serial) then parallel per-node `node info` probes
    (each shells out to a fresh node-cli process; the daemon remains a separate
    process — a CLI probe never disturbs it). Never raises: errors are reported
    per source so the UI can keep rendering with warnings.
    """
    started = time.monotonic()

    # --- source 1: node list (fast, single call) ------------------------------
    try:
        raw = await _run_node_cli(["node", "list"], timeout=25.0)
        nodes = _loads_json(raw) or []
        nodes = nodes if isinstance(nodes, list) else []
    except Exception as exc:
        log.warning("node list probe failed: %s: %s", type(exc).__name__, exc)
        nodes = []
    node_errors: list[str] = []
    if not nodes:
        node_errors.append("node list failed — see gateway log")

    # --- source 2: capability map (from the same server, single call) ---------
    try:
        raw = await _run_node_cli(["capabilities", "server"], timeout=25.0)
        caps_raw = _loads_json(raw) or []
        caps_raw = caps_raw if isinstance(caps_raw, list) else []
    except Exception as exc:
        log.warning("capabilities server probe failed: %s: %s", type(exc).__name__, exc)
        caps_raw = []
        cap_errors = ["capabilities map failed — see gateway log"]
    else:
        cap_errors = []

    by_id: dict[str, dict] = {}
    for entry in caps_raw:
        if not isinstance(entry, dict):
            continue
        for n in entry.get("nodes") or []:
            if isinstance(n, dict) and n.get("node_id"):
                by_id.setdefault(n["node_id"], {"caps": [], "avail": 0})
                by_id[n["node_id"]]["caps"].append(entry.get("name"))
                if n.get("available"):
                    by_id[n["node_id"]]["avail"] += 1

    # --- source 3: health probe (unauth, cached 30s) --------------------------
    health = await _relay_health()

    # --- source 4: per-node info — queue_depth, load_source, description ------
    # Only meaningful for role 'node'/'worker' entries with a daemon; service
    # roles (storage/flow-runner) and admin rows skip it. One round of
    # asyncio.gather, bounded by the CLI timeout.
    probes: dict[str, NodeProbe] = {}
    workerlike = [
        n for n in nodes
        if n.get("role") in ("node", "worker")
        and isinstance(n.get("node_id"), str)
    ]
    if workerlike:
        async def _probe(meta: dict, node_id: str) -> NodeProbe:
            p = NodeProbe(
                node_id=node_id,
                name=str(meta.get("node_name") or node_id),
            )
            try:
                raw = await _run_node_cli(["node", "info", node_id], timeout=15.0)
                p.result = _loads_json(raw) or {}
            except Exception as exc:
                p.error = f"{type(exc).__name__}: {str(exc)[:120]}"
            return p

        for p in await asyncio.gather(
            *(_probe(n, str(n["node_id"])) for n in workerlike)
        ):
            probes[p.node_id] = p

    # --- merge into the render shape ----------------------------------------
    merged_nodes = []
    for n in nodes:
        node_id = n.get("node_id") or n.get("node_name") or "?"
        cap_meta = by_id.get(node_id)
        p = probes.get(node_id)
        info = p.result if (p and isinstance(p.result, dict)) else {}
        merged_nodes.append({
            "node_id": node_id,
            "node_name": n.get("node_name"),
            "role": n.get("role", "node"),
            "status": n.get("status", "offline"),
            "load": n.get("load"),
            "load_source": (info.get("load_source") if isinstance(info.get("load_source"), str) else None),
            "queue_depth": (
                info.get("queue_depth", n.get("queue_depth"))
                if isinstance(info.get("queue_depth"), int)
                else n.get("queue_depth")
            ),
            "busy": bool(info.get("busy")) if "busy" in info else bool(n.get("busy")),
            "last_seen": n.get("last_seen"),
            "available": bool(n.get("available")),
            "capabilities": n.get("capabilities") or [],
            "cap_count": len(by_id.get(node_id, {}).get("caps", []) or (n.get("capabilities") or [])),
            "probe_error": (p.error if p else None),
        })

    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "backend": "node-cli",
        "nodes": merged_nodes,
        "capability_map": {k: v["caps"] for k, v in by_id.items()},
        "health": health,
        "errors": node_errors + cap_errors + [
            p.error for p in probes.values() if p.error
        ],
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }