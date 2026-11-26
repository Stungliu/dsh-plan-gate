/**
 * `request_plan_mode` — let the agent *ask* for plan mode instead of pretending
 * it can switch modes.
 *
 * DSH plan mode is user-owned: `ctx.planMode` exposes no Remote method and only
 * the `/plan` human command enters it (`@deepseek-ai/dsh-plan-mode`). This tool
 * therefore stops at the composer: it asks one fixed question through the
 * existing user-question card, and when the human picks the enter option it runs
 * the exact same `/plan <instruction>` command the composer control runs, so the
 * mode change and the follow-up instruction are logged as if the user typed them.
 *
 * The human's click stays the authority — the tool never calls `planMode.set`
 * itself. Without an answer channel (subagent, no client, dismissed card) it
 * returns guidance instead of blocking the flow.
 *
 * @module dsh-plan-gate
 */

/** Registered tool name. */
const TOOL = 'request_plan_mode'

/** Question id echoed back in the answer batch. */
const QUESTION_ID = 'plan_gate'

/** User-question failure codes that mean "no answer channel here", not "wrong". */
const UNAVAILABLE_CODES = new Set([
  'ASK_ABORTED',
  'BAD_INTENT',
  'CALLER_NOT_LIVE',
  'DELEGATED_CALLER',
  'EMPTY_QUESTIONS',
  'NO_PROVIDER',
])

const DEFAULTS = {
  header: '切换 Plan 模式',
  question: '澄清已完成，是否进入 Plan 模式给出方案？',
  enterLabel: '进入 Plan 模式并出方案',
  enterDescription: '执行 /plan：会话切到 Plan 模式，并把「请给出方案」这条指令作为你的消息发出。',
  skipLabel: '跳过，直接在回复里给方案',
  skipDescription: '保持当前模式：Agent 在回复里写方案，等你确认后再改文件。',
  instruction: '请按已澄清的需求给出完整实现方案（目标、改动范围、实现步骤、风险与验证方式），并通过 exit_plan_mode 提交给我审批。',
}

const NO_CHANNEL = '请改为：直接在回复里给出完整方案（目标、改动范围、实现步骤、风险与验证方式），'
  + '明确等待用户确认后再改文件；或提醒用户输入 /plan。'

const DESCRIPTION = '在「需求澄清」结束、准备给出实现方案之前调用它。你不能自己进入 Plan 模式：'
  + '本工具会在输入框处弹出一张确认卡，并阻塞等待用户选择。返回的 outcome 决定你接下来做什么：'
  + '\n- entered：会话已执行 /plan <instruction>，自下一步起处于 Plan 模式。在 Plan 模式下输出完整方案，'
  + '并以 exit_plan_mode 作为该步最后且唯一的工具调用提交审批。'
  + '\n- skipped：用户选择跳过。立刻在当前回合给出完整方案，明确等待用户确认后再改文件，不要空等。'
  + '\n- declined：用户关闭了确认卡并把回合拿走了。停止动作，等用户的下一条消息，不要重复调用。'
  + '\n- already / unavailable：不要重复请求。按返回文本改用「在回复里给出方案并等待确认」，'
  + '或提醒用户输入 /plan；子 agent 内调用只会得到 unavailable。'
  + '\n一次任务只调用一次；调用前不要修改任何文件。'

