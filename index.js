import { Ledger, LedgerInputError, DEFAULT_DIR } from './ledger.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'sky-evidence-recovery'
export const inject = ['tools']

export const Config = Schema.object({
  dataDir: Schema.string().default(DEFAULT_DIR),
  rules: Schema.array(Schema.object({
    tool: Schema.string().required(),
    keyArg: Schema.string().default(''),
  })).default([]),
})

const blockedReasons = {
  SKY_ALREADY_EXECUTED: '当前业务标识已有完成记录，请查询结果。',
  SKY_KEY_CONFLICT: '同一业务标识对应不同参数，拒绝执行。',
  SKY_EXECUTION_UNKNOWN: '提交状态未知，必须由操作者核查下游并对账。',
}

const jsonOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

function block(code, message) {
  return {
    isError: true,
    content: [{ type: 'text', text: code + ': ' + message }],
    error: { message, info: { name: 'SkyEvidenceRecovery', code } },
  }
}

export function apply(ctx, config) {
  const rules = new Map()
  const invalidRules = new Set()
  for (const rule of config?.rules ?? []) {
    if (!rule.tool || rule.tool.startsWith('sky_recovery_') || rules.has(rule.tool)) {
      invalidRules.add(rule.tool || '')
    }
    if (rule.tool) rules.set(rule.tool, rule.keyArg || undefined)
  }

  if (invalidRules.size) {
    ctx.logger?.warn?.('SKY_INVALID_RULE: 保护规则存在无效条目，请检查 sky_recovery_health 的 invalidRules')
  }

  let ledger
  let ledgerNote = '账本目录初始化失败'
  let pending = 0
  let closing = false
  try {
    ledger = new Ledger(config?.dataDir || DEFAULT_DIR)
    ledger.tryLock()
  } catch {
    // Keep the interceptor mounted when storage is unavailable.
  }

  function closeIfIdle() {
    if (!closing || pending) return
    try {
      ledger?.close()
    } catch {
      ctx.logger?.warn?.('SKY Evidence Recovery：无法正常清理账本锁')
    }
  }

  ctx.effect(() => () => {
    closing = true
    closeIfIdle()
  })

  function ledgerHealth() {
    const ledgerLocked = !closing && ledger?.checkOwner() === true
    return {
      ledgerLocked,
      ledgerNote: ledgerLocked ? '' : (ledger?.lockNote || ledgerNote),
    }
  }

  const health = ledgerHealth()
  if (!health.ledgerLocked) ctx.logger?.warn?.('SKY Evidence Recovery：' + health.ledgerNote)

  ctx.tools.register(defineTool({
    name: 'sky_recovery_health',
    description: 'Read-only plugin health, including ledger lock and configured protected tools.',
    parameters: {},
    output: jsonOutput,
    async execute() {
      return JSON.stringify({
        loaded: true,
        ...ledgerHealth(),
        protectedTools: [...rules.keys()],
        invalidRules: [...invalidRules],
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sky_recovery_status',
    description: 'Read-only execution ledger status.',
    parameters: {
      tool: { type: 'string', required: true, description: 'Exact protected tool name.' },
      argumentsJson: { type: 'string', required: true, description: 'JSON object containing original tool arguments.' },
    },
    output: jsonOutput,
    async execute(args) {
      const health = ledgerHealth()
      if (!rules.has(args.tool)) return JSON.stringify({ state: 'unprotected', ...health })
      if (!ledger || invalidRules.has(args.tool)) return JSON.stringify({ state: 'unavailable', ...health })
      let originalArgs
      try {
        originalArgs = JSON.parse(args.argumentsJson)
      } catch {
        return JSON.stringify({ state: 'error', code: 'SKY_INVALID_INPUT', ...health })
      }
      try {
        return JSON.stringify({ ...ledger.status(args.tool, originalArgs, rules.get(args.tool)), ...health })
      } catch (error) {
        const code = error instanceof LedgerInputError ? error.code : 'SKY_LEDGER_UNAVAILABLE'
        return JSON.stringify({ state: 'error', code, ...health })
      }
    },
  }))

  function settle(ticket, result, reason, thrownInfo) {
    try {
      // Dispatch results are diagnostic. They cannot authorize a release.
      const info = result?.error?.info ?? thrownInfo
      ledger.settle(ticket.key, ticket.executionId, result?.isError === false, reason, info)
    } catch {
      // Preserve the tool's reply. The persisted claim still blocks a repeat.
      ctx.logger?.warn?.('SKY Evidence Recovery：执行结果未能写入账本')
    }
  }

  ctx.on('tools/execute', async (exec, next) => {
    if (!rules.has(exec.name) || exec.name === 'sky_recovery_health' || exec.name === 'sky_recovery_status') {
      return next()
    }
    if (invalidRules.has(exec.name)) return block('SKY_INVALID_RULE', '保护规则无效，拒绝执行')
    const health = ledgerHealth()
    if (!health.ledgerLocked) {
      return block('SKY_LEDGER_UNAVAILABLE', '账本不可用，拒绝执行：' + health.ledgerNote)
    }

    let ticket
    try {
      ticket = ledger.claim(exec.name, exec.arguments, rules.get(exec.name))
    } catch (error) {
      if (error instanceof LedgerInputError) {
        return block(error.code, error.message)
      }
      return block('SKY_LEDGER_UNAVAILABLE', '无法持久化执行登记，拒绝执行')
    }
    if (!ticket.ok) return block(ticket.code, blockedReasons[ticket.code])

    pending++
    try {
      const result = await next()
      settle(ticket, result, 'TOOL_OUTCOME_UNKNOWN')
      return result
    } catch (error) {
      settle(ticket, undefined, 'TOOL_DISPATCH_THROWN', error)
      throw error
    } finally {
      pending--
      closeIfIdle()
    }
  })
}
