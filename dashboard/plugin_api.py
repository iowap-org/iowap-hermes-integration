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
- Load values from CT nodes are cgroup/agent-scoped; `load_source` surfaces
  what the value actually means. Values >100 are forwarded as-is (server
  schema clamps/validates elsewhere; never fabricate a 100 here).

Additional endpoints (T-006):
- GET /activity  — capability-level view: providers, queue_depth (the honest
  fleet-wide "has work right now" signal; node-cli has no task list endpoint,
  so per-task activity on remote nodes is NOT observable from here), local
  daemon status, local node identity.
- GET /tasks     — status of tasks TRACKED BY THIS PLUGIN. Tracking is opt-in
  because node-cli can only fetch task results whose owner identity matches
  this node (server-side T-005g scoping on the result endpoint).
  Sources (v2): POST /tasks/submit (dashboard form), POST /tasks/track, and
  the session-side bridge tools/iowap-task (agent sessions) — all merge into
  the SAME flock-protected store (~/.hermes/cache/task-track-iowap.json,
  {"ids": [...], "meta": {...}}). Owner-directed tasks (`--owner <node_id>`)
  stay unreadable from this node BY DESIGN; they are tracked as `delegated`
  rows (honest status "delegated" + note, 24h prune) instead of surfacing as
  fetch_errors on every reload.
- POST /tasks/submit — submit a single-stage task (capability + JSON payload)
  and track it.
- POST /tasks/track — add an existing task_id to tracking; pass
  {"delegated": true} for owner-scoped tasks to skip the fetchability check.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import shutil
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter

log = logging.getLogger("iowap.api")

router = APIRouter()

# ---------------------------------------------------------------------------
# node-cli discovery / execution
# ---------------------------------------------------------------------------

# Known install locations, probed at call time. The desktop-spawned gateway
# process does NOT inherit the login-shell PATH (desktop.log: "login-shell
# PATH resolution unavailable; keeping inherited PATH"), so shutil.which()
# alone finds nothing there — resolution must not depend on the ambient PATH.
_NODE_CLI_CANDIDATES = (
    "/home/felix/.hermes/hermes-agent/venv/bin/node-cli",
    "/home/felix/.local/bin/node-cli",
    "/usr/local/bin/node-cli",
)


def _resolve_node_cli() -> str:
    found = shutil.which("node-cli")
    if found:
        return found
    # Also probe inside known venvs' bin dirs that may not be on PATH.
    for cand in _NODE_CLI_CANDIDATES:
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return "node-cli"  # let create_subprocess_exec raise a clear error


async def _run_node_cli(args: list[str], timeout: float = 20.0, ok: tuple[int, ...] = (0,)) -> str:
    """Run node-cli --json <args>, return stdout (JSON text).

    `ok`: additional exit codes that still count as success with parseable
    output (e.g. `daemon status` exits 1 when the daemon is not running while
    still printing its status block).
    """
    cmd = [_resolve_node_cli(), "--json", *args]
    env = dict(os.environ)
    # Guarantee the venv bin dir is visible to node-cli itself (e.g. for
    # sub-spawns), regardless of how empty the desktop-spawned PATH is.
    venv_bin = "/home/felix/.hermes/hermes-agent/venv/bin"
    if os.path.isdir(venv_bin) and venv_bin not in env.get("PATH", ""):
        env["PATH"] = env.get("PATH", "") + os.pathsep + venv_bin
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd="/home/felix",  # never an iowap checkout (nodes/ shadow pitfall)
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        body, errb = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError(f"node-cli {' '.join(args)} timed out after {timeout}s")
    if proc.returncode not in ok:
        detail = (errb or body).decode("utf-8", "replace").strip()
        raise RuntimeError(f"node-cli exit {proc.returncode}: {detail[:300]}")
    return body.decode("utf-8", "replace")


def _loads_json(raw: str) -> Any:
    return json.loads(raw) if raw.strip() else None


# ---------------------------------------------------------------------------
# Health: unauthenticated /health probe (httpx from the gateway env)
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


