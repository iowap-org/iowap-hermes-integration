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
  cn, haptic, host, Tip, Badge, Button, StatusDot, Input, Textarea,
  Switch,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  icons, relativeTime,
  usePluginI18n, useValue, useQuery, useMutation, useQueryClient, queryClient, atom,
  PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect } from 'react'

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
  // T-007: backend probes via `node-cli server health` (body.ok); the legacy
  // raw-`/health` shape (body.status) stays valid until one app restart.
  if (body.ok) parts.push('relay ok')
  else if (body.status) parts.push(`relay ${body.status}`)
  if (body.version) parts.push(`v${body.version}`)
  return parts.length ? parts.join(' · ') : null
}

function loadStr(n) {
  return typeof n?.load === 'number' ? (Math.round(n.load * 10) / 10).toFixed(1) : '–'
}

function queueOf(n) {
  return typeof n?.queue_depth === 'number' ? n.queue_depth : 0
}

const TASK_KEY = [ID, 'tasks']
const ACTIVITY_KEY = [ID, 'activity']

// Stage → dot tone (mirrors the relay state machine pending→claimed→completed)
function stageTone(st) {
  if (st === 'completed') return 'good'
  if (st === 'claimed' || st === 'pending') return 'warn'
  if (st === 'failed' || st === 'timed_out') return 'bad'
  return 'muted'
}

function capStatusTone(p) {
  // a capability is only as alive as its available providers
  return (p || []).some(x => x.available) ? 'good' : 'bad'
}

function providersShort(p, t) {
  if (!p || !p.length) return t('noProviders')
  const names = p.map(x => x.node_name || x.node_id).filter(Boolean)
  const s = names.slice(0, 3).join(', ')
  return names.length > 3 ? `${s} +${names.length - 3}` : s
}

// ---------------------------------------------------------------------------
// Task watcher (pure logic — no ctx): posts stage results and terminal task
// states into chat via host.composer. Non-terminal transitions only move the
// registry forward (no noise); first sight registers without back-posting.
// ---------------------------------------------------------------------------

const TERMINAL_TASK = ['completed', 'failed', 'timed_out']
const POSTED_STAGE = ['completed', 'failed', 'timed_out']

function taskSnap(x) {
  return {
    status: x?.status ?? '',
    stages: (x?.stages || []).map(s => s?.status ?? '')
  }
}

function sameSnap(a, b) {
  return a && b
    && a.status === b.status
    && a.stages.length === b.stages.length
    && a.stages.every((s, i) => s === b.stages[i])
}

const LONGRUN_MS = 5 * 60_000

// Pure sweep: (prevMap, tasks, t, now) → { lines, nextMap }. One line per
// meaningful transition, the caller decides how to post them (all lines of a
// sweep go into ONE submit — no per-line turns). Watcher bookkeeping
// (seenAt/warned) rides inside the registry values; duplication is prevented
// by the stage/task transition guards, not by a whole-snapshot compare.
// Longrun: non-terminal > 5 min → ONE hint per task.
function watchSweep(prevMap, tasks, t, now = Date.now()) {
  const lines = []
  const nextMap = {}
  for (const x of tasks || []) {
    if (!x?.task_id) continue
    const prev = prevMap[x.task_id]
    const snap = taskSnap(x)
    nextMap[x.task_id] = { ...snap, seenAt: prev?.seenAt ?? now, warned: prev?.warned ?? false }
    const book = nextMap[x.task_id]
    if (prev && !book.warned && !TERMINAL_TASK.includes(snap.status) && now - book.seenAt > LONGRUN_MS) {
      book.warned = true
      lines.push(t('watchLongrun', x.name || x.task_id, Math.max(1, Math.round((now - book.seenAt) / 60_000))))
    }
    if (!prev) continue // first sight: register only, never back-post
    const name = x.name || x.task_id
    ;(x.stages || []).forEach((st, i) => {
      const before = prev.stages?.[i]
      const now = snap.stages[i]
      if (!now || before === now || !POSTED_STAGE.includes(now)) return
      const preview = String(st?.result_preview || '').trim()
      lines.push(t('watchStage', name, x.task_id, i + 1, now, preview))
    })
    if (prev.status !== snap.status && TERMINAL_TASK.includes(snap.status)) {
      lines.push(t('watchFinal', name, x.task_id, snap.status, String(x.error || '').trim()))
    }
  }
  return { lines, nextMap }
}

