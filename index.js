/**
 * @local/dsh-project-hooks — 每个工作区各自的项目钩子（Host 一半）。
 *
 * 设计要点：
 * - 按「会话 cwd」向上找 `<root>/.dsh/hooks.json` 定位项目，天然一项目一套钩子。
 * - 信任模型：hooks.json 的 sha256 指纹被显式信任过才执行；文件一变指纹失效。
 * - 会话开始用 `agent/created`（serial，每会话一次，source 含 compact），
 *   不需要任何时间闸门；压缩恢复天然覆盖。
 * - 提交门禁用 `tools/pre-execute` waterfall，命中 git commit 才 spawn 脚本。
 * - 配置与运行日志都在 `$DSH_HOME/project-hooks/` 下，改完即生效，不重启。
 * - 与面板通信走 `ctx.webServer` 的 HTTP 路由（Client 一半 fetch 它）。
 *
 * 配置（cordis.patch.yml 的 config）：见 DEFAULTS。
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'project-hooks'

/** HTTP 面板接口前缀。 */
const API = '/dsh-project-hooks'
const STATE_VERSION = 2
const HOOKS_FILE = path.join('.dsh', 'hooks.json')

/** 可调默认值；全部可被 cordis.patch.yml 覆盖。 */
const DEFAULTS = {
  enabled: true,
  defaultTimeoutMs: 600000,
  contextLimit: 2400,
  blockTools: true,
  nodeExecutable: '',
  maxWalkUp: 12,
  commitPattern: '(?:^|[\\s;&|(])git(?:\\.exe)?\\s+commit\\b(?=\\s+-|\\s*$|\\s*&&|\\s*;|\\s*\\|\\|)',
  // ---- 运行日志 ----
  /** 是否把脚本输出（stdout/stderr/注入正文）写进日志；关掉只留调用摘要。 */
  captureOutput: true,
  /** 是否把每一步实际发给模型的 messages 快照写进日志（只记已识别项目的会话）。 */
  logRequests: true,
  /** 快照里每条消息最多保留多少字。 */
  requestItemLimit: 600,
  /** 每段输出最多保留多少字。 */
  outputLimit: 4000,
  /** 条数上限。 */
  runsKeep: 2000,
  /** 体积上限（字节）。到顶就按最旧优先丢弃。 */
  runsMaxBytes: 5 * 1024 * 1024,
}

/** 约定：一个项目支持两个钩子位，脚本路径可在 state.json 里改。 */
const HOOK_SLOTS = [
  {
    id: 'session-start',
    event: 'agent/created',
    script: path.join('.dsh', 'hooks', 'session-start.mjs'),
    timeoutMs: 600000,
  },
  {
    id: 'pre-commit',
    event: 'tools/pre-execute',
    script: path.join('.dsh', 'hooks', 'pre-commit.mjs'),
    timeoutMs: 600000,
    match: 'win_bash|bash|pwsh|powershell|shell|terminal',
  },
]

/** @type {Promise<any> | undefined} */
let llmModule

/**
 * 懒加载 dsh-llm（拿规范的 createUserMessage）。拿不到就退回等价的结构体。
 * @returns {Promise<any>} 模块或 undefined
 */
function loadLlm() {
  llmModule ??= import('@deepseek-ai/dsh-llm').catch(() => undefined)
  return llmModule
}

/**
 * 构造一条注入用的上下文消息。
 *
 * `source.kind` 刻意不用 `user`：DSH 客户端把非 user 来源的消息渲染成
 * 可折叠的“上下文注入”一行（与 AGENTS.md、技能注入同样式），
 * 而不是一条占满屏的用户气泡；模型看到的正文完全一致。
 * @param {string} text 注入正文
 * @param {{summary?: string}} [meta] 折叠行上的一句话摘要
 * @returns {Promise<object>} UserMessage
 */
async function buildUserMessage(text, meta) {
  const source = {
    kind: 'project-hooks',
    form: 'notice',
    summary: meta?.summary ?? `项目钩子注入 ${text.length} 字`,
  }
  const mod = await loadLlm()
  if (typeof mod?.createUserMessage === 'function') {
    return mod.createUserMessage({ content: [{ type: 'text', text }], source })
  }
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source }
}

/** @returns {string} DSH 主目录 */
function dshHome() {
  return process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
}

/** @returns {string} 插件私有数据目录 */
function dataDir() {
  return path.join(dshHome(), 'project-hooks')
}

const statePath = () => path.join(dataDir(), 'state.json')
const runsPath = () => path.join(dataDir(), 'runs.jsonl')

/** @returns {object} 空状态 */
function emptyState() {
  return { version: STATE_VERSION, projects: {}, seen: {}, defaults: { ...DEFAULTS }, updatedAt: null }
}

/** @returns {object} 读状态（坏文件不抛） */
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
    // 只认面板真正写过的覆盖项。version < 2 的 state.json 存过整份默认值（不是用户意图），
    // 一律丢弃；同版本内也剔掉与默认值相同的项。
    const accepted = Number(parsed?.version ?? 1) >= 2
    const overrides = accepted
      ? Object.fromEntries(
          Object.entries(parsed?.defaults ?? {}).filter(([key, value]) => DEFAULTS[key] !== value),
        )
      : {}
    return {
      ...emptyState(),
      ...parsed,
      projects: parsed?.projects ?? {},
      seen: parsed?.seen ?? {},
      /** 面板写过、覆盖 patch config 的字段（只存显式覆盖项）。 */
      overrides,
      /** 生效值：默认值 + patch config 由插件另算，这里只给默认值 + 覆盖项。 */
      defaults: { ...DEFAULTS, ...overrides },
    }
  } catch {
    return { ...emptyState(), overrides: {} }
  }
}

