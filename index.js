/**
 * dsh-cloud-servers —— 宿主（Node）半边。
 *
 * 职责：
 *  1. 在本机 dsh 的 Web 服务上挂 `/cloud-servers/api/*`，浏览器只跟本机说话；
 *     密码等凭据不出宿主进程。
 *  2. 管理服务器清单（地址 / 账号 / 密钥或密码），落盘到
 *     `$DSH_HOME/storages/dsh-cloud-servers/servers.json`（首次自动用 seed-servers.json 播种）。
 *  3. 通过 SSH 采集状态、执行命令：
 *     - 密钥类主机直接调系统 `ssh`（BatchMode，无交互）；
 *     - 密码类主机走 `scripts/ssh_password.py`（paramiko），密码经 stdin 传入。
 *  4. 注册 `cloud_servers` 工具，让模型在对话里也能查服务器 / 跑命令。
 *
 * 设计约束：
 *  - 不 import 任何 @deepseek-ai/* 运行时包，靠 ctx 注入取服务，方便以普通 ESM 装进 profile。
 *  - 所有注册都包在 ctx.effect / ctx.inject 里，插件卸载即回收。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'cloud-servers'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROUTE_PREFIX = '/cloud-servers/api'
const STORE_VERSION = 1
const MAX_STDOUT = 256 * 1024
const MAX_STDERR = 16 * 1024
const TOOL_NAME_CANDIDATES = ['cloud_servers', 'dsh_cloud_servers']
const SKILL_CREDENTIAL_FILE = path.join(
  os.homedir(),
  '.agents',
  'skills',
  'ssh-log-analyzer',
  'scripts',
  'ssh_log.py',
)

const DEFAULTS = {
  enabled: true,
  allowExec: true,
  connectTimeoutMs: 8000,
  statusTimeoutMs: 25000,
  execTimeoutMs: 30000,
  statusTtlMs: 60000,
  pythonPath: 'python',
}

/* ------------------------------------------------------------------ 存储 */

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function storePath() {
  return path.join(dshHome(), 'storages', 'dsh-cloud-servers', 'servers.json')
}

function emptyState() {
  return { version: STORE_VERSION, servers: [] }
}

async function writeState(state) {
  const file = storePath()
  await mkdir(path.dirname(file), { recursive: true })
  const body = JSON.stringify({ version: STORE_VERSION, servers: state.servers }, null, 2)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
}

async function readSeed() {
  // 自己的清单（seed-servers.json，不入库）；没有就用仓库里的示例清单
  for (const name of ['seed-servers.json', 'seed-servers.example.json']) {
    try {
      const raw = await readFile(path.join(PLUGIN_DIR, name), 'utf8')
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : parsed?.servers
      if (Array.isArray(list) && list.length > 0) return list
    } catch {
      /* 换下一个 */
    }
  }
  return []
}

async function readState() {
  try {
    const raw = await readFile(storePath(), 'utf8')
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : parsed?.servers
    if (!Array.isArray(list)) return emptyState()
    return { version: STORE_VERSION, servers: list.filter((item) => item && typeof item.id === 'string') }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const seeded = { version: STORE_VERSION, servers: await readSeed() }
      await writeState(seeded)
      return seeded
    }
    throw error
  }
}

/* --------------------------------------------------------------- 数据整形 */

