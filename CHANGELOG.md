# Changelog

Dates in Europe/Berlin. Behavior changes bump minor, fixes bump patch.

## 0.5.0 — 2026-10-30

### Added
- **Fully configurable task & fleet notification center** (Notifications
  page, sidebar + ⌘K): chat, pane and chip each switchable per area,
  chat target (origin / manual session id), draft | direct mode, one
  fleet chat session id, bounded event log (100 entries, clearable).
- **Notifications in chat, pane and chip**: chat posts event-only watch
  lines into the submitting session (fail-closed, per teknium1 review);
  the pane shows task tiles with copy-to-clipboard; the status chip
  flashes the last event ("node <name> online/offline", "task <id>
  completed", relay up/down).
- **All defaults OFF**: nothing posts, flashes or tiles until explicitly
  enabled on the Notifications page.
- Fleet-page activity rows: last 8 tracked tasks with per-stage status
  dots; per-locale nav labels.

### Fixed
- A failed direct submit no longer silently degrades into a draft — it
  surfaces as a toast + log line; drafts are only written in draft mode.
- The task watch bridge (tools/iowap-task) deploys as the 5th pair with
  md5 verify — it was silently missing from every deploy before.
- Chip flash tolerates both payload shapes (string vs. object) so the
  flash reports the correct event.
- Rules-of-hooks crash in the fleet pane (conditional useValue inside a
  ternary broke the Slot tree).
- Undefined stageDotClass symbol on activity-row dots — crash on the
  first activity render with data.
- Task tiles wrap (`break-all`) instead of truncating mid-name.

### Notes
- The deploy/commit gate now verifies the render-smoke exit code, so a
  broken build can no longer be pushed or synced unnoticed.
- Storage quirk observed once: an app restart can lose plugin-storage
  config (mode fell back to its draft default); re-selecting the option
  re-persists it. Failing safe, no behavior change needed.

### Testing
- Release-exercised live on the night of 2026-10-30: many test tasks
  fired end-to-end (single runs, a 5-task batch, draft and direct mode,
  mounted and unmounted targets, chip flash, pane tiles and fleet
  activity rows) — every delivery event-only and fail-closed, every
  toggle verified.

### Acknowledgements
- Huge thanks to **teknium1** — an extremely thorough review, as always.
  Every point landed in code, and the notification center is the better
  product for it.

## 0.4.2 — 2026-10-29 (PR #144628 review response)

### Changed — consent model overhauled (teknium1 review, all three points)
- **Everything OFF by default.** The watcher no longer posts anywhere until
  the user opts in on the new **IOWAP Notifications page**
  (`/iowap-notifications`, sidebar + ⌘K). Composer posts carry the user's
  typing authority, so they require the user's explicit enablement.
- **No more `submit(null, …)` auto-addressing.** Task messages are routed
  into **the session that submitted the task**: agent submits carry their
  session id (`tools/iowap-task --session <id>`, MCP `task_submit(
  session_id=…)`), the backend rides it through `/tasks` as
  `session_id`, and the watcher posts **per task, per origin session**
  (grouped so one sweep yields one delivery per distinct target; a
  not-mounted session drops the post fail-closed). Tasks-Page submits
  default to **draft**; a **draft | direct** switch and an optional
  manual session id live on the notifications page.
- **Node output no longer enters chat at all.** Posts are event-only
  lines — task name, task id, stage/final status. No `result_preview`, no
  raw `error` text rides in a user-typed message (the reviewer's
  untrusted-quotation point solved by eliminating the channel entirely;
  details are pulled via `task_result`/Tasks page when needed).
- **Fleet/relay/long-run messages go to `host.notify`** (toast /
  notification center) by default; optional chat posts into one
  explicitly configured session id (fleet monitoring section).
- The notifications page **collects every message** from both areas in a
  bounded log (100 entries, clearable) — the one place to see what the
  watcher reported, independent of chat/notify routing.
- i18n: all new settings/log strings in en/de/es/fr.

### Fixed
- The ⌘K toggle and the Tasks-page switch now drive the tasks-chat gate
  (`notify.tasks.chat`) instead of the retired `watch.enabled` key; fresh
  installs start with the watcher fully OFF.

## 0.4.1 — 2026-10-25

### Fixed
- **Longrun hint no longer lies about queued tasks**: the ⏳ hint fired for
  **pending (queued, unclaimed) tasks** after 5 min of watcher sight —
  during a 17-task queue pileup that meant 17 "running for 5 min" lines
  for tasks that had not started at all. The hint now fires only for
  tasks whose status is `running` (actually claimed by a node). Live
  false-positive reproduced: ⏳ for a task that had finished long ago
  (it sat in the tracker as a `fetch_error` tombstone — see below).
- **The hint's minute count is honest now**: it measures watcher sight
  time, so the wording says "running for at least N min" (any earlier
  queue time is not measurable from the watcher).
- **`fetch_error` tombstones are pruned**: a task the relay now 404s
  leaves no cache entry, so the finished-task prune never matched and the
  row stayed in `/tasks` (and in the watcher registry) forever, feeding
  the longrun bug and bloating the Tasks page. Rows aged past the 6 h TTL
  without any cached status now fall out of the store; rows with no
  usable `submitted_at` stay (conservative default). RED→GREEN proven
  with two new store tests (31 total).

## 0.4.0 — 2026-10-25

### Added
- **Task watcher**: stage results and final task states are posted
  automatically into the active chat via `host.composer` (send with the
  user's typing authority, fail-closed — never a broadcast; without a
  mounted composer the update lands as a draft plus a toast). Posted
  lines carry the task id. Toggle via the Tasks-page switch or a ⌘K
  command with a live on/off detail; the preference and the sweep
  registry are persisted, so reloads and redeploys never double-post.
- **Fleet watch**: node status transitions (online → anything else = one
  ⚠️ warning, back online = ✅ recovery) and relay reachability
  (unreachable → one ⚠️, reachable again → ✅) post under the same
  toggle. Runs on the fleet query the chip/pane/page already poll — no
  extra polling.
- **Long-run hint**: a task non-terminal for more than 5 minutes posts a
  one-time ⏳ hint with the run time; its final post is unaffected.
- Locales: full **Spanish** and **French** bundles (chat lines
  included); status enums stay English. Other app locales fall back to
  English.

### Fixed
- The task form consumes the backend-computed `selectable` flag (with
  the legacy `type !== 'native'` filter only as fallback), instead of
  re-deriving the vocabulary split in the frontend.
- `tools/deploy.sh` creates the parent directories itself and installs
  `plugin.yaml` (install + md5 pair) — the deployed desktop half no
  longer drifts below the repo version.

### Changed
- Watch/fleet chat lines, the toggle label and the ⌘K command follow the
  app locale deliberately (en/de/es/fr bundles; everything else falls
  back to English).

## 0.3.2 — 2026-10-16

### Fixed
- node-cli resolution got a first link that does not depend on PATH or a
  guessed install layout: the top-level `node_cli_path` pin in
  `~/.relay/node.yaml`, **self-stamped by node-cli itself** (T-226,
  iowap-node 2.3.20). The desktop-spawned gateway inherits no
  login-shell PATH, and the hardcoded candidate list missed real layouts
  (live: mac node-cli at `~/iowap-node/.venv/bin/node-cli` — plugin could
  not find node-cli although it was installed). Chain: node.yaml pin →
  PATH → known venv locations; a stale pin falls through, the pin read is
  strictly read-only. `tools/iowap-task` mirrors the same chain.

## 0.3.1 — 2026-10-10

### Fixed
- Relay health probe runs through node-cli itself (`node-cli server
  health`): the backend never talks raw HTTP to the relay anymore and no
  longer hand-parses the relay URL out of `~/.relay/iowap-agent.json` —
  that file has carried no `base_url` since the iowap-node 2.3.17 wheel
  (T-198 pin move to `relay_config.json`), which made the old probe
  report "relay not configured" while the relay was healthy (live
  finding). Relay-target resolution (pin, mDNS fallback) is node-cli's
  business now.
- Frontend `healthLineOf` renders the node-cli body shape (`body.ok`);
  the legacy raw-`/health` shape is still accepted for one app-restart
  window.
- Render smoke test additionally covers the health-error state.

### Changed
- Docstrings, test fixtures and bridge examples use generic example
  values (Node-23A / NODE23A4 style) instead of real node names/ids.

## 0.3.0 — 2026-10-08

- Native catalog layout: `desktop/plugin.js` + root `plugin.yaml`
  (kind: desktop) — `hermes plugins validate` passes. Catalog entry
  merged upstream (#134804, 2026-10-10).
- Tasks page (submit / track / live list) + session-side bridge
  `tools/iowap-task` writing the same flock-protected track store as the
  backend (v2 schema: per-id meta; owner-directed tasks render as honest
  `delegated` rows with a 24h prune — server-side T-005g owner scoping
  keeps their results unreadable from this node by design).
- Setup gate: catalog users on hosts without an IOWAP setup get
  onboarding guidance instead of probe-error noise.
- Capability form normalization for both input-schema dialects
  (relay-native `fields` and JSON Schema).

## 0.2.0 — 2026-10-07

- Live statusbar chip (StatusDot tone + N/M nodes online), draggable
  fleet pane, fleet page, palette commands (refresh/status/pages), i18n
  en+de. Fleet data through node-cli (`node list`, `capabilities
  server`), relay health via raw unauthenticated `/health`.

## 0.1.0 — 2026-10-07

- Skeleton: statusbar chip + pane placeholder.