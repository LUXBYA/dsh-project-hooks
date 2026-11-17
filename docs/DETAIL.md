# 项目钩子（Project hooks）

每个工作区自己的钩子，互不串味。

## 能力

- **会话开始注入**：跑该项目的 `session-start` 脚本，把输出注入成一条上下文消息。
  派发用的 DSH 事件**以项目 `hooks.json` 为准**：`agent/pre-step` → 每轮第一步（`step === 1`，同一 轮/步 只跑一次，
  模型请求重试不会重复执行）；`agent/created` → 每会话一次（含压缩后 fork 的新会话）。两者只走一条，不会双派发。
  注入消息的 source 是 `{ kind: 'project-hooks', form: 'notice', summary }` 而不是 `{ kind: 'user' }`：
  DSH 客户端只把 `kind === 'user'` 的消息渲染成对话气泡，其余来源一律按“注入上下文”处理，
  所以对话界面里看不到它（与 AGENTS.md、技能注入同样式），模型看到的正文完全一致；
  要核对注入内容，看「轨迹 → 上下文」或本插件运行日志里的 `contextText`。
- **提交门禁**：`tools/pre-execute` 阶段命中 `git commit` 时先跑 `pre-commit` 脚本，脚本返回 `decision: block` 就阻断本次提交。
- **配置面板**：设置 → 项目钩子，按项目/按钩子开关、改超时与 matcher、信任或撤销信任、一键试跑。
- **运行日志**：每次派发都留一条记录，可在面板筛选、点开看明细。

### 一条记录里有什么

| 字段 | 含义 |
|---|---|
| `ts` / `project` / `hookId` / `trigger` | 时间、项目根、钩子位、触发方式（`turn` 每轮第一步 / `created` 会话开始 / `panel-test` 面板试跑）|
| `turn` / `step` | 触发时所在的轮次与步号（`agent/pre-step` 派发时才有）|
| `outcome` | `ok` / `timeout` / `spawn-error` / `exit-N` / `disabled` / `missing-script` / `skipped-subagent` / `untrusted` |
| `durationMs` / `exitCode` / `timedOut` / `spawnError` | 耗时与进程结果 |
| `command` | 被门禁检查的命令原文（`pre-commit` 才有，最长 2000 字）|
| `decision` / `reason` | 脚本给的判定与理由（阻断原因）|
| `contextText` + `contextChars` | 真正注入的那段正文 |
| `stdout` / `stderr` + 字数 | 脚本输出原文，按单段上限截断 |
| `hookJson` | 从 stdout 解析出的钩子 JSON |

### 模型请求快照（`hookId: 'pre-step'`）

开了 `logRequests`（默认开）后，每一步（`agent/pre-step`）都会额外写一条 `hookId: 'pre-step'`、`outcome: 'request'` 的记录，内容就是**这一步真正喂给模型的 messages**（已经算上本步注入的那条消息）：

| 字段 | 含义 |
|---|---|
| `request` | 压平后的 messages 文本，每条一行 `[role] 正文`；整体按 `outputLimit` 截断 |
| `messageCount` / `requestChars` | 条数与总字数（截断前的真实值）|
| `injectedCount` / `injectedChars` | 这一步里由本插件加进去的消息条数与字数 |
| `turn` / `step` | 第几轮第几步 |

- 每条消息按 `requestItemLimit`（默认 600 字）单独截断，避免一条超长工具输出把整段挤掉。
- 只记**已识别项目**（cwd 向上能找到 `.dsh/hooks.json`）的会话，仓库外的会话不写，避免污染日志。
- 快照只含 `messages`，不含 system prompt 与工具定义；要看完整上下文去「轨迹 → 上下文」。
- 想关掉：面板里点「记录模型请求」，或 `logRequests: false`。

### 时间显示

`runs.jsonl` 里的 `ts` 存 UTC ISO（`2026-11-17T05:40:04.275Z`，无歧义）；面板的「时间」列按浏览器本地时区显示，
表头标注当前偏移（如 `时间（UTC+08:00）`），展开一行还能看到「本地时间 + 原始 UTC」对照。换时区不会改动已存数据。

### 双上限（防止日志吃盘）

- **体积上限** `runsMaxBytes`（默认 5 MB）与**条数上限** `runsKeep`（默认 2000）同时生效，超了就从最旧的丢。
- **单段输出上限** `outputLimit`（默认 4000 字）限制 stdout/stderr/正文/JSON 各存多少。
- `captureOutput` 关掉后只留摘要（时间、结果、耗时、字数、判定），完全不写输出原文。
- 三个值都能在面板里直接改，写进 `state.json` 的 `defaults`，立即生效、无需重启。

## 两个面板入口

| 入口 | 内容 | 注册的槽位 |
|---|---|---|
| 设置 → 项目钩子 | 「配置」「运行日志」两个 tab | `settings.section` |
| 侧栏「项目钩子」图标 | 运行日志整页面板 | `sidebar.panellist` + `main`（同一 id `project-hooks`）|

侧栏图标与它打开的主面板共用一个 id；配置刻意留在设置里，避免侧栏堆两个入口。

## 隔离与信任

- 项目由**会话 cwd 向上找 `.dsh/hooks.json`** 定位；找不到就完全不参与。
- 只有显式「信任」过、且 `hooks.json` 的 sha256 指纹未变的项目才会执行；文件一改指纹失效，回落到「未信任」。
- 未信任的项目只出现在面板里，不执行任何脚本。

## 配置文件

- `cordis.patch.yml` 的 `config`：`enabled`、`blockTools`、`defaultTimeoutMs`、`contextLimit`、`runsKeep`（改动需重启 profile）。
- `$DSH_HOME/project-hooks/state.json`：按项目的启用状态、信任指纹、每钩子的开关/超时/matcher（面板改，立即生效）。
- `$DSH_HOME/project-hooks/runs.jsonl`：运行日志，按 `runsKeep` 滚动。

## 限制

- 面板数据走 `ctx.webServer` 的 HTTP 路由，只在 Web GUI 页面里可用；`file://` 打开的窗口读不到数据。
- 一个项目目前支持两个钩子位：`session-start`（`agent/pre-step` 每轮第一步，或 `agent/created` 每会话）与 `pre-commit`（`tools/pre-execute`）。
- 面板文案目前只有中文。
