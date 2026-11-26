# dsh-plan-gate

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：给 Agent 一个 **`request_plan_mode`** 工具，让它在「该出方案」时**征求你的同意**，而不是自作主张开工。

`request_plan_mode` gives a DSH agent a way to *ask* for plan mode. In DSH, plan mode is user-owned — only the human `/plan` command enters it, and `ctx.planMode` exposes no remote method — so an agent that is told to "switch to plan mode" can only pretend. This plugin turns that instruction into a click: the agent asks, you confirm at the composer, and the plugin then runs the exact `/plan <instruction>` command you would have typed.

## 它解决什么

你写了这样的流程规则：「先澄清需求 → 切 Plan 模式出方案 → 我确认后才改代码」。
但 Agent 没有进入 Plan 模式的能力，于是它要么跳过这一步直接改文件，要么嘴上说「已切换到 Plan 模式」。

装上本插件后，流程变成：

```
Agent 澄清完毕 → 调用 request_plan_mode
      → 输入框处弹出确认卡（两个按钮）
          ├── 进入 Plan 模式并出方案   → 插件执行 /plan <指令> → 会话进入 Plan 模式
          │                             并把「请给出方案」作为你的消息发出
          │                             → Agent 在 Plan 模式下写方案 → exit_plan_mode 审批卡 → Approve → 才开始改文件
          └── 跳过，直接在回复里给方案 → Agent 立刻在本回合写出方案，等你确认
```

**插件不会自己调用 `planMode.set`。** 模式切换只发生在你的点击之后，并且走的是与人类命令相同的日志路径（`command/run` / `command/done`），所以在会话日志里与你手敲 `/plan` 完全等价。

## 安装

1. `git clone https://github.com/Stungliu/dsh-plan-gate.git`
2. DSH → **Settings → Plugins → Add plugin** → 选择刚 clone 出来的目录。
   （本地安装是**链接**该目录，所以请放在一个长期存在的路径上；也可以让 Agent 用 `plugin_manager install_bundle` 装。）
3. 新建会话即可看到 `request_plan_mode` 工具。

要求：当前 Agent preset 挂载了 Plan 模式（DSH 官方 `standard` preset 已挂载）。没有 `/plan` 命令时工具会直接返回 `unavailable`，不会弹一张没用的卡。

## 搭配的全局规则

放到 `~/.dsh/AGENTS.md`（对所有项目生效），或项目根的 `AGENTS.md`：

```markdown
## 流程：需求澄清 → Plan → 再改代码

1. 先理解需求，再提问：一次只问一个问题，给选项并标注推荐项；能自己读代码确认的事实不要问用户。
2. 出方案：澄清结束后调用 `request_plan_mode`（它会阻塞等待用户选择）。
   - `entered` → 自下一步起在 Plan 模式下写完整方案，并用 `exit_plan_mode` 提交审批
   - `skipped` → 立刻在本回合给出方案，明确等待确认
   - `declined` → 停止动作，等用户下一条消息
   - `already` / `unavailable` → 不要重复请求，改用「回复内给方案并等确认」
3. 未获用户明确确认 / Plan 批准前，禁止改代码、禁止运行会改状态的命令。
```

## 可覆盖的配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（**整行 `config` 全量替换，要写就写全**）：

```yaml
- id: plan-gate
  name: 'dsh-plan-gate'
  config:
    question: 澄清已完成，是否进入 Plan 模式给出方案？
    enterLabel: 进入 Plan 模式并出方案
    skipLabel: 跳过，直接在回复里给方案
    instruction: 请给出完整实现方案，并通过 exit_plan_mode 提交给我审批。
```

可覆盖键：`header`、`question`、`enterLabel`、`enterDescription`、`skipLabel`、`skipDescription`、`instruction`。
`instruction` 里的换行与多余空白会被压成一行，保证 `/plan` 参数合法。

## 返回的 outcome

| outcome | 含义 | Agent 应有的行为 |
|---|---|---|
| `entered` | 你点了进入，`/plan <指令>` 已执行 | 在 Plan 模式下写方案，`exit_plan_mode` 提交审批 |
| `skipped` | 你点了跳过 | 当前回合立刻给出方案并等你确认 |
| `declined` | 你关闭了确认卡 | 结束回合，等你的下一条消息，不重复调用 |
| `already` | 会话已在 / 即将进入 Plan 模式（读 `plan` 投影判定） | 直接出方案，不再弹卡 |
| `unavailable` | 子 agent、无已连接客户端、preset 无 `/plan` | 改用「回复内给方案并等确认」，或提醒你输入 `/plan` |

## 边界与限制

- **Host-only**：本插件没有前端代码，确认卡是 DSH 内置的提问卡（位置就在输入框处）。若你想要一个专门的单按钮条，需要另外注册 `conversation.input.dock`，并自建 projection 作为状态源。
- 子 agent 里没有提问通道，调用只会立刻拿到 `unavailable`。
- 一次工具调用会阻塞当前回合直到你作答；`/plan off` 之后可以再次请求。
- 修改 `index.js` 后需让 Host 重读模块：插件页 disable → enable，或重启应用（打包版 Desktop 没有 `dev:web` watcher，改前端文件不会免刷新生效）。

## 已实测 / 未实测

已在 DSH `0.2.2-rc.5` 上实测通过：`entered` 完整链路（弹卡 → 点击 → 会话真的进入 Plan 模式并收到自动指令）、`skipped`、子 agent 的 `unavailable`、`node --check`、disable→enable 重载。
未实测：`declined`（需人为关闭卡片）、`already`（需先进再退 Plan 模式）、未挂 Plan 模式的 preset。

## License

[MIT](LICENSE)
