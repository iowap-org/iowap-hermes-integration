/**
 * IOWAP Hermes Integration — fleet statusbar chip + fleet pane + fleet page.
 *
 * Data source: the plugin's Python backend (plugin_api.py → /api/plugins/iowap),
 * which shells out to `node-cli` on the desktop host. node-cli owns all relay
 * auth/token handling — relay tokens never enter the desktop renderer.
 * Backend missing (not enabled in config.yaml) → the UI degrades to an error
 * state with a hint, it never crashes the app.
 *
 * Install:
 *   desktop half:   ~/.hermes/desktop-plugins/iowap/plugin.js   (this file)
 *   backend half:   ~/.hermes/plugins/iowap/dashboard/{manifest.json, plugin_api.py}
 *                   + "iowap" in config.yaml → plugins.enabled
 * Reload: hot-reloads on save; fallback ⌘K → "Reload desktop plugins".
 * Backend needs a gateway (app) restart after the config change.
 */

import {
  cn, haptic, host, Tip, Badge, Button, StatusDot,
  icons, relativeTime,
  usePluginI18n, useValue, useQuery, useQueryClient, queryClient, atom,
  PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'iowap'
const FLEET_KEY = [ID, 'fleet']

// ---------------------------------------------------------------------------
// Pure helpers (module scope, no ctx)
// ---------------------------------------------------------------------------

function pickName(n) {
  return n?.node_name || n?.node_id || '?'
}

function workerNodes(data) {
  // Admin/service-bookkeeping rows (e.g. Dashboard Admin) are not workers.
  return (data?.nodes || []).filter(n => (n.role ?? 'node') !== 'admin')
}

function statusTone(n) {
  if (n?.status === 'online') return 'good'
  if (n?.status === 'pending' || n?.status === 'approved') return 'warn'
  return 'bad'
}

function ageStr(iso) {
  const t = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(t) || Date.now() - t < 1500) return 'now'
  return relativeTime(t)
}


function summaryOf(data) {
  const nodes = workerNodes(data)
  const online = nodes.filter(n => n.status === 'online')
  const errors = data?.errors || []
  let tone = 'good'
  if (!nodes.length) tone = 'bad'
  else if (errors.length || online.length !== nodes.length) tone = 'warn'
  if (errors.length && !online.length) tone = 'bad'
  return { tone, online: online.length, total: nodes.length, errors }
}

function healthLineOf(h) {
  if (!h) return null
  if (h.error) return `relay unreachable (${String(h.error).slice(0, 60)})`
  const body = h.body || {}
  const parts = []
  if (body.status) parts.push(`relay ${body.status}`)
  if (body.version) parts.push(`v${body.version}`)
  return parts.length ? parts.join(' · ') : null
}

function loadStr(n) {
  return typeof n?.load === 'number' ? (Math.round(n.load * 10) / 10).toFixed(1) : '–'
}

function queueOf(n) {
  return typeof n?.queue_depth === 'number' ? n.queue_depth : 0
}

// ---------------------------------------------------------------------------
// register(ctx) — components close over ctx (rest, i18n, storage)
// ---------------------------------------------------------------------------

