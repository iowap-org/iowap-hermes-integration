/**
 * Render smoke test for plugin.js — catches runtime ReferenceErrors (like a
 * missing helper variable) that `node --check` cannot see, without needing a
 * running desktop app.
 *
 * Strategy: stub every @hermes/plugin-sdk export with the smallest object that
 * records a render, execute the real plugin file, call register(stubCtx), then
 * invoke every registered component's render() with both empty and populated
 * fleet data. Any throw = fail.
 *
 * Usage: node tools/render-smoke.mjs
 * Exit 0 = all renders clean, 1 = a render threw (prints the stack).
 */
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginSrc = readFileSync(join(repo, 'desktop', 'plugin.js'), 'utf8')

// ---- stub the SDK ----------------------------------------------------------
// React is required by the plugin's jsx factories; use the real one so element
// creation is real, but render only to JSON (no DOM).
const require = createRequire(import.meta.url)
let jsxModule
try {
  const reactJsxPaths = ['react/jsx-runtime']
  jsxModule = require(reactJsxPaths[0])
} catch {
  jsxModule = { jsx: (...a) => ({ __jsx: a }), jsxs: (...a) => ({ __jsx: a }) }
}

let renders = 0
const sdkStub = {
  cn: (...a) => a.filter(Boolean).join(' '),
  haptic: () => {},
  host: { navigate: () => {}, notify: () => {} },
  Tip: 'Tip',
  Badge: 'Badge',
  Button: 'Button',
  StatusDot: 'StatusDot',
  icons: { RefreshCw: 'RefreshCw', Activity: 'Activity', LayoutDashboard: 'LayoutDashboard', ListTodo: 'ListTodo' },
  relativeTime: () => 'just now',
  usePluginI18n: () => {
    // Real-ish i18n: functions must survive being called with args.
    const table = new Proxy({}, {
      get: (_t, key) => (...args) => `[${String(key)}${args.length ? ':' + args.join('|') : ''}]`
    })
    return k => table[k]
  },
  useValue: a => (a && typeof a.get === 'function' ? a.get() : a),
  useQuery: def => {
    // Per-key data: fleet (FLEET_KEY contains 'tasks'? no — fleet key uses
    // 'fleet'), tasks, activity. The plugin passes the key as first arg.
    const key = JSON.stringify(def?.queryKey || [])
    if (key.includes('activity')) return { data: globalThis.__ACTIVITY_DATA__, isError: false, error: undefined, isFetching: false, isLoading: false, dataUpdatedAt: Date.now(), refetch: () => {} }
    if (key.includes('tasks')) return { data: globalThis.__TASKS_DATA__, isError: false, error: undefined, isFetching: false, isLoading: false, dataUpdatedAt: Date.now(), refetch: () => {} }
    return { data: globalThis.__FLEET_DATA__, isError: globalThis.__FLEET_IS_ERROR__ ?? false, error: undefined, isFetching: false, isLoading: false, dataUpdatedAt: Date.now(), refetch: () => {} }
  },
  useMutation: () => ({ mutate: () => {}, isPending: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  queryClient: { invalidateQueries: () => {} },
  atom: init => ({ get: () => init, set: () => {} }),
  PALETTE_AREA: 'palette',
  ROUTES_AREA: 'routes',
  SIDEBAR_NAV_AREA: 'sidebar-nav',
  STATUSBAR_AREAS: { right: 'statusbar-right' }
}

const temp = mkdtempSync(join(tmpdir(), 'iowap-plugin-smoke-'))
// Nested stub dirs must exist before the file writes below.
mkdirSync(join(temp, 'node_modules', '@hermes', 'plugin-sdk'), { recursive: true })
mkdirSync(join(temp, 'node_modules', 'react'), { recursive: true })
const sdkPath = join(temp, 'node_modules', '@hermes', 'plugin-sdk', 'index.mjs')
writeFileSync(sdkPath, `
export const cn = ${sdkStub.cn.toString()}
export const haptic = () => {}
globalThis.__COMPOSER__ = { submitted: [], inserted: [] }
export const host = {
  navigate: () => {},
  notify: () => {},
  composer: {
    getDraft: async () => null,
    setDraft: async () => true,
    insertText: async (_sid, text) => { globalThis.__COMPOSER__.inserted.push(String(text)); return true },
    submit: (_sid, text) => { globalThis.__COMPOSER__.submitted.push(String(text)); return true },
    focus: () => {}
  }
}
export const Tip = 'Tip'
export const Badge = 'Badge'
export const Button = 'Button'
export const StatusDot = 'StatusDot'
export const icons = ${JSON.stringify(sdkStub.icons)}
export const relativeTime = () => 'just now'
export const usePluginI18n = ${sdkStub.usePluginI18n.toString()}
export const useValue = a => (a && typeof a.get === 'function' ? a.get() : a)
export function useQuery() {
  const def = arguments[0]
  const key = JSON.stringify(def?.queryKey || [])
  if (key.includes('activity')) return { data: globalThis.__ACTIVITY_DATA__, isError: false, error: undefined, isFetching: false, isLoading: false, dataUpdatedAt: Date.now(), refetch: () => {} }
  if (key.includes('tasks')) return { data: globalThis.__TASKS_DATA__, isError: false, error: undefined, isFetching: false, isLoading: false, dataUpdatedAt: Date.now(), refetch: () => {} }
  return { data: globalThis.__FLEET_DATA__, isError: globalThis.__FLEET_IS_ERROR__ ?? false, error: undefined, isFetching: false, isLoading: false, dataUpdatedAt: Date.now(), refetch: () => {} }
}
export const useMutation = () => ({ mutate: () => {}, isPending: false, isError: false })
export const useQueryClient = () => ({ invalidateQueries: () => {} })
export const queryClient = { invalidateQueries: () => {} }
export const atom = init => ({ get: () => init, set: () => {} })
export const Input = 'Input'
export const Textarea = 'Textarea'
export const Switch = 'Switch'
export const Select = 'Select'
export const SelectContent = 'SelectContent'
export const SelectItem = 'SelectItem'
export const SelectTrigger = 'SelectTrigger'
export const SelectValue = 'SelectValue'
export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const STATUSBAR_AREAS = { right: 'statusbar-right' }
`)
writeFileSync(join(temp, 'node_modules', '@hermes', 'plugin-sdk', 'package.json'),
  JSON.stringify({ name: '@hermes/plugin-sdk', type: 'module', main: './index.mjs' }))

// react/jsx-runtime: prefer the real one from the repo's node_modules if present,
// else stub with plain objects.
let jsxShim
try {
  jsxShim = require(join(repo, 'node_modules', 'react', 'jsx-runtime.js'))
} catch {
  jsxShim = {
    jsx: (type, props, key) => ({ type, props, key }),
    jsxs: (type, props, key) => ({ type, props, key })
  }
}
writeFileSync(join(temp, 'node_modules', 'react', 'jsx-runtime.js'),
  `export const jsx = ${jsxShim.jsx.toString()}\nexport const jsxs = ${jsxShim.jsxs.toString()}\nexport const useEffect = () => {}\n`)
writeFileSync(join(temp, 'node_modules', 'react', 'package.json'),
  JSON.stringify({
    name: 'react',
    type: 'module',
    main: './jsx-runtime.js',
    exports: { '.': './jsx-runtime.js', './jsx-runtime': './jsx-runtime.js' }
  }))

// ---- load the real plugin against the stubs --------------------------------
const registered = []
const stubCtx = {
  rest: async () => (globalThis.__FLEET_DATA__ ?? {}),
  i18n: {
    register: () => {},
    t: key => `[${String(key)}]`
  },
  register: contribution => registered.push(contribution)
}

// Evaluate the plugin source as a module scoped to the temp node_modules.
const pluginPath = join(temp, 'plugin-under-test.mjs')
writeFileSync(pluginPath, pluginSrc)
const mod = await import(pluginPath)
mod.default.register(stubCtx)

const contributionsWithRender = registered.filter(c => typeof c.render === 'function')
const navRows = registered.filter(c => c.area === 'sidebar-nav')
if (!contributionsWithRender.length && !navRows.length) {
  console.error('FAIL: no renderable contributions registered')
  process.exit(1)
}

// ---- render each component with both data states ---------------------------
// render() returns a React element; function components must actually be
// INVOKED (like React would) for hook calls and their function bodies to run
// — that is where runtime ReferenceErrors live.
const MAX_DEPTH = 25

function renderElement(el, depth) {
  if (depth > MAX_DEPTH) throw new Error('render depth exceeded — recursive component?')
  if (el == null || typeof el === 'boolean' || typeof el === 'string' || typeof el === 'number') return
  if (Array.isArray(el)) {
    for (const child of el) renderElement(child, depth + 1)
    return
  }
  if (typeof el.type === 'function') {
    // Function component (FleetPage, NodeCard, …): invoke it like React would.
    renderElement(el.type(el.props || {}), depth + 1)
    return
  }
  // Host element (string type or stubbed jsx object): walk children.
  const props = el.props || {}
  renderElement(props.children, depth + 1)
}

function renderContribution(c) {
  renderElement(c.render(), 0)
}

// T-010 assertion helper: collect every visible string from a rendered tree
// (same walk as renderElement — function components must be invoked first).
function collectText(el, depth, out) {
  if (depth > MAX_DEPTH || el == null || typeof el === 'boolean') return out
  if (typeof el === 'string' || typeof el === 'number') { out.push(String(el)); return out }
  if (Array.isArray(el)) { for (const c of el) collectText(c, depth + 1, out); return out }
  if (typeof el.type === 'function') return collectText(el.type(el.props || {}), depth + 1, out)
  return collectText((el.props || {}).children, depth + 1, out)
}

try {
  // Empty fleet (loading state)
  globalThis.__FLEET_DATA__ = undefined
  for (const c of contributionsWithRender) renderContribution(c)

  // Populated fleet (happy path, like the live backend returns)
  globalThis.__FLEET_DATA__ = {
    generated_at: new Date().toISOString(),
    backend: 'node-cli',
    nodes: [
      { node_id: 'n1', node_name: 'Node-41C', role: 'node', status: 'online', load: 0.42, load_source: 'cgroup2', queue_depth: 0, busy: false, last_seen: new Date().toISOString(), available: true, capabilities: [{ name: 'chat.ai' }, { name: 'web.ai' }] },
      { node_id: 'n2', node_name: 'Node-31B', role: 'node', status: 'online', load: 2.9, load_source: 'loadavg', queue_depth: 1, busy: true, last_seen: new Date().toISOString(), available: true, capabilities: [{ name: 'tts.ai' }] },
      { node_id: 'n3', node_name: 'Dashboard Admin', role: 'admin', status: 'online', load: null, load_source: null, queue_depth: null, busy: false, last_seen: null, available: true, capabilities: [] }
    ],
    capability_map: { n1: ['chat.ai'], n2: ['tts.ai'] },
    health: { ok: true, via: 'node-cli', body: { ok: true, error: '', version: '2.0.0', mode: 'core', database: 'ok', nodes_online: 9, nodes_total: 10 } },
    errors: []
  }
  for (const c of contributionsWithRender) renderContribution(c)

  // Health-error line: node-cli reports an unreachable relay (T-007 shape —
  // {"error", via}, no body) — healthLineOf must render the unreachable line.
  globalThis.__FLEET_DATA__ = { ...globalThis.__FLEET_DATA__,
    health: { error: 'health: [Errno 111] Connection refused', via: 'node-cli' } }
  for (const c of contributionsWithRender) renderContribution(c)

  // Populated activity (tasks + capabilities — the new TasksPage path)
  globalThis.__TASKS_DATA__ = {
    generated_at: new Date().toISOString(),
    tasks: [
      { task_id: 'task_x1', name: 'T-006-plugin-smoke', status: 'completed', priority: 0, stages: [{ stage_id: 's1', capability: 'hermes-test.ai', status: 'completed', result_preview: 'ok', retry_count: 0, claimed_by: 'NODE23A4' }], error: null, artifacts: [{ name: 'out.txt' }] },
      { task_id: 'task_x2', name: 'draft-chapter', status: 'pending', priority: 1, stages: [{ stage_id: 's2', capability: 'draft.ai', status: 'pending', result_preview: '', retry_count: 1 }], error: 'retry exhausted on stage', artifacts: [] }
    ],
    errors: ['node r2 unreachable (timeout)']
  }
  globalThis.__ACTIVITY_DATA__ = {
    generated_at: new Date().toISOString(),
    daemon: { running: true, pid: 4242, heartbeat_status: 'ok', tasks_completed: 14, tasks_failed: 1 },
    local_node: { node_id: 'n0', node_name: 'node-23a', node_role: 'node' },
    capabilities: [
      {
        name: 'draft.ai', type: 'task', provider_count: 2, queues_total: 3, selectable: true,
        description: 'Writes draft sections.',
        fields: {
          topic: { name: 'topic', type: 'string', required: true, description: 'Topic to draft, e.g. "release notes".' },
          lines: { name: 'lines', type: 'number', required: false, description: 'How many lines, default 40, max 400.', example: 100 },
          verbose: { name: 'verbose', type: 'boolean', required: false, description: 'Talk more.', example: false }
        },
        providers: [
          { node_id: 'n1', node_name: 'Node-41C', available: true, queues: [{ queue: 'q1', depth: 3 }] },
          { node_id: 'n2', node_name: 'Node-31B', available: false, queues: [] }
        ]
      },
      {
        name: 'hermes-test.ai', type: 'task', provider_count: 1, queues_total: 0, selectable: true,
        description: 'Hermes connectivity test.',
        fields: { task: { name: 'task', type: 'string', required: true, description: 'What to test.' } },
        providers: [{ node_id: 'n0', node_name: 'node-23a', available: false, queues: [] }]
      },
      {
        name: 'backup.info', type: 'native', provider_count: 1, queues_total: 0, selectable: false,
        description: 'Relay storage op — not submittable here.',
        fields: {},
        providers: [{ node_id: 'n1', node_name: 'Node-41C', available: true, queues: [] }]
      },
      {
        name: 'proxy.admin', type: 'proxy', provider_count: 1, queues_total: 0, selectable: false,
        description: 'Internal proxy op off the submit vocabulary.',
        fields: {},
        providers: [{ node_id: 'n1', node_name: 'Node-41C', available: true, queues: [] }]
      },
      {
        name: 'legacy.info', type: 'task', provider_count: 1, queues_total: 0, selectable: false,
        description: 'Backend overrode a known type with the flag.',
        fields: {},
        providers: [{ node_id: 'n0', node_name: 'node-23a', available: true, queues: [] }]
      },
      {
        name: 'nostamp.legacy', type: 'tool', provider_count: 1, queues_total: 0,
        description: 'Legacy backend response without a selectable stamp.',
        fields: {},
        providers: [{ node_id: 'n0', node_name: 'node-23a', available: true, queues: [] }]
      }
    ]
  }
  for (const c of contributionsWithRender) renderContribution(c)

  // T-010 assertion: the task form's capability select must consume the
  // backend-computed `selectable` flag, not guess from the raw `type` value —
  // scoped to `SelectContent`, because the fleet page legitimately lists the
  // FULL capability inventory (unfiltered) elsewhere. proxy.admin (new type)
  // and legacy.info (flagged off) are invisible in the form; nostamp.legacy
  // (no flag field — legacy backend) falls back to the type filter and shows.
  function collectSelectContentText(el, depth, out) {
    if (depth > MAX_DEPTH || el == null || typeof el === 'boolean') return out
    if (Array.isArray(el)) { for (const c of el) collectSelectContentText(c, depth + 1, out); return out }
    if (typeof el.type === 'function') return collectSelectContentText(el.type(el.props || {}), depth + 1, out)
    const props = (el.props || {})
    if (el.type === 'SelectContent') return collectText(props.children, depth + 1, out)
    return collectSelectContentText(props.children, depth + 1, out)
  }
  {
    const texts = []
    for (const c of contributionsWithRender) collectSelectContentText(c.render(), 0, texts)
    const blob = texts.join('\n')
    for (const h of ['proxy.admin', 'legacy.info']) {
      if (blob.includes(h)) throw new Error(
        `T-010: backend-flagged non-selectable cap "${h}" rendered in the task form — filter must consume selectable, not type`)
    }
    for (const s of ['draft.ai', 'nostamp.legacy']) {
      if (!blob.includes(s)) throw new Error(`T-010: expected selectable cap "${s}" missing from the task form render`)
    }
  }

  // T-013 watcher logic: pure sweep, invoked through the plugin's __test hook.
  {
    const assert = (cond, msg) => { if (!cond) throw new Error('T-013: ' + msg) }
    const t = (...a) => a.join('|')
    const row = (status, stages, name, err, preview) => ({
      task_id: 't13', name, status, error: err ?? null,
      stages: stages.map(s => ({ status: s, result_preview: preview || '' }))
    })
    // first sight: registry only, silent
    let r = mod.__test.watchSweep({}, [row('pending', ['pending'], 'demo')], t)
    assert(!r.lines.length, 'first sight must not back-post')
    assert(r.nextMap.t13?.status === 'pending', 'first sight must register the task')
    // non-terminal transitions stay silent (registry moves on)
    r = mod.__test.watchSweep(r.nextMap, [row('running', ['claimed'], 'demo')], t)
    assert(!r.lines.length, 'non-terminal transitions must not post')
    // stage completed → exactly one EVENT line — the node's result preview
    // itself must NEVER enter the chat (T-016, PR review point 3)
    r = mod.__test.watchSweep(r.nextMap, [row('running', ['completed'], 'demo', null, 'done ok')], t)
    assert(r.lines.length === 1 && r.lines[0] === 'watchStage|demo|t13|1|completed',
      'stage completion posts an event-only line (no node output)')
    assert(r.targets.length === 1 && r.targets[0] === null, 'line without session origin targets null')
    // final state → posted; unchanged stage is NOT re-posted
    r = mod.__test.watchSweep(r.nextMap, [row('completed', ['completed'], 'demo')], t)
    assert(r.lines.length === 1 && r.lines[0] === 'watchFinal|demo|t13|completed', 'final must post once')
    // same poll again → dup-guard stays silent
    const again = mod.__test.watchSweep(r.nextMap, [row('completed', ['completed'], 'demo')], t)
    assert(!again.lines.length, 'dup guard must not post twice')
    // failed final: stage failure and the final line post in ONE sweep —
    // the raw error string must NOT ride along
    const f = mod.__test.watchSweep(
      { t13b: { status: 'running', stages: ['claimed'] } },
      [{ task_id: 't13b', name: 'demo-b', status: 'failed', error: 'boom', stages: [{ status: 'failed', result_preview: '' }] }],
      t)
    assert(f.lines.length === 2
      && f.lines[0] === 'watchStage|demo-b|t13b|1|failed'
      && f.lines[1] === 'watchFinal|demo-b|t13b|failed',
      'failed final posts event-only lines (error text stays out)')
  }

  // T-016 origin-session targets ride per line.
  {
    const assert = (cond, msg) => { if (!cond) throw new Error('T-016 targets: ' + msg) }
    const t = (...a) => a.join('|')
    const oo = mod.__test.watchSweep(
      { o1: { status: 'running', stages: ['claimed'], seenAt: 0, warned: false } },
      [{ task_id: 'o1', name: 'orig', status: 'completed', session_id: 'sess_9', error: null, stages: [{ status: 'completed', result_preview: '' }] }],
      t)
    assert(oo.lines.length === 2 && oo.targets.length === 2
      && oo.targets[0] === 'sess_9' && oo.targets[1] === 'sess_9',
      'origin session id rides on every posted line')
  }

  // T-013 longrun: non-terminal > 5 min → exactly one hint, then silent.
  {
    const assert = (cond, msg) => { if (!cond) throw new Error('T-013 longrun: ' + msg) }
    const t = (...a) => a.join('|')
    const row = s => ({ task_id: 'lr1', name: 'longtask', status: s, error: null, stages: [{ status: 'claimed', result_preview: '' }] })
    const done = { task_id: 'lr1', name: 'longtask', status: 'completed', error: null, stages: [{ status: 'completed', result_preview: 'ok' }] }
    let r = mod.__test.watchSweep({}, [row('running')], t, 1_000_000)
    assert(!r.lines.length, 'first sight: no longrun hint')
    // QUEUED (pending) task must NOT get a longrun hint — that was the false alarm
    const qr = mod.__test.watchSweep({}, [{ task_id: 'lr2', name: 'queuedtask', status: 'pending', error: null, stages: [] }], t, 1_000_000)
    const qr2 = mod.__test.watchSweep(qr.nextMap, [{ task_id: 'lr2', name: 'queuedtask', status: 'pending', error: null, stages: [] }], t, 1_000_000 + 30 * 60_000)
    assert(!qr2.lines.length, 'pending (queued, unclaimed) task must not fire longrun hint')
    r = mod.__test.watchSweep(r.nextMap, [row('running')], t, 1_000_000 + 6 * 60_000)
    assert(r.lines.length === 1 && r.lines[0] === 'watchLongrun|longtask|6', 'longrun hint fires with minutes')
    r = mod.__test.watchSweep(r.nextMap, [row('running')], t, 1_000_000 + 7 * 60_000)
    assert(!r.lines.length, 'longrun hint must fire only once')
    r = mod.__test.watchSweep(r.nextMap, [done], t, 1_000_000 + 8 * 60_000)
    assert(r.lines.length === 2
      && r.lines[0] === 'watchStage|longtask|lr1|1|completed'
      && r.lines[1] === 'watchFinal|longtask|lr1|completed',
      'final still posts after longrun (stage + final in one sweep)')
  }

  // T-014 fleet watch: node transitions + relay reachability.
  {
    const assert = (cond, msg) => { if (!cond) throw new Error('T-014 fleet: ' + msg) }
    const t = (...a) => a.join('|')
    const mk = n1st => ({
      nodes: [
        { node_id: 'n1', node_name: 'Alpha', role: 'node', status: n1st },
        { node_id: 'n2', node_name: 'Beta', role: 'node', status: 'online' }
      ],
      health: { body: { ok: true } }, errors: []
    })
    let r = mod.__test.fleetSweep({}, mk('online'), t)
    assert(!r.lines.length && r.nextMap.n1?.status === 'online' && !r.nextMap.n3, 'first sight silent')
    r = mod.__test.fleetSweep(r.nextMap, mk('offline'), t)
    assert(r.lines.length === 1 && r.lines[0] === 'fleetOffline|Alpha|offline', 'offline transition warns')
    r = mod.__test.fleetSweep(r.nextMap, mk('online'), t)
    assert(r.lines.length === 1 && r.lines[0] === 'fleetBack|Alpha', 'recovery posts')
    const fdn = mk('online'); fdn.health = { error: 'health: conn refused', via: 'node-cli' }
    let d = mod.__test.fleetSweep(r.nextMap, fdn, t)
    assert(d.lines.length === 1 && d.lines[0] === 'fleetRelayDown', 'relay down warns')
    d = mod.__test.fleetSweep(d.nextMap, fdn, t)
    assert(!d.lines.length, 'relay down must not repeat')
    d = mod.__test.fleetSweep(d.nextMap, mk('online'), t)
    assert(d.lines.length === 1 && d.lines[0] === 'fleetRelayBack', 'relay recovery posts')
  }

  // T-016 defaults: with factory settings (all gates OFF) NO render pass —
  // including every watch-enabled sweep the chip performs — may touch the
  // composer. submit(null)/insert(null) without consent is the reviewer's
  // core complaint; prove absence.
  {
    const assert = (cond, msg) => { if (!cond) throw new Error('T-016 defaults: ' + msg) }
    const composer = globalThis.__COMPOSER__ = globalThis.__COMPOSER__ || { submitted: [], inserted: [] }
    assert(!composer.submitted.length, 'factory settings: no composer submit may happen')
    assert(!composer.inserted.length, 'factory settings: no composer insert may happen')
  }

  // Error path (backend unreachable)
  globalThis.__FLEET_DATA__ = undefined
  globalThis.__TASKS_DATA__ = undefined
  globalThis.__ACTIVITY_DATA__ = undefined
  globalThis.__FLEET_IS_ERROR__ = true
  for (const c of contributionsWithRender) renderContribution(c)

  console.log(`OK: ${contributionsWithRender.length} contributions rendered clean in 5 data states (empty/populated/health-error/activity/error)`)
  rmSync(temp, { recursive: true, force: true })
  process.exit(0)
} catch (err) {
  console.error('FAIL:', err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : err)
  rmSync(temp, { recursive: true, force: true })
  process.exit(1)
}