/** @param {object} state 状态 @returns {void} */
function writeState(state) {
  fs.mkdirSync(dataDir(), { recursive: true })
  const payload = {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    defaults: state.overrides ?? {},
    projects: state.projects ?? {},
    seen: state.seen ?? {},
  }
  const tmp = `${statePath()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, statePath())
}

/** @param {string} file 文件 @returns {string | undefined} 内容 sha256 */
function sha256File(file) {
  try {
    return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
  } catch {
    return undefined
  }
}

/**
 * 由 cwd 向上找项目根（含 .dsh/hooks.json）。
 * @param {string} cwd 起点 @param {number} maxWalkUp 最多上溯层数
 * @returns {string | undefined} 项目根
 */
function findProjectRoot(cwd, maxWalkUp) {
  if (!cwd) return undefined
  let dir = path.resolve(cwd)
  for (let i = 0; i <= maxWalkUp; i += 1) {
    if (fs.existsSync(path.join(dir, HOOKS_FILE))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** 插件真正会派发的事件白名单；hooks.json 里写了别的名字时退回 agent/created。 */
const SUPPORTED_EVENTS = new Set(['agent/pre-step', 'agent/created', 'tools/pre-execute'])

/**
 * 读项目 hooks.json，按钩子位抽出脚本、事件名、超时、matcher 与 firstStepOnly。
 * 事件名以这里为唯一事实来源，不落盘、不猜测：配 agent/pre-step 就每轮第一步跑，配 agent/created 就每会话跑一次。
 * @param {string} root 项目根
 * @returns {Record<string, {event: string, script: string, timeoutMs: number, match: string | null, firstStepOnly: boolean}>} 钩子规格
 */
function readHooksSpec(root) {
  const spec = {}
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, HOOKS_FILE), 'utf8'))
  } catch {
    return spec
  }
  for (const [eventName, list] of Object.entries(raw?.hooks ?? {})) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const command = String(entry?.commandWindows ?? entry?.command ?? '')
      const match = command.match(/([A-Za-z]:[\\/][^"'`]*?\.mjs|[^"'`\s]+\.mjs)/)
      if (!match) continue
      const absolute = match[1].replace(/\//g, '\\')
      const insideRoot = absolute.toLowerCase().startsWith(root.toLowerCase())
      const script = insideRoot ? path.relative(root, absolute) : absolute
      const lower = script.toLowerCase()
      const id = lower.includes('pre-commit') ? 'pre-commit' : lower.includes('session-start') ? 'session-start' : path.basename(script, '.mjs')
      spec[id] = {
        event: SUPPORTED_EVENTS.has(eventName) ? eventName : 'agent/created',
        script,
        timeoutMs: Number(entry?.timeout) > 0 ? Math.round(Number(entry.timeout) * 1000) : 600000,
        match: typeof entry?.matcher === 'string' ? entry.matcher : null,
        firstStepOnly: entry?.firstStepOnly !== false,
      }
    }
  }
  return spec
}

/**
 * 某个项目某个钩子位在 hooks.json 里声明的事件名。
 * @param {string} root 项目根 @param {string} hookId 钩子位
 * @returns {string | undefined} 事件名
 */
function hookEventOf(root, hookId) {
  return readHooksSpec(root)[hookId]?.event
}

/**
 * 从 hooks.json 生成该项目的钩子表（面板展示与首次落 state 用）。
 * @param {string} root 项目根
 * @returns {Record<string, object>} 钩子表
 */
function seedHooks(root) {
  const hooks = {}
  for (const slot of HOOK_SLOTS) {
    hooks[slot.id] = {
      enabled: true,
      script: slot.script,
      event: slot.event,
      timeoutMs: slot.timeoutMs,
      ...(slot.match ? { match: slot.match } : {}),
    }
  }
  for (const [id, found] of Object.entries(readHooksSpec(root))) {
    hooks[id] = {
      enabled: hooks[id]?.enabled ?? true,
      script: found.script,
      event: found.event,
      timeoutMs: found.timeoutMs,
      ...(found.match ? { match: found.match } : {}),
      ...(found.event === 'agent/pre-step' ? { firstStepOnly: found.firstStepOnly } : {}),
    }
  }
  return hooks
}

/**
 * 求脚本的绝对路径。
 * @param {string} root 项目根 @param {string} script 配置里的脚本
 * @returns {string} 绝对路径
 */
function resolveScript(root, script) {
  return path.isAbsolute(script) ? script : path.join(root, script)
}

/** @returns {string} 用来跑 .mjs 的 node 可执行文件 */
function nodeCommand(settings) {
  const configured = String(settings.nodeExecutable ?? '').trim()
  if (configured) return configured
  const fromEnv = String(process.env.DSH_NODE_EXECUTABLE ?? '').trim()
  if (fromEnv) return fromEnv
  return process.execPath
}

/**
 * 跑一个钩子脚本：stdin 传 payload，收集 stdout/stderr，超时杀掉。
 * @param {{scriptPath: string, cwd: string, payload: object, timeoutMs: number, settings: object}} input 入参
 * @returns {Promise<object>} { code, timedOut, stdout, stderr, durationMs }
 */
