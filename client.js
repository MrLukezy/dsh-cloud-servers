/**
 * dsh-cloud-servers —— 浏览器半边。
 *
 * 1) 左侧栏「云服务器」入口 + 主面板。
 * 2) 面板左边是分组服务器清单（状态点 / 名称 / 账号@地址），右边是详情：
 *    运行时长、负载、内存/磁盘进度条、nginx/docker/dsh 服务状态，以及命令控制台。
 * 3) 支持新增 / 编辑 / 删除服务器；凭据来源（面板密码 / ssh-log-analyzer）一眼可见。
 *
 * 所有数据走宿主 /cloud-servers/api/*，浏览器不直连 SSH，密码不出宿主进程。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cloud-servers',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useMemo } = React

    const PLUGIN_ID = 'dsh-cloud-servers'
    const PANEL_ID = 'cloud-servers'
    const API = '/cloud-servers/api'
    const POLL_INTERVAL_MS = 30000

    /* ------------------------------------------------------------- 样式 */

    const CSS = [
      '.cs-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font-size:13.5px}',
      '.cs-head{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));flex:none}',
      '.cs-head-title{display:flex;align-items:baseline;gap:8px;font-size:14px;font-weight:600}',
      '.cs-kicker{color:var(--dsw-alias-text-secondary,#8a8f95);font-size:11px;font-weight:400;letter-spacing:.3px}',
      '.cs-count{padding:0 6px;border-radius:9px;background:var(--dsw-alias-bg-l3,rgba(127,127,127,.2));color:var(--dsw-alias-text-secondary,#8a8f95);font-size:11px;line-height:18px}',
      '.cs-head-actions{margin-left:auto;display:flex;align-items:center;gap:8px}',
      '.cs-search{width:150px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:7px;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.05));color:inherit;font:inherit;font-size:12px;outline:none}',
      '.cs-search:focus{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.6))}',
      '.cs-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(230px,310px) minmax(0,1fr)}',
      '.cs-list{border-right:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));overflow-y:auto;padding:8px 8px 20px;overscroll-behavior:contain}',
      '.cs-group{margin:8px 6px 4px;color:var(--dsw-alias-text-secondary,#8a8f95);font-size:11px;letter-spacing:.4px}',
      '.cs-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.cs-item:hover{background:var(--dsw-alias-bg-l2,rgba(127,127,127,.12))}',
      '.cs-item.active{background:var(--dsw-alias-bg-l3,rgba(127,127,127,.2))}',
      '.cs-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.cs-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}',
      '.cs-item-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-text-secondary,#8a8f95);font-size:10.5px;font-family:ui-monospace,Consolas,monospace}',
      '.cs-item-meta{flex:none;color:var(--dsw-alias-text-secondary,#8a8f95);font-size:10.5px;text-align:right}',
      '.cs-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-text-secondary,#8a8f95);opacity:.5}',
      '.cs-dot.ok{background:#3ecf8e;opacity:1;box-shadow:0 0 0 2px rgba(62,207,142,.18)}',
      '.cs-dot.err{background:#e5534b;opacity:1}',
      '.cs-dot.busy{background:#d29922;opacity:1;animation:csPulse 1s ease-in-out infinite}',
      '@keyframes csPulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.cs-detail{overflow-y:auto;padding:18px 22px 30px}',
      '.cs-detail-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}',
      '.cs-detail-title{flex:1;min-width:220px}',
      '.cs-detail-name{margin:0;font-size:16px;font-weight:600}',
      '.cs-detail-addr{margin-top:3px;color:var(--dsw-alias-text-secondary,#8a8f95);font-size:11.5px;font-family:ui-monospace,Consolas,monospace}',
      '.cs-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.cs-btn{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.cs-btn:hover{background:var(--dsw-alias-bg-l3,rgba(127,127,127,.2))}',
      '.cs-btn.primary{border-color:transparent;background:var(--dsw-alias-bg-inverse,#4d6bfe);color:var(--dsw-alias-label-inverse,#fff)}',
      '.cs-btn.danger{color:#e5534b;border-color:rgba(229,83,75,.4)}',
      '.cs-btn:disabled{opacity:.45;cursor:default}',
      '.cs-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:10px}',
      '.cs-tag{padding:1px 7px;border-radius:9px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.14));color:var(--dsw-alias-text-secondary,#8a8f95);font-size:10.5px}',
      '.cs-tag.warn{background:rgba(229,83,75,.14);color:#e5534b}',
      '.cs-banner{margin-top:14px;padding:8px 11px;border:1px solid rgba(229,83,75,.35);border-radius:8px;background:rgba(229,83,75,.08);color:#c4453d;font-size:12px;line-height:1.65;word-break:break-word}',
      '.cs-banner.info{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-l1,rgba(127,127,127,.05));color:var(--dsw-alias-text-secondary,#8a8f95)}',
      '.cs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:10px;margin-top:16px}',
      '.cs-card{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:10px;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.04))}',
      '.cs-card-k{color:var(--dsw-alias-text-secondary,#8a8f95);font-size:10.5px;letter-spacing:.3px}',
      '.cs-card-v{margin-top:4px;font-size:15px;font-weight:600;line-height:1.3}',
      '.cs-card-sub{margin-top:2px;color:var(--dsw-alias-text-secondary,#8a8f95);font-size:10.5px}',
      '.cs-bar{margin-top:7px;height:5px;border-radius:3px;background:var(--dsw-alias-bg-l3,rgba(127,127,127,.2));overflow:hidden}',
      '.cs-bar-fill{height:100%;border-radius:3px;background:#4d6bfe;transition:width .3s ease}',
      '.cs-bar-fill.warn{background:#d29922}',
      '.cs-bar-fill.bad{background:#e5534b}',
      '.cs-services{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}',
      '.cs-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:999px;font-size:11.5px}',
      '.cs-chip .cs-dot{width:6px;height:6px}',
      '.cs-section{margin-top:22px}',
      '.cs-section-title{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;font-weight:600}',
      '.cs-section-title .cs-hint{font-weight:400;color:var(--dsw-alias-text-secondary,#8a8f95);font-size:11px}',
      '.cs-console{display:flex;flex-direction:column;gap:8px}',
      '.cs-console-row{display:flex;gap:8px}',
      '.cs-input{flex:1;min-width:0;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-size:12.5px;outline:none}',
      '.cs-input:focus{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.6))}',
      '.cs-input.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}',
      '.cs-output{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:8px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.07));font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto}',
      '.cs-output .cs-exit{color:var(--dsw-alias-text-secondary,#8a8f95)}',
      '.cs-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px;padding:30px;color:var(--dsw-alias-text-secondary,#8a8f95);font-size:12.5px;line-height:1.8;text-align:center}',
      '.cs-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px;max-width:720px}',
      '.cs-field{display:flex;flex-direction:column;gap:4px}',
      '.cs-field.wide{grid-column:1 / -1}',
      '.cs-field-label{color:var(--dsw-alias-text-secondary,#8a8f95);font-size:11px}',
      '.cs-form-foot{grid-column:1 / -1;display:flex;gap:8px;justify-content:flex-end;margin-top:4px}',
      '.cs-select{width:100%;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-size:12.5px}',
      '.cs-textarea{width:100%;min-height:64px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;font-size:12.5px;resize:vertical}',
      '.cs-check{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-text-secondary,#8a8f95);font-size:11.5px}',
      '.cs-toast{position:fixed;right:22px;bottom:22px;z-index:60;max-width:360px;padding:9px 13px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:9px;background:var(--dsw-alias-bg-l1,#1c1d1f);color:var(--dsw-alias-label-primary,#fff);font-size:12.5px;line-height:1.6;box-shadow:0 8px 24px rgba(0,0,0,.28)}',
      '.cs-copy-list{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:10px;padding:2px 12px}',
      '.cs-copy-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.22))}',
      '.cs-copy-row:last-child{border-bottom:0}',
      '.cs-copy-main{flex:1;min-width:0}',
      '.cs-copy-k{color:var(--dsw-alias-text-secondary,#8a8f95);font-size:10.5px;letter-spacing:.3px}',
      '.cs-copy-v{margin-top:2px;font-size:12px;line-height:1.5;word-break:break-all}',
      '.cs-copy-v.mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px}',
      '.cs-copy{flex:none;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}',
      '.cs-copy:hover{background:var(--dsw-alias-bg-l3,rgba(127,127,127,.2))}',
      '.cs-copy.done{color:#3ecf8e;border-color:rgba(62,207,142,.5)}',
      '.cs-chip-ref{display:inline-flex;align-items:center;gap:5px;margin:0 2px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));border-radius:999px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.12));font-size:12px;line-height:1.7;cursor:pointer;vertical-align:baseline;user-select:none}',
      '.cs-chip-ref:hover{background:var(--dsw-alias-bg-l3,rgba(127,127,127,.22))}',
      '.cs-chip-ref-dot{width:6px;height:6px;border-radius:50%;background:#3ecf8e;flex:none}',
      '.cs-pub{margin-top:2px}',
      '.cs-pub-summary{padding:6px 0;color:var(--dsw-alias-text-secondary,#8a8f95);font-size:11px;cursor:pointer;list-style:none}',
      '.cs-pub-summary::-webkit-details-marker{display:none}',
      '.cs-more{margin-top:18px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:10px;padding:0 12px}',
      '.cs-more-summary{display:flex;align-items:center;gap:8px;padding:9px 0;font-size:12px;font-weight:600;cursor:pointer;list-style:none}',
      '.cs-more-summary::-webkit-details-marker{display:none}',
      '.cs-more[open]{padding-bottom:10px}',
      '.cs-more[open] .cs-more-summary{border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));margin-bottom:8px}',
      '.cs-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:5px 18px}',
      '.cs-kv-row{display:flex;gap:8px;min-width:0;padding:2px 0}',
      '.cs-kv-k{flex:none;width:76px;color:var(--dsw-alias-text-secondary,#8a8f95);font-size:10.5px;line-height:1.7}',
      '.cs-kv-v{flex:1;min-width:0;font-size:11.5px;line-height:1.7;word-break:break-all}',
      '.cs-mounts{margin-top:10px}',
      '.cs-mount-row{display:flex;align-items:baseline;gap:10px;padding:3px 0;font-size:11.5px}',
      '.cs-mount-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace}',
      '.cs-mount-size{flex:none;color:var(--dsw-alias-text-secondary,#8a8f95);font-size:11px}',
      '.cs-mount-pct{flex:none;width:42px;text-align:right;font-size:11px}',
      '@media (max-width:820px){.cs-body{grid-template-columns:1fr}.cs-list{max-height:38vh;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}.cs-detail{padding:14px 16px 24px}.cs-form{grid-template-columns:1fr}.cs-search{width:110px}}',
    ].join('\n')

    /* ------------------------------------------------------------- 图标 */

    function ServerGlyph(props) {
      const size = props.size ?? 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 3, y: 4, width: 18, height: 6.2, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('rect', { x: 3, y: 13.8, width: 18, height: 6.2, rx: 1.8, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('circle', { cx: 6.6, cy: 7.1, r: 1.05, fill: 'currentColor' }),
        h('circle', { cx: 6.6, cy: 16.9, r: 1.05, fill: 'currentColor' }),
        h('path', { d: 'M10 7.1h7.2M10 16.9h7.2', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )
    }

    /* ------------------------------------------------------------- 工具 */

    const pad = (n) => String(n).padStart(2, '0')

    function formatUptime(sec) {
      if (typeof sec !== 'number' || !Number.isFinite(sec)) return '—'
      const days = Math.floor(sec / 86400)
      const hours = Math.floor((sec % 86400) / 3600)
      if (days > 0) return `${days}d ${hours}h`
      const minutes = Math.floor((sec % 3600) / 60)
      return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
    }

    function formatKb(kb) {
      if (typeof kb !== 'number' || !Number.isFinite(kb)) return '—'
      const mb = kb / 1024
      if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
      return `${Math.round(mb)} MB`
    }

    function formatClock(ts) {
      if (!ts) return ''
      const date = new Date(ts)
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function levelOf(pct) {
      if (typeof pct !== 'number') return ''
      if (pct >= 88) return ' bad'
      if (pct >= 70) return ' warn'
      return ''
    }

    function statusClass(status, busy) {
      if (busy) return 'busy'
      if (!status) return ''
      return status.ok === true ? 'ok' : 'err'
    }

    function apiUrl(pathname) {
      const suffix = String(pathname ?? '').replace(/^\/+/u, '')
      return `${API}/${suffix}`
    }

    async function api(pathname, options = {}) {
      const url = apiUrl(pathname)
      const init = { method: options.method ?? 'GET', headers: {} }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      const response = await fetch(url, init)
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`非 JSON 响应（HTTP ${response.status}）：${url}`)
      }
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}（${url}）`)
      return payload
    }

    /* --------------------------------------------------- @ 服务器提及（composer） */

    /** id → 服务器摘要，供 chip 序列化时补全 name/host。 */
    const serverIndex = new Map()
    let serverCache = { at: 0, list: [] }

    async function fetchServers() {
      if (serverCache.list.length > 0 && Date.now() - serverCache.at < 5000) return serverCache.list
      const payload = await api('state')
      const list = Array.isArray(payload.servers) ? payload.servers : []
      for (const item of list) serverIndex.set(item.id, item)
      serverCache = { at: Date.now(), list }
      return list
    }

    function escapeAttr(value) {
      return String(value ?? '').replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;')
    }

    /**
     * `@` 触发源：输入 @ 就能按名字 / IP 挑服务器。
     * 选中后草稿里是一个 chip，提交时由 codec.serialize 变成
     * `<cloud-server id="…" name="…" host="…"/>`，模型据此调 cloud_servers 工具。
     */
    function buildServerSource() {
      return {
        trigger: '@',
        name: 'servers',
        showGroupTitle: false,
        async candidates(session, { query, quoted, signal } = {}) {
          if (quoted === true) return []
          let list
          try {
            list = await fetchServers()
          } catch {
            return []
          }
          if (signal && signal.aborted) return []
          const needle = String(query ?? '').trim().toLowerCase()
          const rows =
            needle === ''
              ? list
              : list.filter((item) =>
                  [item.name, item.host, item.group, item.user, ...(item.tags || [])]
                    .join(' ')
                    .toLowerCase()
                    .includes(needle),
                )
          return rows.slice(0, 20).map((item) => ({
            name: item.name,
            description: `${item.user}@${item.host} · ${item.group}`,
            section: item.group || '未分组',
            value: JSON.stringify({ kind: 'server', id: item.id }),
          }))
        },
        onPick({ candidate } = {}) {
          let value
          try {
            value = JSON.parse(candidate?.value ?? '')
          } catch {
            value = undefined
          }
          if (!value || value.kind !== 'server') return undefined
          const server = serverIndex.get(value.id)
          return {
            insert: {
              source: 'servers',
              ref: `@${value.id}`,
              label: server?.name ?? value.id,
              appearance: 'cloud-server',
              clipboardText: `@${server?.name ?? value.id}`,
            },
          }
        },
        codec: {
          clipboardText: (ref) => String(ref ?? ''),
          serialize: (ref) => {
            const id = String(ref ?? '').replace(/^@/u, '')
            const server = serverIndex.get(id)
            if (!server) return Promise.resolve(`<cloud-server id="${escapeAttr(id)}"/>`)
            return Promise.resolve(
              `<cloud-server id="${escapeAttr(server.id)}" name="${escapeAttr(server.name)}" host="${escapeAttr(server.host)}" user="${escapeAttr(server.user)}" group="${escapeAttr(server.group)}"/>`,
            )
          },
        },
      }
    }

    /** 消息里的服务器 chip：点一下切到云服务器面板。 */
    function ServerChip({ node, raw }) {
      const data = node?.data ?? {}
      const label = data.label || data.ref || raw || '服务器'
      return h(
        'span',
        {
          className: 'cs-chip-ref',
          title: data.host ? `${label} · ${data.host}` : label,
          onClick: () => openPanel(),
        },
        h('span', { className: 'cs-chip-ref-dot' }),
        h('span', null, String(label).replace(/^@/u, '')),
      )
    }

    /* ------------------------------------------------------------- 复制 */

    async function copyText(text) {
      const value = String(text ?? '')
      if (value === '') return false
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(value)
          return true
        }
      } catch {
        /* 退回到 execCommand */
      }
      try {
        const area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    function CopyButton({ text, label }) {
      const [done, setDone] = useState(false)
      return h(
        'button',
        {
          type: 'button',
          className: `cs-copy${done ? ' done' : ''}`,
          title: label ? `复制${label}` : '复制',
          onClick: async (event) => {
            event.stopPropagation()
            const ok = await copyText(text)
            if (!ok) return
            setDone(true)
            window.setTimeout(() => setDone(false), 1400)
          },
        },
        done ? '已复制' : '复制',
      )
    }

    function CopyRow({ label, value, mono }) {
      const text = String(value ?? '')
      return h(
        'div',
        { className: 'cs-copy-row' },
        h(
          'div',
          { className: 'cs-copy-main' },
          h('div', { className: 'cs-copy-k' }, label),
          h('div', { className: `cs-copy-v${mono ? ' mono' : ''}` }, text || '—'),
        ),
        text ? h(CopyButton, { text, label }) : null,
      )
    }

    /* ------------------------------------------------------------- 组件 */

    function Bar({ pct }) {
      const value = typeof pct === 'number' ? Math.max(0, Math.min(100, pct)) : 0
      return h(
        'div',
        { className: 'cs-bar' },
        h('div', { className: `cs-bar-fill${levelOf(pct)}`, style: { width: `${value}%` } }),
      )
    }

    function Card({ label, value, sub, pct }) {
      return h(
        'div',
        { className: 'cs-card' },
        h('div', { className: 'cs-card-k' }, label),
        h('div', { className: 'cs-card-v' }, value),
        sub ? h('div', { className: 'cs-card-sub' }, sub) : null,
        typeof pct === 'number' ? h(Bar, { pct }) : null,
      )
    }

    function Chip({ label, state }) {
      const cls = state === 'active' ? 'ok' : state === 'inactive' || state === 'failed' ? 'err' : ''
      return h(
        'span',
        { className: 'cs-chip' },
        h('span', { className: `cs-dot ${cls}` }),
        h('span', null, label),
        h('span', { className: 'cs-tag' }, state || '未知'),
      )
    }

    function ServersPanel() {
      const [servers, setServers] = useState([])
      const [statuses, setStatuses] = useState({})
      const [selectedId, setSelectedId] = useState('')
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [filter, setFilter] = useState('')
      const [editing, setEditing] = useState(null)
      const [terminal, setTerminal] = useState({ command: '', running: false, output: '', code: null, error: '' })
      const [sshInfo, setSshInfo] = useState({})
      const [toast, setToast] = useState('')
      const toastTimer = useRef(0)
      const sshLoaded = useRef({})

      async function loadSsh(id) {
        if (!id) return
        try {
          const payload = await api(`servers/${encodeURIComponent(id)}/ssh`)
          setSshInfo((current) => ({ ...current, [id]: payload.ssh }))
        } catch (err) {
          setSshInfo((current) => ({ ...current, [id]: { error: String(err?.message ?? err) } }))
        }
      }

      function notify(message) {
        setToast(message)
        try {
          if (toastTimer.current) window.clearTimeout(toastTimer.current)
          toastTimer.current = window.setTimeout(() => setToast(''), 4200)
        } catch {
          /* ignore */
        }
      }

      async function load(showSpinner) {
        if (showSpinner !== false) setLoading(true)
        let lastError = ''
        // 刚启动时宿主路由可能还没挂好，重试几次比直接报错友好
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const payload = await api('state')
            const list = Array.isArray(payload.servers) ? payload.servers : []
            setServers(list)
            setStatuses(payload.statuses && typeof payload.statuses === 'object' ? payload.statuses : {})
            setSelectedId((current) => (current && list.some((item) => item.id === current) ? current : (list[0]?.id ?? '')))
            setError('')
            setLoading(false)
            // 首次打开、宿主缓存还是空的时候，后台预热一轮，让左边状态点立刻有意义
            if (list.length > 0 && Object.keys(payload.statuses || {}).length === 0) void warmUp()
            return
          } catch (err) {
            lastError = String(err?.message ?? err)
            if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800))
          }
        }
        setError(lastError)
        setLoading(false)
      }

      async function warmUp() {
        try {
          const payload = await api('status-all', { method: 'POST' })
          mergeStatuses(payload.statuses)
        } catch {
          /* 预热失败不打扰用户 */
        }
      }

      function mergeStatuses(incoming) {
        if (!incoming || typeof incoming !== 'object') return
        setStatuses((current) => ({ ...current, ...incoming }))
      }

      async function refreshAll() {
        setBusy('all')
        try {
          const payload = await api('status-all?fresh=1', { method: 'POST' })
          mergeStatuses(payload.statuses)
          notify(`已刷新 ${Object.keys(payload.statuses || {}).length} 台服务器`)
        } catch (err) {
          notify(`刷新失败：${String(err?.message ?? err)}`)
        } finally {
          setBusy('')
        }
      }

      async function refreshOne(id, silent) {
        if (!id) return
        if (!silent) setBusy(id)
        try {
          const payload = await api(`servers/${encodeURIComponent(id)}/status?fresh=1`, { method: 'POST' })
          mergeStatuses({ [id]: payload.status })
        } catch (err) {
          mergeStatuses({ [id]: { ok: false, error: String(err?.message ?? err), at: Date.now() } })
        } finally {
          if (!silent) setBusy('')
        }
      }

      async function testOne(id) {
        if (!id) return
        setBusy(id)
        try {
          const payload = await api(`servers/${encodeURIComponent(id)}/test`, { method: 'POST' })
          notify(payload.ok ? `连接正常 · ${payload.detail || ''}（${payload.latencyMs}ms）` : `连接失败：${payload.error}`)
        } catch (err) {
          notify(`连接失败：${String(err?.message ?? err)}`)
        } finally {
          setBusy('')
        }
      }

      async function runCommand(id) {
        const command = terminal.command.trim()
        if (!id || !command || terminal.running) return
        setTerminal((current) => ({ ...current, running: true, output: '', error: '', code: null }))
        try {
          const payload = await api(`servers/${encodeURIComponent(id)}/exec`, { method: 'POST', body: { command } })
          setTerminal((current) => ({
            ...current,
            running: false,
            output: [payload.stdout, payload.stderr].filter((item) => item && item.trim() !== '').join('\n').trim(),
            code: payload.code,
            error: payload.error || '',
          }))
          void refreshOne(id)
        } catch (err) {
          setTerminal((current) => ({ ...current, running: false, error: String(err?.message ?? err) }))
        }
      }

      async function saveServer(form) {
        const isEdit = form.id !== ''
        try {
          const body = {
            name: form.name,
            group: form.group,
            host: form.host,
            port: form.port,
            user: form.user,
            authType: form.authType,
            keyPath: form.keyPath,
            passwordFrom: form.passwordFrom,
            tags: form.tags,
            note: form.note,
          }
          if (form.password !== '') body.password = form.password
          if (form.clearPassword) body.clearPassword = true
          if (isEdit) await api(`servers/${encodeURIComponent(form.id)}`, { method: 'PATCH', body })
          else await api('servers', { method: 'POST', body })
          if (isEdit) delete sshLoaded.current[form.id]
          setEditing(null)
          await load(false)
          notify(isEdit ? '已保存修改' : '已添加服务器')
        } catch (err) {
          notify(`保存失败：${String(err?.message ?? err)}`)
        }
      }

      async function removeServer(server) {
        if (!server) return
        if (!window.confirm(`确定删除「${server.name}」吗？只删本地登记，不会动服务器。`)) return
        try {
          await api(`servers/${encodeURIComponent(server.id)}`, { method: 'DELETE' })
          setEditing(null)
          await load(false)
          notify('已删除')
        } catch (err) {
          notify(`删除失败：${String(err?.message ?? err)}`)
        }
      }

      useEffect(() => {
        void load(true)
      }, [])

      useEffect(() => {
        if (!selectedId) return undefined
        const timer = window.setInterval(() => {
          if (editing) return
          void refreshOne(selectedId, true)
        }, POLL_INTERVAL_MS)
        return () => window.clearInterval(timer)
      }, [selectedId, editing])

      // 连接信息按需拉取（含 ssh-keygen 指纹），每台只拉一次，编辑后失效
      useEffect(() => {
        if (!selectedId || editing) return
        if (sshLoaded.current[selectedId]) return
        sshLoaded.current[selectedId] = true
        void loadSsh(selectedId)
      }, [selectedId, editing])

      const selected = servers.find((item) => item.id === selectedId) || null
      const visible = useMemo(() => {
        const needle = filter.trim().toLowerCase()
        if (!needle) return servers
        return servers.filter((item) =>
          [item.name, item.host, item.group, item.user, ...(item.tags || [])]
            .join(' ')
            .toLowerCase()
            .includes(needle),
        )
      }, [servers, filter])

      const groups = useMemo(() => {
        const map = new Map()
        for (const item of visible) {
          const key = item.group || '未分组'
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(item)
        }
        return [...map.entries()]
      }, [visible])

      const selectedStatus = selected ? statuses[selected.id] : null

      return h(
        'div',
        { className: 'cs-root' },
        h(
          'header',
          { className: 'cs-head' },
          h(
            'div',
            { className: 'cs-head-title' },
            h('span', null, '云服务器'),
            h('span', { className: 'cs-count' }, String(servers.length)),
            h('span', { className: 'cs-kicker' }, 'SSH 巡检 · 命令执行'),
          ),
          h(
            'div',
            { className: 'cs-head-actions' },
            h('input', {
              className: 'cs-search',
              value: filter,
              placeholder: '搜索名称 / 地址',
              onChange: (event) => setFilter(event.target.value),
            }),
            h('button', { className: 'cs-btn', onClick: () => void load(true), disabled: loading }, loading ? '加载中…' : '重新加载'),
            h('button', { className: 'cs-btn', onClick: () => void refreshAll(), disabled: busy === 'all' }, busy === 'all' ? '刷新中…' : '刷新全部'),
            h(
              'button',
              { className: 'cs-btn primary', onClick: () => setEditing({ mode: 'create', form: emptyForm() }) },
              '添加服务器',
            ),
          ),
        ),
        h(
          'div',
          { className: 'cs-body' },
          h(
            'aside',
            { className: 'cs-list' },
            loading && servers.length === 0 ? h('div', { className: 'cs-empty' }, '正在读取服务器清单…') : null,
            !loading && servers.length === 0
              ? h('div', { className: 'cs-empty' }, '还没有登记服务器', h('span', null, '点右上角「添加服务器」开始'))
              : null,
            groups.map(([group, items]) =>
              h(
                'div',
                { key: group },
                h('div', { className: 'cs-group' }, `${group} · ${items.length}`),
                items.map((item) => {
                  const status = statuses[item.id]
                  return h(
                    'button',
                    {
                      key: item.id,
                      type: 'button',
                      className: `cs-item${item.id === selectedId ? ' active' : ''}`,
                      onClick: () => {
                        setSelectedId(item.id)
                        setTerminal({ command: '', running: false, output: '', code: null, error: '' })
                        if (!statuses[item.id]) void refreshOne(item.id)
                      },
                    },
                    h('span', { className: `cs-dot ${statusClass(status, busy === item.id)}` }),
                    h(
                      'span',
                      { className: 'cs-item-main' },
                      h('span', { className: 'cs-item-name' }, item.name),
                      h('span', { className: 'cs-item-sub' }, `${item.user}@${item.host}`),
                    ),
                    h('span', { className: 'cs-item-meta' }, status?.ok === true ? formatUptime(status.uptimeSec) : status ? '离线' : ''),
                  )
                }),
              ),
            ),
          ),
          h(
            'section',
            { className: 'cs-detail' },
            error ? h('div', { className: 'cs-banner' }, `读取失败：${error}`) : null,
            editing
              ? h(Editor, {
                  form: editing.form,
                  mode: editing.mode,
                  onChange: (patch) => setEditing((current) => ({ ...current, form: { ...current.form, ...patch } })),
                  onCancel: () => setEditing(null),
                  onSave: (form) => void saveServer(form),
                  onDelete: editing.form.id ? () => void removeServer(editing.form) : null,
                })
              : selected
                ? h(Detail, {
                    server: selected,
                    status: selectedStatus,
                    ssh: sshInfo[selected.id],
                    busy: busy === selected.id,
                    terminal,
                    onTerminal: (patch) => setTerminal((current) => ({ ...current, ...patch })),
                    onRefresh: () => void refreshOne(selected.id),
                    onTest: () => void testOne(selected.id),
                    onRun: () => void runCommand(selected.id),
                    onEdit: () => setEditing({ mode: 'edit', form: formOf(selected) }),
                    onDelete: () => void removeServer(selected),
                  })
                : h('div', { className: 'cs-empty' }, '左边选一台服务器看详情'),
          ),
        ),
        toast ? h('div', { className: 'cs-toast' }, toast) : null,
      )
    }

    function emptyForm() {
      return {
        id: '',
        name: '',
        group: '未分组',
        host: '',
        port: 22,
        user: 'root',
        authType: 'key',
        keyPath: '',
        password: '',
        passwordFrom: '',
        clearPassword: false,
        tags: '',
        note: '',
      }
    }

    function formOf(server) {
      return {
        id: server.id,
        name: server.name,
        group: server.group,
        host: server.host,
        port: server.port,
        user: server.user,
        authType: server.authType,
        keyPath: server.keyPath || '',
        password: '',
        passwordFrom: server.passwordFrom || '',
        clearPassword: false,
        tags: (server.tags || []).join(', '),
        note: server.note || '',
      }
    }

    function Detail({ server, status, ssh, busy, terminal, onTerminal, onRefresh, onTest, onRun, onEdit, onDelete }) {
      const authLabel =
        server.authType === 'key'
          ? '密钥登录'
          : server.credentialSource === 'panel'
            ? '面板密码'
            : server.credentialSource === 'ssh-log-analyzer'
              ? '密码来自 ssh-log-analyzer（未复制）'
              : '未配置密码'
      const memPct = status?.ok ? status.memPct : null
      const diskPct = status?.ok ? status.diskPct : null
      const ok = status?.ok === true
      const portList = ok && Array.isArray(status.ports) ? status.ports : []
      const ports =
        portList.length > 8 ? `${portList.slice(0, 8).join(', ')} 等 ${portList.length} 个` : portList.join(', ')
      const mounts = ok && Array.isArray(status.mounts) ? status.mounts : []
      const tops = ok && Array.isArray(status.top) ? status.top : []
      const swapTotal = ok ? status.swapTotalKb : null
      const swapUsed =
        ok && typeof status.swapTotalKb === 'number' && typeof status.swapFreeKb === 'number'
          ? status.swapTotalKb - status.swapFreeKb
          : null

      const kvRows = [
        ['架构', ok ? [status.arch, status.timezone].filter(Boolean).join(' · ') : '—'],
        ['CPU 型号', ok ? status.cpuModel || '—' : '—'],
        ['内网 IP', ok ? status.ip || '—' : '—'],
        ['启动时间', ok ? status.bootAt || '—' : '—'],
        ['进程 / 用户', ok ? `${status.procs ?? '?'} 个进程${status.users > 0 ? ` · ${status.users} 人登录` : ''}` : '—'],
        ['交换分区', ok ? (swapTotal ? `${formatKb(swapUsed)} / ${formatKb(swapTotal)}` : '未启用') : '—'],
        ['容器', ok ? `${status.containers ?? 0} 个运行中` : '—'],
        ['监听端口', ports || '—'],
        ['最后登录', ok && status.lastLogin ? String(status.lastLogin).slice(0, 56) : '—'],
      ]

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'cs-detail-head' },
          h(
            'div',
            { className: 'cs-detail-title' },
            h('h2', { className: 'cs-detail-name' }, server.name),
            h('div', { className: 'cs-detail-addr' }, `${server.user}@${server.host}:${server.port}`),
          ),
          h(
            'div',
            { className: 'cs-actions' },
            h('button', { className: 'cs-btn', onClick: onRefresh, disabled: busy }, busy ? '采集中…' : '刷新状态'),
            h('button', { className: 'cs-btn', onClick: onTest, disabled: busy }, '测试连接'),
            h('button', { className: 'cs-btn', onClick: onEdit }, '编辑'),
            h('button', { className: 'cs-btn danger', onClick: onDelete }, '删除'),
          ),
        ),
        h(
          'div',
          { className: 'cs-tags' },
          h('span', { className: 'cs-tag' }, server.group || '未分组'),
          (server.tags || []).map((tag) => h('span', { key: tag, className: 'cs-tag' }, tag)),
          h('span', { className: `cs-tag${server.credentialSource === 'none' ? ' warn' : ''}` }, authLabel),
        ),
        status && !ok ? h('div', { className: 'cs-banner' }, `离线 / 采集失败：${status.error || '未知错误'}`) : null,
        status && !ok && server.authType === 'password' && server.credentialSource === 'none'
          ? h('div', { className: 'cs-banner info' }, '这台主机还没有可用密码：点「编辑」补密码，或确认 ssh-log-analyzer 的 SSH_PASS 可读。')
          : null,
        h(
          'div',
          { className: 'cs-grid' },
          h(Card, {
            label: '运行时长',
            value: ok ? formatUptime(status.uptimeSec) : '—',
            sub: ok ? `系统时间 ${status.serverTime || '?'}` : '尚未采集',
          }),
          h(Card, {
            label: '负载 / 核数',
            value: ok && status.load?.length ? status.load.join(' / ') : '—',
            sub: ok ? `${status.cpus ?? '?'} 核 · ${status.kernel || ''}` : '',
          }),
          h(Card, {
            label: 'CPU 使用率',
            value: ok && typeof status.cpuUsedPct === 'number' ? `${status.cpuUsedPct}%` : '—',
            sub: ok && tops.length > 0 ? `最高 ${tops[0].name} ${tops[0].pct}%` : '',
            pct: ok && typeof status.cpuUsedPct === 'number' ? status.cpuUsedPct : undefined,
          }),
          h(Card, {
            label: '内存',
            value: ok ? `${memPct ?? '?'}%` : '—',
            sub: ok ? `${formatKb(status.memUsedKb)} / ${formatKb(status.memTotalKb)}` : '',
            pct: typeof memPct === 'number' ? memPct : undefined,
          }),
          h(Card, {
            label: '磁盘 /',
            value: ok ? `${diskPct ?? '?'}%` : '—',
            sub: ok ? `${formatKb(status.diskUsedKb)} / ${formatKb(status.diskTotalKb)}` : '',
            pct: typeof diskPct === 'number' ? diskPct : undefined,
          }),
          h(Card, {
            label: '系统',
            value: ok ? String(status.os || '').replace(/^["']|["']$/g, '') : '—',
            sub: ok ? status.hostname || '' : '',
          }),
          h(Card, {
            label: '响应',
            value: ok ? `${status.latencyMs} ms` : status ? '失败' : '—',
            sub: status?.at ? `采集于 ${formatClock(status.at)}` : '',
          }),
        ),
        ok
          ? h(
              'div',
              { className: 'cs-services' },
              h(Chip, { label: 'nginx', state: status.services?.nginx }),
              h(Chip, { label: 'docker', state: status.services?.docker }),
              h(Chip, { label: 'dsh web', state: status.dshWeb ? 'active' : 'inactive' }),
              h(Chip, { label: '容器', state: (status.containers ?? 0) > 0 ? 'active' : 'inactive' }),
            )
          : null,
        server.note ? h('div', { className: 'cs-banner info' }, server.note) : null,
        h(
          'div',
          { className: 'cs-section' },
          h(
            'div',
            { className: 'cs-section-title' },
            h('span', null, '连接信息'),
            h('span', { className: 'cs-hint' }, '点右侧「复制」直接拿去用；私钥内容不会外传'),
          ),
          h(
            'div',
            { className: 'cs-copy-list' },
            ssh?.error
              ? h('div', { className: 'cs-banner' }, `读取连接信息失败：${ssh.error}`)
              : null,
            h(CopyRow, { label: 'SSH 命令', value: ssh?.command || '', mono: true }),
            server.authType === 'key'
              ? h(CopyRow, { label: '私钥', value: server.keyPath || '', mono: true })
              : h(CopyRow, {
                  label: '密码来源',
                  value:
                    server.credentialSource === 'panel'
                      ? '面板里保存的密码（已隐藏，编辑时可改）'
                      : server.credentialSource === 'ssh-log-analyzer'
                        ? 'ssh-log-analyzer 的 SSH_PASS（运行时读取，未复制）'
                        : '未配置',
                }),
            ssh?.fingerprint ? h(CopyRow, { label: '指纹', value: ssh.fingerprint, mono: true }) : null,
            ssh?.publicKey
              ? h(
                  'details',
                  { className: 'cs-pub' },
                  h('summary', { className: 'cs-pub-summary' }, '公钥（点击展开）'),
                  h(
                    'div',
                    { className: 'cs-copy-row' },
                    h('div', { className: 'cs-copy-main' }, h('div', { className: 'cs-copy-v mono' }, ssh.publicKey)),
                    h(CopyButton, { text: ssh.publicKey, label: '公钥' }),
                  ),
                )
              : null,
            ssh && ssh.authType === 'key' && ssh.keyExists === false
              ? h('div', { className: 'cs-banner' }, `私钥文件不存在：${ssh.keyPath}`)
              : null,
          ),
        ),
        h(
          'details',
          { className: 'cs-more' },
          h(
            'summary',
            { className: 'cs-more-summary' },
            h('span', null, '更多数据'),
            h('span', { className: 'cs-hint' }, '架构 / 端口 / 挂载点 / 进程 / 登录'),
          ),
          h(
            'div',
            { className: 'cs-kv' },
            kvRows.map(([key, value]) =>
              h(
                'div',
                { className: 'cs-kv-row', key },
                h('span', { className: 'cs-kv-k' }, key),
                h('span', { className: 'cs-kv-v' }, value || '—'),
              ),
            ),
          ),
          mounts.length > 0
            ? h(
                'div',
                { className: 'cs-mounts' },
                h('div', { className: 'cs-kv-k' }, '磁盘挂载点'),
                mounts.map((item) =>
                  h(
                    'div',
                    { className: 'cs-mount-row', key: item.mount },
                    h('span', { className: 'cs-mount-name' }, item.mount),
                    h('span', { className: 'cs-mount-size' }, `${formatKb(item.usedKb)} / ${formatKb(item.totalKb)}`),
                    h('span', { className: 'cs-mount-pct' }, `${item.pct ?? '?'}%`),
                  ),
                ),
              )
            : null,
          tops.length > 0
            ? h(
                'div',
                { className: 'cs-mounts' },
                h('div', { className: 'cs-kv-k' }, 'CPU 占用前三'),
                tops.map((item) =>
                  h(
                    'div',
                    { className: 'cs-mount-row', key: item.name },
                    h('span', { className: 'cs-mount-name' }, item.name),
                    h('span', { className: 'cs-mount-size' }, item.pct === null ? '' : `${item.pct}%`),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'cs-section' },
          h(
            'div',
            { className: 'cs-section-title' },
            h('span', null, '命令控制台'),
            h('span', { className: 'cs-hint' }, '在远端执行一条 shell 命令，输出回显在这里'),
          ),
          h(
            'div',
            { className: 'cs-console' },
            h(
              'div',
              { className: 'cs-console-row' },
              h('input', {
                className: 'cs-input mono',
                value: terminal.command,
                placeholder: 'uptime && df -h /  或  systemctl status nginx',
                onChange: (event) => onTerminal({ command: event.target.value }),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') onRun()
                },
              }),
              h('button', { className: 'cs-btn primary', onClick: onRun, disabled: terminal.running }, terminal.running ? '执行中…' : '执行'),
            ),
            terminal.error ? h('div', { className: 'cs-banner' }, terminal.error) : null,
            terminal.output !== '' || terminal.code !== null
              ? h(
                  'pre',
                  { className: 'cs-output' },
                  terminal.output || '（无输出）',
                  h('span', { className: 'cs-exit' }, `\n\n[exit ${terminal.code ?? '?'}]`),
                )
              : null,
          ),
        ),
      )
    }

    function Editor({ form, mode, onChange, onCancel, onSave, onDelete }) {
      const isPassword = form.authType === 'password'
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'cs-detail-head' },
          h(
            'div',
            { className: 'cs-detail-title' },
            h('h2', { className: 'cs-detail-name' }, mode === 'create' ? '添加服务器' : `编辑 · ${form.name || form.host}`),
            h('div', { className: 'cs-detail-addr' }, '只写本机清单；密码保存在本机 storages 目录（0600），不会上传'),
          ),
        ),
        h(
          'div',
          { className: 'cs-form' },
          h(
            'label',
            { className: 'cs-field' },
            h('span', { className: 'cs-field-label' }, '名称'),
            h('input', {
              className: 'cs-input',
              value: form.name,
              placeholder: '腾讯云 · 主站',
              onChange: (event) => onChange({ name: event.target.value }),
            }),
          ),
          h(
            'label',
            { className: 'cs-field' },
            h('span', { className: 'cs-field-label' }, '分组'),
            h('input', {
              className: 'cs-input',
              value: form.group,
              placeholder: '个人腾讯云 / 公司内网 / 内网游戏服',
              onChange: (event) => onChange({ group: event.target.value }),
            }),
          ),
          h(
            'label',
            { className: 'cs-field' },
            h('span', { className: 'cs-field-label' }, '地址'),
            h('input', {
              className: 'cs-input mono',
              value: form.host,
              placeholder: '203.0.113.10',
              onChange: (event) => onChange({ host: event.target.value }),
            }),
          ),
          h(
            'label',
            { className: 'cs-field' },
            h('span', { className: 'cs-field-label' }, '端口'),
            h('input', {
              className: 'cs-input',
              value: form.port,
              placeholder: '22',
              onChange: (event) => onChange({ port: event.target.value }),
            }),
          ),
          h(
            'label',
            { className: 'cs-field' },
            h('span', { className: 'cs-field-label' }, '登录用户'),
            h('input', {
              className: 'cs-input',
              value: form.user,
              placeholder: 'root',
              onChange: (event) => onChange({ user: event.target.value }),
            }),
          ),
          h(
            'label',
            { className: 'cs-field' },
            h('span', { className: 'cs-field-label' }, '认证方式'),
            h(
              'select',
              {
                className: 'cs-select',
                value: form.authType,
                onChange: (event) => onChange({ authType: event.target.value }),
              },
              h('option', { value: 'key' }, 'SSH 私钥'),
              h('option', { value: 'password' }, '账号密码'),
            ),
          ),
          form.authType === 'key'
            ? h(
                'label',
                { className: 'cs-field wide' },
                h('span', { className: 'cs-field-label' }, '私钥路径'),
                h('input', {
                  className: 'cs-input mono',
                  value: form.keyPath,
                  placeholder: 'C:/Users/you/.ssh/id_ed25519',
                  onChange: (event) => onChange({ keyPath: event.target.value }),
                }),
              )
            : h(
                'label',
                { className: 'cs-field wide' },
                h('span', { className: 'cs-field-label' }, `密码${mode === 'edit' ? '（留空表示不修改）' : ''}`),
                h('input', {
                  className: 'cs-input',
                  type: 'password',
                  value: form.password,
                  placeholder: '不填则使用下面的凭据来源',
                  onChange: (event) => onChange({ password: event.target.value }),
                }),
              ),
          isPassword
            ? h(
                'label',
                { className: 'cs-field wide' },
                h('span', { className: 'cs-field-label' }, '密码来源'),
                h(
                  'select',
                  {
                    className: 'cs-select',
                    value: form.passwordFrom,
                    onChange: (event) => onChange({ passwordFrom: event.target.value }),
                  },
                  h('option', { value: '' }, '只用上面填的密码'),
                  h('option', { value: 'ssh-log-analyzer' }, '读取 ssh-log-analyzer 的 SSH_PASS（不复制）'),
                ),
              )
            : null,
          mode === 'edit' && isPassword
            ? h(
                'label',
                { className: 'cs-check' },
                h('input', {
                  type: 'checkbox',
                  checked: form.clearPassword,
                  onChange: (event) => onChange({ clearPassword: event.target.checked }),
                }),
                h('span', null, '清除已保存的密码'),
              )
            : null,
          h(
            'label',
            { className: 'cs-field wide' },
            h('span', { className: 'cs-field-label' }, '标签（逗号分隔）'),
            h('input', {
              className: 'cs-input',
              value: form.tags,
              placeholder: 'dsh, nginx, game',
              onChange: (event) => onChange({ tags: event.target.value }),
            }),
          ),
          h(
            'label',
            { className: 'cs-field wide' },
            h('span', { className: 'cs-field-label' }, '备注'),
            h('textarea', {
              className: 'cs-textarea',
              value: form.note,
              placeholder: '这台机器跑什么、日志在哪、注意事项…',
              onChange: (event) => onChange({ note: event.target.value }),
            }),
          ),
          h(
            'div',
            { className: 'cs-form-foot' },
            onDelete ? h('button', { className: 'cs-btn danger', onClick: onDelete }, '删除') : null,
            h('button', { className: 'cs-btn', onClick: onCancel }, '取消'),
            h('button', { className: 'cs-btn primary', onClick: () => onSave(form) }, '保存'),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------- 入口 */

    let rootCtx = null

    /** 从消息里的服务器 chip 跳回面板。 */
    function openPanel() {
      try {
        const layout = rootCtx?.layout ?? (typeof rootCtx?.get === 'function' ? rootCtx.get('layout') : undefined)
        if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
      } catch {
        /* 面板没开也不影响对话 */
      }
    }

    function apply(ctx) {
      rootCtx = ctx
      ctx.effect(() => {
        if (document.querySelector(`style[data-plugin="${PLUGIN_ID}"]`)) return undefined
        const style = document.createElement('style')
        style.dataset.plugin = PLUGIN_ID
        style.textContent = CSS
        document.head.append(style)
        return () => {
          style.remove()
        }
      }, 'dsh-cloud-servers: panel styles')

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 25, label: '云服务器' }, ServerGlyph),
      )
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, ServersPanel))

      // 对话输入框里 @ 出服务器清单
      if (typeof ctx.inject === 'function') {
        ctx.inject(['inputTriggers'], (triggerCtx) => {
          const service =
            (typeof triggerCtx.get === 'function' ? triggerCtx.get('inputTriggers') : undefined) ?? triggerCtx.inputTriggers
          if (!service || typeof service.registerSource !== 'function') return
          triggerCtx.effect(() => service.registerSource(buildServerSource()), 'dsh-cloud-servers: @ source')
        })
      }

      // 消息里的服务器 chip
      ctx.slots.inject('conversation.user.text.node', () =>
        ctx.slots.register({ name: 'conversation.user.text.node', key: 'cloud-server', priority: 100 }, ServerChip),
      )
    }

    return {
      name: 'cloud-servers',
      inject: ['slots'],
      apply,
      __components: { ServersPanel, Detail, Editor, CopyButton, CopyRow, ServerChip },
      __internals: { buildServerSource, serverIndex },
    }
  },
})