// Pure fleet watch: (prevMap, data, t) → { lines, nextMap }. Node status
// transitions (online → non-online = warning, back = recovery) and relay
// reachability (down → warning once, up → recovery once). First sight is
// silent; unchanged nodes never post.
function fleetSweep(prevMap, data, t) {
  const lines = []
  const nextMap = {}
  for (const n of workerNodes(data)) {
    const id = n.node_id || n.node_name
    if (!id) continue
    const prev = prevMap[id]
    const nowStatus = n.status ?? ''
    nextMap[id] = { status: nowStatus, name: pickName(n) }
    if (!prev) continue // first sight: silent
    if (prev.status === 'online' && nowStatus !== 'online') {
      lines.push(t('fleetOffline', pickName(n), nowStatus || 'offline'))
    } else if (prev.status !== 'online' && nowStatus === 'online') {
      lines.push(t('fleetBack', pickName(n)))
    }
  }
  // Relay reachability as row "__relay__" — health-error shape means down.
  const down = data != null && data?.health?.error != null
  const prevRelay = prevMap.__relay__
  nextMap.__relay__ = { status: down ? 'down' : 'up' }
  if (prevRelay?.status && prevRelay.status !== (down ? 'down' : 'up')) {
    lines.push(down ? t('fleetRelayDown') : t('fleetRelayBack'))
  }
  return { lines, nextMap }
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

    // Task tracking: poll fast while anything is non-terminal, slow otherwise.
    function useTasks() {
      return useQuery({
        queryKey: TASK_KEY,
        queryFn: () => ctx.rest('/tasks', { timeoutMs: 20000 }),
        refetchInterval: query => {
          const tasks = query?.state?.data?.tasks
          const busy = (tasks || []).some(x => !['completed', 'failed', 'timed_out'].includes(x.status))
          return busy || (tasks || []).length === 0 ? 5000 : 60000
        },
        refetchIntervalInBackground: false
      })
    }

    function useActivity() {
      return useQuery({
        queryKey: ACTIVITY_KEY,
        queryFn: () => ctx.rest('/activity', { timeoutMs: 25000 }),
        refetchInterval: 15000,
        refetchIntervalInBackground: false
      })
    }

    // -----------------------------------------------------------------
    // Task watcher (T-013): the chip renders for the app's whole lifetime,
    // so the watcher rides on it — polls /tasks (same key as the tasks page,
    // one poll), diffs against a persisted registry and auto-posts stage
    // results + finals into chat via host.composer. Fail-closed: submits
    // only into a mounted composer; otherwise the update lands as a draft
    // plus a toast (never a broadcast into a hidden pane).
    // -----------------------------------------------------------------
    let watchRegistry = {}
    try { watchRegistry = ctx.storage.get('watch.registry') || {} } catch { /* memory-only */ }
    const $watchOn = atom(true)
    try { $watchOn.set(ctx.storage.get('watch.enabled') !== false) } catch { /* default on */ }

    function setWatchOn(v) {
      $watchOn.set(v)
      try { ctx.storage.set('watch.enabled', v) } catch { /* best effort */ }
    }

    function persistWatch(next) {
      // Bounded store: drop terminal task rows first, then oldest entries.
      let keep = next
      const ids = Object.keys(next)
      if (ids.length > 200) {
        keep = { ...next }
        for (const id of Object.keys(keep)) {
          if (Object.keys(keep).length <= 200) break
          if (TERMINAL_TASK.includes(keep[id]?.status)) delete keep[id]
        }
        const rest = Object.keys(keep)
        if (rest.length > 200) for (const id of rest.slice(0, rest.length - 200)) delete keep[id]
      }
      watchRegistry = keep
      try { ctx.storage.set('watch.registry', keep) } catch { /* best effort */ }
    }

    function postWatchLines(lines, t) {
      const text = lines.join('\n')
      if (!text) return
      let ok = false
      try { ok = host.composer.submit(null, text) } catch { /* fall through */ }
      if (ok) return
      let drafted = false
      try { drafted = host.composer.insertText(null, text, { mode: 'block' }) } catch { /* fall through */ }
      try { host.notify({ kind: 'info', message: drafted ? t('watchDraftNote') : text }) } catch { /* nothing else */ }
    }

    function sweepTasks(tasks, t) {
      const { lines, nextMap } = watchSweep(watchRegistry, tasks || [], t)
      persistWatch(nextMap)
      if (lines.length && $watchOn.get()) postWatchLines(lines, t)
    }

    // Fleet watch state: node statuses + relay reachability (T-014). Same
    // toggle as the task watcher; first sight silent, transitions warn once.
    let fleetRegistry = {}
    try { fleetRegistry = ctx.storage.get('watch.fleet') || {} } catch { /* memory-only */ }

    function persistFleet(next) {
      fleetRegistry = next
      try { ctx.storage.set('watch.fleet', next) } catch { /* best effort */ }
    }

    function sweepFleet(data, t) {
      const { lines, nextMap } = fleetSweep(fleetRegistry, data, t)
      persistFleet(nextMap)
      if (lines.length && $watchOn.get()) postWatchLines(lines, t)
    }

    // (T-013: the watcher hooks live in Chip — no separate headless component;
    // Tip accepts exactly one child.)

    // -----------------------------------------------------------------
    // Statusbar chip: live dot + online/total counter
    // -----------------------------------------------------------------
    function Chip() {
      const t = usePluginI18n(ID)
      const summary = useValue(lastSummary)
      // T-013 task watcher rides INSIDE this always-mounted component: the
      // hooks live in the component body — Tip (Radix slot) accepts exactly
      // ONE child, so the watcher can't be an extra JSX child (that shipped
      // as 'Primitive.button failed to slot onto its children' crash).
      const tasksQ = useTasks()
      const fleetQ = useFleet()
      useEffect(() => {
        if (tasksQ?.data) sweepTasks(tasksQ.data.tasks || [], t)
      }, [tasksQ?.data])
      useEffect(() => {
        if (fleetQ?.data) sweepFleet(fleetQ.data, t)
      }, [fleetQ?.data])

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

    // Onboarding card: plugin installed, but no IOWAP node setup on this host.
    // Rendered by the fleet pane/page and the tasks page when the backend's
    // setup gate short-circuits (catalog review follow-up: catalog users get
    // guidance instead of probe error noise).
    function SetupNotice({ setup }) {
      const t = usePluginI18n(ID)
      const repos = setup?.repos || {}
      return jsxs('div', {
        className: cn(
          'flex flex-col gap-2 rounded-lg border border-(--ui-stroke-secondary)',
          'p-4 text-sm'
        ),
        children: [
          jsxs('div', { className: 'flex items-center gap-2', children: [
            jsx(StatusDot, { tone: 'warn' }),
            jsx('span', { className: 'font-medium', children: t('setupTitle') })
          ]}),
          jsx('div', { className: 'text-(--ui-text-tertiary)', children: t('setupWhat') }),
          (setup?.reasons || []).length
            ? jsx('div', {
                className: 'flex flex-col gap-1 text-xs text-destructive',
                children: setup.reasons.map((r, i) =>
                  jsx('div', { key: i, children: '⚠ ' + r }))
              })
            : null,
          jsxs('div', { className: 'flex flex-col gap-1 text-xs text-(--ui-text-tertiary)', children: [
            jsx('div', { className: 'font-medium', children: t('setupFix') }),
            jsx('div', { children: t('setupStep1') }),
            jsx('div', { children: t('setupStep2') }),
            jsx('div', { children: t('setupStep3') })
          ]}),
          jsxs('div', { className: 'flex items-center gap-3 text-xs', children: [
            jsx('span', { className: 'text-(--ui-text-tertiary)', children: t('setupDocs') + ':' }),
            repos.node ? jsx('a', {
              href: repos.node, target: '_blank', rel: 'noreferrer',
              className: 'underline underline-offset-2',
              children: 'iowap-org/iowap-node'
            }) : null,
            repos.overview ? jsx('a', {
              href: repos.overview, target: '_blank', rel: 'noreferrer',
              className: 'underline underline-offset-2',
              children: 'iowap-org/iowap'
            }) : null
          ]})
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
          data?.setup ? jsx(SetupNotice, { setup: data.setup }) : null,
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
      const tasksQ = useTasks()
      const activityQ = useActivity()
      const info = summaryOf(data)
      const nodes = workerNodes(data)
      const queueSum = nodes.reduce((a, n) => a + queueOf(n), 0)
      const hl = healthLineOf(data?.health)
      const caps = activityQ.data?.capabilities || []
      const daemon = activityQ.data?.daemon || {}
      const localNode = activityQ.data?.local_node

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
          data?.setup ? jsx(SetupNotice, { setup: data.setup }) : null,
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
          jsx('div', { className: 'text-[11px] text-(--ui-text-quaternary)', children: t('backendBy') }),

          // --- activity: daemon self-sight, tracked tasks, capabilities ----
          jsxs('div', { className: 'flex flex-col gap-3', children: [
            jsxs('div', { className: 'flex items-center gap-3', children: [
              jsx('div', { className: 'text-base font-medium', children: t('activityTitle') }),
              jsx('span', { className: 'flex-1' }),
              isFetching ? jsx('span', { className: 'text-xs text-(--ui-text-quaternary)', children: '…' }) : null
            ]}),
            localNode
              ? jsx('div', {
                  className: 'text-xs text-(--ui-text-tertiary)',
                  children: [t('localNode'), String(localNode.node_name || localNode.node_id || ''),
                    daemon.running ? `· ${daemon.heartbeat_status || 'ok'}` : t('daemonSelf', String(daemon.tasks_completed ?? '?'))]
                    .join(' ')
                })
              : null,
            tasksQ.data?.tasks?.length
              ? jsxs('div', { className: 'flex flex-wrap items-center gap-1.5 text-xs', children:
                  tasksQ.data.tasks.map(x => jsxs('span', {
                    className: 'inline-flex items-center gap-1 rounded border border-(--ui-stroke-secondary) px-1.5 py-0.5',
                    children: [
                      jsx(StatusDot, { tone: stageTone(x.status) }),
                      jsx('span', { className: 'tabular-nums', children: (x.name || x.task_id).slice(0, 28) }),
                      jsx('span', { className: 'truncate text-(--ui-text-quaternary)', children: x.status })
                    ]
                  }, x.task_id))
                })
              : null,
            caps.length
              ? jsxs('div', {
                  className: 'grid gap-3',
                  style: { gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' },
                  children: caps.map(c => jsx(CapActivityCard, { key: c.name, c }))
                })
              : null
          ]})
        ]
      })
    }

    // -----------------------------------------------------------------
    // Tasks page (/iowap-tasks): submit + track + live status list
    // -----------------------------------------------------------------
    function StageRow({ s }) {
      return jsxs('div', {
        className: 'flex items-start gap-2 text-xs',
        children: [
          jsx(StatusDot, { tone: stageTone(s.status) }),
          jsxs('div', {
            className: 'min-w-0 flex-1',
            children: [
              jsxs('div', {
                className: 'flex items-baseline gap-2',
                children: [
                  jsx('span', { className: 'truncate text-(--ui-text-secondary)', children: s.capability || s.stage_name || s.stage_id }),
                  jsx('span', { className: 'tabular-nums text-(--ui-text-quaternary)', children: s.status }),
                  s.claimed_by ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: `· ${s.claimed_by}` }) : null,
                  s.retry_count ? jsx('span', { className: 'text-(--ui-text-quaternary)', children: `· retry ${s.retry_count}` }) : null
                ]
              }),
              s.result_preview
                ? jsx('div', {
                    className: 'mt-0.5 break-words text-(--ui-text-tertiary)',
                    style: { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
                    children: s.result_preview
                  })
                : null
            ]
          })
        ]
      })
    }

    function TaskCard({ task }) {
      return jsxs('div', {
        className: 'flex flex-col gap-2 rounded-lg border border-(--ui-stroke-secondary) p-3',
        children: [
          jsxs('div', { className: 'flex items-center gap-2', children: [
            jsx(StatusDot, { tone: stageTone(task.status) }),
            jsx('span', { className: 'truncate font-medium', children: task.name || task.task_id }),
            task.priority ? jsx(Badge, { children: `p${task.priority}` }) : null,
            jsx('span', { className: 'flex-1' }),
            jsx('code', { className: 'text-[10px] text-(--ui-text-quaternary)', children: task.task_id })
          ]}),
          (task.stages || []).map(s => jsx(StageRow, { key: s.stage_id || s.stage_name, s })),
          task.error
            ? jsx('div', { className: 'text-xs text-destructive break-words', children: task.error })
            : null,
          (task.artifacts || []).length
            ? jsx('div', { className: 'text-[11px] text-(--ui-text-tertiary)', children: task.artifacts.map(a => a.name).join(', ') })
            : null
        ]
      })
    }

    // -------------------------------------------------------------------
    // Field helpers: live JSON preview from plaintext field values,
    // plaintext input rows (string → Input, number → numeric Input,
    // boolean → Switch, everything else → text).
    // -------------------------------------------------------------------
    function safeJson(v) {
      try { return JSON.stringify(v, null, 2) } catch { return null }
    }

    function buildPreview(defs, vals) {
      const out = {}
      for (const f of defs) {
        const v = vals[f.name]
        if (v === undefined || v === '' || v === null) continue
        if (f.type === 'number' || f.type === 'integer') out[f.name] = Number(v) || 0
        else if (f.type === 'boolean') out[f.name] = v === true
        else out[f.name] = String(v)
      }
      return out
    }

    function fieldControl(f, val, set) {
      if (f.type === 'boolean') {
        return jsx(Switch, {
          id: `iowap-f-${f.name}`, checked: val === true,
          onCheckedChange: v => set(v), size: 'xs'
        })
      }
      const num = f.type === 'number' || f.type === 'integer'
      return jsx(Input, {
        id: `iowap-f-${f.name}`,
        type: num ? 'number' : 'text',
        inputMode: num ? 'numeric' : undefined,
        value: val === undefined || val === null ? '' : String(val),
        onChange: e => set(num ? e.target.value : e.target.value),
        placeholder: f.example != null ? String(f.example) : undefined
      })
    }

    function CapabilityFields({ defs, vals, $vals, t }) {
      return jsxs('div', {
        className: 'grid gap-2',
        children: defs.map(f => {
          const set = v => $vals.set({ ...vals, [f.name]: v })
          return jsxs('div', { key: f.name, className: 'grid grid-cols-[130px_1fr] items-center gap-2', children: [
            jsxs('label', {
              htmlFor: `iowap-f-${f.name}`,
              className: 'text-xs break-words',
              children: [
                f.name,
                f.required ? jsx('span', { className: 'text-destructive', children: ' *' }) : null,
                jsx('div', { className: 'text-[10px] font-normal text-(--ui-text-quaternary)', children: f.type || 'string' })
              ]
            }),
            jsxs('div', { className: 'grid gap-0.5', children: [
              fieldControl(f, vals[f.name], set),
              f.description
                ? jsx('div', { className: 'text-[10px] leading-snug text-(--ui-text-quaternary)', children: f.description })
                : null
            ]})
          ]})
        })
      })
    }

    // form atoms — module scope: atoms created in a component body are
    // re-created on EVERY render and reset instantly (select "didn't stick",
    // advanced toggle "couldn't switch off"). Module scope survives renders
    // and mounts alike.
    const $cap = atom('')
    const $name = atom('')
    const $formErr = atom('')
    const $trackId = atom('')
    const $adv = atom(false)
    const $raw = atom('{}')
    const $vals = atom({})

    // -------------------------------------------------------------------
    // TaskForm: capability select (selectable only, type != native) +
    // plaintext fields from the capability's input_schema — payload JSON is
    // GENERATED, not handwritten. "Advanced" toggle for raw JSON edits.
    // -------------------------------------------------------------------
    function TaskForm({ caps, cap, onCap, nameTxt, onName, onErr, onSubmit, submitting, err, t }) {
      const activityQ = useActivity()
      const sel = caps.find(c => c.name === cap) || null
      const fields = sel && sel.fields && typeof sel.fields === 'object' ? Object.values(sel.fields) : []

      const adv = useValue($adv)
      const rawTxt = useValue($raw)
      const vals = useValue($vals)

      // field defs sorted once per capability (stable key order)
      const defs = (fields || [])
        .filter(f => f && f.name)
        .sort((a, b) => (a.required === b.required ? 0 : a.required ? -1 : 1))

      function buildPayload() {
        const out = {}
        for (const f of defs) {
          const v = vals[f.name]
          if (v === undefined || v === '' || v === null) continue
          let val = v
          if (f.type === 'number' || f.type === 'integer') {
            const n = Number(v)
            if (!Number.isFinite(n)) { onErr(t('numErr', f.name)); return null }
            val = n
          } else if (f.type === 'boolean') {
            val = v === true
          } else {
            val = String(v)
          }
          out[f.name] = val
        }
        if (!Object.keys(out).length && rawTxt.trim()) {
          let p
          try { p = JSON.parse(rawTxt) } catch { onErr(t('invalidJson')); return null }
          if (!p || typeof p !== 'object' || Array.isArray(p)) { onErr(t('invalidJson')); return null }
          return p
        }
        return out
      }

      const hasFields = defs.length > 0
      return jsxs('div', {
        className: 'flex flex-col gap-2',
        children: [
          jsx(Select, {
            value: cap,
            onValueChange: v => onCap(v),
            children: [
              jsx(SelectTrigger, { className: 'w-full', children: jsx(SelectValue, { placeholder: t('selectCap') }) }),
              jsx(SelectContent, {
                children: caps.map(c => jsx(SelectItem, {
                  key: c.name, value: c.name,
                  children: `${c.name} · ${providersShort(c.providers, t)}`
                }))
              })
            ]
          }),
          (!caps.length && !activityQ.isLoading)
            ? jsx('div', { className: 'text-xs text-(--ui-text-quaternary)', children: t('noSubmitCaps') })
            : null,
          sel?.description
            ? jsx('div', {
                className: 'text-[11px] leading-relaxed text-(--ui-text-quaternary) break-words',
                style: { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
                children: sel.description
              })
            : null,
          hasFields
            ? jsx(CapabilityFields, { defs, vals, $vals, t })
            : null,
          jsxs('div', { className: 'flex items-center gap-2', children: [
            jsx(Switch, {
              id: 'iowap-adv', checked: !hasFields || adv,
              onCheckedChange: v => $adv.set(v), size: 'xs', disabled: !hasFields
            }),
            jsx('label', { htmlFor: 'iowap-adv', className: 'text-xs text-(--ui-text-tertiary)', children: t('advJson') })
          ]}),
          (adv || !hasFields)
            ? jsx(Textarea, {
                placeholder: "{}", spellCheck: false,
                value: rawTxt, onChange: e => $raw.set(e.target.value),
                className: 'min-h-16 font-mono text-xs'
              })
            : null,
          hasFields && !adv
            ? jsx('div', {
                className: 'rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-fill-tertiary) p-2 font-mono text-[11px] text-(--ui-text-quaternary) break-words whitespace-pre-wrap',
                children: safeJson(buildPreview(defs, vals)) || '{}'
              })
            : null,
          jsx(Input, { placeholder: t('namePh'), value: nameTxt, onChange: e => onName(e.target.value) }),
          err ? jsx('div', { className: 'text-xs text-destructive', children: err }) : null,
          jsx(Button, {
            onClick: () => { haptic('tap'); const body = buildPayload(); if (body) { onErr(''); onSubmit(body) } },
            disabled: submitting || !caps.length,
            children: submitting ? t('submitting') : t('submit')
          })
        ]
      })
    }

    function TasksPage() {
      const t = usePluginI18n(ID)
      const qc = useQueryClient()
      const tasksQ = useTasks()
      const activityQ = useActivity()

      const cap = useValue($cap)
      const nameTxt = useValue($name)
      const formErr = useValue($formErr)
      const trackId = useValue($trackId)
      const watchOn = useValue($watchOn)

      // Backend-first: consume the computed `selectable` flag (T-010); the
      // type check is only the fallback for legacy responses without the flag.
      const caps = (activityQ.data?.capabilities || []).filter(c => c.selectable ?? (c.type !== 'native'))

      const submit = useMutation({
        mutationFn: body => ctx.rest('/tasks/submit', { method: 'POST', body, timeoutMs: 35000 }),
        onSuccess: res => {
          qc.invalidateQueries({ queryKey: TASK_KEY })
          if (res?.ok) {
            host.notify({ kind: 'info', message: t('submittedOk', res.task_id) })
            if ($watchOn.get()) {
              const nm = String($name.get() || '').trim()
              postWatchLines([t('watchSubmitted', nm || res.task_id, res.task_id)], t)
            }
            $name.set(''); $formErr.set('')
          } else {
            host.notify({ kind: 'error', message: t('submitErr', res?.error || '?') })
          }
        },
        onError: e => host.notify({ kind: 'error', message: t('submitErr', e?.message || String(e)) })
      })
      const track = useMutation({
        mutationFn: tid => ctx.rest('/tasks/track', { method: 'POST', body: { task_id: tid }, timeoutMs: 20000 }),
        onSuccess: res => {
          qc.invalidateQueries({ queryKey: TASK_KEY })
          if (res?.ok) { host.notify({ kind: 'info', message: t('trackOk', res.task_id) }); $trackId.set('') }
          else host.notify({ kind: 'error', message: t('trackErr', res?.error || '?') })
        },
        onError: e => host.notify({ kind: 'error', message: t('trackErr', e?.message || String(e)) })
      })

      const tasks = tasksQ.data?.tasks || []
      const busy = tasks.some(x => !['completed', 'failed', 'timed_out'].includes(x.status))

      return jsxs('div', {
        className: 'flex h-full flex-col gap-4 overflow-y-auto p-6 text-sm',
        children: [
          jsxs('div', { className: 'flex items-center gap-3', children: [
            jsx('div', { className: 'text-base font-medium', children: t('tasksTitle') }),
            jsxs('label', {
              className: 'flex items-center gap-1.5 text-xs text-(--ui-text-tertiary)',
              children: [
                jsx(Switch, {
                  id: 'iowap-watch',
                  size: 'xs',
                  checked: watchOn,
                  onCheckedChange: v => { haptic('tap'); setWatchOn(v) }
                }),
                t('watchToggleLabel')
              ]
            }),
            jsx('span', { className: 'flex-1' }),
            jsx(Button, {
              disabled: tasksQ.isFetching,
              onClick: () => { haptic('tap'); qc.invalidateQueries({ queryKey: TASK_KEY }) },
              children: t('refresh')
            })
          ]}),
          jsx('div', {
            className: 'text-xs text-(--ui-text-quaternary)',
            children: t('tasksHint', String(tasks.length), busy ? t('busyLive') : t('idlePolled'))
          }),

          // --- submit form ---
      jsxs('div', {
        className: 'flex flex-col gap-2 rounded-lg border border-(--ui-stroke-secondary) p-3',
        children: [
          jsx('div', { className: 'text-xs font-medium text-(--ui-text-tertiary)', children: t('submitTitle') }),
          jsx(TaskForm, {
            caps, cap, onCap: v => $cap.set(v), nameTxt, onName: v => $name.set(v),
            onErr: m => $formErr.set(m), onSubmit: body => submit.mutate({
              capability: cap, payload: body, name: nameTxt.trim() || undefined, priority: 0
            }),
            submitting: submit.isPending, err: formErr, t
          })
        ]
      }),

          // --- track by id ---
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx(Input, {
                placeholder: 'task_…',
                value: trackId,
                onChange: e => $trackId.set(e.target.value),
                className: 'flex-1 font-mono text-xs'
              }),
              jsx(Button, {
                disabled: track.isPending || !trackId.trim(),
                onClick: () => { haptic('tap'); track.mutate(trackId.trim()) },
                children: track.isPending ? '…' : t('track')
              })
            ]
          }),

          // --- live list ---
          jsxs('div', {
            className: 'grid gap-3',
            style: { gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' },
            children: [
              !tasksQ.data && !tasksQ.isError
                ? jsx('div', { className: 'text-(--ui-text-quaternary)', children: t('loading') })
                : null,
              tasksQ.data && !tasks.length
                ? jsx('div', { className: 'text-(--ui-text-quaternary)', children: t('noTasks') })
                : null,
              tasks.map(x => jsx(TaskCard, { key: x.task_id, task: x }))
            ]
          }),
          (tasksQ.data?.errors || []).length
            ? jsxs('div', { className: 'rounded-lg border border-(--ui-stroke-secondary) p-3 text-xs', children:
                tasksQ.data.errors.map((e, i) => jsx('div', { key: i, className: 'text-(--ui-text-tertiary) break-words', children: '⚠ ' + e }))
              })
            : null,
          tasksQ.isError
            ? jsx('div', {
                className: 'rounded-lg border border-(--ui-stroke-secondary) p-4 text-destructive',
                children: t('loadErr') + ': ' + (tasksQ.error?.message || String(tasksQ.error || '')) + ' — ' + t('enableHint')
              })
            : null,
          tasksQ.data?.setup ? jsx(SetupNotice, { setup: tasksQ.data.setup }) : null,
          jsx('div', { className: 'text-[11px] text-(--ui-text-quaternary)', children: t('tasksScope') })
        ]
      })
    }

    function CapActivityCard({ c }) {
      const t = usePluginI18n(ID)
      return jsxs('div', {
        className: 'flex flex-col gap-2 rounded-lg border border-(--ui-stroke-secondary) p-3',
        children: [
          jsxs('div', { className: 'flex items-center gap-2', children: [
            jsx(StatusDot, { tone: capStatusTone(c.providers) }),
            jsx('span', { className: 'truncate font-medium', children: c.name }),
            c.type ? jsx(Badge, { children: c.type }) : null,
            jsx('span', { className: 'flex-1' }),
            jsx('span', {
              className: 'tabular-nums text-xs text-(--ui-text-quaternary)',
              children: c.queues_total > 0 ? `Σ ${c.queues_total}` : ''
            })
          ]}),
          jsx('div', { className: 'text-xs text-(--ui-text-tertiary) truncate', children: providersShort(c.providers, t) }),
          c.description
            ? jsx('div', {
                className: 'text-[11px] leading-relaxed text-(--ui-text-quaternary) break-words',
                style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
                children: c.description
              })
            : null
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
        palPage: 'IOWAP: open fleet page',
        palTasks: 'IOWAP: open tasks page',
        tasksTitle: 'IOWAP Tasks',
        tasksHint: (n, mode) => `${n} tracked tasks — ${mode}`,
        busyLive: 'live polling (non-terminal tasks present)',
        idlePolled: 'idle polling',
        tasksScope: 'tracking is instance-local: tasks submitted from this app (or added by id) — the relay exposes no global task list',
        submitTitle: 'Submit a task',
        selectCap: 'capability…',
        namePh: 'name (optional)',
        invalidJson: 'payload is not valid JSON (object expected)',
        pickCap: 'pick a capability first',
        numErr: name => `field '${name}' needs a number`,
        advJson: 'advanced: edit JSON directly',
        submit: 'Submit',
        submitting: 'submitting…',
        submittedOk: tid => `submitted ${tid}`,
        submitErr: e => `submit failed: ${e}`,
        track: 'Track',
        trackOk: tid => `tracking ${tid}`,
        trackErr: e => `track failed: ${e}`,
        noTasks: 'no tracked tasks yet',
        noProviders: 'no providers',
        noSubmitCaps: 'no task capabilities visible — is the node daemon connected?',
        activityTitle: 'Activity',
        daemonSelf: tid => `daemon off (completed ${tid})`,
        localNode: 'local node',
        capabilities: 'capabilities',
        setupTitle: 'IOWAP: no node setup on this host',
        setupWhat: 'This plugin renders your IOWAP fleet via node-cli on this machine. It is installed, but this host has no node framework or registered node yet — so there is nothing to show.',
        setupFix: 'Fix it (2 steps):',
        setupStep1: '1. Install the node framework: git clone https://github.com/iowap-org/iowap-node && cd iowap-node && pip install -e .',
        setupStep2: '2. Register against a relay: node-cli node register --base-url <relay-url>',
        setupStep3: '3. Reload this app — the fleet view appears automatically.',
        setupDocs: 'Docs',
        // task watcher (T-013)
        watchToggleLabel: 'post task updates to chat',
        watchSubmitted: (n, tid) => `IOWAP watch: tracking "${n}" [${tid}] — updates will post here.`,
        watchStage: (n, tid, i, s, p) => `IOWAP task "${n}" [${tid}]: stage ${i} → ${s}${p ? ` — ${p}` : ''}`,
        watchFinal: (n, tid, s, e) => `IOWAP task "${n}" [${tid}]: ${s}${e ? ` — ${e}` : ''}`,
        watchDraftNote: () => 'iowap watch — no open chat composer, update kept as draft',
        palWatch: 'IOWAP: toggle task watch posts',
        watchOnMsg: () => 'iowap task watcher: ON — stage results + finals post to chat',
        watchOffMsg: () => 'iowap task watcher: OFF — no chat posts',
        watchLongrun: (n, m) => `⏳ iowap task "${n}" running for ${m} min — still going`,
        fleetOffline: (n, st) => `⚠️ iowap fleet: node "${n}" went ${st || 'offline'}`,
        fleetBack: n => `✅ iowap fleet: node "${n}" is back online`,
        fleetRelayDown: () => '⚠️ iowap fleet: relay unreachable',
        fleetRelayBack: () => '✅ iowap fleet: relay reachable again'
      },
      de: {
        paneTitle: 'IOWAP Fleet',
        pageTitle: 'IOWAP Fleet',
        navLabel: 'IOWAP',
        chipTip: 'IOWAP fleet — open overview',
        loading: 'loading fleet…',
        online: 'nodes online',
        refresh: 'Refresh',
        updated: ago => `updated ${ago}`,
        load: 'Load',
        queue: 'Queue',
        noCaps: 'no capabilities',
        lastSeen: 'last seen',
        loadErr: 'fleet data error',
        partialErr: 'data source issue',
        enableHint: 'Fleet data is fetched by the plugin backend (config.yaml → plugins.enabled: iowap + dashboard/plugin_api.py). Reload plugins, or restart the app if it stays empty.',
        backendBy: 'data via node-cli on this desktop host — relay tokens never enter the app',
        palRefresh: 'IOWAP: refresh fleet data',
        palStatus: 'IOWAP: fleet status',
        palStatusMsg: n => `Fleet: ${n} online`,
        palPage: 'IOWAP: open fleet page',
        palTasks: 'IOWAP: open tasks page',
        tasksTitle: 'IOWAP Tasks',
        tasksHint: (n, mode) => `${n} tracked tasks — ${mode}`,
        busyLive: 'live polling (non-terminal tasks present)',
        idlePolled: 'idle polling',
        tasksScope: 'tracking is instance-local: tasks submitted from this app (or added by id) — the relay exposes no global task list',
        submitTitle: 'Submit a task',
        selectCap: 'Capability…',
        namePh: 'Name (optional)',
        invalidJson: 'payload is not valid JSON (object expected)',
        pickCap: 'pick a capability first',
        numErr: name => `field '${name}' needs a number`,
        advJson: 'advanced: edit JSON directly',
        submit: 'Submit',
        submitting: 'submitting…',
        submittedOk: tid => `submitted ${tid}`,
        submitErr: e => `submit failed: ${e}`,
        track: 'Track',
        trackOk: tid => `tracking ${tid}`,
        trackErr: e => `track failed: ${e}`,
        noTasks: 'no tracked tasks yet',
        noProviders: 'no providers',
        noSubmitCaps: 'no task capabilities visible — is the node daemon connected?',
        activityTitle: 'Activity',
        daemonSelf: tid => `daemon off (completed ${tid})`,
        localNode: 'local node',
        capabilities: 'Capabilities',
        setupTitle: 'IOWAP: no node setup on this host',
        setupWhat: 'This plugin renders your IOWAP fleet via node-cli on this machine. It is installed, but this host has no node framework or registered node yet — so there is nothing to show.',
        setupFix: 'Fix it (2 steps):',
        setupStep1: '1. Install the node framework: git clone https://github.com/iowap-org/iowap-node && cd iowap-node && pip install -e .',
        setupStep2: '2. Register against a relay: node-cli node register --base-url <relay-url>',
        setupStep3: '3. Reload this app — the fleet view appears automatically.',
        setupDocs: 'Docs',
        // Task-Watcher (T-013) — chat lines follow the APP LOCALE on purpose
        // (i18n resolver: app locale → en → raw key; Ronny 2026-10-25).
        watchToggleLabel: 'Task-Updates in den Chat posten',
        watchSubmitted: (n, tid) => `IOWAP watch: überwache "${n}" [${tid}] — Updates laufen hier ein.`,
        watchStage: (n, tid, i, s, p) => `IOWAP-Task "${n}" [${tid}]: Stage ${i} → ${s}${p ? ` — ${p}` : ''}`,
        watchFinal: (n, tid, s, e) => `IOWAP-Task "${n}" [${tid}]: ${s}${e ? ` — ${e}` : ''}`,
        watchDraftNote: () => 'iowap watch — kein offener Chat-Composer, Update liegt als Draft',
        palWatch: 'IOWAP: Task-Watcher umschalten',
        watchOnMsg: () => 'IOWAP Task-Watcher: AN — Stage-Ergebnisse + Finals posten in den Chat',
        watchOffMsg: () => 'IOWAP Task-Watcher: AUS — keine Chat-Posts',
        watchLongrun: (n, m) => `⏳ IOWAP-Task "${n}" läuft seit ${m} min — noch aktiv`,
        fleetOffline: (n, st) => `⚠️ IOWAP-Flotte: Node "${n}" jetzt ${st || 'offline'}`,
        fleetBack: n => `✅ IOWAP-Flotte: Node "${n}" wieder online`,
        fleetRelayDown: () => '⚠️ IOWAP-Flotte: Relay nicht erreichbar',
        fleetRelayBack: () => '✅ IOWAP-Flotte: Relay wieder erreichbar'
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

    // Tasks page (submit / track / live status) + nav row.
    ctx.register({
      id: 'tasks-page',
      area: ROUTES_AREA,
      data: { path: '/iowap-tasks' },
      render: () => jsx(TasksPage, {})
    })
    ctx.register({
      id: 'tasks-nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/iowap-tasks', label: ctx.i18n.t('navLabel') + ' Tasks', codicon: 'checklist' }
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
    ctx.register({
      id: 'cmd-tasks',
      area: PALETTE_AREA,
      data: {
        id: 'iowap.tasks',
        label: ctx.i18n.t('palTasks'),
        keywords: ['iowap', 'relay', 'tasks', 'submit'],
        icon: icons.ListTodo,
        run: () => {
          haptic('tap')
          host.navigate('/iowap-tasks')
        }
      }
    })
    // T-013: quick toggle for the task watcher (live on/off in the detail row).
    ctx.register({
      id: 'cmd-watch-toggle',
      area: PALETTE_AREA,
      data: {
        id: 'iowap.watch-toggle',
        label: ctx.i18n.t('palWatch'),
        keywords: ['iowap', 'watch', 'task', 'chat', 'toggle'],
        detail: () => ($watchOn.get() ? 'on' : 'off'),
        detailVariant: 'state',
        run: () => {
          setWatchOn(!$watchOn.get())
          haptic('tap')
          host.notify({ kind: 'info', message: ctx.i18n.t($watchOn.get() ? 'watchOnMsg' : 'watchOffMsg') })
        }
      }
    })
  }
}

// Test hook for tools/render-smoke.mjs — inert in production (the app loads
// only the default export): exposes the pure watcher sweep for assertions.
export const __test = { watchSweep, taskSnap, sameSnap, fleetSweep }