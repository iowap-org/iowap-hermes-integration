#!/usr/bin/env bash
# Deploy both halves of the iowap plugin to the live Hermes plugin dirs and
# verify byte-identity with the repo. Frontend hot-reloads via file watcher;
# the Python backend imports once at app start (backend edits need one
# restart — the deploy does NOT restart the app).
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Parent dirs first — on a fresh host (or after a manual cleanup) neither the
# desktop plugin dir nor the backend dashboard dir exists yet; `install -m`
# does not create them (live finding 2026-10-25: backend half wiped by a half
# catalog install attempt → deploy failed with ENOENT).
mkdir -p "$HOME/.hermes/desktop-plugins/iowap" "$HOME/.hermes/plugins/iowap/dashboard" "$HOME/.local/bin"

install -m 644 "$repo/desktop/plugin.js" "$HOME/.hermes/desktop-plugins/iowap/plugin.js"
install -m 644 "$repo/plugin.yaml" "$HOME/.hermes/desktop-plugins/iowap/plugin.yaml"
install -m 644 "$repo/dashboard/plugin_api.py" "$HOME/.hermes/plugins/iowap/dashboard/plugin_api.py"
install -m 644 "$repo/dashboard/manifest.json" "$HOME/.hermes/plugins/iowap/dashboard/manifest.json"
install -m 755 "$repo/tools/iowap-task" "$HOME/.local/bin/iowap-task"  # T-016: bridge deploys too

fail=0
for pair in \
  "$repo/desktop/plugin.js:$HOME/.hermes/desktop-plugins/iowap/plugin.js" \
  "$repo/plugin.yaml:$HOME/.hermes/desktop-plugins/iowap/plugin.yaml" \
  "$repo/dashboard/plugin_api.py:$HOME/.hermes/plugins/iowap/dashboard/plugin_api.py" \
  "$repo/dashboard/manifest.json:$HOME/.hermes/plugins/iowap/dashboard/manifest.json" \
  "$repo/tools/iowap-task:$HOME/.local/bin/iowap-task"; do
  src="${pair%%:*}"; dst="${pair##*:}"
  a=$(md5sum "$src" | cut -d' ' -f1); b=$(md5sum "$dst" | cut -d' ' -f1)
  if [ "$a" != "$b" ]; then
    echo "MISMATCH: $dst" >&2; fail=1
  else
    echo "ok: $dst"
  fi
done
[ "$fail" -eq 0 ] || exit 1
echo "deployed. frontend live via hot-reload; backend edit? restart the app once."