function runScript({ scriptPath, cwd, payload, timeoutMs, settings }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timer
    const finish = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ durationMs: Date.now() - startedAt, timedOut, stdout, stderr, ...extra })
    }
    let child
    try {
      child = spawn(nodeCommand(settings), [scriptPath], {
        cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    } catch (error) {
      resolve({ durationMs: 0, timedOut: false, stdout: '', stderr: String(error?.message ?? error), error: String(error?.message ?? error) })
      return
    }
    timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经被回收 */
      }
    }, Math.max(1000, Number(timeoutMs) || 600000))
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ error: String(error?.message ?? error) }))
    child.on('close', (code) => finish({ code }))
    child.stdin.on('error', () => {})
    try {
      child.stdin.end(JSON.stringify(payload ?? {}))
    } catch {
      /* stdin 已关闭 */
    }
  })
}

/**
 * 去掉 heredoc 正文：写在文档或脚本里的「git commit」字样不是真的提交。
 * @param {string} command 原始命令 @returns {string} 供匹配与钩子使用的命令
 */
function stripHeredocBodies(command) {
  const text = String(command ?? '')
  if (!text.includes('<<')) return text
  return text.replace(/<<-?\s*['"`]?([A-Za-z_][A-Za-z0-9_]*)['"`]?[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*(?=\n|$)/g, '<<HEREDOC>>\n')
}

/**
 * 取 stdout 上最后一行 JSON。
 * @param {string} stdout 输出 @returns {object | undefined} 解析结果
 */
function parseHookJson(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue
    try {
      return JSON.parse(lines[i])
    } catch {
      /* 继续往前找 */
    }
  }
  return undefined
}

/** @param {string} text 文本 @param {number} limit 上限 @returns {string} 截断结果 */
function truncate(text, limit) {
  const value = String(text ?? '')
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value
  return `${value.slice(0, limit)}\n…（已截断，原文 ${value.length} 字）`
}

/**
 * 渲染一条消息里的单个内容块。
 * @param {any} block 内容块 @param {number} perLimit 最多保留多少字
 * @returns {string} 文本
 */
function renderBlock(block, perLimit) {
  if (block == null) return ''
  if (typeof block === 'string') return truncate(block, perLimit)
  const type = String(block.type ?? '')
  if (type === 'text' || typeof block.text === 'string') return truncate(String(block.text ?? ''), perLimit)
  if (/image/i.test(type)) return `[${type}]`
  if (/tool[-_]?(call|use)/i.test(type)) {
    const name = String(block.name ?? block.toolName ?? block.tool ?? 'tool')
    return `→ ${name}(${truncate(JSON.stringify(block.arguments ?? block.input ?? {}), perLimit)})`
  }
  if (/tool[-_]?(result|output)/i.test(type)) {
    const body = block.content ?? block.result ?? block.output ?? block
    return `← ${truncate(typeof body === 'string' ? body : JSON.stringify(body), perLimit)}`
  }
  try {
    return truncate(JSON.stringify(block), perLimit)
  } catch {
    return `[${type || 'block'}]`
  }
}

/**
 * 把一条消息压成可读文本，用于「发给模型的 messages」快照。
 * @param {any} message 消息 @param {number} perLimit 单块最多保留多少字
 * @returns {string} 形如 `[user] …`
 */
function renderMessage(message, perLimit) {
  const role = String(message?.role ?? message?.type ?? 'unknown')
  const content = message?.content
  const blocks = []
  if (typeof content === 'string') blocks.push(content)
  else if (Array.isArray(content)) {
    for (const block of content) blocks.push(renderBlock(block, perLimit))
  } else if (content && typeof content === 'object') blocks.push(renderBlock(content, perLimit))
  else if (typeof message?.text === 'string') blocks.push(String(message.text))
  const body = blocks.filter(Boolean).join('\n').trim()
  return `[${role}] ${body || '（空）'}`
}

/** 内存里记住的日志行数，避免每次追写都重读文件。 */
let runsLines
/**
 * 当前日志文件的行数（首次调用读一次，之后靠追加自增）。
 * @returns {number} 行数
 */
function runsLineCount() {
  if (runsLines === undefined) {
    try {
      runsLines = fs.readFileSync(runsPath(), 'utf8').split(/\r?\n/).filter(Boolean).length
    } catch {
      runsLines = 0
    }
  }
  return runsLines
}

/**
 * 日志文件占用：条数与字节。
 * @returns {{count: number, bytes: number}} 占用情况
 */
function runsStats() {
  let bytes = 0
  try {
    bytes = fs.statSync(runsPath()).size
  } catch {
    bytes = 0
  }
  return { count: runsLineCount(), bytes }
}

/**
 * 按条数 + 体积双上限裁剪：先丢最旧，直到两个上限都满足。
 * @param {{keep?: number, maxBytes?: number}} limits 上限
 * @returns {void}
 */
function pruneRuns(limits) {
  const keep = Math.max(5, Number(limits?.keep) || 2000)
  const maxBytes = Math.max(64 * 1024, Number(limits?.maxBytes) || 5 * 1024 * 1024)
  const file = runsPath()
  let size
  try {
    size = fs.statSync(file).size
  } catch {
    runsLines = 0
    return
  }
  if (size <= maxBytes && runsLineCount() <= keep) return
  let lines
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  } catch {
    return
  }
  const kept = lines.slice(-keep)
  let bytes = kept.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0)
  while (kept.length > 1 && bytes > maxBytes) {
    bytes -= Buffer.byteLength(kept.shift(), 'utf8') + 1
  }
  try {
    fs.writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
    runsLines = kept.length
  } catch {
    /* 写不进去就下次再说 */
  }
}

