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
export const host = { navigate: () => {}, notify: () => {} }
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
  `export const jsx = ${jsxShim.jsx.toString()}\nexport const jsxs = ${jsxShim.jsxs.toString()}\n`)
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

try {
  // Empty fleet (loading state)
  globalThis.__FLEET_DATA__ = undefined
  for (const c of contributionsWithRender) renderContribution(c)

  // Populated fleet (happy path, like the live backend returns)
  globalThis.__FLEET_DATA__ = {
    generated_at: new Date().toISOString(),
    backend: 'node-cli',
    nodes: [
      { node_id: 'n1', node_name: 'webstack', role: 'node', status: 'online', load: 0.42, load_source: 'cgroup2', queue_depth: 0, busy: false, last_seen: new Date().toISOString(), available: true, capabilities: [{ name: 'chat.ai' }, { name: 'web.ai' }] },
      { node_id: 'n2', node_name: 'NovaForge', role: 'node', status: 'online', load: 2.9, load_source: 'loadavg', queue_depth: 1, busy: true, last_seen: new Date().toISOString(), available: true, capabilities: [{ name: 'tts.ai' }] },
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
      { task_id: 'task_x1', name: 'T-006-plugin-smoke', status: 'completed', priority: 0, stages: [{ stage_id: 's1', capability: 'hermes-test.ai', status: 'completed', result_preview: 'ok', retry_count: 0, claimed_by: 'E4W3CBWQ' }], error: null, artifacts: [{ name: 'out.txt' }] },
      { task_id: 'task_x2', name: 'draft-chapter', status: 'pending', priority: 1, stages: [{ stage_id: 's2', capability: 'draft.ai', status: 'pending', result_preview: '', retry_count: 1 }], error: 'retry exhausted on stage', artifacts: [] }
    ],
    errors: ['node r2 unreachable (timeout)']
  }
  globalThis.__ACTIVITY_DATA__ = {
    generated_at: new Date().toISOString(),
    daemon: { running: true, pid: 4242, heartbeat_status: 'ok', tasks_completed: 14, tasks_failed: 1 },
    local_node: { node_id: 'n0', node_name: 'E4W3CBWQ', node_role: 'node' },
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
          { node_id: 'n1', node_name: 'webstack', available: true, queues: [{ queue: 'q1', depth: 3 }] },
          { node_id: 'n2', node_name: 'NovaForge', available: false, queues: [] }
        ]
      },
      {
        name: 'hermes-test.ai', type: 'task', provider_count: 1, queues_total: 0, selectable: true,
        description: 'Hermes connectivity test.',
        fields: { task: { name: 'task', type: 'string', required: true, description: 'What to test.' } },
        providers: [{ node_id: 'n0', node_name: 'E4W3CBWQ', available: false, queues: [] }]
      },
      {
        name: 'backup.info', type: 'native', provider_count: 1, queues_total: 0, selectable: false,
        description: 'Relay storage op — not submittable here.',
        fields: {},
        providers: [{ node_id: 'n1', node_name: 'webstack', available: true, queues: [] }]
      }
    ]
  }
  for (const c of contributionsWithRender) renderContribution(c)

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