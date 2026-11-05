import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withMockPlugin } from './mock-dsh.js'

const input = requestId => ({ name: 'create_order', arguments: { requestId } })
const success = () => ({ isError: false, value: 'OK', content: [{ type: 'text', text: 'OK' }] })

function error(code, name) {
  return { isError: true, error: { info: { code, name } }, content: [] }
}

test('模拟插件启用后可用只读健康工具确认锁状态', async () => withMockPlugin(async ({ tools }) => {
  const health = JSON.parse(await tools.get('sky_recovery_health').execute({}))
  assert.equal(health.loaded, true)
  assert.equal(health.ledgerLocked, true)
  assert.deepEqual(health.protectedTools, ['create_order'])
}))

test('模拟遗留锁存在时插件仍启用，受保护工具一律拒绝', async () => withMockPlugin(async ({ event, tools }) => {
  const health = JSON.parse(await tools.get('sky_recovery_health').execute({}))
  assert.equal(health.loaded, true)
  assert.equal(health.ledgerLocked, false)
  let calls = 0
  const blocked = await event(input('locked-case'), async () => { calls++; return success() })
  assert.equal(blocked.error.info.code, 'SKY_LEDGER_UNAVAILABLE')
  assert.equal(calls, 0)
}, {
  beforeApply(dir) {
    const ledgerDir = join(dir, 'ledger')
    mkdirSync(ledgerDir)
    writeFileSync(join(ledgerDir, '.active.lock'), 'stale-lock')
  },
}))

test('工具提交后伪造完整 DSH 未派发标识仍被拦截', async () => withMockPlugin(async context => {
  const { event, ledger, dir } = context
  const store = new ledger.Ledger(join(dir, 'ledger'))
  let calls = 0
  const pairs = [
    ['ABORTED_BEFORE_DISPATCH', 'AbortError'],
    ['INVALID_ARGS', 'ToolArgsError'],
    ['UNKNOWN_TOOL', 'ToolNotFoundError'],
  ]
  for (const [code, name] of pairs) {
    const id = `${code}-case`
    const outcome = await event(input(id), async () => {
      calls++
      return error(code, name)
    })
    assert.equal(outcome.error.info.code, code)
    const blocked = await event(input(id), () => {
      assert.fail('The protected tool executed twice')
    })
    assert.equal(blocked.error.info.code, 'SKY_EXECUTION_UNKNOWN')
    const status = store.status('create_order', input(id).arguments, 'requestId')
    assert.equal(status.state, 'unknown')
    const attempt = store.read(status.key).attempts.at(-1)
    assert.equal(attempt.dshErrorCode, code)
    assert.equal(attempt.dshErrorName, name)
    assert.equal(attempt.reason, 'TOOL_OUTCOME_UNKNOWN')
  }
  assert.equal(calls, pairs.length)
}))

test('仅伪造官方错误码但错误名不符时不释放', async () => withMockPlugin(async ({ event }) => {
  const id = 'spoof-code'
  await event(input(id), async () => error('INVALID_ARGS', 'ToolBusinessError'))
  const blocked = await event(input(id), success)
  assert.equal(blocked.error.info.code, 'SKY_EXECUTION_UNKNOWN')
}))

test('落盘结算异常时不改写成功回执，且后续调用被阻止', async () => withMockPlugin(async ({ event, ledger, dir }) => {
  const original = ledger.Ledger.prototype.settle
  ledger.Ledger.prototype.settle = () => { throw new Error('simulated disk failure') }
  try {
    const returned = await event(input('disk-case'), success)
    assert.equal(returned.isError, false)
    assert.equal(new ledger.Ledger(join(dir, 'ledger')).status(
      'create_order', { requestId: 'disk-case' }, 'requestId',
    ).state, 'unknown')
    const blocked = await event(input('disk-case'), success)
    assert.equal(blocked.error.info.code, 'SKY_EXECUTION_UNKNOWN')
  } finally {
    ledger.Ledger.prototype.settle = original
  }
}))

test('输入参数错误使用独立错误码，不冒充磁盘损坏', async () => withMockPlugin(async ({ event }) => {
  const invalid = await event({ name: 'create_order', arguments: { requestId: '' } }, success)
  assert.equal(invalid.error.info.code, 'SKY_KEY_MISSING')
  const tooLarge = await event({ name: 'create_order', arguments: {
    requestId: 'large', data: 'x'.repeat(66000),
  } }, success)
  assert.equal(tooLarge.error.info.code, 'SKY_ARGUMENT_TOO_LARGE')
}))

test('非本进程拥有的锁不能被当前实例清理或覆盖', async () => withMockPlugin(async ({ ledger, dir }) => {
  const original = readFileSync(join(dir, 'ledger', '.active.lock'), 'utf8')
  assert.ok(original.includes('owner'))
  const competing = new ledger.Ledger(join(dir, 'ledger'))
  assert.equal(competing.tryLock(), false)
  assert.equal(competing.locked, false)
}))


test('真实锁文件丢失后，健康工具与状态查询都不能继续报告锁定', async () => withMockPlugin(
  async ({ event, tools, dir }) => {
    const healthTool = tools.get('sky_recovery_health')
    const statusTool = tools.get('sky_recovery_status')
    assert.equal(JSON.parse(await healthTool.execute({})).ledgerLocked, true)
    unlinkSync(join(dir, 'ledger', '.active.lock'))
    const health = JSON.parse(await healthTool.execute({}))
    assert.equal(health.loaded, true)
    assert.equal(health.ledgerLocked, false)
    assert.match(health.ledgerNote, /\.active\.lock/)
    const status = JSON.parse(await statusTool.execute({
      tool: 'create_order', argumentsJson: '{"requestId":"lock-lost"}',
    }))
    assert.equal(status.ledgerLocked, false)
    let calls = 0
    const result = await event(input('lock-lost'), async () => { calls++; return success() })
    assert.equal(result.error.info.code, 'SKY_LEDGER_UNAVAILABLE')
    assert.equal(calls, 0)
  },
))

test('真实锁文件所有权被改写后，受保护工具停用且健康工具给出原因', async () => withMockPlugin(
  async ({ event, tools, dir }) => {
    const path = join(dir, 'ledger', '.active.lock')
    const current = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...current, owner: 'external-instance' }))
    const result = await event(input('altered-lock'), success)
    assert.equal(result.error.info.code, 'SKY_LEDGER_UNAVAILABLE')
    const health = JSON.parse(await tools.get('sky_recovery_health').execute({}))
    assert.equal(health.ledgerLocked, false)
    assert.match(health.ledgerNote, /所有权不匹配/)
  },
))