/**
 * 追加一条运行记录，然后按上限裁剪。
 * @param {object} entry 记录 @param {{keep?: number, maxBytes?: number}} limits 上限
 * @returns {void}
 */
function appendRun(entry, limits) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true })
    fs.appendFileSync(runsPath(), `${JSON.stringify(entry)}\n`, 'utf8')
    runsLines = (runsLines ?? 0) + 1
    pruneRuns(limits)
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/**
 * 读最近若干条运行记录。
 * @param {number} limit 条数 @returns {object[]} 记录（新在前）
 */
function readRuns(limit) {
  try {
    const lines = fs.readFileSync(runsPath(), 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-Math.max(1, limit)).reverse().map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { ts: null, outcome: 'unparsed', raw: line.slice(0, 200) }
      }
    })
  } catch {
    return []
  }
}

/**
 * 取 agent 的会话工作目录。
 * @param {any} ctx 上下文 @param {any} agent agent
 * @returns {Promise<string | undefined>} cwd
 */
async function resolveAgentCwd(ctx, agent) {
  const direct = agent?.session?.cwd
  if (typeof direct === 'string' && direct.trim()) return direct
  const workingDirectory = ctx.get?.('workingDirectory')
  if (workingDirectory?.ensure && agent) {
    try {
      return await workingDirectory.ensure(agent, undefined)
    } catch {
      return undefined
    }
  }
  return process.cwd()
}

/**
 * 面板用的项目视图。
 * @param {object} state 状态 @param {string} dir 项目根 @returns {object} 视图
 */
function projectView(state, dir) {
  const entry = state.projects[dir] ?? {}
  const hooksFile = path.join(dir, HOOKS_FILE)
  const present = fs.existsSync(hooksFile)
  const hash = present ? sha256File(hooksFile) : undefined
  const trustedHash = entry.trustedHash
  const hooks = entry.hooks ?? seedHooks(dir)
  return {
    dir,
    name: path.basename(dir),
    present,
    enabled: entry.enabled !== false,
    trusted: Boolean(trustedHash) && trustedHash === hash,
    changed: Boolean(trustedHash) && trustedHash !== hash,
    hooksHash: hash ?? null,
    hooks: Object.entries(hooks).map(([id, hook]) => ({
      id,
      // 事件名以 hooks.json 为准；面板显示的就是实际派发用的事件。
      event: hookEventOf(dir, id) ?? hook.event,
      script: hook.script,
      enabled: hook.enabled !== false,
      timeoutMs: hook.timeoutMs ?? 600000,
      match: hook.match ?? null,
      exists: fs.existsSync(resolveScript(dir, hook.script)),
    })),
  }
}

