# Changelog

Dates in Europe/Berlin. Behavior changes bump minor, fixes bump patch.

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