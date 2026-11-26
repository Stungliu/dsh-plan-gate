# Plan 模式请求（plan-gate）

给 Agent 一个「请求进入 Plan 模式」的动作，而不是让它自称已经切换了模式。

## 它做什么

DSH 的 Plan 模式属于用户：只有 `/plan` 这条人类命令能进入，`ctx.planMode` 对 Client 不开放任何 Remote 方法。
本插件注册一个工具 `request_plan_mode`，Agent 在需求澄清结束、准备出方案时调用它：

1. 输入框处弹出确认卡（复用现有 `ask_user_question` 的问题卡通道），两个选项：
   - **进入 Plan 模式并出方案**（默认项）
   - **跳过，直接在回复里给方案**
2. 你点第一个 → 插件在 Host 侧执行与你自己手敲完全一致的 `/plan <指令>`：会话进入 Plan 模式，并把「请给出完整方案并通过 exit_plan_mode 提交」作为你的消息发出。
3. 之后 Agent 在 Plan 模式下写方案，方案通过 `exit_plan_mode` 的审批卡交给你，Approve 后它才开始改文件。

搭配 `~/.dsh/AGENTS.md` 里的全局流程规则使用（澄清 → Plan → 再改代码）。

## 边界

- 插件**不会**自己调用 `planMode.set`：模式切换只发生在你的点击之后，走的是与人类命令相同的日志路径。
- 弹卡前先检查 `/plan` 命令是否存在（`commands.find`）；不存在就直接返回 `unavailable`，不会弹一张没用的卡。
- `already` 判定读的是 `plan` 会话投影 `{active, pending}`：正在或即将处于 Plan 模式时不再重复弹卡；你用 `/plan off` 退出后可以再次请求。
- 子 agent、没有已连接的客户端、或你关闭确认卡时，工具不会挂住本轮：它返回 `unavailable` / `declined` 并告诉 Agent 改用「在回复里给方案并等待确认」这条路。
- 只改 Host 侧，没有前端代码：卡片是 DSH 已有的提问卡，位置在输入框处。
- `instruction` 里的换行与多余空白会被压成一行，保证 `/plan` 参数是合法的一行命令。

## 可调项

行 `plan-gate` 的 `config` 可覆盖文案与默认指令（省略则用内置默认）。在 profile 的 `cordis.patch.yml` 里用同 id 覆盖时，**整行 `config` 是全量替换**，要写就写全：

```yaml
- id: plan-gate
  name: 'dsh-plan-gate'
  config:
    question: 澄清已完成，是否进入 Plan 模式给出方案？
    enterLabel: 进入 Plan 模式并出方案
    skipLabel: 跳过，直接在回复里给方案
    instruction: 请给出完整实现方案，并通过 exit_plan_mode 提交给我审批。
```

可覆盖的键：`header`、`question`、`enterLabel`、`enterDescription`、`skipLabel`、`skipDescription`、`instruction`。