/** @param {any} res 响应 @param {number} status 状态码 @param {any} body 内容 @returns {void} */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** @param {any} req 请求 @returns {Promise<any>} JSON body */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 512 * 1024) raw = raw.slice(0, 512 * 1024)
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * 插件入口。
 * @param {any} ctx Cordis 上下文 @param {object} config patch 里的 config
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  /** @type {Map<string, object>} 注入失败时留给 pre-step 兜底 */
  const pending = new Map()
  /** sessionId → 本插件注入过的消息指纹（用于在请求快照里标出「这条是注入的」）。 */
  const injectedMarks = new Map()

  /** 生效设置 = patch config + 面板写进 state.json 的覆盖项（改完即生效）。 */
  const currentSettings = () => ({ ...settings, ...(readState().overrides ?? {}) })

  const record = (entry) => {
    const live = currentSettings()
    appendRun({ ts: new Date().toISOString(), ...entry }, { keep: live.runsKeep, maxBytes: live.runsMaxBytes })
  }

  const log = (message) => {
    try {
      ctx.logger?.('project-hooks')?.info?.(message)
    } catch {
      /* 没有 logger 就算了 */
    }
  }

  /**
   * 执行某项目的某个钩子。
   * @param {string} root 项目根 @param {object} entry 项目状态 @param {string} hookId 钩子 id
   * @param {object} payload 传给脚本的 payload @param {object} extra 额外记录字段
   * @returns {Promise<{outcome: string, text?: string, reason?: string, result?: object, json?: any}>} 结果
   */
  const execHook = async (root, entry, hookId, payload, extra = {}) => {
    const hook = entry?.hooks?.[hookId]
    if (!hook || hook.enabled === false) {
      record({ project: root, hookId, outcome: 'disabled', ...extra })
      return { outcome: 'disabled' }
    }
    const scriptPath = resolveScript(root, hook.script)
    if (!fs.existsSync(scriptPath)) {
      record({ project: root, hookId, outcome: 'missing-script', script: hook.script, ...extra })
      return { outcome: 'missing-script' }
    }
    const live = currentSettings()
    const result = await runScript({
      scriptPath,
      cwd: root,
      payload,
      timeoutMs: hook.timeoutMs ?? live.defaultTimeoutMs,
      settings: live,
    })
    const json = parseHookJson(result.stdout)
    const text = truncate(String(json?.hookSpecificOutput?.additionalContext ?? ''), live.contextLimit)
    const decision = String(json?.decision ?? json?.permissionDecision ?? '')
    const outcome = result.timedOut
      ? 'timeout'
      : result.error
        ? 'spawn-error'
        : result.code === 0
          ? 'ok'
          : `exit-${result.code}`
    // 明细：默认只留摘要；captureOutput 打开才写命令、脚本输出与注入正文。
    const capture = live.captureOutput !== false
    const cap = Math.max(200, Number(live.outputLimit) || 4000)
    const command = typeof payload?.tool_input?.command === 'string' ? payload.tool_input.command : ''
    record({
      project: root,
      hookId,
      outcome,
      durationMs: result.durationMs,
      exitCode: result.code ?? null,
      timedOut: result.timedOut === true,
      spawnError: result.error ? String(result.error).slice(0, 400) : null,
      contextChars: text.length,
      stdoutChars: String(result.stdout ?? '').length,
      stderrChars: String(result.stderr ?? '').length,
      decision: decision || null,
      reason: json?.reason ? String(json.reason).slice(0, 800) : null,
      ...(capture
        ? {
            script: hook.script,
            command: command ? truncate(command, Math.min(cap, 2000)) : null,
            hookJson: json ? truncate(JSON.stringify(json), cap) : null,
            contextText: text || null,
            stdout: result.stdout ? truncate(result.stdout, cap) : null,
            stderr: result.stderr ? truncate(result.stderr, cap) : null,
          }
        : {}),
      ...extra,
    })
    return { outcome, text, reason: json?.reason ? String(json.reason) : undefined, result, json }
  }

  /**
   * 取（并按需初始化）某个项目的状态条目。
   * @param {object} state 状态 @param {string} root 项目根 @returns {object} 条目
   */
  const ensureEntry = (state, root) => {
    if (!state.projects[root]) {
      state.projects[root] = { enabled: true, trustedHash: null, hooks: seedHooks(root) }
    }
    state.projects[root].hooks ??= seedHooks(root)
    return state.projects[root]
  }

  // ---- 会话开始 / 每轮第一步：跑项目自己的 session-start 钩子并注入 ----
  /** 每轮第一步只派发一次：key = 会话:轮:步，模型请求重试不会重复跑脚本。 */
  const firstStepSeen = new Set()
  /** 已记过 skipped-subagent 的会话，避免子代理每一轮都写一条。 */
  const subagentNoted = new Set()

  /**
   * 跑某个 Agent 所属项目的 session-start 钩子，返回可注入的消息。
   * 事件名以项目 hooks.json 为准：trigger=created 对应 agent/created，trigger=turn 对应 agent/pre-step；
   * 事件对不上就直接不派发，保证一个钩子只被一套事件执行。
   * @param {any} agent Agent @param {{trigger: 'created' | 'turn', source?: string | null, turn?: number, step?: number}} meta 触发信息
   * @returns {Promise<object | undefined>} 注入消息（无内容时为 undefined）
   */
  const dispatchSessionStart = async (agent, meta) => {
    const live = currentSettings()
    if (!live.enabled) return undefined
    const sessionId = String(agent?.id ?? '')
    // 子代理会话继承父会话的上下文，再注入只会变成噪声（origin / delegationDepth 在会话头上）。
    const sessionHeader = agent?.session?.header ?? {}
    const sessionOrigin = String(sessionHeader.origin ?? agent?.session?.origin ?? '')
    const delegationDepth = Number(sessionHeader.delegationDepth ?? agent?.session?.delegationDepth ?? 0)
    if (sessionOrigin === 'subagent' || (Number.isFinite(delegationDepth) && delegationDepth > 0)) {
      if (!subagentNoted.has(sessionId)) {
        subagentNoted.add(sessionId)
        record({ hookId: 'session-start', outcome: 'skipped-subagent', sessionId, trigger: meta.trigger })
      }
      return undefined
    }
    const cwd = await resolveAgentCwd(ctx, agent)
    const root = findProjectRoot(cwd, live.maxWalkUp ?? settings.maxWalkUp)
    if (!root) {
      log(`未找到项目钩子（cwd=${cwd ?? '未知'}）`)
      return undefined
    }
    const wantedEvent = hookEventOf(root, 'session-start') ?? 'agent/created'
    const triggerEvent = meta.trigger === 'turn' ? 'agent/pre-step' : 'agent/created'
    if (wantedEvent !== triggerEvent) return undefined
    // 默认只在每轮第一步派发（hooks.json 里写 firstStepOnly: false 才每步都跑）。
    if (meta.trigger === 'turn' && meta.step !== 1) {
      const spec = readHooksSpec(root)['session-start']
      if (spec?.firstStepOnly !== false) return undefined
    }

    const state = readState()
    const entry = ensureEntry(state, root)
    // 老版本把 agent/pre-step 一律改写成 agent/created，这里顺手把 state 里记的事件名对齐回 hooks.json。
    if (entry.hooks?.['session-start'] && entry.hooks['session-start'].event !== wantedEvent) {
      entry.hooks['session-start'].event = wantedEvent
    }
    const seenCwd = state.seen?.[root]?.cwd ?? null
    const seenAt = Date.parse(state.seen?.[root]?.at ?? '') || 0
    if (meta.trigger === 'created' || seenCwd !== (cwd ?? null) || Date.now() - seenAt > 60000) {
      state.seen = { ...(state.seen ?? {}), [root]: { at: new Date().toISOString(), cwd: cwd ?? null } }
    }
    const hash = sha256File(path.join(root, HOOKS_FILE))
    if (!entry.trustedHash || entry.trustedHash !== hash) {
      writeState(state)
      record({
        project: root,
        hookId: 'session-start',
        outcome: 'untrusted',
        sessionId,
        trigger: meta.trigger,
        source: meta.source ?? null,
      })
      log(`项目 ${root} 的 hooks.json 未信任或已变更，跳过注入`)
      return undefined
    }
    writeState(state)
    if (entry.enabled === false) {
      record({ project: root, hookId: 'session-start', outcome: 'project-disabled', sessionId, trigger: meta.trigger })
      return undefined
    }
    const outcome = await execHook(
      root,
      entry,
      'session-start',
      {
        hook_event_name: 'agent/pre-step',
        session_id: sessionId,
        turn_id: meta.turn ?? null,
        cwd: root,
        prompt: '',
        source: meta.source ?? null,
      },
      {
        sessionId,
        trigger: meta.trigger,
        source: meta.source ?? null,
        turn: meta.turn ?? null,
        step: meta.step ?? null,
      },
    )
    if (!outcome.text) return undefined
    return buildUserMessage(outcome.text, {
      summary: `SessionStart 注入 ${outcome.text.length} 字 · ${path.basename(root)}`,
    })
  }

  // ---- 会话开始：hooks.json 配 agent/created 的项目在这里跑一次 ----
  ctx.on('agent/created', async (payload) => {
    try {
      const agent = payload?.agent
      const message = await dispatchSessionStart(agent, { trigger: 'created', source: payload?.source ?? null })
      if (!message) return
      const sessionId = String(agent?.id ?? '')
      if (typeof agent?.inject === 'function') {
        agent.inject(message)
      } else {
        pending.set(sessionId, message)
      }
    } catch (error) {
      log(`agent/created 处理失败：${String(error?.message ?? error)}`)
      record({ hookId: 'session-start', outcome: 'plugin-error', reason: String(error?.message ?? error) })
    }
  })

  // ---- 每轮第一步：hooks.json 配 agent/pre-step 的项目在这里跑；同时兜底 pending 注入 ----
  // DSH 的 step 从 1 开始计数（payload.step = 上一步 + 1），所以「每轮第一步」= step === 1。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter') return decision
      const agent = payload?.agent
      const sessionId = String(agent?.id ?? '')
      const live = currentSettings()
      const base = decision.messages ?? []
      const messages = [...base]
      /** 本步新增的注入消息（用于请求快照）。 */
      const injected = []

      // 1) agent.inject 不可用时，agent/created 留下的兜底消息
      const fallback = pending.get(sessionId)
      if (fallback) {
        pending.delete(sessionId)
        messages.push(fallback)
        injected.push(fallback)
      }

      // 2) 每轮第一步跑该项目的 session-start 钩子（hooks.json 写 firstStepOnly: false 时每步都跑）
      const turn = Number(payload?.turn)
      const step = Number(payload?.step)
      if (Number.isFinite(step) && step > 0) {
        const key = `${sessionId}:${turn}:${step}`
        if (!firstStepSeen.has(key)) {
          firstStepSeen.add(key)
          if (firstStepSeen.size > 500) firstStepSeen.clear()
          const message = await dispatchSessionStart(agent, { trigger: 'turn', turn, step })
          if (message) {
            messages.push(message)
            injected.push(message)
          }
        }
      }

      // 记下本步注入内容的指纹：注入只发生一次，之后它作为普通消息留在会话历史里，
      // 靠这个指纹才能在后续每一步的快照里把它标出来（而不是重新注入）。
      if (injected.length > 0) {
        const marks = injectedMarks.get(sessionId) ?? new Set()
        for (const message of injected) {
          const text = renderMessage(message, 200)
          if (text.length >= 40) marks.add(text.slice(0, 60))
        }
        injectedMarks.set(sessionId, marks)
        if (injectedMarks.size > 200) injectedMarks.clear()
      }

      // 3) 把「这一步实际发给模型的 messages」记进运行日志（只记已识别项目的会话）
      if (live.logRequests !== false && Number.isFinite(step) && step > 0) {
        try {
          const cwd = await resolveAgentCwd(ctx, agent)
          const root = cwd ? findProjectRoot(cwd, live.maxWalkUp ?? DEFAULTS.maxWalkUp) : undefined
          if (root) {
            const perItem = Math.max(80, Number(live.requestItemLimit) || DEFAULTS.requestItemLimit)
            const cap = Math.max(200, Number(live.outputLimit) || DEFAULTS.outputLimit)
            // 已提交的历史（session 的模型可见投影）+ 本步刚被接受的用户批次 + 本插件注入的消息
            let history = []
            try {
              if (typeof agent?.session?.deriveMessages === 'function') history = agent.session.deriveMessages()
            } catch (error) {
              log(`读取会话历史失败：${String(error?.message ?? error)}`)
            }
            const batch = Array.isArray(payload?.messages) ? payload.messages : []
            // 真正发出去的 = 已提交历史 + 本步 enter 决策里的 messages（用户批次 + 运行时上下文 + 本插件注入）
            const all = [...history, ...messages]
            // 从最新一条往前攒，攒够上限就停：长会话不必每次渲染整段历史。
            const marks = injectedMarks.get(sessionId) ?? new Set()
            const isInjected = (text) => {
              for (const mark of marks) if (text.includes(mark)) return true
              return false
            }
            const lines = []
            let used = 0
            let skipped = 0
            for (let index = all.length - 1; index >= 0; index -= 1) {
              const raw = renderMessage(all[index], perItem)
              const line = isInjected(raw) ? `⟨注入⟩ ${raw}` : raw
              if (used + line.length > cap && lines.length > 0) {
                skipped = index + 1
                break
              }
              lines.unshift(line)
              used += line.length + 2
            }
            const header = []
            if (skipped > 0) header.push(`……（更早的 ${skipped} 条未展示，共 ${all.length} 条）`)
            // 注入那条如果已经滑出窗口，单独钉在头部，保证每步都能确认「它还在请求里」。
            if (marks.size > 0) {
              let pinned = 0
              for (let index = 0; index < skipped && pinned < 3; index += 1) {
                const raw = renderMessage(all[index], 160)
                if (!isInjected(raw)) continue
                header.push(`[第 ${index + 1}/${all.length} 条 · 注入内容，仍在本次请求中] ${truncate(raw, 160)}`)
                pinned += 1
              }
            }
            const body = lines.join('\n\n')
            const text = header.length > 0 ? `${header.join('\n')}\n\n${body}` : body
            record({
              project: root,
              hookId: 'pre-step',
              outcome: 'request',
              trigger: 'turn',
              sessionId,
              turn,
              step,
              messageCount: all.length,
              historyCount: history.length,
              batchCount: batch.length,
              baseCount: base.length,
              injectedCount: injected.length,
              injectedChars: injected.reduce((sum, message) => sum + renderMessage(message, perItem).length, 0),
              requestChars: text.length,
              request: truncate(text, cap + 200),
            })
          }
        } catch (error) {
          log(`请求快照记录失败：${String(error?.message ?? error)}`)
        }
      }

      if (messages.length === base.length) return decision
      return { ...decision, messages }
    } catch (error) {
      log(`agent/pre-step 处理失败：${String(error?.message ?? error)}`)
      return decision
    }
  })

  // ---- 提交门禁 ----
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    const liveSettings = currentSettings()
    if (!liveSettings.enabled || !liveSettings.blockTools) return decision
    if (decision?.kind !== 'allow') return decision
    try {
      const name = String(exec?.name ?? '')
      const args = exec?.arguments ?? {}
      const command = stripHeredocBodies(typeof args?.command === 'string' ? args.command : JSON.stringify(args ?? {}))
      if (!new RegExp(settings.commitPattern, 'i').test(command)) return decision
      const cwd = await resolveAgentCwd(ctx, exec?.agent)
      const root = findProjectRoot(cwd, settings.maxWalkUp)
      if (!root) return decision
      const state = readState()
      const entry = state.projects[root]
      if (!entry || entry.enabled === false) return decision
      const hash = sha256File(path.join(root, HOOKS_FILE))
      if (!entry.trustedHash || entry.trustedHash !== hash) {
        record({ project: root, hookId: 'pre-commit', outcome: 'untrusted', toolName: name })
        return decision
      }
      const hook = entry.hooks?.['pre-commit']
      if (!hook || hook.enabled === false) return decision
      if (hook.match && !new RegExp(hook.match, 'i').test(name)) return decision
      const outcome = await execHook(
        root,
        entry,
        'pre-commit',
        {
          hook_event_name: 'tools/pre-execute',
          session_id: String(exec?.agent?.id ?? ''),
          turn_id: null,
          cwd: root,
          tool_name: name,
          tool_input: typeof args?.command === 'string' ? { ...args, command } : args,
        },
        { sessionId: String(exec?.agent?.id ?? ''), toolName: name },
      )
      if (/^(block|deny)$/i.test(String(outcome.json?.decision ?? outcome.json?.permissionDecision ?? ''))) {
        return {
          kind: 'deny',
          reason: String(outcome.reason ?? 'pre-commit 钩子阻断了本次提交'),
        }
      }
      return decision
    } catch (error) {
      log(`pre-execute 处理失败：${String(error?.message ?? error)}`)
      return decision
    }
  })

  // ---- 面板接口（HTTP：读配置 / 改配置 / 看日志 / 试跑） ----
  const handleApi = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(API.length) || '/'
    try {
      if (req.method === 'GET' && (route === '/' || route === '/bootstrap')) {
        const state = readState()
        const dirs = new Set([...Object.keys(state.seen ?? {}), ...Object.keys(state.projects ?? {})])
        sendJson(res, 200, {
          plugin: { name: 'project-hooks', version: 1, dir: dataDir() },
          settings: { ...currentSettings(), overridden: Object.keys(state.overrides ?? {}) },
          runsStats: runsStats(),
          projects: [...dirs].sort().map((dir) => projectView(state, dir)),
          runs: readRuns(200),
        })
        return
      }
      if (req.method === 'GET' && route === '/runs') {
        const limit = Number(url.searchParams.get('limit')) || 200
        sendJson(res, 200, { runs: readRuns(limit) })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      const body = await readJsonBody(req)
      const op = String(body?.op ?? '')
      const state = readState()

      if (op === 'add-project') {
        const root = path.resolve(String(body.dir ?? ''))
        if (!String(body.dir ?? '').trim() || !fs.existsSync(path.join(root, HOOKS_FILE))) {
          sendJson(res, 400, { error: 'hooks.json-not-found', dir: root })
          return
        }
        ensureEntry(state, root)
        state.seen[root] = { at: new Date().toISOString(), cwd: null }
        writeState(state)
        sendJson(res, 200, { project: projectView(readState(), root) })
        return
      }
      if (op === 'trust' || op === 'reseed') {
        const root = path.resolve(String(body.dir ?? ''))
        if (!fs.existsSync(path.join(root, HOOKS_FILE))) {
          sendJson(res, 400, { error: 'hooks.json-not-found', dir: root })
          return
        }
        const entry = ensureEntry(state, root)
        if (op === 'reseed') entry.hooks = seedHooks(root)
        entry.trustedHash = sha256File(path.join(root, HOOKS_FILE))
        entry.enabled = true
        state.seen[root] = { at: new Date().toISOString(), cwd: null }
        writeState(state)
        sendJson(res, 200, { project: projectView(readState(), root) })
        return
      }
      if (op === 'revoke') {
        const root = path.resolve(String(body.dir ?? ''))
        const entry = ensureEntry(state, root)
        entry.trustedHash = null
        writeState(state)
        sendJson(res, 200, { project: projectView(readState(), root) })
        return
      }
      if (op === 'toggle-project') {
        const root = path.resolve(String(body.dir ?? ''))
        const entry = ensureEntry(state, root)
        entry.enabled = body.enabled !== false
        writeState(state)
        sendJson(res, 200, { project: projectView(readState(), root) })
        return
      }
      if (op === 'update-hook') {
        const root = path.resolve(String(body.dir ?? ''))
        const id = String(body.hookId ?? '')
        const entry = ensureEntry(state, root)
        const hook = entry.hooks?.[id]
        if (!hook) {
          sendJson(res, 404, { error: 'hook-not-found', hookId: id })
          return
        }
        const patch = body.patch ?? {}
        if (typeof patch.enabled === 'boolean') hook.enabled = patch.enabled
        if (Number(patch.timeoutMs) > 0) hook.timeoutMs = Math.round(Number(patch.timeoutMs))
        if (typeof patch.match === 'string') hook.match = patch.match
        if (typeof patch.script === 'string' && patch.script.trim()) hook.script = patch.script.trim()
        writeState(state)
        sendJson(res, 200, { project: projectView(readState(), root) })
        return
      }
      if (op === 'settings.update') {
        const patch = body.patch ?? {}
        const allowed = ['enabled', 'blockTools', 'captureOutput', 'defaultTimeoutMs', 'contextLimit', 'runsKeep', 'runsMaxBytes', 'outputLimit']
        const overrides = { ...(state.overrides ?? {}) }
        for (const key of allowed) {
          if (!(key in patch)) continue
          if (typeof DEFAULTS[key] === 'boolean') overrides[key] = Boolean(patch[key])
          else if (Number(patch[key]) > 0) overrides[key] = Math.round(Number(patch[key]))
        }
        // 与默认值相同的项不落盘：state.json 只留真正的覆盖。
        state.overrides = Object.fromEntries(
          Object.entries(overrides).filter(([key, value]) => DEFAULTS[key] !== value),
        )
        writeState(state)
        sendJson(res, 200, { settings: { ...currentSettings(), overridden: Object.keys(overrides) }, runsStats: runsStats() })
        return
      }
      if (op === 'clear-runs') {
        try {
          fs.writeFileSync(runsPath(), '', 'utf8')
          runsLines = 0
        } catch {
          /* 没有就算了 */
        }
        sendJson(res, 200, { ok: true })
        return
      }
      if (op === 'test') {
        const root = path.resolve(String(body.dir ?? ''))
        const id = String(body.hookId ?? 'session-start')
        const entry = ensureEntry(state, root)
        const hash = sha256File(path.join(root, HOOKS_FILE))
        if (!entry.trustedHash || entry.trustedHash !== hash) {
          sendJson(res, 409, { error: 'untrusted', dir: root })
          return
        }
        const probe = `session-panel-${Date.now().toString(36)}`
        const payload = id === 'pre-commit'
          ? {
              hook_event_name: 'tools/pre-execute',
              session_id: probe,
              turn_id: null,
              cwd: root,
              tool_name: 'win_bash',
              tool_input: { command: 'echo project-hooks self-test' },
            }
          : {
              hook_event_name: 'agent/pre-step',
              session_id: probe,
              turn_id: null,
              cwd: root,
              prompt: '',
            }
        const outcome = await execHook(root, entry, id, payload, { trigger: 'panel-test' })
        sendJson(res, 200, {
          outcome: outcome.outcome,
          text: outcome.text ?? '',
          reason: outcome.reason ?? null,
          stderr: outcome.result?.stderr?.slice(-800) ?? '',
          durationMs: outcome.result?.durationMs ?? 0,
        })
        return
      }
      sendJson(res, 400, { error: 'unknown-op', op })
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  const webServer = ctx.get?.('webServer')
  if (webServer?.register) {
    ctx.effect(() => {
      const dispose = webServer.register({ kind: 'prefix', path: API, handler: handleApi })
      return () => {
        try {
          dispose()
        } catch {
          /* 已释放 */
        }
      }
    }, 'project-hooks.http')
    log(`面板接口已挂载：${API}`)
  } else {
    log('webServer 服务不可用，配置面板将无法读取数据')
  }
}