function normalizeServer(input, base = {}) {
  const pick = (key, fallback) => (input[key] !== undefined ? input[key] : base[key] !== undefined ? base[key] : fallback)
  const host = String(pick('host', '')).trim()
  if (!host) throw new Error('主机地址不能为空')
  if (!/^[A-Za-z0-9_.:-]+$/u.test(host)) throw new Error('主机地址只能包含字母、数字、点、横线、下划线和冒号')
  const user = String(pick('user', '')).trim()
  if (!user) throw new Error('登录用户不能为空')
  const portRaw = Number(pick('port', 22))
  const port = Number.isFinite(portRaw) && portRaw > 0 && portRaw < 65536 ? Math.trunc(portRaw) : 22
  const authType = pick('authType', 'key') === 'password' ? 'password' : 'key'
  const keyPath = String(pick('keyPath', '')).trim()
  if (authType === 'key' && !keyPath) throw new Error('密钥登录需要填私钥路径')
  const password = typeof pick('password', '') === 'string' ? String(pick('password', '')) : ''
  const tagsRaw = pick('tags', [])
  const tags = (Array.isArray(tagsRaw) ? tagsRaw : String(tagsRaw ?? '').split(/[,，\s]+/u))
    .map((tag) => String(tag ?? '').trim())
    .filter(Boolean)
    .slice(0, 8)
  return {
    id: String(pick('id', '')).trim(),
    name: String(pick('name', '')).trim() || `${user}@${host}`,
    group: String(pick('group', '')).trim() || '未分组',
    host,
    port,
    user,
    authType,
    keyPath,
    password,
    passwordFrom: String(pick('passwordFrom', '')).trim(),
    tags,
    note: String(pick('note', '')).trim().slice(0, 500),
  }
}

function credentialSource(server) {
  if (server.authType === 'key') return server.keyPath ? 'key' : 'none'
  if (server.password) return 'panel'
  if (server.passwordFrom === 'ssh-log-analyzer' && readSkillCredential()) return 'ssh-log-analyzer'
  return 'none'
}

function sanitize(server) {
  return {
    id: server.id,
    name: server.name,
    group: server.group || '未分组',
    host: server.host,
    port: server.port || 22,
    user: server.user,
    authType: server.authType === 'password' ? 'password' : 'key',
    keyPath: server.keyPath || '',
    hasPassword: Boolean(server.password),
    passwordFrom: server.passwordFrom || '',
    credentialSource: credentialSource(server),
    tags: Array.isArray(server.tags) ? server.tags : [],
    note: server.note || '',
    createdAt: server.createdAt ?? 0,
    updatedAt: server.updatedAt ?? 0,
  }
}

/* ------------------------------------------------------------- 凭据来源 */

/* 内网游戏服 / 公司云的密码本来只存在于 ssh-log-analyzer 这个 skill 里。
   这里按需读取，不复制、不落盘；skill 改了密码这里自动跟着变。 */
let skillCredCache = { at: 0, value: null }

function readSkillCredential() {
  if (Date.now() - skillCredCache.at < 60000) return skillCredCache.value
  let value = null
  try {
    const text = readFileSync(SKILL_CREDENTIAL_FILE, 'utf8')
    const user = /^SSH_USER\s*=\s*['"]([^'"]*)['"]/mu.exec(text)?.[1] ?? ''
    const password = /^SSH_PASS\s*=\s*['"]([^'"]*)['"]/mu.exec(text)?.[1] ?? ''
    if (password) value = { user, password }
  } catch {
    /* 没装该 skill 就走别的来源 */
  }
  skillCredCache = { at: Date.now(), value }
  return value
}

function resolveAuth(server) {
  if (server.authType === 'key') {
    return server.keyPath ? { type: 'key', keyPath: server.keyPath } : { type: 'none' }
  }
  if (server.password) return { type: 'password', password: server.password, source: 'panel' }
  if (server.passwordFrom === 'ssh-log-analyzer') {
    const cred = readSkillCredential()
    if (cred?.password) return { type: 'password', password: cred.password, source: 'ssh-log-analyzer' }
  }
  return { type: 'none' }
}

/* ------------------------------------------------------------- 连接信息 */

