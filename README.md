# dsh-project-hooks

**每个工作区各自一套项目钩子**：会话（或每轮第一步）注入项目上下文，`git commit` 前跑项目自己的门禁脚本，内置配置面板与运行日志。

A per-workspace project-hooks plugin for DeepSeek Harness: injects project context at the start of each turn and gates `git commit` behind a project-owned script, with a settings panel and a run log.

## 它做什么

- **项目上下文注入**：从当前工作目录向上找到最近的项目根（含 `.dsh/hooks.json`），跑项目自己的 `session-start` 脚本，把输出注入成一条上下文消息。
  注入时机跟着 `hooks.json` 里声明的事件走：配 `agent/pre-step` 就**每轮第一步**注入一次（同一 轮/步 只跑一次，模型请求重试不会重复执行），配 `agent/created` 就每会话一次。
- **提交门禁**：匹配 `git commit` 的 shell 调用先跑 `pre-commit` 脚本，退出码非 0 就阻断，并把你配置的理由回给模型。
- **配置面板**（设置 → 项目钩子）：按项目、按钩子开关；超时、matcher、信任（记录的 `hooks.json` 哈希）与「试跑」。
- **运行日志**：侧栏独立面板 + 设置内页签；每行记录时间（按本地时区）、项目、**会话**、钩子、结果、**注入状态**、耗时、输出、细节，可展开看执行的命令原文、脚本 stdout/stderr、解析出的钩子 JSON、注入正文、本步发给模型的 messages 快照与判定理由。
  双上限自动裁剪最旧记录：体积默认 5 MB、条数默认 2000 条、单段输出默认 4000 字，面板里可改，立即生效。

### 运行日志怎么看

- **分页**：每页 10 / 20 / 50 / 100 条（默认 20），顶部「上一页 / 下一页」+ 页码；日志每步一条，会一直长。
- **表内滚动**：表格自己是一个滚动区，表头吸附在顶部，展开的明细再长也不会把表头挤走。
- **筛选**：项目 / 钩子 / 结果三个下拉可叠加，切筛选或改每页条数自动回第 1 页。
- **会话列**：日志只存 `sessionId`，面板显示的是**会话标题**（折叠该会话日志里的 `session/title` 事件得到，走 `sessionQuery.readTitleSnapshots`，带 30 秒缓存）；标题还没生成或历史会话没有标题时退化成 `session-xxxx…` 短 id，悬停看完整 id。
- **注入列**：`+1 条 · 1453 字` = 本步新注入；`沿用 · 第 N 条` = 本步没新注入，但开课注入的那段仍在本次请求的第 N 条里；`无注入` = 请求里也没有。悬停有解释。
- 只看脚本产出：钩子筛成 `session-start`；只看每步请求快照：筛成 `pre-step`。

## 安装

```text
plugin_manager  install_bundle  target = dsh-project-hooks
```

装好后在 **设置 → 项目钩子** 里看到面板；侧栏可固定「项目钩子」图标打开运行日志。

## 项目侧需要一个 `.dsh/hooks.json`

放在项目根目录，按事件名列钩子脚本：

```json
{
  "hooks": {
    "agent/pre-step": [
      {
        "commandWindows": "\"C:\\Program Files\\nodejs\\node.exe\" .dsh/hooks/session-start.mjs",
        "command": "node .dsh/hooks/session-start.mjs",
        "timeout": 30,
        "firstStepOnly": true
      }
    ],
    "tools/pre-execute": [
      {
        "matcher": "win_bash|bash|pwsh|powershell",
        "command": "node .dsh/hooks/pre-commit.mjs",
        "timeout": 600
      }
    ]
  }
}
```

- `timeout` 单位是**秒**。
- 支持的钩子事件：`agent/pre-step`（每轮第一步，`firstStepOnly: false` 则每步）、`agent/created`（每会话一次）、`tools/pre-execute`（工具调用前，配合 `matcher` 与提交门禁）。
- 脚本从 stdin 收一份 JSON（`hook_event_name`、`session_id`、`turn_id`、`cwd`、`prompt`、工具调用的 `tool_name`/`tool_input`），把要注入的正文打到 stdout 即可；退出码非 0 表示门禁不通过。
- `hooks.json` 第一次被读到时是**未信任**状态，需要在面板里点一次「信任」；之后文件一变（哈希变），注入与门禁会停下并在日志里记 `untrusted`。

## 边界与已知限制

- 只认 `.dsh/hooks.json`；工作区里没有该文件就完全不动，不注入也不记日志。
- 子代理会话不注入（它继承父会话上下文，再注入只是噪声），只在日志里留一条 `skipped-subagent`。
- 注入进去的那条消息 `source.kind` 不是 `user`，所以**对话里不出现气泡**（不打断你的输入记录）；内容和时机在「轨迹 → 上下文」里可查。
- 注入正文默认截到 2400 字（面板可改）。
- 状态与日志落在 `$DSH_HOME/project-hooks/`（`state.json`、`runs.jsonl`），不写进项目仓库。
- 目前只做「注入 / 门禁 / 日志」，不提供钩子脚本的自动生成。

## 许可

MIT。详见 [LICENSE](LICENSE) 与 [docs/DETAIL.md](docs/DETAIL.md)。
