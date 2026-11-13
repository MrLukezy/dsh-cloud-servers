/**
 * 浏览器半边结构冒烟测试：不启动 dsh、不装 React。
 *
 * 用假的 React 跑一遍工厂函数，验证：ModuleLoader 注册 id 正确、
 * apply 注册了侧栏入口 + 主面板、面板能完整渲染而不抛错、样式只注入一次。
 *
 *   node test/client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'client.js'), 'utf8')

let captured
const styleCalls = []
const sandbox = {
  console,
  setTimeout: (fn) => {
    fn()
    return 0
  },
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  navigator: { language: 'zh-CN' },
  fetch: async () => ({ ok: false, status: 500, text: async () => '' }),
  document: {
    createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
    head: { append: (node) => styleCalls.push(node) },
    querySelector: () => null,
  },
  window: {
    localStorage: { getItem: () => null, setItem: () => {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (fn) => {
      fn()
      return 0
    },
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: () => true,
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.ok(captured, 'client.js 应调用 window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-cloud-servers')

const hooks = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(4) }),
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
  useRef(value) {
    return { current: value }
  },
  useEffect(fn) {
    hooks.push(fn)
  },
}

const module = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error(`意外的 require：${name}`)
})

assert.equal(module.inject[0], 'slots')
assert.equal(typeof module.apply, 'function')

const registrations = []
const sources = []
const inputTriggers = {
  registerSource(source) {
    sources.push(source)
    return () => {}
  },
}
const ctx = {
  slots: {
    inject(_key, callback) {
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  inject(_deps, callback) {
    callback({
      get(name) {
        return name === 'inputTriggers' ? inputTriggers : undefined
      },
      effect(fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
    })
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

module.apply(ctx)

assert.equal(registrations.length, 3, '应注册侧栏入口 + 主面板 + 消息 chip 三个插槽')
const sidebar = registrations.find((item) => item.options.name === 'sidebar.panellist')
const main = registrations.find((item) => item.options.name === 'main')
const chipSlot = registrations.find((item) => item.options.name === 'conversation.user.text.node')
assert.ok(sidebar && main && chipSlot)
assert.equal(chipSlot.options.key, 'cloud-server')
assert.equal(sidebar.options.id, 'cloud-servers')
assert.equal(sidebar.options.label, '云服务器')
assert.equal(main.options.key, 'cloud-servers')

const glyph = sidebar.component({ size: 18, active: false })
assert.equal(glyph.type, 'svg')

const tree = main.component()
assert.equal(tree.type, 'div')
assert.equal(tree.props.className, 'cs-root')

function walk(node) {
  if (node === null || node === undefined) return 0
  if (Array.isArray(node)) return node.reduce((total, item) => total + walk(item), 0)
  if (typeof node !== 'object') return 0
  if (node.type === undefined && (node.children ?? []).length === 0) {
    throw new Error('渲染树里出现了没有 type 的对象')
  }
  let count = 1
  for (const child of node.children ?? []) count += walk(child)
  return count
}

const nodes = walk(tree)
assert.ok(nodes > 10, `面板应渲染出完整结构，实际节点 ${nodes}`)
assert.equal(styleCalls.length, 1, '样式只应注入一次')

const css = styleCalls[0].textContent
assert.ok(css.includes('.cs-root'))
assert.ok(!css.includes('undefined'), 'CSS 里不该出现 undefined')

/* --------------------------------------------------- 详情页（连接信息 + 更多数据） */

function texts(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const item of node) texts(item, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (typeof node !== 'object') return out
  for (const child of node.children ?? []) texts(child, out)
  return out
}

const { Detail } = module.__components
assert.ok(Detail, '应导出 Detail 便于测试')

const server = {
  id: 'srv-x',
  name: '测试机',
  group: '测试分组',
  host: '1.2.3.4',
  port: 22,
  user: 'root',
  authType: 'key',
  keyPath: 'C:/Users/you/.ssh/id_ed25519',
  hasPassword: false,
  credentialSource: 'key',
  tags: ['demo'],
  note: '备注',
}
const status = {
  ok: true,
  hostname: 'demo-host',
  os: 'Ubuntu 24.04.4 LTS',
  kernel: '6.8.0',
  arch: 'x86_64',
  timezone: 'Asia/Shanghai',
  cpuModel: 'Intel Xeon Platinum',
  cpuUsedPct: 12,
  cpus: 2,
  uptimeSec: 90061,
  bootAt: '2026-01-01 00:00',
  load: [0.1, 0.2, 0.3],
  memTotalKb: 1000,
  memAvailKb: 400,
  memUsedKb: 600,
  memPct: 60,
  swapTotalKb: 0,
  swapFreeKb: 0,
  diskTotalKb: 100,
  diskUsedKb: 50,
  diskPct: 50,
  mounts: [{ mount: '/', totalKb: 100, usedKb: 50, pct: 50 }],
  services: { nginx: 'active', docker: 'inactive' },
  containers: 0,
  dshWeb: 1,
  ports: [22, 80],
  procs: 100,
  users: 1,
  ip: '10.0.0.1',
  top: [{ pct: 3, name: 'node' }],
  lastLogin: 'root pts/0',
  serverTime: '2026-11-13T08:00:00Z',
  latencyMs: 500,
  at: Date.now(),
}
const ssh = {
  authType: 'key',
  command: 'ssh -i "C:/Users/you/.ssh/id_ed25519" root@1.2.3.4',
  keyPath: 'C:/Users/you/.ssh/id_ed25519',
  keyExists: true,
  publicKey: 'ssh-ed25519 AAAAC3Nza root@host',
  fingerprint: '256 SHA256:abc123 opencode (ED25519)',
}