/** Collapse whitespace so the value stays one command line. */
function line(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** Read one string option, falling back to the shipped wording. */
function text(config, key) {
  const value = config?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value : DEFAULTS[key]
}

/** Canonical tool value: an outcome tag plus the model-facing instruction. */
function outcome(kind, message) {
  return { outcome: kind, text: message }
}

/**
 * Cordis plugin entry.
 * @param ctx - Host root context (the row is mounted in the Host tree, so the
 *   tool lands in the global tool layer and every Agent in every preset sees it).
 * @param config - optional row config; any key overrides the defaults above.
 */
export function apply(ctx, config = {}) {
  /**
   * The live `plan` projection for one Session, or `undefined` when the Agent's
   * preset did not mount plan mode at all. `snapshot()` folds only units that
   * declare `wire`, which the `plan` unit does.
   * @param session - the calling Agent's session.
   * @returns `{ active, pending }`, or `undefined` when unavailable.
   */
  const planView = (session) => {
    try {
      return ctx.sessionProjections.snapshot(session, ['plan'])?.values?.plan
    } catch {
      return undefined
    }
  }

  ctx.tools.register({
    name: TOOL,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '一句话说明为什么现在该出方案，会显示在确认卡上。',
        },
        instruction: {
          type: 'string',
          description: '可选。用户点击后自动发送的 /plan 指令文本；省略时用配置里的默认指令。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: { type: 'string', enum: ['entered', 'skipped', 'declined', 'already', 'unavailable'] },
          text: { type: 'string' },
        },
        required: ['outcome', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const enter = text(config, 'enterLabel')
      const instruction = line(args?.instruction) || text(config, 'instruction')
      const agent = exec.agent
      const questions = ctx.userQuestions
      if (agent === undefined || questions === undefined) {
        return outcome('unavailable', `当前调用没有可提问的用户通道（子 agent 或无已连接客户端）。${NO_CHANNEL}`)
      }
      // Ask only when the switch can actually happen: no `/plan` command means no
      // plan mode in this preset, and a dead card would waste the human's click.
      if (ctx.commands.find(agent, 'plan') === undefined) {
        return outcome('unavailable', `本会话没有 /plan 命令（当前 preset 未挂载 Plan 模式）。${NO_CHANNEL}`)
      }
      const plan = planView(agent.session)
      if (plan !== undefined && (plan.active === true || plan.pending === true)) {
        return outcome('already', `会话${plan.active === true ? '已' : '即将'}处于 Plan 模式。`
          + '直接输出完整方案，并以 exit_plan_mode 作为本步最后且唯一的工具调用提交审批，不要再重复请求。')
      }

      let answer
      try {
        answer = await questions.ask({
          agent,
          signal: exec.signal,
          questions: [{
            id: QUESTION_ID,
            header: text(config, 'header'),
            question: text(config, 'question'),
            detail: [
              line(args?.reason),
              `点击「${enter}」后自动执行：/plan ${instruction}`,
            ].filter(part => part !== '').join('\n'),
            options: [
              { label: enter, description: text(config, 'enterDescription') },
              { label: text(config, 'skipLabel'), description: text(config, 'skipDescription') },
            ],
          }],
        })
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : ''
        if (code === 'ASK_CANCELLED') {
          // The user took the turn back to say something the two options miss.
          exec.concludeTurn()
          return outcome('declined', '用户关闭了这次确认并想自己说。等待用户的下一条消息，不要重复调用本工具。')
        }
        if (UNAVAILABLE_CODES.has(code) || error?.name === 'AbortError') {
          return outcome('unavailable', `无法打开 Plan 模式确认${code === '' ? '' : `（${code}）`}。${NO_CHANNEL}`)
        }
        throw error
      }

      const item = answer.answers.filter(entry => entry.id === QUESTION_ID)[0]
      const custom = line(item?.custom)
      const picked = Array.isArray(item?.selected) ? item.selected[0] : undefined
      if (picked !== enter && custom === '') {
        return outcome('skipped', '用户选择跳过 Plan 模式。现在就在本回合给出完整方案（目标、改动范围、'
          + '实现步骤、风险与验证方式），并明确等待用户确认后再改文件。')
      }

      // A typed answer replaces the instruction: the user is steering what to plan.
      const command = picked === enter ? instruction : custom
      let execution
      try {
        execution = await ctx.commands.execute(agent, `/plan ${command}`, [], exec.signal)
      } catch (error) {
        return outcome('unavailable', `执行 /plan 失败：${String(error?.message ?? error)}。${NO_CHANNEL}`)
      }
      if (execution === undefined) {
        return outcome('unavailable', `本会话没有可用的 /plan 命令。${NO_CHANNEL}`)
      }
      if (execution.result.kind === 'error') {
        return outcome('unavailable', `/plan 返回错误：${execution.result.text ?? '未知原因'}。${NO_CHANNEL}`)
      }

      return outcome('entered', `${execution.result.text ?? '已进入 Plan 模式。'} `
        + `已把「/plan ${command}」作为用户消息提交。现在停止修改文件，`
        + '只在 Plan 模式下给出完整方案，并以 exit_plan_mode 作为本步最后且唯一的工具调用提交审批。')
    },
    presentCall: (args) => {
      const reason = line(args?.reason)
      return {
        card: 'generic',
        title: '请求进入 Plan 模式',
        kind: 'other',
        content: [{ type: 'text', text: reason === '' ? '澄清结束，等待用户确认是否进入 Plan 模式。' : reason }],
      }
    },
    presentResult: (_args, result) => ({ card: 'generic', title: 'Plan 模式请求', content: result.content }),
  })
}

export const name = 'plan-gate'
export const inject = ['tools', 'userQuestions', 'commands', 'sessionProjections']
