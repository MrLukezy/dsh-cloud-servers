/**
 * 宿主半边测试：不启动 dsh，用假 ctx 捕获 /cloud-servers/api 的 handler，
 * 直接发 HTTP 请求验证 清单 / 增删改 / 状态采集 / 命令执行。
 *
 *   node test/host.mjs                 # 只跑本地逻辑（不连服务器）
 *   $env:CS_NETWORK=1; node test/host.mjs   # 额外跑真机连通（腾讯云主站 + 公司云）
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'cs-host-'))
process.env.DSH_HOME = tmpHome

const { apply, __internals } = await import('../index.js')

/* ------------------------------------------------------------- 假宿主 */

let handler = null
const registered = []

const webServer = {
  register(options) {
    registered.push(options)
    handler = options.handler
    return () => {
      handler = null
    }
  },
}

const ctx = {
  logger: { info() {}, warn() {} },
  inject(deps, callback) {
    if (deps.includes('webServer')) callback({ webServer, effect: (fn) => fn() })
    if (deps.includes('tools')) callback({ tools: { register(spec) { registered.push(spec) } } })
  },
  effect(fn) {
    fn()
  },
}

apply(ctx, { statusTtlMs: 0 })

assert.ok(handler, '应注册 /cloud-servers/api 路由')
assert.equal(registered[0].path, '/cloud-servers/api')

/* ------------------------------------------------------------- 假请求 */

function makeReq(method, url, body) {
  const headers = { host: '127.0.0.1:54560' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload)
    },
  }
}

function makeRes() {
  const res = {
    status: 0,
    body: '',
    done: null,
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      this.body = chunk
      this.done?.(this)
    },
  }
  res.finished = new Promise((resolve) => {
    res.done = resolve
  })
  return res
}

async function call(method, url, body) {
  const res = makeRes()
  handler(makeReq(method, url, body), res)
  await res.finished
  return { status: res.status, payload: JSON.parse(res.body) }
}

/* --------------------------------------------------------------- 断言 */

// 1. 首次读取：自动从 seed 播种
let state = await call('GET', '/cloud-servers/api/state')
assert.equal(state.status, 200)
assert.equal(state.payload.ok, true)
assert.ok(state.payload.servers.length >= 2, `种子清单至少应有 2 台，实际 ${state.payload.servers.length}`)
const seedCount = state.payload.servers.length
assert.ok(state.payload.servers.every((item) => typeof item.id === 'string' && item.hasPassword === false))
const passwordServer = state.payload.servers.find((item) => item.authType === 'password')
assert.ok(passwordServer, '种子清单里应有密码机')
assert.ok(!('password' in passwordServer), '接口不能回传密码字段')

// 2. 新增
const created = await call('POST', '/cloud-servers/api/servers', {
  name: '测试机',
  group: '测试分组',
  host: '192.0.2.10',
  port: '2222',
  user: 'tester',
  authType: 'password',
  password: 'secret',
  tags: 'a, b',
  note: '临时',
})
assert.equal(created.payload.ok, true, created.payload.error)
assert.match(created.payload.server.id, /^srv-/u)
assert.equal(created.payload.server.port, 2222)
assert.equal(created.payload.server.hasPassword, true)
assert.deepEqual(created.payload.server.tags, ['a', 'b'])
const newId = created.payload.server.id

// 3. 修改（不传 password 时保留原密码）
const patched = await call('PATCH', `/cloud-servers/api/servers/${newId}`, { name: '测试机 2' })
assert.equal(patched.payload.ok, true, patched.payload.error)
assert.equal(patched.payload.server.name, '测试机 2')
assert.equal(patched.payload.server.hasPassword, true, '未传 password 时应保留原密码')

// 4. 清除密码
const cleared = await call('PATCH', `/cloud-servers/api/servers/${newId}`, { clearPassword: true })
assert.equal(cleared.payload.server.hasPassword, false)

// 5. 校验失败要报错而不是崩
const bad = await call('POST', '/cloud-servers/api/servers', { host: '', user: '' })
assert.equal(bad.payload.ok, false)
assert.match(bad.payload.error, /主机地址不能为空/u)

// 6. 删除
const removed = await call('DELETE', `/cloud-servers/api/servers/${newId}`)
assert.equal(removed.payload.ok, true)
state = await call('GET', '/cloud-servers/api/state')
assert.equal(state.payload.servers.length, seedCount)

// 7. 状态解析（离线 fixture，CentOS 7 风格输出）
const fixture = [
  'CS_HOST=10-1-3-51',
  'CS_OS="CentOS Linux 7 (Core)"',
  'CS_KERNEL=3.10.0-1160.105.1.el7.x86_64',
  'CS_CPUS=8',
  'CS_UPTIME=31536000',
  'CS_LOAD=0.12 0.20 0.31',
  'CS_MEM=16246784 12000000',
  'CS_DISK=52403200 10240000 42163200 20%',
  'CS_NGINX=active',
  'CS_DOCKER=inactive',
  'CS_DSH=1',
  'CS_TIME=2026-11-13T08:00:00Z',
].join('\n')
const parsed = __internals.parseStatus(fixture)
assert.equal(parsed.hostname, '10-1-3-51')
assert.equal(parsed.cpus, 8)
assert.equal(parsed.memPct, 26)
assert.equal(parsed.diskPct, 20)
assert.deepEqual(parsed.load, [0.12, 0.2, 0.31])
assert.equal(parsed.services.nginx, 'active')
assert.equal(parsed.dshWeb, 1)