def _normalize_fields(schema: dict | None) -> dict[str, dict]:
    """Normalize a capability input schema to the dashboard field dialect.

    Two dialects exist on the fleet (T-202, live-verified 2026-10-07):
    - Relay-native: {"fields": {name: {name, type, required, description, …}}}
      (felix-cyberfox profile, storage, bot-desktop, webstack).
    - JSON-Schema:  {"type": "object", "properties": {name: {type,
      description}}, "required": [...]} — what NovaForge heartbeats.

    The TaskForm reader (plugin.js "TaskForm") only understands the relay
    dialect, so JSON-Schema caps silently rendered an empty form. The server
    stays dumb per the dumb-server doctrine — this consumer-side normalizer
    maps the second dialect onto the first. Returns {} when the capability
    genuinely takes no input (e.g. mc.list.players).
    """
    if not isinstance(schema, dict):
        return {}
    fields = schema.get("fields")
    if isinstance(fields, dict):
        return {k: v for k, v in fields.items() if isinstance(v, dict)}
    props = schema.get("properties")
    if not isinstance(props, dict):
        return {}
    required = {
        r for r in (schema.get("required") or [])
        if isinstance(r, str)
    }
    out: dict[str, dict] = {}
    for name, defn in props.items():
        if not isinstance(defn, dict):
            defn = {}
        fdef: dict[str, Any] = {"name": name, "type": defn.get("type") or "string"}
        if name in required:
            fdef["required"] = True
        if isinstance(defn.get("description"), str) and defn["description"]:
            fdef["description"] = defn["description"]
        if defn.get("default") is not None:
            fdef["example"] = defn["default"]
        out[name] = fdef
    return out


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


# ---------------------------------------------------------------------------
# /activity — capability-level "who has work right now" (best effort)
# ---------------------------------------------------------------------------

@router.get("/activity")
async def activity() -> dict:
    """Capability-level activity view.

    Per capability: provider nodes with available flag, queue_depth and load —
    the honest fleet-wide "busy right now" signal available WITHOUT a task list
    endpoint. Plus the local node's daemon status (daemon status is the only
    per-task self view: tasks_completed/failed/in-flight counters).
    """
    started = time.monotonic()
    errors: list[str] = []

    # --- capability instances from the server -------------------------------
    try:
        raw = await _run_node_cli(["capabilities", "server"], timeout=25.0)
        caps_raw = _loads_json(raw) or []
        caps_raw = caps_raw if isinstance(caps_raw, list) else []
    except Exception as exc:
        errors.append(f"capabilities server: {type(exc).__name__}: {str(exc)[:150]}")
        caps_raw = []

    caps = []
    for entry in caps_raw:
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        providers = []
        for n in entry.get("nodes") or []:
            if not isinstance(n, dict):
                continue
            providers.append({
                "node_id": n.get("node_id"),
                "node_name": n.get("node_name"),
                "available": bool(n.get("available")),
                "queue_depth": n.get("queue_depth") if isinstance(n.get("queue_depth"), int) else None,
                "load": n.get("load") if isinstance(n.get("load"), (int, float)) else None,
            })
        fields = (entry.get("input_schema") or {}).get("fields") if isinstance(entry.get("input_schema"), dict) else None
        cap_type = entry.get("type") or ""
        # Task-submit-worthy: standard submit path (capability:json stage).
        # 'native' caps are relay storage/admin ops — not submittable from here.
        selectable = cap_type in ("", "task", "ai", "tool", "workflow")
        # T-202: normalize BOTH schema dialects (relay-native "fields" and the
        # JSON-Schema dialect NovaForge heartbeats) to the TaskForm dialect.
        fields = _normalize_fields(entry.get("input_schema"))
        caps.append({
            "name": entry["name"],
            "type": entry.get("type"),
            "description": (entry.get("description") or "")[:220],
            "version": entry.get("version"),
            "selectable": selectable,
            "providers": providers,
            "provider_count": len(providers),
            "available": bool(entry.get("available")),
            "fields": fields if isinstance(fields, dict) else {},
            "result_path_hints": entry.get("result_path_hints"),
        })
    caps.sort(key=lambda c: (c["type"] or "", c["name"]))

    # --- local daemon status (self-sight counters + heartbeat) ---------------
    # NOTE: `daemon status` exits 1 when the daemon is NOT running but still
    # prints the full status block — that is a valid answer, not an error.
    daemon: dict = {"running": None}
    try:
        raw = await _run_node_cli(["daemon", "status"], timeout=10.0, ok=(1,))
        kv: dict[str, str] = {}
        for line in raw.strip().splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                kv[k.strip()] = v.strip()
        daemon = {
            "running": kv.get("running") == "True",
            "pid": int(kv["pid"]) if (kv.get("pid") or "").lstrip("-").isdigit() else None,
            "active_profile": kv.get("active_profile"),
            "last_heartbeat": kv.get("last_heartbeat"),
            "heartbeat_status": kv.get("heartbeat_status"),
            "tasks_completed": int(kv["tasks_completed"]) if (kv.get("tasks_completed") or "").isdigit() else None,
            "tasks_failed": int(kv["tasks_failed"]) if (kv.get("tasks_failed") or "").isdigit() else None,
        }
    except Exception as exc:
        errors.append(f"daemon status: {type(exc).__name__}: {str(exc)[:150]}")

    # --- local node identity (read-only json file, no tokens) ----------------
    local_node = None
    try:
        with open("/home/felix/.relay/iowap-agent.json", "r", encoding="utf-8") as fh:
            meta = json.load(fh)
        local_node = {"node_id": meta.get("node_id"), "node_name": meta.get("node_name")}
    except Exception:
        local_node = None

    # Summarize "active" per capability: any provider with queue_depth > 0 or
    # (unknown queue) & available — flag as active_est where signals exist.
    for c in caps:
        with_signal = [p for p in c["providers"] if p["queue_depth"] is not None]
        c["active_est"] = any((p["queue_depth"] or 0) > 0 or p["load"] and p["load"] >= 90 for p in with_signal)
        c["queues_total"] = sum(p["queue_depth"] or 0 for p in with_signal)

    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "capabilities": caps,
        "local_node": local_node,
        "daemon": daemon,
        # tracked task ids, newest first (the tasks endpoint keeps this fresh)
        "tracked_count": len(_tracked_list()),
        "errors": errors,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


