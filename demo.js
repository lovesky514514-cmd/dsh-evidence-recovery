import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'sky-evidence-recovery-demo'
export const inject = ['tools']
const defaultDemoDir = join(homedir(), '.sky-evidence-recovery-demo')
export const Config = Schema.object({
  dataDir: Schema.string().default(defaultDemoDir),
})

export function apply(ctx, config) {
  const demoDir = config?.dataDir || defaultDemoDir
  const orderPath = id => join(demoDir, `${createHash('sha256').update(id).digest('hex')}.json`)

  ctx.tools.register(defineTool({
    name: 'sky_demo_create_order',
    description: 'SIMULATION ONLY. outcome=lost creates local record and drops acknowledgment; no external API.',
    parameters: {
      requestId: { type: 'string', required: true, description: 'Simulated operation ID.' },
      outcome: { type: 'string', required: true, description: 'success or lost.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const { requestId, outcome } = args
      if (typeof requestId !== 'string' || !requestId.trim() || !['success', 'lost'].includes(outcome)) {
        throw new Error('无效模拟订单参数')
      }
      mkdirSync(demoDir, { recursive: true, mode: 0o700 })
      const path = orderPath(requestId)
      if (existsSync(path)) throw new Error('模拟下游显示该业务标识已提交')
      const order = { requestId, state: 'created', createdAt: new Date().toISOString() }
      writeFileSync(path, JSON.stringify(order), { flag: 'wx', mode: 0o600, flush: true })
      if (outcome === 'lost') throw new Error('SIMULATED_RESPONSE_LOST_AFTER_COMMIT')
      return JSON.stringify({ ok: true, simulation: true, order })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'sky_demo_readback',
    description: 'Read-only simulated downstream query; not independent business evidence.',
    parameters: { requestId: { type: 'string', required: true, description: 'Simulated operation ID.' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      if (typeof args.requestId !== 'string' || !args.requestId.trim()) throw new Error('无效 requestId')
      const path = orderPath(args.requestId)
      const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
      return JSON.stringify({ simulation: true, committed: result !== null, record: result })
    },
  }))
}
