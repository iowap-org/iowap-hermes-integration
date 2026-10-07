/**
 * IOWAP — Hermes desktop plugin (skeleton, Phase 1 / T-001).
 * Statusbar chip + fleet pane placeholder. Real relay data (nodes online,
 * health) lands in T-002 via the plugin's Python backend — never raw HTTP
 * from the desktop: node-cli owns auth/token handling (see iowap-node-ops).
 *
 * Install: copy this file to  ~/.hermes/desktop-plugins/iowap/plugin.js
 * Reload: ⌘K → "Reload desktop plugins" (the app also hot-reloads on save).
 */

import { cn, haptic, host, Tip, usePluginI18n, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'iowap'

function FleetPane() {
  const t = usePluginI18n(ID)

  return jsxs('div', {
    className: 'flex h-full flex-col gap-2 p-3 text-sm',
    children: [
      jsx('div', { className: 'font-medium', children: t('paneTitle') }),
      jsx('div', {
        className: 'text-(--ui-text-tertiary)',
        children: t('panePlaceholder')
      }),
      jsx('div', {
        className: 'text-(--ui-text-quaternary)',
        children: useValue(host.state.gateway)
      })
    ]
  })
}

function StatusChip() {
  const t = usePluginI18n(ID)

  return jsx(Tip, {
    label: t('chipTip'),
    children: jsx('button', {
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      type: 'button',
      onClick: () => {
        haptic('tap')
        host.notify({ kind: 'info', message: t('hello') })
      },
      children: jsx('span', {
        className: 'inline-flex items-center gap-1',
        children: [
          jsx('span', {
            className: 'h-1.5 w-1.5 rounded-full',
            style: { backgroundColor: 'var(--ui-text-quaternary)' } // placeholder dot; status color in T-002
          }),
          t('chipLabel')
        ]
      })
    })
  })
}

export default {
  id: ID, // must match the folder name (~/.hermes/desktop-plugins/iowap/)
  name: 'IOWAP Hermes Integration',
  register(ctx) {
    ctx.i18n.register({
      en: {
        paneTitle: 'IOWAP Fleet',
        panePlaceholder: 'Node list lands here once the fleet data wiring (T-002) is done — relay data flows through the plugin backend, not the desktop.',
        chipTip: 'IOWAP — open fleet',
        hello: 'IOWAP plugin online',
        chipLabel: 'iowap'
      },
      de: {
        paneTitle: 'IOWAP Fleet',
        panePlaceholder: 'Hier landet die Node-Liste, sobald die Datenanbindung (T-002) steht — Relay-Daten laufen über das Plugin-Backend, nicht über den Desktop.',
        chipTip: 'IOWAP — Fleet öffnen',
        hello: 'IOWAP-Plugin online',
        chipLabel: 'iowap'
      }
    })

    // Fleet pane — right zone; the user can drag it anywhere afterwards.
    ctx.register({
      id: 'fleet-pane',
      area: 'panes',
      title: 'iowap fleet',
      data: { placement: 'right', width: '260px' },
      render: () => jsx(FleetPane, {})
    })

    // Statusbar chip (right side).
    ctx.register({
      id: 'status-chip',
      area: 'statusBar.right',
      order: 130,
      render: () => jsx(StatusChip, {})
    })
  }
}