/** 面板「连接信息」用：拼好可直接粘贴的 ssh 命令，顺带读公钥与指纹（私钥内容永不外传）。 */
async function describeSsh(server) {
  const port = server.port || 22
  const target = `${server.user}@${server.host}`
  const base = { host: server.host, port, user: server.user, target, authType: server.authType }
  if (server.authType === 'key' && server.keyPath) {
    const keyPath = server.keyPath
    const pubPath = `${keyPath}.pub`
    const keyExists = existsSync(keyPath)
    let publicKey = ''
    try {
      publicKey = readFileSync(pubPath, 'utf8').trim()
    } catch {
      /* 没有 .pub 就只给路径 */
    }
    let fingerprint = ''
    const probe = await runProcess('ssh-keygen', ['-lf', publicKey ? pubPath : keyPath], { timeoutMs: 5000 })
    if (probe.code === 0) fingerprint = probe.stdout.trim()
    const command =
      port === 22 ? `ssh -i "${keyPath}" ${target}` : `ssh -i "${keyPath}" -p ${port} ${target}`
    return {
      ...base,
      authType: 'key',
      keyPath,
      keyExists,
      publicKeyPath: publicKey ? pubPath : '',
      publicKey,
      fingerprint,
      command,
    }
  }
  const command = port === 22 ? `ssh ${target}` : `ssh -p ${port} ${target}`
  return { ...base, authType: 'password', credentialSource: credentialSource(server), command }
}

/* ------------------------------------------------------------- 进程执行 */

function runProcess(command, args, { timeoutMs, stdin, maxStdout = MAX_STDOUT } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: '', ms: 0, timedOut: false, error: String(error?.message ?? error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let done = false
    let timedOut = false
    const finish = (code, error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, ms: Date.now() - started, timedOut, error })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
    }, Math.max(1000, timeoutMs))
    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= maxStdout) return
      stdoutBytes += chunk.length
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length >= MAX_STDERR) return
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => finish(-1, String(error?.message ?? error)))
    child.on('close', (code) => finish(code ?? -1, undefined))
    if (stdin !== undefined) child.stdin.end(stdin)
    else child.stdin.end()
  })
}

/** 在远端跑一条命令；返回 { code, stdout, stderr, ms, auth, error }。 */
async function runRemote(server, command, { timeoutMs, config }) {
  const auth = resolveAuth(server)
  const started = Date.now()
  if (auth.type === 'none') {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      ms: 0,
      auth: 'none',
      error:
        server.authType === 'key'
          ? '该主机没有配置私钥路径'
          : '该主机还没有可用密码：在面板里补密码，或确认 ssh-log-analyzer 的凭据可用',
    }
  }
  if (auth.type === 'key') {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${Math.max(2, Math.ceil(config.connectTimeoutMs / 1000))}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'LogLevel=ERROR',
      '-p', String(server.port || 22),
      '-i', auth.keyPath,
      '-o', 'IdentitiesOnly=yes',
      `${server.user}@${server.host}`,
      command,
    ]
    const result = await runProcess('ssh', args, { timeoutMs })
    return { ...result, auth: 'key', ms: Date.now() - started }
  }

  // 密码登录：交给 paramiko 助手，密码走 stdin
  const payload = JSON.stringify({
    host: server.host,
    port: server.port || 22,
    user: server.user,
    password: auth.password,
    command,
    timeout: Math.ceil(timeoutMs / 1000),
  })
  const result = await runProcess(config.pythonPath || 'python', [path.join(PLUGIN_DIR, 'scripts', 'ssh_password.py')], {
    timeoutMs: timeoutMs + 5000,
    stdin: payload,
  })
  const base = { ...result, auth: 'password', ms: Date.now() - started }
  if (result.error) return { ...base, error: `启动 python 失败：${result.error}` }
  const text = result.stdout.trim()
  if (!text) {
    return { ...base, code: -1, error: result.stderr.trim() || `python 没有返回结果（退出码 ${result.code}）` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ...base, code: -1, error: `python 返回了非 JSON：${text.slice(0, 200)}` }
  }
  return {
    ...base,
    code: typeof parsed.code === 'number' ? parsed.code : -1,
    stdout: String(parsed.stdout ?? ''),
    stderr: String(parsed.stderr ?? ''),
    error: parsed.ok === true ? undefined : String(parsed.error || '密码登录失败'),
  }
}

/* --------------------------------------------------------------- 状态采集 */