// 8. 跨站请求要被拒
const res = makeRes()
handler({ ...makeReq('GET', '/cloud-servers/api/state'), headers: { host: '127.0.0.1:54560', origin: 'http://evil.example' } }, res)
await res.finished
assert.equal(res.status, 403)

console.log(`✓ 种子清单 ${seedCount} 台，接口不回传密码`)
console.log('✓ 增 / 改 / 清密码 / 删 全部通过')
console.log('✓ 状态输出解析（CentOS 7 fixture）通过')
console.log('✓ 跨站请求被 403 拒绝')

/* ------------------------------------------------------------- 真机连通 */

if (process.env.CS_NETWORK === '1') {
  const list = (await call('GET', '/cloud-servers/api/state')).payload.servers
  // 示例清单里的地址是 RFC 5737 / RFC 1918 文档地址，连不通是正常的
  const demoHost = (host) => /^(203\.0\.113\.|198\.51\.100\.|192\.0\.2\.|10\.0\.0\.)/u.test(String(host))
  const real = list.filter((item) => !demoHost(item.host))
  if (real.length === 0) {
    console.log('· 当前是示例清单（文档地址），跳过真机连通')
  } else {
    const main = real[0]
    const status = await call('POST', `/cloud-servers/api/servers/${main.id}/status?fresh=1`)
    assert.equal(status.payload.status.ok, true, `${main.name} 状态失败：${status.payload.status.error}`)
    assert.ok(status.payload.status.memTotalKb > 0)
    assert.ok(status.payload.status.cpus >= 1)
    console.log(`✓ ${main.name}：${status.payload.status.hostname} · ${status.payload.status.os} · mem ${status.payload.status.memPct}% · disk ${status.payload.status.diskPct}%`)

  // 新增字段：架构 / 时区 / CPU / 进程 / 端口 / 挂载点
  const rich = status.payload.status
  assert.ok(rich.arch, '应有架构')
  assert.ok(rich.timezone, '应有时区')
  assert.ok(rich.cpuModel, '应有 CPU 型号')
  assert.ok(typeof rich.cpuUsedPct === 'number', '应有 CPU 使用率')
  assert.ok(typeof rich.procs === 'number' && rich.procs > 0, '应有进程数')
  assert.ok(Array.isArray(rich.ports) && rich.ports.includes(22), '监听端口应含 22')
  assert.ok(Array.isArray(rich.mounts) && rich.mounts.length > 0, '应有磁盘挂载点')
  assert.ok(Array.isArray(rich.top) && rich.top.length > 0, '应有 CPU 占用前三')
  console.log(
    `✓ 更多数据：${rich.arch} · ${rich.timezone} · ${rich.cpuModel.slice(0, 28)} · cpu ${rich.cpuUsedPct}% · ${rich.procs} 进程 · 端口 ${rich.ports.slice(0, 6).join(',')} · ${rich.mounts.length} 个挂载点`,
  )

  const ssh = await call('GET', `/cloud-servers/api/servers/${main.id}/ssh`)
  assert.equal(ssh.payload.ok, true, ssh.payload.error)
  assert.match(ssh.payload.ssh.command, /^ssh -i /u)
  assert.ok(ssh.payload.ssh.fingerprint, '应有密钥指纹')
  assert.ok(!('privateKey' in ssh.payload.ssh), '接口不应返回私钥内容')
  console.log(`✓ 连接信息：${ssh.payload.ssh.command} · ${ssh.payload.ssh.fingerprint.slice(0, 40)}…`)

  const exec = await call('POST', `/cloud-servers/api/servers/${main.id}/exec`, { command: 'echo cs-ok && uname -s' })
  assert.equal(exec.payload.ok, true, `执行失败：${exec.payload.error}`)
  assert.match(exec.payload.stdout, /cs-ok/u)
  console.log(`✓ 命令执行：${exec.payload.stdout.trim().replace(/\n/gu, ' | ')}`)

  const company = real.find((item) => item.authType === 'password')
  if (company) {
    const companyStatus = await call('POST', `/cloud-servers/api/servers/${company.id}/status?fresh=1`)
    assert.equal(companyStatus.payload.status.ok, true, `${company.name} 状态失败：${companyStatus.payload.status.error}`)
    console.log(`✓ 密码机（${company.credentialSource}）：${companyStatus.payload.status.hostname} · ${companyStatus.payload.status.os}`)
  }

  if (process.env.CS_ALL === '1') {
    const all = await call('POST', '/cloud-servers/api/status-all?fresh=1')
    const rows = real.map((item) => ({ item, status: all.payload.statuses[item.id] }))
    for (const row of rows) {
      const status = row.status
      const label = status?.ok
        ? `${String(status.os || '').replace(/^"|"$/gu, '')} · up ${Math.floor((status.uptimeSec || 0) / 86400)}d · mem ${status.memPct}% · disk ${status.diskPct}% · ${status.latencyMs}ms`
        : `失败：${status?.error || '未知'}`
      console.log(`  ${status?.ok ? '●' : '○'} ${row.item.name.padEnd(22, ' ')} ${row.item.host.padEnd(16, ' ')} ${label}`)
    }
    const online = rows.filter((row) => row.status?.ok).length
    const expected = rows.filter((row) => row.item.credentialSource !== 'none').length
    assert.equal(online, expected, `有凭据的 ${expected} 台应全部在线，实际 ${online}`)
    console.log(`✓ 全量巡检：${online}/${rows.length} 台在线（未配凭据的 ${rows.length - expected} 台跳过）`)
  }
  }
} else {
  console.log('· 跳过真机连通（设置 CS_NETWORK=1 开启）')
}

await rm(tmpHome, { recursive: true, force: true })
console.log('\n全部通过')