# ---------------------------------------------------------------------------
# /tasks — track tasks submitted (or pinned) from this plugin
# ---------------------------------------------------------------------------

_TASKS_TTL = 6 * 3600  # forget finished tasks after 6h
_tasks_state: dict[str, tuple[float, dict]] = {}  # task_id -> (last_fetch_ts, result)


_TRACK_FILE = Path("/home/felix/.hermes/cache/task-track-iowap.json")


@contextmanager
def _track_file_lock(exclusive: bool):
    """Open the track file under an flock (shared read / exclusive write).

    The store is shared with the session-side submit bridge
    (tools/iowap-task), which runs outside the gateway process and has no
    access to backend memory — the file IS the interface between them.
    """
    _TRACK_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not _TRACK_FILE.exists():
        _TRACK_FILE.touch()
    fh = _TRACK_FILE.open("r+" if exclusive else "r", encoding="utf-8")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield fh
    finally:
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        fh.close()


def _track_store_read() -> dict:
    """Read the track store: {"ids": [...], "meta": {task_id: {...}, …}}.

    Tolerates the legacy {"ids": [...]} layout (meta comes back empty) and
    returns an empty store for unreadable content.
    """
    try:
        with _track_file_lock(exclusive=False) as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        return {"ids": [], "meta": {}}
    except Exception:
        log.warning("iowap track file unreadable, treating as empty: %s", _TRACK_FILE)
        return {"ids": [], "meta": {}}
    if not isinstance(raw, dict):
        return {"ids": [], "meta": {}}
    ids = [t for t in (raw.get("ids") or []) if isinstance(t, str)]
    meta = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
    return {"ids": ids, "meta": meta}


_TRACK_META_MAX = 50  # tracking is capped to the newest 50 ids


def _track_store_merge(tid: str, meta: dict | None = None) -> bool:
    """Add/refresh one tracked id + meta under an exclusive flock.

    New ids go to the front; the store holds at most _TRACK_META_MAX ids
    (metadata of dropped ids is pruned with them). Returns True when the
    id was newly added.
    """
    with _track_file_lock(exclusive=True) as fh:
        try:
            raw = json.load(fh)
        except Exception:
            raw = {}
        ids = [t for t in (raw.get("ids") or []) if isinstance(t, str)]
        meta_map = raw.get("meta") if isinstance(raw.get("meta"), dict) else {}
        added = tid not in ids
        if added:
            ids.insert(0, tid)
            ids = ids[:_TRACK_META_MAX]
        if meta:
            meta_map = {**meta_map, tid: {**meta_map.get(tid, {}), **meta}}
        live = set(ids)
        meta_map = {k: v for k, v in meta_map.items() if k in live}
        fh.seek(0)
        fh.truncate()
        json.dump({"ids": ids, "meta": meta_map}, fh)
        return added


def _track_store_write(ids: list[str], meta: dict | None = None) -> None:
    """Full rewrite under an exclusive flock (used by the prune path)."""
    with _track_file_lock(exclusive=True) as fh:
        fh.seek(0)
        fh.truncate()
        json.dump({"ids": ids, "meta": meta or {}}, fh)