/* 一次 SSH 往返把面板要的指标全取回来：OS / 核数 / 负载 / 内存 / 磁盘 / 服务 / 端口 / 进程。 */
const STATUS_SCRIPT = [
  'export LC_ALL=C',
  'echo "CS_HOST=$(hostname 2>/dev/null)"',
  'echo "CS_OS=$( ( . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME" ) )"',
  'echo "CS_KERNEL=$(uname -r 2>/dev/null)"',
  'echo "CS_ARCH=$(uname -m 2>/dev/null)"',
  'echo "CS_TZ=$( (timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null) )"',
  'echo "CS_CPUS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null)"',
  'echo "CS_CPU_MODEL=$(awk -F: \'/model name/{gsub(/^[ \\t]+/,"",$2); print $2; exit}\' /proc/cpuinfo 2>/dev/null)"',
  'echo "CS_CPU_USED=$(vmstat 1 2 2>/dev/null | tail -1 | awk \'{if(NF>=15) printf "%.0f", 100-$15}\')"',
  'echo "CS_UPTIME=$(cut -d. -f1 /proc/uptime 2>/dev/null)"',
  'echo "CS_BOOT=$(date -d "@$(( $(date +%s) - $(cut -d. -f1 /proc/uptime) ))" "+%Y-%m-%d %H:%M" 2>/dev/null)"',
  'echo "CS_LOAD=$(cut -d" " -f1-3 /proc/loadavg 2>/dev/null)"',
  'echo "CS_MEM=$(awk \'/MemTotal/{t=$2}/MemAvailable/{a=$2}END{print t" "a}\' /proc/meminfo 2>/dev/null)"',
  'echo "CS_SWAP=$(awk \'/SwapTotal/{t=$2}/SwapFree/{f=$2}END{print t" "f}\' /proc/meminfo 2>/dev/null)"',
  'echo "CS_DISK=$(df -Pk / 2>/dev/null | awk \'NR==2{print $2" "$3" "$4" "$5}\')"',
  'echo "CS_DISKS=$(df -Pk 2>/dev/null | awk \'NR>1 && $1 ~ /^\\// {printf "%s|%s|%s|%s;", $6, $2, $3, $5}\')"',
  'echo "CS_NGINX=$(systemctl is-active nginx 2>/dev/null || true)"',
  'echo "CS_DOCKER=$(systemctl is-active docker 2>/dev/null || true)"',
  'echo "CS_CONTAINERS=$(docker ps -q 2>/dev/null | wc -l | tr -d " ")"',
  'echo "CS_DSH=$( (ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | grep -c ":13080 " )"',
  'echo "CS_PORTS=$( (ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | awk \'NR>1{split($4,a,":"); print a[length(a)]}\' | sort -n -u | tr "\\n" ",")"',
  'echo "CS_PROCS=$(ps -e --no-headers 2>/dev/null | wc -l | tr -d " ")"',
  'echo "CS_USERS=$(who 2>/dev/null | wc -l | tr -d " ")"',
  'echo "CS_IP=$(hostname -I 2>/dev/null | awk \'{print $1}\')"',
  'echo "CS_TOP=$(ps -eo pcpu,comm --sort=-pcpu --no-headers 2>/dev/null | awk \'$2 != "ps" {print; n++; if (n==3) exit}\' | tr "\\n" ";")"',
  'echo "CS_LAST=$(last -n 1 -w 2>/dev/null | head -1 | cut -c1-80)"',
  'echo "CS_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
].join('; ')

function toInt(value) {
  const n = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) ? n : null
}

