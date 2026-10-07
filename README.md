# IOWAP Hermes Integration

A [Hermes desktop](https://hermes-agent.nousresearch.com) plugin that puts
[IOWAP](https://github.com/iowap-org/iowap) fleet data into the desktop app:

- **Statusbar chip** — live dot + `N/M` nodes online, click opens the fleet page
- **Fleet pane** (right zone, draggable) — compact node list
- **Fleet page** (`/iowap-fleet`, sidebar nav + ⌘K) — full overview: status,
  load, queue depth, capabilities per node, plus an **Activity** section
  (daemon self-sight, tracked tasks, task-capability provider health)
- **Tasks page** (`/iowap-tasks`, sidebar nav + ⌘K) — submit a task to any
  task-type capability (capability picker, JSON payload, optional name),
  track an existing task by its relay id, and watch tracked tasks live
  (per-stage status dots, result previews, artifacts). Tasks submitted from
  agent sessions via `iowap-task submit` (repo `tools/iowap-task`, installed
  at `~/.local/bin/iowap-task`) land in the same track store — the bridge
  wraps `node-cli task submit` and merges into
  `~/.hermes/cache/task-track-iowap.json`. Owner-directed tasks
  (`--owner <node_id>`) show as `delegated` rows (result unreadable from
  this node — server-side T-005g scoping) instead of fetch errors.
- **⌘K commands** — refresh fleet data, notify fleet status, open the pages

## Architecture

```
desktop renderer (plugin.js)        gateway process (plugin_api.py)        relay
┌─────────────────────┐   ctx.rest  ┌──────────────────────────┐  node-cli  ┌───────┐
│ chip / pane / page  │ ──────────► │ /api/plugins/iowap/fleet │ ─────────► │ :8788 │
└─────────────────────┘             └──────────────────────────┘            └───────┘
```

The desktop **frontend** never touches relay HTTP or tokens. The **backend**
(`/api/plugins/iowap/*`) shells out to `node-cli --json`, which owns all relay
auth and token handling (`~/.relay/*`). Relay tokens never enter the renderer.

## Install

**Desktop half** (chip, pane, page, commands):

```bash
mkdir -p ~/.hermes/desktop-plugins/iowap
curl -o ~/.hermes/desktop-plugins/iowap/plugin.js \
  https://raw.githubusercontent.com/iowap-org/iowap-hermes-integration/main/plugin.js
```

**Backend half** (fleet data through node-cli):

```bash
mkdir -p ~/.hermes/plugins/iowap/dashboard
curl -o ~/.hermes/plugins/iowap/dashboard/manifest.json \
  https://raw.githubusercontent.com/iowap-org/iowap-hermes-integration/main/dashboard/manifest.json
curl -o ~/.hermes/plugins/iowap/dashboard/plugin_api.py \
  https://raw.githubusercontent.com/iowap-org/iowap-hermes-integration/main/dashboard/plugin_api.py
hermes config set plugins.enabled '["iowap"]'
```

**Update an installed plugin** (this machine — from the repo):

```bash
tools/deploy.sh   # copies both halves, verifies md5; frontend hot-reloads,
                  # backend edits need one app restart
```

Requires `node-cli` (pip `iowap-node`) on the desktop host and a logged-in node
state (`~/.relay/iowap-agent.*`). Then **restart the Hermes desktop app** (the
backend imports live in the gateway process — a plugin reload is not enough the
first time) and run **Reload desktop plugins** (⌘K) afterwards for frontend
edits. Without the backend the UI degrades gracefully to an error hint.

The plugin id is `iowap` — the desktop folder name must match it (SDK
requirement). Enable the desktop half in **Capabilities → Plugins** if it
stays off.

## Status

**v0.2.0-fleet** — chip + pane + page + palette commands, live data via
`node-cli`. The relay health probe is an unauthenticated `/health` GET.
Per-node detail (`load_source`) distinguishes host-load (`loadavg`) from
agent-scoped cgroup values — do not compare load numbers across nodes.

## Layout of this repo

```
plugin.js                   ← desktop half (→ ~/.hermes/desktop-plugins/iowap/)
dashboard/manifest.json     ← backend manifest (→ ~/.hermes/plugins/iowap/dashboard/)
dashboard/plugin_api.py     ← backend routes (→ ~/.hermes/plugins/iowap/dashboard/)
README.md
```

## License

MIT — see [LICENSE](LICENSE).