def _tracked_list() -> list[str]:
    """Ids currently tracked — prunes finished/expired/delegated-stale rows."""
    store = _track_store_read()
    meta = store["meta"]
    now = time.monotonic()
    now_wall = time.time()  # meta.submitted_at is wall clock (survives restarts)
    keep = []
    for tid in store["ids"]:
        m = meta.get(tid) or {}
        if m.get("delegated"):
            # owner-scoped tasks are never fetchable from this node
            # (server-side T-005g scoping) — drop once older than a day
            try:
                stale = now_wall - float(m.get("submitted_at", 0)) > 24 * 3600
            except (TypeError, ValueError):
                stale = False
            if stale:
                meta.pop(tid, None)
                continue
        else:
            ent = _tasks_state.get(tid)
            if ent and now - ent[0] > _TASKS_TTL and ent[1].get("task", {}).get("status") in (
                "completed", "failed", "timed_out"
            ):
                meta.pop(tid, None)
                continue
        keep.append(tid)
    if len(keep) != len(store["ids"]) or meta != store["meta"]:
        _track_store_write(keep, meta)
    # evict stale cache entries the store no longer tracks — _tasks_state is
    # process-lifetime otherwise (full TaskViews leak until gateway restart)
    if set(_tasks_state) - set(keep):
        for dropped in set(_tasks_state) - set(keep):
            _tasks_state.pop(dropped, None)
    return keep


async def _fetch_task(task_id: str) -> dict:
    """Fetch one task result via node-cli; caches within a short TTL."""
    now = time.monotonic()
    cached = _tasks_state.get(task_id)
    status = None
    if cached:
        status = cached[1].get("task", {}).get("status")
        # fresh enough for non-terminal, never refetch terminal
        if cached[0] and (now - cached[0] < 3.0 or status in ("completed", "failed", "timed_out")):
            return cached[1]
    raw = await _run_node_cli(["task", "result", task_id], timeout=15.0)
    data = _loads_json(raw)
    if not isinstance(data, dict) or "task" not in data:
        raise RuntimeError(f"unexpected task result shape for {task_id}")
    _tasks_state[task_id] = (now, data)
    return data


def _summarize_task(data: dict) -> dict:
    task = data.get("task") or {}
    stages = []
    for s in data.get("stages") or []:
        stages.append({
            "stage_id": s.get("stage_id"),
            "stage_name": s.get("stage_name"),
            "capability": s.get("capability"),
            "status": s.get("status"),
            "claimed_by": s.get("claimed_by"),
            "claimed_at": s.get("claimed_at"),
            "completed_at": s.get("completed_at"),
            "retry_count": s.get("retry_count"),
            # result: compact preview only; full text stays in task result
            "result_preview": _result_preview(s.get("result")),
        })
    return {
        "task_id": task.get("task_id"),
        "name": task.get("task_name"),
        "status": task.get("status"),
        "priority": task.get("priority"),
        "owner_node_id": task.get("owner_node_id"),
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
        "stages": stages,
        "artifacts": [
            {"id": a.get("artifact_id") or a.get("id"), "name": a.get("name"), "size": a.get("size")}
            for a in (data.get("artifacts") or []) if isinstance(a, dict)
        ],
        "notes": [
            {"node": n.get("node_id") or n.get("node_name"), "text": n.get("text"), "ts": n.get("ts") or n.get("created_at")}
            for n in (data.get("notes") or []) if isinstance(n, dict)
        ],
    }


def _result_preview(result: Any) -> str | None:
    """Compact preview of a stage result. Walks result_path_hints-style keys."""
    if result is None:
        return None
    # result is often {"status": ..., "result": {"answer": "..."}} — dig for the
    # first plausible text value without importing anything relay-specific.
    stack = [result]
    while stack:
        cur = stack.pop(0)
        if isinstance(cur, str) and cur.strip():
            return cur[:400]
        if isinstance(cur, dict):
            # prioritize common keys
            for k in ("answer", "result", "output", "text", "content", "stdout"):
                if k in cur:
                    stack.insert(0, cur[k])
                    break
            else:
                stack[:0] = [v for v in cur.values() if isinstance(v, (str, dict, list))]
        elif isinstance(cur, (list, tuple)):
            # lists (e.g. search results) previously fell through both branches
            # and were silently discarded — push their items instead
            stack[:0] = [x for x in cur if isinstance(x, (str, dict, list))][:3]
    # last resort for shapes the walk cannot textualize: compact JSON
    try:
        compact = json.dumps(result, ensure_ascii=False, separators=(",", ":"))
        return compact[:400] if compact and compact != "null" else None
    except (TypeError, ValueError):
        return None


