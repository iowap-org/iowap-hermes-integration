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
// Pure sweep: (prevMap, tasks, t, now) → { lines, targets, nextMap }. One
// line per meaningful transition — event-only, NO node output (PR #144628
// review point 3: result_preview/error never enter chat; whoever needs the
// details pulls them via task_result). `targets` carries the per-line
// origin session id (from the row's session_id meta) or null; the caller
// groups lines by target for scoped delivery. Watcher bookkeeping
// (seenAt/warned) rides inside the registry values; duplication is
// prevented by the stage/task transition guards. Longrun: only for tasks
// with status running (actually claimed) > 5 min → ONE hint per task.
function watchSweep(prevMap, tasks, t, now = Date.now()) {
  const lines = []
  const targets = []
  const nextMap = {}
  let flash = null // last final transition: 'taskDone' | 'taskFailed' — feeds the chip flash (T-17)
  for (const x of tasks || []) {
    if (!x?.task_id) continue
    const prev = prevMap[x.task_id]
    const snap = taskSnap(x)
    nextMap[x.task_id] = { ...snap, seenAt: prev?.seenAt ?? now, warned: prev?.warned ?? false }
    const book = nextMap[x.task_id]
    if (prev && !book.warned && snap.status === 'running' && now - book.seenAt > LONGRUN_MS) {
      book.warned = true
      lines.push(t('watchLongrun', x.name || x.task_id, Math.max(1, Math.round((now - book.seenAt) / 60_000))))
      targets.push(x.session_id || null)
    }
    if (!prev) continue // first sight: register only, never back-post
    const name = x.name || x.task_id
    ;(x.stages || []).forEach((st, i) => {
      const before = prev.stages?.[i]
      const now = snap.stages[i]
      if (!now || before === now || !POSTED_STAGE.includes(now)) return
      // no result_preview here — event only
      lines.push(t('watchStage', name, x.task_id, i + 1, now))
      targets.push(x.session_id || null)
    })
    if (prev.status !== snap.status && TERMINAL_TASK.includes(snap.status)) {
      // no error text here — event only
      lines.push(t('watchFinal', name, x.task_id, snap.status))
      targets.push(x.session_id || null)
      flash = snap.status === 'completed' ? 'taskDone' : 'taskFailed'
    }
  }
  return { lines, targets, nextMap, flash }
}