/** 把函数组件展开成普通节点树（假 React 不会自动渲染子组件）。 */
function expand(node) {
  if (Array.isArray(node)) return node.flatMap((item) => expand(item))
  if (!node || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props ?? {}))
  return { ...node, children: (node.children ?? []).flatMap((item) => expand(item)) }
}

const detailTree = expand(
  Detail({
    server,
    status,
    ssh,
    busy: false,
    terminal: { command: '', running: false, output: '', code: null, error: '' },
    onTerminal() {},
    onRefresh() {},
    onTest() {},
    onRun() {},
    onEdit() {},
    onDelete() {},
  }),
)

const detailNodes = walk(detailTree)
assert.ok(detailNodes > 60, `详情页应有完整结构，实际节点 ${detailNodes}`)

const detailText = texts(detailTree).join('|')
for (const label of ['连接信息', 'SSH 命令', '私钥', '指纹', '更多数据', 'CPU 使用率', '磁盘挂载点', '监听端口']) {
  assert.ok(detailText.includes(label), `详情页应包含「${label}」`)
}
assert.ok(detailText.includes('复制'), '连接信息每行都应有复制按钮')
assert.ok(detailText.includes('ssh -i'), '应拼出可直接粘贴的 ssh 命令')
assert.ok(!detailText.includes('BEGIN OPENSSH PRIVATE KEY'), '绝不能把私钥内容渲染出来')

/* --------------------------------------------------------- @ 服务器提及 */

const atSource = sources[0]
assert.ok(atSource, '应通过 inputTriggers 注册 @ 触发源')
assert.equal(atSource.trigger, '@')
assert.equal(atSource.name, 'servers')
assert.equal(typeof atSource.candidates, 'function')
assert.equal(typeof atSource.onPick, 'function')
assert.equal(typeof atSource.codec?.serialize, 'function')

// 拉不到清单时安静返回空，不炸输入框
const emptyRows = await atSource.candidates({}, { query: '' })
assert.equal(emptyRows.length, 0)

// 正常清单
sandbox.fetch = async () => ({
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({
      ok: true,
      servers: [
        { id: 'srv-x', name: '测试机', group: '测试分组', host: '1.2.3.4', port: 22, user: 'root', tags: ['demo'] },
        { id: 'srv-y', name: '另一台', group: '别的组', host: '5.6.7.8', port: 22, user: 'ubuntu', tags: [] },
      ],
    }),
})
const rows = await atSource.candidates({}, { query: '' })
assert.equal(rows.length, 2)
assert.equal(rows[0].name, '测试机')
assert.equal(rows[0].section, '测试分组')
assert.ok(rows[0].description.includes('root@1.2.3.4'))

const filtered = await atSource.candidates({}, { query: '5.6.7.8' })
assert.equal(filtered.length, 1)
assert.equal(filtered[0].name, '另一台')

// 选中 → chip + 提交时序列化成模型看得懂的标签
const picked = atSource.onPick({ candidate: rows[0] })
assert.equal(picked.insert.source, 'servers')
assert.equal(picked.insert.ref, '@srv-x')
assert.equal(picked.insert.appearance, 'cloud-server')
assert.equal(picked.insert.label, '测试机')

const serialized = await atSource.codec.serialize('@srv-x')
assert.match(serialized, /^<cloud-server /u)
assert.match(serialized, /id="srv-x"/u)
assert.match(serialized, /host="1\.2\.3\.4"/u)
assert.match(serialized, /name="测试机"/u)

// 老消息里只剩 id 也要能序列化
assert.equal(await atSource.codec.serialize('@srv-gone'), '<cloud-server id="srv-gone"/>')

// 别的候选类型不能被误吞
assert.equal(atSource.onPick({ candidate: { value: JSON.stringify({ kind: 'file' }) } }), undefined)

// chip 渲染
const chip = expand(chipSlot.component({ node: { data: { label: '测试机', host: '1.2.3.4' } }, raw: '@srv-x' }))
const chipText = texts(chip).join('')
assert.ok(chipText.includes('测试机'), 'chip 应显示服务器名')

console.log('✓ ModuleLoader 注册 id:', captured.id)
console.log('✓ 插槽注册:', registrations.map((item) => item.options.name).join(', '))
console.log('✓ @ 触发源:', atSource.trigger, atSource.name, '· 候选', rows.length, '台 · 序列化', serialized)
console.log('✓ 侧栏图标 / 主面板渲染节点数:', nodes)
console.log('✓ 样式注入一次，长度', css.length)
console.log('\n全部通过')