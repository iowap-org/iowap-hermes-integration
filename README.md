# IOWAP Hermes Integration

A [Hermes desktop](https://hermes-agent.nousresearch.com) plugin that puts
[IOWAP](https://github.com/iowap-org/iowap) fleet data into the desktop app:
a statusbar chip (relay status, nodes online) and a fleet pane (node list
with capabilities).

## Install

```bash
mkdir -p ~/.hermes/desktop-plugins/iowap
curl -o ~/.hermes/desktop-plugins/iowap/plugin.js \
  https://raw.githubusercontent.com/iowap-org/iowap-hermes-integration/main/plugin.js
```

Then run **Reload desktop plugins** from the ⌘K palette in the Hermes desktop
app (the app also hot-reloads the file on every save while it exists).

The plugin id is `iowap` — the folder name must match it (SDK requirement).

## Status

**v0.1.0-skeleton** — chip + fleet pane placeholder. Live relay data arrives
in T-002 via the plugin's Python backend (`plugin_api.py`), which shells out
to `node-cli --json` — the desktop frontend never touches relay tokens or
HTTP directly.

Planned areas (see repo `PLAN.md` on the local project board):

- Statusbar chip with live "N online" and health dot
- Fleet pane: node list with capabilities, load, click-through details
- ⌘K command: submit a small probe task to a named node

## Layout of this repo

```
plugin.js     ← the whole plugin (copy to ~/.hermes/desktop-plugins/iowap/)
README.md     ← this file
```

## License

MIT — see [LICENSE](LICENSE).