export default {
  id: ID, // must match the folder name (~/.hermes/desktop-plugins/iowap/)
  name: 'IOWAP Hermes Integration',
  register(ctx) {
    // Latest fleet summary for imperative readers (palette detail, chip notify).
    const lastSummary = atom({ tone: 'muted', online: 0, total: 0, errors: [] })

    function useFleet() {
      return useQuery({
        queryKey: FLEET_KEY,
        queryFn: async () => {
          const res = await ctx.rest('/fleet', { timeoutMs: 20000 })
          lastSummary.set(summaryOf(res))
          return res
        },
        refetchInterval: 5000,
        refetchIntervalInBackground: false
      })
    }

    // -----------------------------------------------------------------
    // Statusbar chip: live dot + online/total counter
    // -----------------------------------------------------------------
    function Chip() {
      const t = usePluginI18n(ID)
      const summary = useValue(lastSummary)

      return jsx(Tip, {
        label: t('chipTip'),
        children: jsx('button', {
          className: cn(
            'inline-flex h-full items-center gap-1.5 px-1.5 text-[0.6875rem] transition-colors',
            'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          ),
          type: 'button',
          onClick: () => {
            haptic('tap')
            host.navigate('/iowap-fleet')
          },
          children: jsxs('span', {
            className: 'inline-flex items-center gap-1',
            children: [
              jsx(StatusDot, { tone: summary.tone }),
              jsx('span', { children: ID }),
              jsx('span', { className: 'tabular-nums', children: `${summary.online}/${summary.total}` })
            ]
          })
        })
      })
    }

    // -----------------------------------------------------------------
    // Fleet pane (right zone): compact node list
    // -----------------------------------------------------------------
    function NodeRow({ n }) {
      return jsx('button', {
        className: cn(
          'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left',
          'text-(--ui-text-secondary) hover:bg-(--chrome-action-hover)'
        ),
        type: 'button',
        onClick: () => {
          haptic('tap')
          host.navigate('/iowap-fleet')
        },
        children: [
          jsx(StatusDot, { tone: statusTone(n) }),
          jsx('span', { className: 'flex-1 truncate', children: pickName(n) }),
          jsx('span', { className: 'text-(--ui-text-quaternary)', children: String(n.capabilities?.length || 0) })
        ]
      })
    }

    function FleetPane() {
      const t = usePluginI18n(ID)
      const { data, isError, error, isFetching } = useFleet()
      const info = summaryOf(data)
      const hl = healthLineOf(data?.health)

      return jsxs('div', {
        className: 'flex h-full flex-col gap-2 p-3 text-sm',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between',
            children: [
              jsx('div', { className: 'font-medium', children: t('paneTitle') }),
              jsxs('span', {
                className: cn('inline-flex items-center gap-1.5 tabular-nums', isFetching && 'opacity-60'),
                children: [
                  jsx(StatusDot, { tone: info.tone }),
                  jsx('span', { children: `${info.online}/${info.total}` })
                ]
              })
            ]
          }),
          hl ? jsx('div', { className: 'text-xs text-(--ui-text-quaternary) truncate', children: hl }) : null,
          jsxs('div', {
            className: 'min-h-0 flex-1 overflow-y-auto',
            children: [
              !data && !isError
                ? jsx('div', { className: 'text-(--ui-text-quaternary)', children: t('loading') })
                : null,
              data && workerNodes(data).map(n => jsx(NodeRow, { key: n.node_id || pickName(n), n }))
            ]
          }),
          isError
            ? jsx('div', {
                className: 'text-xs text-destructive break-words',
                children: [t('loadErr'), error?.message || String(error || ''), t('enableHint')]
                  .filter(Boolean).join(' — ')
              })
            : null,
          info.errors.length
            ? jsx('div', {
                className: 'text-xs text-(--ui-text-quaternary) truncate',
                children: info.errors.length + '× ' + t('partialErr') + ': ' + info.errors[0]
              })
            : null
        ]
      })
    }

    // -----------------------------------------------------------------
    // Fleet page (/iowap-fleet): full overview with capabilities
    // -----------------------------------------------------------------
    function NodeCard({ n }) {
      const t = usePluginI18n(ID)
      const caps = (n.capabilities || []).map(c => c?.name).filter(Boolean)
      return jsxs('div', {
        className: cn(
          'flex flex-col gap-2 rounded-lg border border-(--ui-stroke-secondary)',
          'p-3'
        ),
        children: [
          jsxs('div', { className: 'flex items-center gap-2', children: [
            jsx(StatusDot, { tone: statusTone(n) }),
            jsx('span', { className: 'font-medium', children: pickName(n) }),
            n.role ? jsx(Badge, { children: n.role }) : null,
            jsx('span', { className: 'flex-1' }),
            jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', children: ageStr(n.last_seen) })
          ]}),
          jsxs('div', { className: 'text-xs text-(--ui-text-tertiary) tabular-nums', children: [
            t('load'), ' ', loadStr(n),
            '   ·   ', t('queue'), ' ', String(queueOf(n))
          ]}),
          jsx('div', {
            className: 'text-[11px] leading-relaxed text-(--ui-text-quaternary) break-words',
            children: caps.length ? caps.join(', ') : t('noCaps')
          })
        ]
      })
    }

    function FleetPage() {
      const t = usePluginI18n(ID)
      const queryClientLocal = useQueryClient()
      const { data, isError, error, isFetching, dataUpdatedAt, refetch } = useFleet()
      const info = summaryOf(data)
      const nodes = workerNodes(data)
      const queueSum = nodes.reduce((a, n) => a + queueOf(n), 0)
      const hl = healthLineOf(data?.health)

      return jsxs('div', {
        className: 'flex h-full flex-col gap-4 overflow-y-auto p-6 text-sm',
        children: [
          jsxs('div', { className: 'flex items-center gap-3', children: [
            jsx('div', { className: 'text-base font-medium', children: t('pageTitle') }),
            jsx('span', { className: 'flex-1' }),
            jsx(Button, {
              onClick: () => {
                haptic('tap')
                queryClientLocal.invalidateQueries({ queryKey: FLEET_KEY })
                refetch()
              },
              disabled: isFetching,
              children: t('refresh')
            })
          ]}),
          jsxs('div', { className: 'flex flex-wrap items-center gap-3 text-xs text-(--ui-text-tertiary)', children: [
            jsx(StatusDot, { tone: info.tone }),
            jsx('span', { children: `${info.online}/${info.total} ${t('online')}` }),
            jsx('span', { children: '· ' + t('queue') + ' ' + String(queueSum) }),
            hl ? jsx('span', { children: '· ' + hl }) : null,
            dataUpdatedAt ? jsxs('span', { children: ['· ', t('updated', relativeTime(dataUpdatedAt))] }) : null
          ]}),
          isError
            ? jsx('div', {
                className: 'rounded-lg border border-(--ui-stroke-secondary) p-4 text-destructive',
                children: t('loadErr') + ': ' + (error?.message || String(error || '')) + ' — ' + t('enableHint')
              })
            : null,
          info.errors.length
            ? jsxs('div', {
                className: 'rounded-lg border border-(--ui-stroke-secondary) p-4 text-xs',
                children: info.errors.map((e, i) => jsx('div', {
                  key: i, className: 'text-(--ui-text-tertiary)', children: '⚠ ' + e
                }))
              })
            : null,
          jsxs('div', {
            className: 'grid gap-3',
            style: { gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' },
            children: [
              !data && !isError
                ? jsx('div', { className: 'text-(--ui-text-quaternary)', children: t('loading') })
                : null,
              (data ? nodes : []).map(n => jsx(NodeCard, { key: n.node_id || pickName(n), n }))
            ]
          }),
          jsx('div', { className: 'text-[11px] text-(--ui-text-quaternary)', children: t('backendBy') })
        ]
      })
    }

    // -----------------------------------------------------------------
    // i18n (scoped to this plugin; app locale wins, then en)
    // -----------------------------------------------------------------
    ctx.i18n.register({
      en: {
        paneTitle: 'IOWAP Fleet',
        pageTitle: 'IOWAP Fleet',
        navLabel: 'IOWAP',
        chipTip: 'IOWAP fleet — open overview',
        loading: 'loading fleet…',
        online: 'nodes online',
        refresh: 'Refresh',
        updated: ago => `updated ${ago}`,
        load: 'load',
        queue: 'queue',
        noCaps: 'no capabilities',
        lastSeen: 'last seen',
        loadErr: 'fleet data error',
        partialErr: 'data source issue',
        enableHint: 'Fleet data is fetched by the plugin backend (config.yaml → plugins.enabled: iowap + dashboard/plugin_api.py). Reload plugins, or restart the app if it stays empty.',
        backendBy: 'data via node-cli on this desktop host — relay tokens never enter the app',
        palRefresh: 'IOWAP: refresh fleet data',
        palStatus: 'IOWAP: fleet status',
        palStatusMsg: n => `Fleet: ${n} online`,
        palPage: 'IOWAP: open fleet page'
      },
      de: {
        paneTitle: 'IOWAP Fleet',
        pageTitle: 'IOWAP Fleet',
        navLabel: 'IOWAP',
        chipTip: 'IOWAP Fleet — Übersicht öffnen',
        loading: 'Lade Fleet…',
        online: 'Nodes online',
        refresh: 'Aktualisieren',
        updated: ago => `aktualisiert ${ago}`,
        load: 'Load',
        queue: 'Queue',
        noCaps: 'keine Capabilities',
        lastSeen: 'zuletzt gesehen',
        loadErr: 'Fleet-Datenfehler',
        partialErr: 'Datenquellen-Problem',
        enableHint: 'Fleet-Daten liefert das Plugin-Backend (config.yaml → plugins.enabled: iowap + dashboard/plugin_api.py). Plugins neu laden, oder App neu starten, wenn es leer bleibt.',
        backendBy: 'Daten via node-cli auf diesem Desktop-Host — Relay-Tokens kommen nie in die App',
        palRefresh: 'IOWAP: Fleet-Daten aktualisieren',
        palStatus: 'IOWAP: Fleet-Status',
        palStatusMsg: n => `Fleet: ${n} online`,
        palPage: 'IOWAP: Fleet-Seite öffnen'
      }
    })

    // -----------------------------------------------------------------
    // Contributions
    // -----------------------------------------------------------------

    // Fleet pane — right zone; user can drag it anywhere afterwards.
    ctx.register({
      id: 'fleet-pane',
      area: 'panes',
      title: 'iowap fleet',
      data: { placement: 'right', width: '260px' },
      render: () => jsx(FleetPane, {})
    })

    // Full workspace page + sidebar nav row (renders below Artifacts).
    ctx.register({
      id: 'fleet-page',
      area: ROUTES_AREA,
      data: { path: '/iowap-fleet' },
      render: () => jsx(FleetPage, {})
    })
    ctx.register({
      id: 'fleet-nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/iowap-fleet', label: ctx.i18n.t('navLabel'), codicon: 'project' }
    })

    // Statusbar chip (right side).
    ctx.register({
      id: 'status-chip',
      area: STATUSBAR_AREAS.right,
      order: 130,
      render: () => jsx(Chip, {})
    })

    // ⌘K palette rows.
    ctx.register({
      id: 'cmd-refresh',
      area: PALETTE_AREA,
      data: {
        id: 'iowap.refresh',
        label: ctx.i18n.t('palRefresh'),
        keywords: ['iowap', 'relay', 'fleet', 'refresh'],
        icon: icons.RefreshCw,
        detail: () => {
          const s = lastSummary.get()
          return `${s.online}/${s.total}`
        },
        detailVariant: 'state',
        keepOpen: true,
        run: () => {
          queryClient.invalidateQueries({ queryKey: FLEET_KEY })
          haptic('tap')
        }
      }
    })
    ctx.register({
      id: 'cmd-status',
      area: PALETTE_AREA,
      data: {
        id: 'iowap.status',
        label: ctx.i18n.t('palStatus'),
        keywords: ['iowap', 'relay', 'fleet', 'status', 'nodes'],
        icon: icons.Activity,
        detail: () => {
          const s = lastSummary.get()
          return s.errors.length ? 'errors' : 'ok'
        },
        detailVariant: 'state',
        run: () => {
          const s = lastSummary.get()
          host.notify({
            kind: s.tone === 'bad' ? 'error' : 'info',
            message: ctx.i18n.t('palStatusMsg', `${s.online}/${s.total}`)
          })
        }
      }
    })
    ctx.register({
      id: 'cmd-page',
      area: PALETTE_AREA,
      data: {
        id: 'iowap.page',
        label: ctx.i18n.t('palPage'),
        keywords: ['iowap', 'relay', 'fleet', 'page'],
        icon: icons.LayoutDashboard,
        run: () => {
          haptic('tap')
          host.navigate('/iowap-fleet')
        }
      }
    })
  }
}