function parseStatus(text) {
  const raw = {}
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    const at = line.indexOf('=')
    if (at <= 3 || !line.startsWith('CS_')) continue
    raw[line.slice(3, at)] = line.slice(at + 1).trim()
  }
  const load = String(raw.LOAD ?? '')
    .split(/\s+/u)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
  const mem = String(raw.MEM ?? '').split(/\s+/u).map((item) => Number(item))
  const diskTokens = String(raw.DISK ?? '').trim().split(/\s+/u)
  const disk = diskTokens.slice(0, 3).map((item) => Number(item))
  const diskPct = toInt(String(diskTokens[3] ?? '').replace('%', ''))
  const memTotalKb = Number.isFinite(mem[0]) ? mem[0] : null
  const memAvailKb = Number.isFinite(mem[1]) ? mem[1] : null
  const diskTotalKb = Number.isFinite(disk[0]) ? disk[0] : null
  const diskUsedKb = Number.isFinite(disk[1]) ? disk[1] : null
  const diskAvailKb = Number.isFinite(disk[2]) ? disk[2] : null
  const swap = String(raw.SWAP ?? '').split(/\s+/u).map((item) => Number(item))
  const mounts = String(raw.DISKS ?? '')
    .split(';')
    .filter(Boolean)
    .slice(0, 8)
    .map((item) => {
      const [mount, total, used, pct] = item.split('|')
      return {
        mount: mount || '',
        totalKb: Number(total) || 0,
        usedKb: Number(used) || 0,
        pct: toInt(String(pct ?? '').replace('%', '')),
      }
    })
  const top = String(raw.TOP ?? '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((item) => {
      const hit = /^([\d.]+)\s+(.+)$/u.exec(item)
      return hit ? { pct: Number(hit[1]), name: hit[2] } : { pct: null, name: item }
    })
  return {
    hostname: raw.HOST || '',
    os: raw.OS || '',
    kernel: raw.KERNEL || '',
    arch: raw.ARCH || '',
    timezone: raw.TZ || '',
    cpuModel: raw.CPU_MODEL || '',
    cpuUsedPct: toInt(raw.CPU_USED),
    cpus: toInt(raw.CPUS),
    uptimeSec: toInt(raw.UPTIME),
    bootAt: raw.BOOT || '',
    load,
    memTotalKb,
    memAvailKb,
    memUsedKb: memTotalKb !== null && memAvailKb !== null ? memTotalKb - memAvailKb : null,
    memPct:
      memTotalKb !== null && memAvailKb !== null && memTotalKb > 0
        ? Math.round(((memTotalKb - memAvailKb) / memTotalKb) * 100)
        : null,
    swapTotalKb: Number.isFinite(swap[0]) ? swap[0] : null,
    swapFreeKb: Number.isFinite(swap[1]) ? swap[1] : null,
    diskTotalKb,
    diskUsedKb,
    diskAvailKb,
    diskPct,
    mounts,
    services: {
      nginx: raw.NGINX || '',
      docker: raw.DOCKER || '',
    },
    containers: toInt(raw.CONTAINERS),
    dshWeb: toInt(raw.DSH),
    ports: String(raw.PORTS ?? '')
      .split(',')
      .map((item) => toInt(item))
      .filter((item) => item !== null)
      .slice(0, 40),
    procs: toInt(raw.PROCS),
    users: toInt(raw.USERS),
    ip: raw.IP || '',
    top,
    lastLogin: raw.LAST || '',
    serverTime: raw.TIME || '',
  }
}

const statusCache = new Map() // id -> { at, value }

async function collectStatus(server, config, { fresh = false } = {}) {
  const cached = statusCache.get(server.id)
  if (!fresh && cached && Date.now() - cached.at < config.statusTtlMs) return cached.value
  const result = await runRemote(server, STATUS_SCRIPT, { timeoutMs: config.statusTimeoutMs, config })
  const base = { at: Date.now(), latencyMs: result.ms, auth: result.auth, source: 'ssh' }
  let value
  if (result.stdout.includes('CS_HOST=')) {
    value = { ok: true, ...base, ...parseStatus(result.stdout) }
  } else {
    value = {
      ok: false,
      ...base,
      error: String(result.error || result.stderr || `SSH 退出码 ${result.code}`).trim().slice(0, 600),
    }
  }
  statusCache.set(server.id, { at: Date.now(), value })
  return value
}

async function mapLimit(items, limit, worker) {
  const queue = items.slice()
  const runners = []
  for (let i = 0; i < Math.min(limit, queue.length); i += 1) {
    runners.push(
      (async () => {
        while (queue.length > 0) {
          const item = queue.shift()
          await worker(item)
        }
      })(),
    )
  }
  await Promise.all(runners)
}

