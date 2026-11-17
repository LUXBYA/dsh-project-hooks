/**
 * @local/dsh-project-hooks — 浏览器一半：设置 → 项目钩子（配置面板 + 运行日志面板）。
 *
 * 数据全部走 Host 一半挂在 `ctx.webServer` 上的 `/dsh-project-hooks` 接口，
 * 因此不需要构建、不需要 typert codegen。所有可改项落在 `$DSH_HOME/project-hooks/state.json`，
 * 改完立即生效（Host 每次事件都重新读状态）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-project-hooks',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const BASE = '/dsh-project-hooks'

    /** 卡片/表格通用样式。 */
    const S = {
      wrap: { padding: '4px 2px 24px', color: 'inherit', fontSize: 13, minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' },
      tabBar: { display: 'flex', gap: 4, marginBottom: 14, borderBottom: '1px solid rgba(127,127,127,.28)' },
      tab: (active) => ({
        padding: '6px 14px',
        cursor: 'pointer',
        fontSize: 13,
        color: 'inherit',
        opacity: active ? 1 : 0.62,
        borderBottom: active ? '2px solid currentColor' : '2px solid transparent',
        background: 'transparent',
        border: 'none',
        borderBottomWidth: 2,
        borderBottomStyle: 'solid',
        borderBottomColor: active ? 'currentColor' : 'transparent',
      }),
      card: {
        border: '1px solid rgba(127,127,127,.28)',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 10,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      primary: { fontWeight: 600, fontSize: 13 },
      sub: { opacity: 0.62, fontSize: 12, wordBreak: 'break-all' },
      btn: {
        padding: '3px 10px',
        fontSize: 12,
        cursor: 'pointer',
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,.45)',
        background: 'transparent',
        color: 'inherit',
      },
      btnOn: {
        padding: '3px 10px',
        fontSize: 12,
        cursor: 'pointer',
        borderRadius: 6,
        border: '1px solid currentColor',
        background: 'transparent',
        color: 'inherit',
        fontWeight: 600,
      },
      input: {
        width: 92,
        padding: '2px 6px',
        fontSize: 12,
        borderRadius: 6,
        border: '1px solid rgba(127,127,127,.45)',
        background: 'transparent',
        color: 'inherit',
      },
      badge: (tone) => ({
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 11,
        border: '1px solid rgba(127,127,127,.45)',
        color: 'inherit',
        opacity: tone === 'muted' ? 0.66 : 1,
        fontWeight: tone === 'warn' ? 600 : 400,
      }),
      th: { textAlign: 'left', fontWeight: 600, padding: '4px 6px', fontSize: 12, opacity: 0.8, whiteSpace: 'nowrap' },
      td: { padding: '4px 6px', fontSize: 12, verticalAlign: 'top' },
      pre: {
        margin: '6px 0 0',
        padding: 8,
        fontSize: 11,
        lineHeight: 1.5,
        background: 'rgba(127,127,127,.10)',
        borderRadius: 6,
        whiteSpace: 'pre-wrap',
        // 长 JSON 里没有空格，只有 anywhere 才会在任意位置折行；同时也把元素的 min-content 压到 1 字符，
        // 免得把外层表格/面板顶宽、右侧内容被裁掉又看不到滚动条。
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        maxWidth: '100%',
        boxSizing: 'border-box',
        maxHeight: 220,
        overflowX: 'auto',
        overflowY: 'auto',
      },
    }

    /**
     * 调 Host 接口。
     * @param {string} suffix 路径后缀 @param {object} [body] POST 体
     * @returns {Promise<any>} JSON
     */
    async function api(suffix, body) {
      const response = await fetch(BASE + suffix, body === undefined
        ? { headers: { accept: 'application/json' } }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
      const text = await response.text()
      let parsed
      try {
        parsed = text ? JSON.parse(text) : {}
      } catch {
        parsed = { error: text.slice(0, 300) }
      }
      if (!response.ok) throw new Error(parsed?.error ?? `HTTP ${response.status}`)
      return parsed
    }

    /** 每行一个小开关。 */
    function Toggle({ on, onClick, children }) {
      return h('button', { type: 'button', style: on ? S.btnOn : S.btn, onClick, 'aria-pressed': on }, children)
    }

    /** 配置面板。 */
    function ConfigTab({ data, reload, busy, setBusy, note }) {
      const [drafts, setDrafts] = React.useState({})
      const draftOf = (key, fallback) => (drafts[key] === undefined ? fallback : drafts[key])
      const setDraft = (key, value) => setDrafts((drafts) => ({ ...drafts, [key]: value }))

      const run = async (fn) => {
        setBusy(true)
        try {
          await fn()
          await reload()
        } finally {
          setBusy(false)
        }
      }
      const save = (patch) => run(() => api('/api', { op: 'settings.update', patch }))

      const projects = data?.projects ?? []
      const settings = data?.settings ?? {}

      return h('div', null,
        h('div', { style: { ...S.card, padding: '10px 12px' } },
          h('div', { style: S.row },
            h(Toggle, { on: settings.enabled !== false, onClick: () => save({ enabled: settings.enabled === false }) }, settings.enabled === false ? '插件已停用' : '插件已启用'),
            h(Toggle, { on: settings.blockTools !== false, onClick: () => save({ blockTools: settings.blockTools === false }) }, settings.blockTools === false ? '提交门禁已关' : '提交门禁已开'),
            h(Toggle, { on: settings.captureOutput !== false, onClick: () => save({ captureOutput: settings.captureOutput === false }) }, settings.captureOutput === false ? '只记摘要' : '记录输出明细'),
            h(Toggle, { on: settings.logRequests !== false, onClick: () => save({ logRequests: settings.logRequests === false }) }, settings.logRequests === false ? '不记模型请求' : '记录模型请求'),
            h('span', { style: S.sub }, '改这里立即生效，不用重启'),
          ),
          h('div', { style: { ...S.row, marginTop: 8 } },
            h('span', { style: S.sub }, '注入上限'),
            h('input', {
              style: S.input,
              value: draftOf('set|contextLimit', settings.contextLimit ?? 2400),
              onChange: (event) => setDraft('set|contextLimit', event.target.value),
              onBlur: () => { const n = Number(draftOf('set|contextLimit', 0)); if (n > 0) save({ contextLimit: n }) },
            }),
            h('span', { style: S.sub }, '字 ·单段输出上限'),
            h('input', {
              style: S.input,
              value: draftOf('set|outputLimit', settings.outputLimit ?? 4000),
              onChange: (event) => setDraft('set|outputLimit', event.target.value),
              onBlur: () => { const n = Number(draftOf('set|outputLimit', 0)); if (n > 0) save({ outputLimit: n }) },
            }),
            h('span', { style: S.sub }, '字 ·日志条数上限'),
            h('input', {
              style: S.input,
              value: draftOf('set|runsKeep', settings.runsKeep ?? 2000),
              onChange: (event) => setDraft('set|runsKeep', event.target.value),
              onBlur: () => { const n = Number(draftOf('set|runsKeep', 0)); if (n > 0) save({ runsKeep: n }) },
            }),
            h('span', { style: S.sub }, '条 ·日志体积上限'),
            h('input', {
              style: S.input,
              value: draftOf('set|runsMaxBytes', Math.round((settings.runsMaxBytes ?? 5242880) / 1024 / 1024)),
              onChange: (event) => setDraft('set|runsMaxBytes', event.target.value),
              onBlur: () => { const n = Number(draftOf('set|runsMaxBytes', 0)); if (n > 0) save({ runsMaxBytes: Math.round(n * 1024 * 1024) }) },
            }),
            h('span', { style: S.sub }, 'MB'),
          ),
          h('div', { style: { ...S.sub, marginTop: 6 } },
            `当前日志占用 ${humanBytes(data?.runsStats?.bytes)} / 上限 ${humanBytes(settings.runsMaxBytes)}（${data?.runsStats?.count ?? 0} 条，到顶后最旧的先丢） · 数据目录 ${data?.plugin?.dir ?? '~/.dsh/project-hooks'}`),
        ),
        note ? h('div', { style: { ...S.sub, margin: '0 0 8px' } }, note) : null,
        h('div', { style: { ...S.card, padding: '8px 12px' } },
          h('div', { style: S.row },
            h('span', { style: S.primary }, '添加项目'),
            h('input', {
              style: { ...S.input, width: 380 },
              placeholder: 'D:\\code\\study-member',
              value: draftOf('add|dir', ''),
              onChange: (event) => setDraft('add|dir', event.target.value),
            }),
            h(Toggle, {
              on: true,
              onClick: () => run(() => api('/api', { op: 'add-project', dir: draftOf('add|dir', '') })),
            }, '添加'),
            h('span', { style: S.sub }, '目录里要有 .dsh/hooks.json'),
          ),
        ),
        projects.length === 0
          ? h('div', { style: { ...S.card, opacity: 0.75 } },
              '还没有发现任何项目钩子。在某个工作区里建 `.dsh/hooks.json`（或从旧插件沿用），然后在该工作区开始一个会话，它就会出现在这里。')
          : null,
        projects.map((project) => {
          const disabled = busy
          return h('div', { key: project.dir, style: S.card },
            h('div', { style: { ...S.row, justifyContent: 'space-between' } },
              h('div', { style: S.row },
                h(Toggle, {
                  on: project.enabled,
                  onClick: () => run(() => api('/api', { op: 'toggle-project', dir: project.dir, enabled: !project.enabled })),
                }, project.enabled ? '项目已启用' : '项目已停用'),
                h('span', { style: S.primary }, project.name),
                project.trusted
                  ? h('span', { style: S.badge() }, '已信任')
                  : h('span', { style: S.badge('warn') }, project.changed ? '配置已变更，需重新信任' : '未信任（不会执行）'),
              ),
              h('div', { style: S.row },
                h(Toggle, {
                  on: false,
                  onClick: () => run(() => api('/api', { op: 'reseed', dir: project.dir })),
                }, '重新读取 hooks.json'),
                project.trusted
                  ? h(Toggle, {
                      on: false,
                      onClick: () => run(() => api('/api', { op: 'revoke', dir: project.dir })),
                    }, '撤销信任')
                  : h(Toggle, {
                      on: true,
                      onClick: () => run(() => api('/api', { op: 'trust', dir: project.dir })),
                    }, '信任并启用'),
              ),
            ),
            h('div', { style: { ...S.sub, marginTop: 2 } }, project.dir),
            h('div', { style: { ...S.sub, marginTop: 2 } }, project.hooksHash ?? '（hooks.json 不存在）'),
            (project.hooks ?? []).map((hook) => {
              const key = `${project.dir}|${hook.id}`
              return h('div', { key, style: { ...S.row, marginTop: 8, justifyContent: 'space-between' } },
                h('div', { style: S.row },
                  h(Toggle, {
                    on: hook.enabled,
                    onClick: () => run(() => api('/api', { op: 'update-hook', dir: project.dir, hookId: hook.id, patch: { enabled: !hook.enabled } })),
                  }, hook.enabled ? '开' : '关'),
                  h('span', { style: S.primary }, hook.id),
                  h('span', { style: S.sub }, hook.event),
                  hook.exists ? null : h('span', { style: S.badge('warn') }, '脚本不存在'),
                ),
                h('div', { style: S.row },
                  h('span', { style: S.sub }, '超时'),
                  h('input', {
                    style: S.input,
                    value: draftOf(`${key}|timeout`, Math.round((hook.timeoutMs ?? 0) / 1000)),
                    onChange: (event) => setDraft(`${key}|timeout`, event.target.value),
                    onBlur: () => {
                      const seconds = Number(draftOf(`${key}|timeout`, 0))
                      if (seconds > 0) {
                        run(() => api('/api', { op: 'update-hook', dir: project.dir, hookId: hook.id, patch: { timeoutMs: Math.round(seconds * 1000) } }))
                      }
                    },
                  }),
                  h('span', { style: S.sub }, 's'),
                  hook.match
                    ? h('input', {
                        style: { ...S.input, width: 200 },
                        value: draftOf(`${key}|match`, hook.match),
                        onChange: (event) => setDraft(`${key}|match`, event.target.value),
                        onBlur: () => run(() => api('/api', { op: 'update-hook', dir: project.dir, hookId: hook.id, patch: { match: draftOf(`${key}|match`, '') } })),
                      })
                    : null,
                  h(Toggle, {
                    on: false,
                    onClick: () => run(async () => {
                      const outcome = await api('/api', { op: 'test', dir: project.dir, hookId: hook.id })
                      setDraft(`${key}|test`, `${outcome.outcome} · ${outcome.durationMs}ms\n${outcome.text || outcome.reason || outcome.stderr || '（无输出）'}`)
                    }),
                  }, '试跑'),
                ),
                h('div', { style: { ...S.sub, marginTop: 2 } }, hook.script),
                drafts[`${key}|test`] ? h('pre', { style: S.pre }, drafts[`${key}|test`]) : null,
              )
            }),
            disabled ? null : null,
          )
        }),
      )
    }

    /** 字节数转人类可读。 */
    function humanBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      return `${(value / 1024 / 1024).toFixed(2)} MB`
    }

    /**
     * UTC ISO 时间戳转浏览器本地时间（日志里存的是 UTC，显示成本地时间）。
     * @param {string} iso 时间戳 @returns {string} 本地时间文本
     */
    function localTime(iso) {
      const at = new Date(String(iso ?? ''))
      if (Number.isNaN(at.getTime())) return iso ? String(iso) : '—'
      const pad = (value) => String(value).padStart(2, '0')
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${
        pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    }

    /**
     * 浏览器本地时区标签，例如 `UTC+08:00`。
     * @returns {string} 时区标签
     */
    function tzOffsetLabel() {
      const minutes = -new Date().getTimezoneOffset()
      const sign = minutes >= 0 ? '+' : '-'
      const absolute = Math.abs(minutes)
      return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
    }

    /** 弹层底色缓存：必须不透明，否则会透出下面的文字。 */
    let popupSurfaceCache

    /**
     * 取页面自身的不透明底色（主题给的可能带透明度）。
     * @returns {string} CSS 颜色
     */
    function popupSurface() {
      if (popupSurfaceCache) return popupSurfaceCache
      const opaque = (color) => Boolean(color) && color !== 'transparent' && !/rgba\([^)]*,\s*0?\.\d+\s*\)$/.test(color)
      for (const node of [document.body, document.documentElement]) {
        if (!node) continue
        const color = getComputedStyle(node).backgroundColor
        if (opaque(color)) {
          popupSurfaceCache = color
          return color
        }
      }
      popupSurfaceCache = 'rgb(30,30,34)'
      return popupSurfaceCache
    }

    /**
     * 轻量下拉：不用原生 select（原生弹层在深色主题下文字几乎看不见），
     * 选项在文档流里展开，不会被容器裁切。
     * @param {{value: string, options: {value: string, label: string}[], onChange: (v: string) => void, width?: number}} props 参数
     * @returns {any} 组件
     */
    function Dropdown({ value, options, onChange, width }) {
      const [open, setOpen] = React.useState(false)
      const current = options.find((option) => option.value === value)
      return h('div', { style: { position: 'relative', display: 'inline-flex', flexDirection: 'column', alignSelf: 'flex-start', width: width ?? 180, verticalAlign: 'top' } },
        h('button', {
          type: 'button',
          style: { ...S.input, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, textAlign: 'left', cursor: 'pointer' },
          title: current?.label ?? '',
          onClick: () => setOpen((open) => !open),
        },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, current?.label ?? '（全部）'),
          h('span', { style: { opacity: 0.6, fontSize: 10 } }, open ? '▲' : '▼'),
        ),
        open
          ? h('div', {
              style: {
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                width: '100%',
                boxSizing: 'border-box',
                zIndex: 60,
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                maxHeight: 260,
                overflowY: 'auto',
                borderRadius: 8,
                // 页面底色 + 一层灰蒙版，深浅主题下都能看出“浮起来”的边界。
                backgroundColor: popupSurface(),
                backgroundImage: 'linear-gradient(rgba(127,127,127,.14), rgba(127,127,127,.14))',
                border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.4))',
                boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.45))',
              },
            },
              options.map((option) => h('button', {
                type: 'button',
                key: option.value || '(all)',
                style: {
                  width: '100%',
                  padding: '5px 8px',
                  borderRadius: 6,
                  border: 'none',
                  textAlign: 'left',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  color: 'inherit',
                  background: option.value === value ? 'rgba(127,127,127,.28)' : 'transparent',
                  fontWeight: option.value === value ? 600 : 400,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
                title: option.label,
                onClick: () => {
                  onChange(option.value)
                  setOpen(false)
                },
              }, option.label)),
            )
          : null,
      )
    }

    /** 详情里的一个小节。 */
    function Detail({ title, text, copy }) {
      if (!text) return null
      return h('div', { style: { marginTop: 8 } },
        h('div', { style: { ...S.sub, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, title),
          copy
            ? h(Toggle, {
                on: false,
                onClick: () => {
                  try {
                    navigator.clipboard?.writeText(String(text))
                  } catch {
                    /* 剪贴板不可用就不提示 */
                  }
                },
              }, '复制')
            : null,
        ),
        h('pre', { style: S.pre }, text),
      )
    }

    /** 日志面板（设置页 tab 与侧栏整页共用）。 */
    function LogTab({ data, reload, busy, setBusy }) {
      const [project, setProject] = React.useState('')
      const [outcome, setOutcome] = React.useState('')
      const [open, setOpen] = React.useState(null)
      const [drafts, setDrafts] = React.useState({})
      const settings = data?.settings ?? {}
      const stats = data?.runsStats ?? { count: 0, bytes: 0 }
      const draftOf = (key, fallback) => (drafts[key] === undefined ? fallback : drafts[key])
      const setDraft = (key, value) => setDrafts((current) => ({ ...current, [key]: value }))
      const save = async (patch) => {
        setBusy(true)
        try {
          await api('/api', { op: 'settings.update', patch })
          await reload()
        } finally {
          setBusy(false)
        }
      }

      const runs = (data?.runs ?? []).filter((entry) => (!project || entry.project === project) && (!outcome || String(entry.outcome) === outcome))
      const projects = [...new Set((data?.runs ?? []).map((entry) => entry.project).filter(Boolean))]
      const outcomes = [...new Set((data?.runs ?? []).map((entry) => String(entry.outcome)).filter(Boolean))]
      const tone = (value) => (/^(ok|injected)$/.test(String(value)) ? 'ok' : /untru?sted|disabled|skipped|^request$/.test(String(value)) ? 'muted' : 'warn')
      const percent = Math.min(100, Math.round((Number(stats.bytes) || 0) / Math.max(1, Number(settings.runsMaxBytes) || 1) * 100))

      return h('div', null,
        h('div', { style: { ...S.row, marginBottom: 6 } },
          h('span', { style: S.primary }, `最近运行 ${runs.length} 条`),
          h(Toggle, { on: false, onClick: () => reload() }, '刷新'),
          h(Toggle, {
            on: false,
            onClick: async () => {
              setBusy(true)
              try {
                await api('/api', { op: 'clear-runs' })
                await reload()
              } finally {
                setBusy(false)
              }
            },
          }, '清空'),
        ),
        h('div', { style: { ...S.row, alignItems: 'flex-start', marginBottom: 6 } },
          h(Dropdown, {
            value: project,
            width: 240,
            options: [{ value: '', label: '全部项目' }, ...projects.map((dir) => ({ value: dir, label: dir }))],
            onChange: setProject,
          }),
          h(Dropdown, {
            value: outcome,
            width: 140,
            options: [{ value: '', label: '全部结果' }, ...outcomes.map((value) => ({ value, label: value }))],
            onChange: setOutcome,
          }),
        ),
        h('div', { style: { ...S.row, marginBottom: 8 } },
          h('span', { style: S.sub }, `占用 ${humanBytes(stats.bytes)} / ${humanBytes(settings.runsMaxBytes)}（${percent}%，${stats.count} 条）`),
          h('span', { style: S.sub }, '· 体积上限'),
          h('input', {
            style: S.input,
            value: draftOf('runsMaxBytes', Math.round((settings.runsMaxBytes ?? 5242880) / 1024 / 1024)),
            onChange: (event) => setDraft('runsMaxBytes', event.target.value),
            onBlur: () => {
              const mb = Number(draftOf('runsMaxBytes', 0))
              if (mb > 0) save({ runsMaxBytes: Math.round(mb * 1024 * 1024) })
            },
          }),
          h('span', { style: S.sub }, 'MB · 条数上限'),
          h('input', {
            style: S.input,
            value: draftOf('runsKeep', settings.runsKeep ?? 2000),
            onChange: (event) => setDraft('runsKeep', event.target.value),
            onBlur: () => {
              const n = Number(draftOf('runsKeep', 0))
              if (n > 0) save({ runsKeep: n })
            },
          }),
          h('span', { style: S.sub }, '条 · 单段输出'),
          h('input', {
            style: S.input,
            value: draftOf('outputLimit', settings.outputLimit ?? 4000),
            onChange: (event) => setDraft('outputLimit', event.target.value),
            onBlur: () => {
              const n = Number(draftOf('outputLimit', 0))
              if (n > 0) save({ outputLimit: n })
            },
          }),
          h('span', { style: S.sub }, '字'),
          h(Toggle, {
            on: settings.captureOutput !== false,
            onClick: () => save({ captureOutput: settings.captureOutput === false }),
          }, settings.captureOutput === false ? '只记摘要' : '记录明细'),
          h(Toggle, {
            on: settings.logRequests !== false,
            onClick: () => save({ logRequests: settings.logRequests === false }),
          }, settings.logRequests === false ? '不记模型请求' : '记录模型请求'),
        ),
        runs.length === 0
          ? h('div', { style: { ...S.card, opacity: 0.75 } }, '还没有运行记录。')
          : h('table', { style: { width: '100%', maxWidth: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' } },
              h('thead', null, h('tr', null,
                [
                  [`时间（${tzOffsetLabel()}）`, 178], ['项目', 128], ['钩子', 100], ['结果', 112], ['耗时', 70], ['输出', 74], ['细节', 96],
                ].map(([title, width]) => h('th', { key: title, style: { ...S.th, width } }, title)),
              )),
              h('tbody', null, runs.map((entry, index) => {
                const key = `${entry.ts ?? index}|${index}`
                const isOpen = open === key
                return h(React.Fragment, { key },
                  h('tr', {
                    style: { cursor: 'pointer', borderTop: '1px solid rgba(127,127,127,.16)' },
                    onClick: () => setOpen(isOpen ? null : key),
                  },
                    h('td', { style: S.td, title: entry.ts ? `${String(entry.ts)}（${tzOffsetLabel()} 本地：${localTime(entry.ts)}）` : undefined }, entry.ts ? localTime(entry.ts) : '—'),
                    h('td', { style: S.td }, entry.project ? String(entry.project).split(/[\\/]/).pop() : '—'),
                    h('td', { style: S.td }, entry.hookId ?? '—'),
                    h('td', { style: S.td }, h('span', { style: S.badge(tone(entry.outcome)) }, String(entry.outcome ?? '—'))),
                    h('td', { style: S.td }, entry.durationMs == null ? '—' : `${entry.durationMs}ms`),
                    h('td', { style: S.td }, entry.requestChars != null ? `${entry.messageCount ?? 0} 条` : `${entry.stdoutChars ?? 0}/${entry.stderrChars ?? 0}`),
                    h('td', { style: S.td },
                      [
                        entry.requestChars != null ? `请求 ${entry.requestChars} 字` : null,
                        entry.decision ? `decision=${entry.decision}` : null,
                        entry.contextChars ? `注入 ${entry.contextChars} 字` : null,
                        entry.command ? `命令 ${String(entry.command).slice(0, 24)}…` : null,
                      ].filter(Boolean).join(' · ') || (isOpen ? '收起' : '展开'),
                    ),
                  ),
                  isOpen
                    ? h('tr', null, h('td', { colSpan: 7, style: { ...S.td, paddingBottom: 10 } },
                        h('div', { style: { minWidth: 0, maxWidth: '100%', boxSizing: 'border-box' } },
                        h('div', { style: { ...S.sub, marginBottom: 2 } },
                          [
                            entry.ts ? `时间 ${localTime(entry.ts)} ${tzOffsetLabel()}（原始 ${String(entry.ts)}）` : null,
                            entry.sessionId ? `会话 ${String(entry.sessionId).slice(0, 18)}` : null,
                            entry.toolName ? `工具 ${entry.toolName}` : null,
                            entry.source ? `来源 ${entry.source}` : null,
                            entry.trigger
                              ? `触发 ${({ turn: '每轮第一步', created: '会话开始', 'panel-test': '面板试跑' })[entry.trigger] ?? entry.trigger}`
                              : null,
                            entry.turn == null ? null : `轮 ${entry.turn}${entry.step == null ? '' : ` · 步 ${entry.step}`}`,
                            entry.exitCode == null ? null : `退出码 ${entry.exitCode}`,
                            entry.timedOut ? '超时被杀' : null,
                          ].filter(Boolean).join(' · ')),
                        h(Detail, { title: '执行的命令', text: entry.command }),
                        h(Detail, { title: `判定 ${entry.decision || '（无）'}${entry.reason ? ` — ${entry.reason}` : ''}`, text: null }),
                        entry.reason ? h(Detail, { title: '阻断/说明理由', text: entry.reason }) : null,
                        entry.request
                          ? h(Detail, {
                              title: `发给模型的 messages（${entry.messageCount ?? 0} 条 · ${entry.requestChars ?? 0} 字${entry.injectedCount ? ` · 其中注入 ${entry.injectedCount} 条` : ''}）`,
                              text: entry.request,
                              copy: true,
                            })
                          : null,
                        entry.request && entry.requestChars > String(entry.request).length
                          ? h('div', { style: { ...S.sub, marginTop: 4 } }, `（快照按单段 ${settings.outputLimit ?? 4000} 字上限截断；完整上下文看「轨迹 → 上下文」）`)
                          : null,
                        h(Detail, { title: `注入正文（${entry.contextChars ?? 0} 字）`, text: entry.contextText, copy: true }),
                        h(Detail, { title: `脚本 stdout（${entry.stdoutChars ?? 0} 字）`, text: entry.stdout }),
                        h(Detail, { title: `脚本 stderr（${entry.stderrChars ?? 0} 字）`, text: entry.stderr }),
                        h(Detail, { title: '解析出的钩子 JSON', text: entry.hookJson }),
                        h(Detail, { title: '原始记录（JSON）', text: JSON.stringify(entry, null, 2) }),
                        )))
                    : null,
                )
              })),
            ),
        busy ? h('div', { style: S.sub }, '处理中…') : null,
      )
    }

    /** 设置页整页。 */
    function Panel() {
      const [tab, setTab] = React.useState('config')
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const reload = React.useCallback(async () => {
        try {
          const next = await api('/bootstrap')
          setData(next)
          setError(null)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [])

      React.useEffect(() => {
        if (typeof fetch !== 'function' || location.protocol === 'file:') {
          setError('当前页面不是 Web GUI（fetch 不可用）。请用浏览器打开 DSH 的 Web 地址使用本面板。')
          return undefined
        }
        reload()
        const timer = setInterval(reload, 5000)
        return () => clearInterval(timer)
      }, [reload])

      if (error) {
        return h('div', { style: S.wrap },
          h('div', { style: S.card }, h('div', { style: S.primary }, '项目钩子面板不可用'), h('div', { style: { ...S.sub, marginTop: 6 } }, error)),
        )
      }
      if (!data) return h('div', { style: S.wrap }, h('div', { style: S.sub }, '读取中…'))

      return h('div', { style: S.wrap },
        h('div', { style: S.tabBar },
          h('button', { type: 'button', style: S.tab(tab === 'config'), onClick: () => setTab('config') }, '配置'),
          h('button', { type: 'button', style: S.tab(tab === 'log'), onClick: () => setTab('log') }, `运行日志${data?.runs?.length ? `（${data.runs.length}）` : ''}`),
        ),
        tab === 'config'
          ? h(ConfigTab, { data, reload, busy, setBusy })
          : h(LogTab, { data, reload, busy, setBusy }),
      )
    }

    /** 侧栏面板 id：侧栏图标与主面板共用同一个 id。 */
    const PANEL_ID = 'project-hooks'

    /**
     * 侧栏图标：钩子形状（上钩 + 下钩 + 连线）。
     * @param {{size?: number, active?: boolean}} props 侧栏给的图标份额
     * @returns {any} svg
     */
    function HooksPanelIcon({ size }) {
      const edge = size ?? 20
      return h('svg', {
        width: edge,
        height: edge,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M7 5v4a3 3 0 0 0 3 3h4a3 3 0 0 1 3 3v4' }),
        h('circle', { cx: 7, cy: 5, r: 1.9 }),
        h('circle', { cx: 17, cy: 19, r: 1.9 }),
      )
    }

    /** 侧栏主面板：整页就是运行日志（配置仍在设置里）。 */
    function LogPage() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      const reload = React.useCallback(async () => {
        try {
          setData(await api('/bootstrap'))
          setError(null)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [])

      React.useEffect(() => {
        if (typeof fetch !== 'function' || location.protocol === 'file:') {
          setError('当前页面不是 Web GUI（fetch 不可用）。请用浏览器打开 DSH 的 Web 地址使用本面板。')
          return undefined
        }
        reload()
        const timer = setInterval(reload, 5000)
        return () => clearInterval(timer)
      }, [reload])

      if (error) {
        return h('div', { style: { padding: '20px 24px' } },
          h('div', { style: S.card }, h('div', { style: S.primary }, '项目钩子面板不可用'), h('div', { style: { ...S.sub, marginTop: 6 } }, error)),
        )
      }
      if (!data) return h('div', { style: { padding: '20px 24px', ...S.sub } }, '读取中…')

      return h('div', { style: { padding: '18px 24px 28px' } },
        h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 2 } }, '项目钩子 · 运行日志'),
        h('div', { style: { ...S.sub, marginBottom: 12 } }, '每个项目自己的钩子派发记录；配置在 设置 → 项目钩子。'),
        h(LogTab, { data, reload, busy, setBusy }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 设置页：配置 + 日志 两个 tab。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'project-hooks',
          order: 75,
          label: () => '项目钩子',
        }, Panel))
        // 侧栏：一个图标 + 它打开的运行日志主面板。
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, LogPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 60,
          label: () => '项目钩子',
        }, HooksPanelIcon))
      },
    }
  },
})
