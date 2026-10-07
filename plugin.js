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

    // -------------------------------------------------------------------
    // TaskForm: capability select (selectable only, type != native) +
    // plaintext fields from the capability's input_schema — payload JSON is
    // GENERATED, not handwritten. "Advanced" toggle for raw JSON edits.
    // -------------------------------------------------------------------
    function TaskForm({ caps, cap, onCap, nameTxt, onName, onErr, onSubmit, submitting, err, t }) {
      const activityQ = useActivity()
      const sel = caps.find(c => c.name === cap) || null
      const fields = sel && sel.fields && typeof sel.fields === 'object' ? Object.values(sel.fields) : []

      const $adv = atom(false)
      const $raw = atom('{}')
      const $vals = atom({})
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
              onCheckedChange: v => $adv.set(v), size: 'xs'
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

      // form atoms — fresh per mount; no SDK react hooks by design
      const $cap = atom('')
      const $name = atom('')
      const $formErr = atom('')
      const $trackId = atom('')
      const cap = useValue($cap)
      const nameTxt = useValue($name)
      const formErr = useValue($formErr)
      const trackId = useValue($trackId)

      const caps = (activityQ.data?.capabilities || []).filter(c => c.type !== 'native')

      const submit = useMutation({
        mutationFn: body => ctx.rest('/tasks/submit', { method: 'POST', body, timeoutMs: 35000 }),
        onSuccess: res => {
          qc.invalidateQueries({ queryKey: TASK_KEY })
          if (res?.ok) {
            host.notify({ kind: 'info', message: t('submittedOk', res.task_id) })
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
        capabilities: 'capabilities'
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
        palPage: 'IOWAP: Fleet-Seite öffnen',
        palTasks: 'IOWAP: Tasks-Seite öffnen',
        tasksTitle: 'IOWAP Tasks',
        tasksHint: (n, mode) => `${n} getrackte Tasks — ${mode}`,
        busyLive: 'Live-Polling (nicht-terminale Tasks vorhanden)',
        idlePolled: 'ruhendes Polling',
        tasksScope: 'Tracking ist instanzlokal: Tasks aus dieser App (oder per ID hinzugefügt) — das Relay hat keine globale Task-Liste',
        submitTitle: 'Task einreichen',
        selectCap: 'Capability…',
        namePh: 'Name (optional)',
        invalidJson: 'Payload ist kein valides JSON (Objekt erwartet)',
        pickCap: 'erst eine Capability wählen',
        numErr: name => `Feld '${name}' braucht eine Zahl`,
        advJson: 'Erweitert: JSON direkt bearbeiten',
        submit: 'Einreichen',
        submitting: 'reiche ein…',
        submittedOk: tid => `eingereicht ${tid}`,
        submitErr: e => `Einreichen fehlgeschlagen: ${e}`,
        track: 'Tracken',
        trackOk: tid => `tracking ${tid}`,
        trackErr: e => `Tracken fehlgeschlagen: ${e}`,
        noTasks: 'noch keine getrackten Tasks',
        noProviders: 'keine Provider',
        noSubmitCaps: 'keine Task-Capabilities sichtbar — ist der Node-Daemon verbunden?',
        activityTitle: 'Aktivität',
        daemonSelf: tid => `Daemon aus (abgeschlossen ${tid})`,
        localNode: 'lokaler Node',
        capabilities: 'Capabilities'
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
  }
}