// Pure fleet watch: (prevMap, data, t) → { lines, nextMap, flash }. Node status
// transitions (online → non-online = warning, back = recovery) and relay
// reachability (down → warning once, up → recovery once). First sight is
// silent; unchanged nodes never post. flash = the LAST transition, as
// { kind: 'nodeDown'|'nodeUp'|'relayDown'|'relayUp', name? } for the chip (T-17).
function fleetSweep(prevMap, data, t) {
  const lines = []
  const nextMap = {}
  let flash = null
  for (const n of workerNodes(data)) {
    const id = n.node_id || n.node_name
    if (!id) continue
    const prev = prevMap[id]
    const nowStatus = n.status ?? ''
    nextMap[id] = { status: nowStatus, name: pickName(n) }
    if (!prev) continue // first sight: silent
    if (prev.status === 'online' && nowStatus !== 'online') {
      lines.push(t('fleetOffline', pickName(n), nowStatus || 'offline'))
      flash = { kind: 'nodeDown', name: pickName(n) }
    } else if (prev.status !== 'online' && nowStatus === 'online') {
      lines.push(t('fleetBack', pickName(n)))
      flash = { kind: 'nodeUp', name: pickName(n) }
    }
  }
  // Relay reachability as row "__relay__" — health-error shape means down.
  const down = data != null && data?.health?.error != null
  const prevRelay = prevMap.__relay__
  nextMap.__relay__ = { status: down ? 'down' : 'up' }
  if (prevRelay?.status && prevRelay.status !== (down ? 'down' : 'up')) {
    lines.push(down ? t('fleetRelayDown') : t('fleetRelayBack'))
    flash = { kind: down ? 'relayDown' : 'relayUp' }
  }
  return { lines, nextMap, flash }
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
    // T-016: '$watchOn' is the tasks-chat quick gate (⌘K toggle / Tasks page
    // switch). ALL chat/notify gates are OFF unless explicitly stored —
    // composer posts carry the user's typing authority, so nothing posts
    // into any chat until the user opted in (PR #144628 review point 1).
    const $watchOn = atom(false)
    try { $watchOn.set(ctx.storage.get('notify.tasks.chat') === true) } catch { /* default OFF */ }

    function setWatchOn(v) {
      $watchOn.set(v)
      try { ctx.storage.set('notify.tasks.chat', v) } catch { /* best effort */ }
    }

    // Notification config ( Ronny spec, three page): notify = toast /
    // notification center; chat = composer post. Tasks: origin | manual
    // session + draft | direct. Fleet: one manual session id. All OFF.
    function cfg(key, fallback) {
      try { return ctx.storage.get(key) ?? fallback } catch { return fallback }
    }
    const $cfgTasksTarget = atom(cfg('notify.tasks.target', 'origin'))  // 'origin' | 'manual'
    const $cfgTasksSession = atom(cfg('notify.tasks.session', ''))
    const $cfgTasksMode = atom(cfg('notify.tasks.mode', 'draft'))       // 'draft' | 'direct'
    const $cfgTasksNotify = atom(cfg('notify.tasks.enabled', false))
    const $cfgFleetNotify = atom(cfg('notify.fleet.enabled', false))
    const $cfgFleetChat = atom(cfg('notify.fleet.chat', false))
    const $cfgFleetSession = atom(cfg('notify.fleet.session', ''))
    // T-17 chip flash: pure display switch (no composer, no consent topic).
    // Ronny principle: EVERYTHING defaults OFF. Shows the last task/fleet
    // event in the chip for ~5 s, then back to N/M.
    const $cfgChipFlash = atom(cfg('chip.flash.enabled', false))
    // T-17 pane tiles: task lines as copy-to-clipboard tiles — also default OFF.
    const $cfgPaneLog = atom(cfg('pane.log.enabled', false))
    const cfgTasksChatOn = () => $watchOn.get()
    const cfgFleetChatOn = () => $cfgFleetChat.get()
    function setCfg(atomRef, key, v) {
      atomRef.set(v)
      try { ctx.storage.set(key, v) } catch { /* best effort */ }
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

    // T-016: one notification log for BOTH areas ('hier generell alle
    // meldungen sammeln') — every event line lands here regardless of
    // notify/chat routing. Bounded to 100.
    let notifLog = []
    try { notifLog = ctx.storage.get('watch.log') || [] } catch { /* memory-only */ }
    const $notifLog = atom(notifLog)
    function logLines(lines, scope, t) {
      notifLog = [...(notifLog || []).slice(-99), { ts: Date.now(), scope, lines: [...lines] }]
      try { ctx.storage.set('watch.log', notifLog) } catch { /* best effort */ }
      $notifLog.set(notifLog)
    }

    // T-17 chip flash state — { key, args, tone, until }; chip decides display.
    const $chipFlash = atom(null)
    let flashTimer = null
    function chipFlashShow(flash, t) {
      if (!$cfgChipFlash.get() || !flash) return
      const key = flash.kind === 'taskDone' ? 'chipTaskDone'
        : flash.kind === 'taskFailed' ? 'chipTaskFailed'
          : flash.kind === 'nodeDown' ? 'chipNodeDown'
            : flash.kind === 'nodeUp' ? 'chipNodeUp'
              : flash.kind === 'relayDown' ? 'chipRelayDown' : 'chipRelayUp'
      const tone = flash.kind === 'taskDone' || flash.kind === 'nodeUp' || flash.kind === 'relayUp' ? 'good'
        : flash.kind === 'nodeDown' || flash.kind === 'relayDown' ? 'bad' : 'warn'
      const args = flash.name ? [flash.name] : []
      $chipFlash.set({ key, args, tone, until: Date.now() + 5_000 })
      if (flashTimer) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => $chipFlash.set(null), 5_000)
    }

    // T-17 pane task tiles: click a tile → copy the watch line to clipboard.
    function copyTaskLines(lines, t) {
      const text = (lines || []).join('\n')
      if (text && navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {})
      haptic('tap')
      try { host.notify({ kind: 'success', message: t('copiedMsg') }) } catch { /* nothing */ }
    }

    function sweepTasks(tasks, t) {
      const { lines, targets, nextMap, flash } = watchSweep(watchRegistry, tasks || [], t)
      persistWatch(nextMap)
      if (!lines.length) return
      logLines(lines, 'tasks', t)
      const chatOn = cfgTasksChatOn()
      const notifyOn = $cfgTasksNotify.get()
      if (!chatOn && !notifyOn) return
      // group by origin target (null = no origin recorded) → one delivery
      // per distinct target, all with the user's opt-in authority
      const groups = {}
      const keys = []
      targets.forEach((tgt, i) => {
        const key = tgt || '__none__'
        if (!groups[key]) { groups[key] = { target: tgt, items: [] }; keys.push(key) }
        groups[key].items.push(lines[i])
      })
      for (const key of keys) {
        const g = groups[key]
        deliverTaskGroup(g.target, g.items.join('\n'), t, notifyOn)
      }
      chipFlashShow(flash, t)
    }

    function deliverTaskGroup(originId, text, t, notifyOn) {
      let target = null
      if ($cfgTasksTarget.get() === 'origin' && originId) target = originId
      if (!target) {
        const manual = ($cfgTasksSession.get() || '').trim()
        if (manual) target = manual
      }
      if (!target) {
        // no configured session at all → draft in the active composer
        try { host.composer.insertText(null, text, { mode: 'block' }) } catch { /* nothing */ }
        try { host.notify({ kind: 'info', message: `iowap watch — ${text}` }) } catch { /* nothing */ }
        return
      }
      if ($cfgTasksMode.get() === 'direct') {
        let ok = false
        try { ok = host.composer.submit(target, text) } catch { /* fall through */ }
        if (!ok) {
          try { ok = host.composer.insertText(target, text, { mode: 'block' }) } catch { /* nothing */ }
        }
        if (ok) return
      } else {
        try { host.composer.insertText(target, text, { mode: 'block' }) } catch { /* nothing */ }
        if (notifyOn) try { host.notify({ kind: 'info', message: `iowap watch — ${text}` }) } catch { /* nothing */ }
        return
      }
      // direct submit failed (session not mounted) → notify fallback
      try { host.notify({ kind: 'warning', message: `iowap watch — ${text}` }) } catch { /* nothing */ }
    }

    // Fleet watch state: node statuses + relay reachability (T-014). First
    // sight silent, transitions warn once.
    let fleetRegistry = {}
    try { fleetRegistry = ctx.storage.get('watch.fleet') || {} } catch { /* memory-only */ }

    function persistFleet(next) {
      fleetRegistry = next
      try { ctx.storage.set('watch.fleet', next) } catch { /* best effort */ }
    }

    function sweepFleet(data, t) {
      const { lines, nextMap, flash } = fleetSweep(fleetRegistry, data, t)
      persistFleet(nextMap)
      if (lines.length) chipFlashShow(flash, t)
      if (!lines.length) return
      logLines(lines, 'fleet', t)
      const notifyOn = $cfgFleetNotify.get()
      const chatOn = cfgFleetChatOn()
      if (!notifyOn && !chatOn) return
      if (!chatOn) {
        for (const line of lines) {
          try { host.notify({ kind: 'warning', message: `iowap fleet — ${line}` }) } catch { /* nothing */ }
        }
        return
      }
      const target = ($cfgFleetSession.get() || '').trim()
      let ok = false
      if (target) {
        try { ok = host.composer.submit(target, lines.join('\n')) } catch { /* fall through */ }
      }
      if (!ok && notifyOn) {
        for (const line of lines) {
          try { host.notify({ kind: 'warning', message: `iowap fleet — ${line}` }) } catch { /* nothing */ }
        }
      }
    }

    // (T-013: the watcher hooks live in Chip — no separate headless component;
    // Tip accepts exactly one child.)

    // -----------------------------------------------------------------
    // Statusbar chip: live dot + online/total counter
    // -----------------------------------------------------------------
    function Chip() {
      const t = usePluginI18n(ID)
      const summary = useValue(lastSummary)
      const flash = useValue($chipFlash)
      const flashActive = !!(flash && Date.now() < flash.until)
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
          children: flashActive
            ? jsx('span', { className: 'inline-flex items-center gap-1', children: [
                jsx(StatusDot, { tone: flash.tone }),
                jsx('span', { children: t(flash.key, ...flash.args) })
              ] })
            : jsxs('span', {
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
      // T-17: last task lines (no fleet rows here — the node list already
      // shows node state) as copy-to-clipboard tiles — default OFF
      const paneLogOn = useValue($cfgPaneLog)
      const taskLog = paneLogOn ? (useValue($notifLog) || []).filter(e => e?.scope === 'tasks').slice(-5) : []

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
          // T-17: task tiles — click copies the watch line (paste into any chat);
          // off by default (Ronny principle), toggled on the notifications page
          paneLogOn ? jsxs('div', {
            className: 'shrink-0 space-y-1',
            children: [
              jsx('div', { className: 'text-xs font-medium text-(--ui-text-tertiary)', children: t('paneLogTitle') }),
              taskLog.length
                ? taskLog.map((e, i) => jsx('button', {
                    key: `${e?.ts || i}-${i}`,
                    type: 'button',
                    title: t('copyHint'),
                    className: 'w-full truncate rounded-md border px-2 py-1 text-left font-mono text-xs hover:bg-(--chrome-action-hover)',
                    onClick: () => copyTaskLines(e.lines, t)
                  }, e.lines.join('\n')))
                : jsx('div', { className: 'text-xs text-(--ui-text-quaternary)', children: t('paneLogEmpty') })
            ]
          }) : null,
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

      // Backend-first: consume the computed `selectable` flag (T-010); the
      // type check is only the fallback for legacy responses without the flag.
      const caps = (activityQ.data?.capabilities || []).filter(c => c.selectable ?? (c.type !== 'native'))

      const submit = useMutation({
        mutationFn: body => ctx.rest('/tasks/submit', { method: 'POST', body, timeoutMs: 35000 }),
        onSuccess: res => {
          qc.invalidateQueries({ queryKey: TASK_KEY })
          if (res?.ok) {
            host.notify({ kind: 'info', message: t('submittedOk', res.task_id) })
            if ($watchOn.get() || $cfgTasksNotify.get()) {
              const nm = String($name.get() || '').trim()
              const line = t('watchSubmitted', nm || res.task_id, res.task_id)
              logLines([line], 'tasks', t)
              if ($watchOn.get()) deliverTaskGroup(null, line, t, $cfgTasksNotify.get())
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
        navFleet: 'IOWAP Fleet',
        navTasks: 'IOWAP Tasks',
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
        watchSubmitted: (n, tid) => `IOWAP watch: tracking "${n}" [${tid}] — updates will post here.`,
        watchStage: (n, tid, i, s) => `IOWAP task "${n}" [${tid}]: stage ${i} → ${s}`,
        watchFinal: (n, tid, s) => `IOWAP task "${n}" [${tid}]: ${s}`,
        watchDraftNote: () => 'iowap watch — no open chat composer, update kept as draft',
        // notifications page (T-016)
        notifTitle: 'IOWAP Notifications',
        notifHint: 'collects task and fleet messages; everything is OFF until you enable it here',
        sectionTasks: 'Task messages',
        sectionFleet: 'Fleet monitoring',
        notifToast: 'notify (toast / notification center)',
        notifChat: 'post to chat',
        targetLabel: 'chat target',
        targetOrigin: 'origin — the session that submitted the task',
        targetManual: 'manual session',
        modeLabel: 'post mode',
        modeDraft: 'draft (review, then send)',
        modeDirect: 'direct submit',
        sessionPh: 'session id, e.g. 20261025_165600_6cb063',
        logTitle: 'Message log',
        logClear: 'Clear',
        logEmpty: 'no messages collected yet',
        chipFlashLabel: 'show latest event in the status chip (5 s)',
        paneLogLabel: 'show last 5 task tiles in the fleet pane (click = copy)',
        chipTaskDone: (n) => 'task completed',
        chipTaskFailed: (n) => 'task failed',
        chipNodeDown: (n) => `${n} offline`,
        chipNodeUp: (n) => `${n} online`,
        chipRelayDown: () => 'relay down',
        chipRelayUp: () => 'relay back',
        paneLogTitle: 'Task messages (click = copy)',
        paneLogEmpty: 'no task messages yet — they appear here once a task finishes',
        copyHint: 'copy to clipboard',
        copiedMsg: 'copied to clipboard',
        palNotif: 'IOWAP: open notifications',
        watchLongrun: (n, m) => `⏳ iowap task "${n}" running for at least ${m} min — still going`,
        fleetOffline: (n, st) => `⚠️ iowap fleet: node "${n}" went ${st || 'offline'}`,
        fleetBack: n => `✅ iowap fleet: node "${n}" is back online`,
        fleetRelayDown: () => '⚠️ iowap fleet: relay unreachable',
        fleetRelayBack: () => '✅ iowap fleet: relay reachable again'
      },
      de: {
        paneTitle: 'IOWAP Fleet',
        pageTitle: 'IOWAP Fleet',
        navFleet: 'IOWAP Fleet (Flotte)',
        navTasks: 'IOWAP Tasks',
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
        watchSubmitted: (n, tid) => `IOWAP watch: überwache "${n}" [${tid}] — Updates laufen hier ein.`,
        watchStage: (n, tid, i, s) => `IOWAP-Task "${n}" [${tid}]: Stage ${i} → ${s}`,
        watchFinal: (n, tid, s) => `IOWAP-Task "${n}" [${tid}]: ${s}`,
        watchDraftNote: () => 'iowap watch — kein offener Chat-Composer, Update liegt als Draft',
        // Benachrichtigungsseite (T-016)
        notifTitle: 'IOWAP-Benachrichtigungen',
        notifHint: 'sammelt Task- und Flotten-Meldungen; alles ist AUS, bis du es hier einschaltest',
        sectionTasks: 'Task-Meldungen',
        sectionFleet: 'Flotten-Überwachung',
        notifToast: 'Meldung (Toast / Benachrichtigungscenter)',
        notifChat: 'in den Chat posten',
        targetLabel: 'Chat-Ziel',
        targetOrigin: 'Ursprung — die Session, die den Task gestellt hat',
        targetManual: 'manuelle Session',
        modeLabel: 'Post-Modus',
        modeDraft: 'Draft (prüfen, dann senden)',
        modeDirect: 'direkt senden',
        sessionPh: 'Session-ID, z. B. 20261025_165600_6cb063',
        logTitle: 'Meldungs-Log',
        logClear: 'Leeren',
        logEmpty: 'noch keine Meldungen gesammelt',
        chipFlashLabel: 'neuestes Ereignis im Status-Chip zeigen (5 s)',
        paneLogLabel: 'letzte 5 Task-Kacheln in der Fleet-Pane zeigen (Klick = kopieren)',
        chipTaskDone: (n) => 'Task erledigt',
        chipTaskFailed: (n) => 'Task fehlgeschlagen',
        chipNodeDown: (n) => `${n} offline`,
        chipNodeUp: (n) => `${n} online`,
        chipRelayDown: () => 'Relay nicht erreichbar',
        chipRelayUp: () => 'Relay wieder da',
        paneLogTitle: 'Task-Meldungen (Klick = kopieren)',
        paneLogEmpty: 'noch keine Task-Meldungen — sie erscheinen, sobald eine Task endet',
        copyHint: 'in die Zwischenablage kopieren',
        copiedMsg: 'kopiert',
        palNotif: 'IOWAP: Benachrichtigungen öffnen',
        watchLongrun: (n, m) => `⏳ IOWAP-Task "${n}" läuft mindestens seit ${m} min — noch aktiv`,
        fleetOffline: (n, st) => `⚠️ IOWAP-Flotte: Node "${n}" jetzt ${st || 'offline'}`,
        fleetBack: n => `✅ IOWAP-Flotte: Node "${n}" wieder online`,
        fleetRelayDown: () => '⚠️ IOWAP-Flotte: Relay nicht erreichbar',
        fleetRelayBack: () => '✅ IOWAP-Flotte: Relay wieder erreichbar'
      },
      es: {
        paneTitle: 'Flota IOWAP',
        pageTitle: 'Flota IOWAP',
        navFleet: 'Flota IOWAP',
        navTasks: 'Tareas IOWAP',
        chipTip: 'Flota IOWAP — abrir resumen',
        loading: 'cargando flota…',
        online: 'nodos en línea',
        refresh: 'Actualizar',
        updated: ago => `actualizado ${ago}`,
        load: 'Carga',
        queue: 'Cola',
        noCaps: 'sin capacidades',
        lastSeen: 'visto por última vez',
        loadErr: 'error de datos de flota',
        partialErr: 'problema de la fuente de datos',
        enableHint: 'Los datos de flota los obtiene el backend del plugin (config.yaml → plugins.enabled: iowap + dashboard/plugin_api.py). Recarga los plugins o reinicia la app si permanecen vacíos.',
        backendBy: 'datos vía node-cli en este equipo — los tokens del relay nunca entran en la app',
        palRefresh: 'IOWAP: actualizar datos de flota',
        palStatus: 'IOWAP: estado de la flota',
        palStatusMsg: n => `Flota: ${n} en línea`,
        palPage: 'IOWAP: abrir página de flota',
        palTasks: 'IOWAP: abrir página de tareas',
        tasksTitle: 'Tareas IOWAP',
        tasksHint: (n, mode) => `${n} tareas rastreadas — ${mode}`,
        busyLive: 'sondeo en vivo (hay tareas no terminales)',
        idlePolled: 'sondeo en reposo',
        tasksScope: 'el seguimiento es local a la instancia: tareas enviadas desde esta app (o añadidas por id) — el relay no expone una lista global de tareas',
        submitTitle: 'Enviar una tarea',
        selectCap: 'capacidad…',
        namePh: 'nombre (opcional)',
        invalidJson: 'el payload no es JSON válido (se espera un objeto)',
        pickCap: 'elige primero una capacidad',
        numErr: name => `el campo '${name}' necesita un número`,
        advJson: 'avanzado: editar el JSON directamente',
        submit: 'Enviar',
        submitting: 'enviando…',
        submittedOk: tid => `enviada ${tid}`,
        submitErr: e => `fallo al enviar: ${e}`,
        track: 'Rastrear',
        trackOk: tid => `rastreando ${tid}`,
        trackErr: e => `fallo al rastrear: ${e}`,
        noTasks: 'aún no hay tareas rastreadas',
        noProviders: 'sin proveedores',
        noSubmitCaps: 'no hay capacidades de tarea visibles — ¿está conectado el daemon del nodo?',
        activityTitle: 'Actividad',
        daemonSelf: tid => `daemon apagado (completadas ${tid})`,
        localNode: 'nodo local',
        capabilities: 'Capacidades',
        setupTitle: 'IOWAP: sin configuración de nodo en este equipo',
        setupWhat: 'Este plugin muestra tu flota IOWAP vía node-cli en esta máquina. Está instalado, pero este equipo no tiene el framework de nodo ni un nodo registrado — así que no hay nada que mostrar.',
        setupFix: 'Arréglalo (2 pasos):',
        setupStep1: '1. Instala el framework de nodo: git clone https://github.com/iowap-org/iowap-node && cd iowap-node && pip install -e .',
        setupStep2: '2. Regístrate en un relay: node-cli node register --base-url <relay-url>',
        setupStep3: '3. Recarga esta app — la vista de flota aparece automáticamente.',
        setupDocs: 'Docs',
        // Task-Watcher (T-013) — las líneas del chat siguen el locale de la app
        watchSubmitted: (n, tid) => `IOWAP watch: rastreando "${n}" [${tid}] — las actualizaciones aparecerán aquí.`,
        watchStage: (n, tid, i, s) => `Tarea IOWAP "${n}" [${tid}]: fase ${i} → ${s}`,
        watchFinal: (n, tid, s) => `Tarea IOWAP "${n}" [${tid}]: ${s}`,
        watchDraftNote: () => 'iowap watch — no hay composer de chat abierto, actualización guardada como borrador',
        // página de notificaciones (T-016)
        notifTitle: 'Notificaciones IOWAP',
        notifHint: 'recopila mensajes de tareas y de la flota; todo está apagado hasta que lo actives aquí',
        sectionTasks: 'Mensajes de tareas',
        sectionFleet: 'Vigilancia de la flota',
        notifToast: 'avisar (toast / centro de notificaciones)',
        notifChat: 'publicar en el chat',
        targetLabel: 'destino del chat',
        targetOrigin: 'origen — la sesión que envió la tarea',
        targetManual: 'sesión manual',
        modeLabel: 'modo de publicación',
        modeDraft: 'borrador (revisar y luego enviar)',
        modeDirect: 'envío directo',
        sessionPh: 'id de sesión, p. ej. 20261025_165600_6cb063',
        logTitle: 'Registro de mensajes',
        logClear: 'Vaciar',
        logEmpty: 'aún no hay mensajes recopilados',
        chipFlashLabel: 'mostrar el último evento en el chip de estado (5 s)',
        paneLogLabel: 'mostrar las últimas 5 fichas de tareas en el panel (clic = copiar)',
        chipTaskDone: (n) => 'tarea completada',
        chipTaskFailed: (n) => 'tarea fallida',
        chipNodeDown: (n) => `${n} sin conexión`,
        chipNodeUp: (n) => `${n} en línea`,
        chipRelayDown: () => 'relay sin conexión',
        chipRelayUp: () => 'relay de vuelta',
        paneLogTitle: 'Mensajes de tareas (clic = copiar)',
        paneLogEmpty: 'aún no hay mensajes de tareas — aparecerán cuando termine una tarea',
        copyHint: 'copiar al portapapeles',
        copiedMsg: 'copiado',
        palNotif: 'IOWAP: abrir notificaciones',
        watchLongrun: (n, m) => `⏳ Tarea IOWAP "${n}" en ejecución desde hace al menos ${m} min — sigue activa`,
        fleetOffline: (n, st) => `⚠️ Flota IOWAP: el nodo "${n}" está ${st || 'offline'}`,
        fleetBack: n => `✅ Flota IOWAP: el nodo "${n}" vuelve a estar en línea`,
        fleetRelayDown: () => '⚠️ Flota IOWAP: relay inaccesible',
        fleetRelayBack: () => '✅ Flota IOWAP: relay accesible de nuevo'
      },
      fr: {
        paneTitle: 'Flotte IOWAP',
        pageTitle: 'Flotte IOWAP',
        navFleet: 'Flotte IOWAP',
        navTasks: 'Tâches IOWAP',
        chipTip: `Flotte IOWAP — ouvrir la vue d'ensemble`,
        loading: 'chargement de la flotte…',
        online: 'nœuds en ligne',
        refresh: 'Actualiser',
        updated: ago => `mis à jour ${ago}`,
        load: 'Charge',
        queue: `File d'attente`,
        noCaps: 'aucune capacité',
        lastSeen: 'dernière activité',
        loadErr: 'erreur des données de flotte',
        partialErr: 'problème de la source de données',
        enableHint: `Les données de flotte sont récupérées par le backend du plugin (config.yaml → plugins.enabled: iowap + dashboard/plugin_api.py). Rechargez les plugins ou redémarrez l'app si elles restent vides.`,
        backendBy: `données via node-cli sur ce poste — les tokens du relay n'entrent jamais dans l'app`,
        palRefresh: 'IOWAP : actualiser les données de flotte',
        palStatus: 'IOWAP : état de la flotte',
        palStatusMsg: n => `Flotte : ${n} en ligne`,
        palPage: 'IOWAP : ouvrir la page flotte',
        palTasks: 'IOWAP : ouvrir la page des tâches',
        tasksTitle: 'Tâches IOWAP',
        tasksHint: (n, mode) => `${n} tâches suivies — ${mode}`,
        busyLive: 'polling en direct (tâches non terminales présentes)',
        idlePolled: 'polling au repos',
        tasksScope: `le suivi est local à l'instance : tâches soumises depuis cette app (ou ajoutées par id) — le relay n'expose pas de liste globale`,
        submitTitle: 'Soumettre une tâche',
        selectCap: 'capacité…',
        namePh: 'nom (optionnel)',
        invalidJson: `le payload n'est pas du JSON valide (objet attendu)`,
        pickCap: `choisissez d'abord une capacité`,
        numErr: name => `le champ '${name}' exige un nombre`,
        advJson: 'avancé : éditer le JSON directement',
        submit: 'Soumettre',
        submitting: 'envoi en cours…',
        submittedOk: tid => `soumise ${tid}`,
        submitErr: e => `échec de la soumission : ${e}`,
        track: 'Suivre',
        trackOk: tid => `suivi de ${tid}`,
        trackErr: e => `échec du suivi : ${e}`,
        noTasks: `aucune tâche suivie pour l'instant`,
        noProviders: 'aucun fournisseur',
        noSubmitCaps: 'aucune capacité de tâche visible — le daemon du nœud est-il connecté ?',
        activityTitle: 'Activité',
        daemonSelf: tid => `daemon arrêté (terminées ${tid})`,
        localNode: 'nœud local',
        capabilities: 'Capacités',
        setupTitle: 'IOWAP : aucun nœud configuré sur ce poste',
        setupWhat: `Ce plugin affiche votre flotte IOWAP via node-cli sur cette machine. Il est installé, mais ce poste n'a ni framework de nœud ni nœud enregistré — rien à afficher.`,
        setupFix: 'Corrigez (2 étapes) :',
        setupStep1: '1. Installez le framework du nœud : git clone https://github.com/iowap-org/iowap-node && cd iowap-node && pip install -e .',
        setupStep2: `2. Enregistrez-vous auprès d'un relay : node-cli node register --base-url <relay-url>`,
        setupStep3: '3. Rechargez cette app — la vue flotte apparaît automatiquement.',
        setupDocs: 'Docs',
        // Observateur de tâches (T-013) — les lignes de chat suivent le locale de l'app
        watchSubmitted: (n, tid) => `IOWAP watch : suivi de "${n}" [${tid}] — les mises à jour s'afficheront ici.`,
        watchStage: (n, tid, i, s) => `Tâche IOWAP "${n}" [${tid}] : étape ${i} → ${s}`,
        watchFinal: (n, tid, s) => `Tâche IOWAP "${n}" [${tid}] : ${s}`,
        watchDraftNote: () => 'iowap watch — aucun composer de chat ouvert, mise à jour en brouillon',
        // page de notifications (T-016)
        notifTitle: 'Notifications IOWAP',
        notifHint: 'collecte les messages des tâches et de la flotte ; tout est désactivé jusqu\'à activation ici',
        sectionTasks: 'Messages des tâches',
        sectionFleet: 'Surveillance de la flotte',
        notifToast: 'notifier (toast / centre de notifications)',
        notifChat: 'publier dans le chat',
        targetLabel: 'destination du chat',
        targetOrigin: 'origine — la session qui a soumis la tâche',
        targetManual: 'session manuelle',
        modeLabel: 'mode de publication',
        modeDraft: 'brouillon (vérifier, puis envoyer)',
        modeDirect: 'envoi direct',
        sessionPh: 'id de session, p. ex. 20261025_165600_6cb063',
        logTitle: 'Journal des messages',
        logClear: 'Vider',
        logEmpty: 'aucun message collecté pour l\'instant',
        chipFlashLabel: 'afficher le dernier événement dans la puce d\'état (5 s)',
        paneLogLabel: 'afficher les 5 dernières tuiles de tâches dans le panneau (clic = copier)',
        chipTaskDone: (n) => 'tâche terminée',
        chipTaskFailed: (n) => 'tâche en échec',
        chipNodeDown: (n) => `${n} hors ligne`,
        chipNodeUp: (n) => `${n} en ligne`,
        chipRelayDown: () => 'relay injoignable',
        chipRelayUp: () => 'relay de retour',
        paneLogTitle: 'Messages des tâches (clic = copier)',
        paneLogEmpty: 'aucun message de tâche — ils apparaissent dès qu\'une tâche se termine',
        copyHint: 'copier dans le presse-papiers',
        copiedMsg: 'copié',
        palNotif: 'IOWAP : ouvrir les notifications',
        watchLongrun: (n, m) => `⏳ Tâche IOWAP "${n}" en cours depuis au moins ${m} min — toujours active`,
        fleetOffline: (n, st) => `⚠️ Flotte IOWAP : le nœud "${n}" est passé ${st || 'hors ligne'}`,
        fleetBack: n => `✅ Flotte IOWAP : le nœud "${n}" est de retour en ligne`,
        fleetRelayDown: () => '⚠️ Flotte IOWAP : relay injoignable',
        fleetRelayBack: () => '✅ Flotte IOWAP : relay de nouveau joignable'
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
      data: { path: '/iowap-fleet', label: ctx.i18n.t('navFleet'), codicon: 'project' }
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
      data: { path: '/iowap-tasks', label: ctx.i18n.t('navTasks'), codicon: 'checklist' }
    })

    // -----------------------------------------------------------------
    // Notifications page (T-016, Ronny spec): all settings OFF by default,
    // one section per area + the collected message log.
    // -----------------------------------------------------------------
    function NotificationsPage() {
      const t = usePluginI18n(ID)
      const log = useValue($notifLog)
      const tasksChat = useValue($watchOn)
      const tasksNotify = useValue($cfgTasksNotify)
      const chipFlash = useValue($cfgChipFlash)
      const paneLog = useValue($cfgPaneLog)
      const tasksTarget = useValue($cfgTasksTarget)
      const tasksSession = useValue($cfgTasksSession)
      const tasksMode = useValue($cfgTasksMode)
      const fleetNotify = useValue($cfgFleetNotify)
      const fleetChat = useValue($cfgFleetChat)
      const fleetSession = useValue($cfgFleetSession)

      const radio = (name, checked, onPick, children) => jsx('label', {
        className: 'flex cursor-pointer items-center gap-1.5 text-sm',
        children: [
          jsx('input', {
            type: 'radio', name, checked, onChange: onPick,
            className: 'accent-(--primary)'
          }),
          children
        ]
      })
      const entry = (e, i) => {
        const when = e?.ts ? relativeTime(e.ts) : '?'
        return jsx('div', { key: i, className: 'border-t first:border-t-0 px-3 py-1.5 text-xs', children: [
          jsx('div', { className: 'text-muted-foreground', children: `${e.scope === 'fleet' ? 'fleet' : 'tasks'} · ${when}` }),
          ...((e.lines || [])).map((line, j) => jsx('div', { key: j, className: 'font-mono', children: line }))
        ] })
      }

      return jsx('div', {
        className: 'mx-auto w-full max-w-3xl space-y-6 p-6',
        children: [
          jsx('h1', { className: 'text-lg font-semibold', children: t('notifTitle') }),
          jsx('p', { className: 'text-sm text-muted-foreground', children: t('notifHint') }),

          jsxs('section', {
            className: 'space-y-4 rounded-lg border p-4',
            children: [
              jsx('h2', { className: 'text-sm font-semibold', children: t('sectionTasks') }),
              jsx('label', {
                className: 'flex items-center gap-2 text-sm',
                children: [
                  jsx(Switch, {
                    id: 'iowap-tasks-notify', size: 'xs', checked: tasksNotify,
                    onCheckedChange: v => { haptic('tap'); setCfg($cfgTasksNotify, 'notify.tasks.enabled', v) }
                  }),
                  t('notifToast')
                ]
              }),
              jsx('label', {
                className: 'flex items-center gap-2 text-sm',
                children: [
                  jsx(Switch, {
                    id: 'iowap-tasks-chat', size: 'xs', checked: tasksChat,
                    onCheckedChange: v => { haptic('tap'); setWatchOn(v) }
                  }),
                  t('notifChat')
                ]
              }),
              jsxs('label', {
                className: 'flex items-center gap-2 text-sm',
                children: [
                  jsx(Switch, {
                    id: 'iowap-chip-flash', size: 'xs', checked: chipFlash,
                    onCheckedChange: v => { haptic('tap'); setCfg($cfgChipFlash, 'chip.flash.enabled', v) }
                  }),
                  t('chipFlashLabel')
                ]
              }),
              jsxs('label', {
                className: 'flex items-center gap-2 text-sm',
                children: [
                  jsx(Switch, {
                    id: 'iowap-pane-log', size: 'xs', checked: paneLog,
                    onCheckedChange: v => { haptic('tap'); setCfg($cfgPaneLog, 'pane.log.enabled', v) }
                  }),
                  t('paneLogLabel')
                ]
              }),
              tasksChat ? jsx('div', { className: 'space-y-3 rounded-md border bg-muted/30 p-3', children: [
                jsx('div', { className: 'text-xs font-medium', children: t('targetLabel') }),
                jsxs('div', { className: 'flex flex-col gap-1.5', children: [
                  radio('iowap-tasks-target', tasksTarget === 'origin',
                    () => { haptic('tap'); setCfg($cfgTasksTarget, 'notify.tasks.target', 'origin') },
                    t('targetOrigin')),
                  radio('iowap-tasks-target', tasksTarget === 'manual',
                    () => { haptic('tap'); setCfg($cfgTasksTarget, 'notify.tasks.target', 'manual') },
                    t('targetManual'))
                ] }),
                jsx(Input, {
                  value: tasksSession, placeholder: t('sessionPh'),
                  onChange: evt => setCfg($cfgTasksSession, 'notify.tasks.session', evt.target.value || '')
                }),
                jsx('div', { className: 'text-xs font-medium', children: t('modeLabel') }),
                jsxs('div', { className: 'flex flex-col gap-1.5', children: [
                  radio('iowap-tasks-mode', tasksMode === 'draft',
                    () => { haptic('tap'); setCfg($cfgTasksMode, 'notify.tasks.mode', 'draft') },
                    t('modeDraft')),
                  radio('iowap-tasks-mode', tasksMode === 'direct',
                    () => { haptic('tap'); setCfg($cfgTasksMode, 'notify.tasks.mode', 'direct') },
                    t('modeDirect'))
                ] })
              ] }) : null
            ]
          }),

          jsxs('section', {
            className: 'space-y-4 rounded-lg border p-4',
            children: [
              jsx('h2', { className: 'text-sm font-semibold', children: t('sectionFleet') }),
              jsx('label', {
                className: 'flex items-center gap-2 text-sm',
                children: [
                  jsx(Switch, {
                    id: 'iowap-fleet-notify', size: 'xs', checked: fleetNotify,
                    onCheckedChange: v => { haptic('tap'); setCfg($cfgFleetNotify, 'notify.fleet.enabled', v) }
                  }),
                  t('notifToast')
                ]
              }),
              jsx('label', {
                className: 'flex items-center gap-2 text-sm',
                children: [
                  jsx(Switch, {
                    id: 'iowap-fleet-chat', size: 'xs', checked: fleetChat,
                    onCheckedChange: v => { haptic('tap'); setCfg($cfgFleetChat, 'notify.fleet.chat', v) }
                  }),
                  t('notifChat')
                ]
              }),
              fleetChat ? jsx(Input, {
                value: fleetSession, placeholder: t('sessionPh'),
                onChange: evt => setCfg($cfgFleetSession, 'notify.fleet.session', evt.target.value || '')
              }) : null
            ]
          }),

          jsxs('section', {
            className: 'space-y-2 rounded-lg border p-4',
            children: [
              jsx('div', { className: 'flex items-center justify-between', children: [
                jsx('h2', { className: 'text-sm font-semibold', children: t('logTitle') }),
                jsx(Button, {
                  size: 'xs', onClick: () => {
                    haptic('tap')
                    notifLog = []
                    try { ctx.storage.set('watch.log', []) } catch { /* best effort */ }
                    $notifLog.set([])
                  }
                }, t('logClear'))
              ] }),
              (log || []).length === 0
                ? jsx('div', { className: 'text-xs text-muted-foreground', children: t('logEmpty') })
                : jsxs('div', { className: 'max-h-80 space-y-2 overflow-y-auto', children: [...(log || []).slice(-50).reverse().map(entry)] })
            ]
          })
        ]
      })
    }
    ctx.register({
      id: 'notif-page',
      area: ROUTES_AREA,
      data: { path: '/iowap-notifications' },
      render: () => jsx(NotificationsPage, {})
    })
    ctx.register({
      id: 'notif-nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: '/iowap-notifications', label: ctx.i18n.t('notifTitle'), codicon: 'bell' }
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
    // T-016: config lives on the notifications page — the palette gets a
    // jump instead of an inline toggle (single place of configuration).
    ctx.register({
      id: 'cmd-notif',
      area: PALETTE_AREA,
      data: {
        id: 'iowap.notif',
        label: ctx.i18n.t('palNotif'),
        keywords: ['iowap', 'watch', 'notification', 'chat', 'settings'],
        detail: () => {
          const n = (notifLog || []).length
          return n ? `${n} msgs` : '0'
        },
        detailVariant: 'state',
        run: () => {
          haptic('tap')
          host.navigate('/iowap-notifications')
        }
      }
    })
  }
}

// Test hook for tools/render-smoke.mjs — inert in production (the app loads
// only the default export): exposes the pure watcher sweep for assertions.
export const __test = { watchSweep, taskSnap, sameSnap, fleetSweep }