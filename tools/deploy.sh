#!/usr/bin/env bash
# Deploy both halves of the iowap plugin to the live Hermes plugin dirs and
# verify byte-identity with the repo. Frontend hot-reloads via file watcher;
# the Python backend imports once at app start (backend edits need one
# restart — the deploy does NOT restart the app).
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

install -m 644 "$repo/plugin.js" "$HOME/.hermes/desktop-plugins/iowap/plugin.js"
install -m 644 "$repo/dashboard/plugin_api.py" "$HOME/.hermes/plugins/iowap/dashboard/plugin_api.py"
install -m 644 "$repo/dashboard/manifest.json" "$HOME/.hermes/plugins/iowap/dashboard/manifest.json"

fail=0
for pair in \
  "$repo/plugin.js:$HOME/.hermes/desktop-plugins/iowap/plugin.js" \
  "$repo/dashboard/plugin_api.py:$HOME/.hermes/plugins/iowap/dashboard/plugin_api.py" \
  "$repo/dashboard/manifest.json:$HOME/.hermes/plugins/iowap/dashboard/manifest.json"; do
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