/* ------------------------------------------------------------- HTTP 工具 */

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed && typeof parsed === 'object' ? parsed : {}
}

/** 只允许本机页面发起的请求：防其它本地网页借道操作服务器。 */
function sameOriginOnly(req) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  return true
}

function newId() {
  return `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

function findServer(servers, key) {
  const needle = String(key ?? '').trim().toLowerCase()
  if (!needle) return undefined
  return (
    servers.find((item) => item.id.toLowerCase() === needle) ??
    servers.find((item) => item.name.toLowerCase() === needle) ??
    servers.find((item) => item.host.toLowerCase() === needle) ??
    servers.find((item) => item.name.toLowerCase().includes(needle) || item.host.includes(needle))
  )
}

/* ------------------------------------------------------------------ 路由 */

async function handle(req, res, config, logger) {
  try {
    if (!sameOriginOnly(req)) {
      sendJson(res, 403, { ok: false, error: '拒绝跨站请求' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const segments = url.pathname.slice(ROUTE_PREFIX.length).split('/').filter(Boolean)
    const state = await readState()

    const requireServer = (id) => {
      const found = state.servers.find((item) => item.id === id)
      if (!found) throw new Error('找不到这台服务器')
      return found
    }

    // GET /state
    if (segments.length === 1 && segments[0] === 'state') {
      const statuses = {}
      for (const [id, entry] of statusCache) statuses[id] = entry.value
      sendJson(res, 200, {
        ok: true,
        servers: state.servers.map(sanitize),
        statuses,
        config: {
          allowExec: config.allowExec !== false,
          statusTtlMs: config.statusTtlMs,
          storePath: storePath(),
        },
      })
      return
    }

    // POST /servers —— 新增
    if (segments.length === 1 && segments[0] === 'servers' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const server = normalizeServer(body, {})
      server.id = newId()
      server.createdAt = Date.now()
      server.updatedAt = server.createdAt
      state.servers.push(server)
      await writeState(state)
      sendJson(res, 200, { ok: true, server: sanitize(server) })
      return
    }

    // POST /status-all —— 批量采集
    if (segments.length === 1 && segments[0] === 'status-all' && req.method === 'POST') {
      const fresh = url.searchParams.get('fresh') === '1'
      const statuses = {}
      await mapLimit(state.servers, 4, async (server) => {
        statuses[server.id] = await collectStatus(server, config, { fresh })
      })
      sendJson(res, 200, { ok: true, statuses })
      return
    }

    if (segments.length >= 2 && segments[0] === 'servers') {
      const server = requireServer(segments[1])

      // PATCH /servers/:id —— 修改
      if (segments.length === 2 && (req.method === 'PATCH' || req.method === 'PUT')) {
        const body = await readJsonBody(req)
        const merged = normalizeServer(body, server)
        merged.id = server.id
        merged.createdAt = server.createdAt ?? Date.now()
        merged.updatedAt = Date.now()
        if (body.clearPassword === true) merged.password = ''
        const index = state.servers.findIndex((item) => item.id === server.id)
        state.servers[index] = merged
        await writeState(state)
        statusCache.delete(server.id)
        sendJson(res, 200, { ok: true, server: sanitize(merged) })
        return
      }

      // DELETE /servers/:id
      if (segments.length === 2 && req.method === 'DELETE') {
        state.servers = state.servers.filter((item) => item.id !== server.id)
        await writeState(state)
        statusCache.delete(server.id)
        sendJson(res, 200, { ok: true })
        return
      }

      // POST /servers/:id/test —— 只验证能不能登录
      if (segments.length === 3 && segments[2] === 'test' && req.method === 'POST') {
        const command = 'echo __CS_OK__; hostname; whoami; uname -sr'
        const result = await runRemote(server, command, { timeoutMs: config.connectTimeoutMs + 7000, config })
        const ok = result.stdout.includes('__CS_OK__')
        const lines = result.stdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line && line !== '__CS_OK__')
        sendJson(res, 200, {
          ok,
          latencyMs: result.ms,
          auth: result.auth,
          detail: lines.slice(0, 4).join(' · '),
          error: ok ? '' : String(result.error || result.stderr || `SSH 退出码 ${result.code}`).trim().slice(0, 600),
        })
        return
      }

      // POST /servers/:id/status
      if (segments.length === 3 && segments[2] === 'status' && req.method === 'POST') {
        const fresh = url.searchParams.get('fresh') === '1'
        const value = await collectStatus(server, config, { fresh })
        sendJson(res, 200, { ok: true, status: value })
        return
      }

      // GET /servers/:id/ssh —— 连接信息（命令 / 私钥 / 指纹 / 公钥）
      if (segments.length === 3 && segments[2] === 'ssh' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, ssh: await describeSsh(server) })
        return
      }

      // POST /servers/:id/exec
      if (segments.length === 3 && segments[2] === 'exec' && req.method === 'POST') {
        if (config.allowExec === false) throw new Error('插件配置里关闭了命令执行（allowExec: false）')
        const body = await readJsonBody(req)
        const command = String(body.command ?? '').trim()
        if (!command) throw new Error('命令不能为空')
        if (command.length > 4000) throw new Error('命令太长（上限 4000 字符）')
        logger.info?.(`[cloud-servers] exec on ${server.name} (${server.user}@${server.host}): ${command.slice(0, 160)}`)
        const result = await runRemote(server, command, { timeoutMs: config.execTimeoutMs, config })
        sendJson(res, 200, {
          ok: !result.error,
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          ms: result.ms,
          timedOut: result.timedOut === true,
          error: result.error ? String(result.error).slice(0, 800) : '',
        })
        return
      }
    }

    sendJson(res, 404, { ok: false, error: '未知接口' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn?.(`[cloud-servers] ${message}`)
    sendJson(res, 200, { ok: false, error: message })
  }
}

/* ------------------------------------------------------------------ 工具 */

function formatServerLine(server) {
  const auth = server.authType === 'key' ? `key:${path.basename(server.keyPath || '')}` : `password:${credentialSource(server)}`
  return `${server.id} | ${server.name} | ${server.user}@${server.host}:${server.port || 22} | ${auth} | ${server.group || '未分组'}`
}

function formatStatus(server, status) {
  if (!status) return `${server.name}：还没有采集状态`
  if (status.ok !== true) return `${server.name}：离线 / 采集失败 — ${status.error || '未知错误'}`
  const mem = status.memPct === null ? '?' : `${status.memPct}%`
  const disk = status.diskPct === null ? '?' : `${status.diskPct}%`
  const load = status.load.length > 0 ? status.load.join('/') : '?'
  const up = typeof status.uptimeSec === 'number' ? `${Math.floor(status.uptimeSec / 86400)}d${Math.floor((status.uptimeSec % 86400) / 3600)}h` : '?'
  return `${server.name}：${status.hostname || server.host} · ${status.os || '?'} · up ${up} · load ${load} · mem ${mem} · disk ${disk} · nginx=${status.services?.nginx || '?'} docker=${status.services?.docker || '?'} · ${status.latencyMs}ms`
}

function registerTools(toolCtx, config, logger) {
  const spec = {
    description:
      'Inspect and manage the cloud servers registered in the DSH "云服务器" panel (SSH inventory). ' +
      'Actions: list = all servers with auth/group info; status = live metrics (os/load/mem/disk/services) for one server or all; ' +
      'exec = run one shell command on a server over SSH. Use list first to learn server ids. ' +
      'When the user picks a server from the composer with "@", the message contains a token like ' +
      '<cloud-server id="srv-demo-web" name="示例 · 主站" host="203.0.113.10"/>. ' +
      'That token is the server the user means: pass its id as the `server` argument and act without asking which host.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'status', 'exec'],
        description: 'Operation to perform.',
      },
      server: {
        type: 'string',
        description:
          'Server id, name, or host (e.g. "srv-demo-web" / "203.0.113.10"). Take it from a <cloud-server id="..."/> token when the user @-mentioned one. Required for exec; omit in status to check all.',
      },
      command: {
        type: 'string',
        description: 'Shell command to run remotely (exec only), e.g. "df -h" or "systemctl status nginx".',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }],
    },
    async execute(args) {
      const action = String(args?.action ?? 'list')
      const state = await readState()
      if (state.servers.length === 0) return { ok: true, text: '还没有登记任何服务器。' }

      if (action === 'list') {
        const lines = state.servers.map((server) => `- ${formatServerLine(server)}`)
        return { ok: true, count: state.servers.length, text: `共 ${state.servers.length} 台服务器：\n${lines.join('\n')}` }
      }

      if (action === 'status') {
        const key = String(args?.server ?? '').trim()
        if (key) {
          const server = findServer(state.servers, key)
          if (!server) return { ok: false, text: `找不到匹配 "${key}" 的服务器` }
          const status = await collectStatus(server, config, { fresh: true })
          return { ok: status.ok === true, server: sanitize(server), status, text: formatStatus(server, status) }
        }
        const rows = []
        await mapLimit(state.servers, 4, async (server) => {
          const status = await collectStatus(server, config, { fresh: true })
          rows.push({ server: sanitize(server), status })
        })
        rows.sort((a, b) => state.servers.findIndex((s) => s.id === a.server.id) - state.servers.findIndex((s) => s.id === b.server.id))
        const text = rows.map((row) => `- ${formatStatus(row.server, row.status)}`).join('\n')
        return { ok: true, results: rows, text }
      }

      if (action === 'exec') {
        if (config.allowExec === false) return { ok: false, text: '插件配置里关闭了命令执行（allowExec: false）' }
        const key = String(args?.server ?? '').trim()
        const server = findServer(state.servers, key)
        if (!server) return { ok: false, text: `找不到匹配 "${key}" 的服务器` }
        const command = String(args?.command ?? '').trim()
        if (!command) return { ok: false, text: 'command 不能为空' }
        const result = await runRemote(server, command, { timeoutMs: config.execTimeoutMs, config })
        const head = `$ ${command}  （${server.user}@${server.host}）\n`
        const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')
        return {
          ok: !result.error,
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          ms: result.ms,
          text: `${head}${result.error ? `错误：${result.error}\n` : ''}${body || '（无输出）'}`,
        }
      }

      return { ok: false, text: `不支持的动作：${action}` }
    },
    timeoutMs: 120000,
  }

  for (const candidate of TOOL_NAME_CANDIDATES) {
    try {
      toolCtx.tools.register({ ...spec, name: candidate })
      logger.info?.(`[cloud-servers] 已注册工具 ${candidate}`)
      return candidate
    } catch (error) {
      const message = String(error?.message ?? error)
      if (/already registered/iu.test(message)) continue
      logger.warn?.(`[cloud-servers] 注册工具 ${candidate} 失败：${message}`)
      return ''
    }
  }
  logger.warn?.('[cloud-servers] 工具名都被占用，跳过工具注册')
  return ''
}

/* ------------------------------------------------------------------ 入口 */

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }
  const logger = ctx.logger ?? console
  if (config.enabled === false) {
    logger.info?.('[cloud-servers] 已在配置里禁用')
    return
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => void handle(req, res, config, logger),
        }),
      'dsh-cloud-servers: api routes',
    )
  })

  ctx.inject(['tools'], (toolCtx) => {
    registerTools(toolCtx, config, logger)
  })

  ctx.effect(
    () => () => {
      statusCache.clear()
    },
    'dsh-cloud-servers: cache',
  )

  logger.info?.('[cloud-servers] 云服务器宿主已加载')
}

/** 测试用：暴露几个纯函数，正式运行不依赖它们。 */
export const __internals = { parseStatus, normalizeServer, sanitize, STATUS_SCRIPT, runRemote }