@router.get("/tasks")
async def tasks() -> dict:
    """Status of all tracked tasks, fetched concurrently, never raises."""
    started = time.monotonic()
    ids = _tracked_list()
    store = _track_store_read()
    meta = store["meta"]
    errors: list[str] = []

    async def _safe(tid: str) -> dict:
        m = meta.get(tid) or {}
        if m.get("delegated"):
            # Owner-scoped tasks are intentionally unreadable from this node
            # (server-side T-005g owner scoping) — render an honest
            # placeholder row instead of a per-reload fetch_error.
            return {
                "task_id": tid,
                "name": m.get("name") or m.get("capability") or "delegated task",
                "status": "delegated",
                "capability": m.get("capability"),
                "owner_node_id": m.get("owner"),
                "delegated": True,
                "stages": [],
                "artifacts": [],
                "notes": [],
                "note": ("result not readable from this node — owner-scoped "
                         "(node-cli task result <id> on the owner, or ask the relay admin DB)"),
            }
        try:
            data = await _fetch_task(tid)
            return _summarize_task(data)
        except Exception as exc:
            errors.append(f"{tid}: {type(exc).__name__}: {str(exc)[:150]}")
            return {"task_id": tid, "status": "fetch_error", "error": str(exc)[:200]}

    summaries = list(await asyncio.gather(*(_safe(t) for t in ids))) if ids else []
    order = {tid: i for i, tid in enumerate(ids)}
    summaries.sort(key=lambda s: order.get(s["task_id"], 999))
    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "tasks": summaries,
        "errors": errors,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }


@router.post("/tasks/submit")
async def tasks_submit(payload: dict) -> dict:
    """Submit a single-stage task via node-cli and track it.

    Body: {"capability": str, "payload": object, "name"?: str,
           "priority"?: int 0-10, "owner"?: str node_id}
    argv-safe: capability is a single argv element, payload is passed as a
    compact JSON string — no shell interpolation anywhere.
    """
    capability = payload.get("capability")
    body = payload.get("payload")
    if not isinstance(capability, str) or not capability.strip():
        return {"ok": False, "error": "capability required"}
    if body is None:
        body = {}
    if not isinstance(body, dict):
        return {"ok": False, "error": "payload must be a JSON object"}
    stage = f"{capability}:{json.dumps(body, separators=(',', ':'))}"
    args = ["task", "submit", "--stage", stage]
    name = payload.get("name")
    if isinstance(name, str) and name.strip():
        args += ["--name", name.strip()[:120]]
    priority = payload.get("priority")
    if isinstance(priority, int) and 0 <= priority <= 10:
        args += ["--priority", str(priority)]
    owner = payload.get("owner")
    if isinstance(owner, str) and owner.strip():
        args += ["--owner", owner.strip()[:32]]

    try:
        raw = await _run_node_cli(args, timeout=30.0)
        data = _loads_json(raw) or {}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:200]}"}

    task_id = data.get("task_id")
    if isinstance(task_id, str) and task_id:
        _track_store_merge(task_id, {
            "capability": payload.get("capability"),
            "name": (name.strip()[:120] if isinstance(name, str) and name.strip() else None),
            "owner": owner.strip()[:32] if isinstance(owner, str) and owner.strip() else None,
            "delegated": bool(isinstance(owner, str) and owner.strip()),
            "submitted_at": time.time(),  # wall clock: survives gateway restarts
        })
    return {"ok": True, "task_id": task_id, "status": data.get("status"),
            "capability": data.get("capability")}


@router.post("/tasks/track")
async def tasks_track(payload: dict) -> dict:
    """Add an existing task_id to tracking. Body: {"task_id": str,
    "capability"/"name"/"owner": optional meta, "delegated": bool}.

    delegated=True skips the fetchability sanity check — owner-scoped tasks
    are intentionally unreadable from this node (server-side T-005g scoping).
    """
    tid = payload.get("task_id")
    if not isinstance(tid, str) or not tid.strip() or len(tid) > 64:
        return {"ok": False, "error": "task_id required"}
    tid = tid.strip()
    delegated = payload.get("delegated") is True
    if not delegated:
        try:
            await _fetch_task(tid)  # sanity: must be fetchable
        except Exception as exc:
            # maybe it became fetchable again / or it IS fetchable but stale
            return {"ok": False, "error": f"task not fetchable: {str(exc)[:200]}"}
    _track_store_merge(tid, {
        "capability": payload.get("capability"),
        "name": payload.get("name") if isinstance(payload.get("name"), str) else None,
        "owner": payload.get("owner") if isinstance(payload.get("owner"), str) else None,
        "delegated": delegated,
        "submitted_at": time.time(),
    })
    return {"ok": True, "task_id": tid}