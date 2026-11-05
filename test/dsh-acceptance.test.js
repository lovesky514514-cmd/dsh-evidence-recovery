import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { withMockPlugin } from './mock-dsh.js'

function callWithId(requestId, extra = {}) {
  return {
    name: 'create_order',
    arguments: { requestId, ...extra },
    signal: new AbortController().signal,
  }
}

test('响应丢失后禁止重试；停机对账；状态跨重启保存', async () => withMockPlugin(async (context) => {
  const { dir, tools, event, ledger, closePlugin } = context
  let commits = 0
  const failed = await event(callWithId('case-100'), async () => {
    commits++
    throw new Error('ack lost')
  }).then(() => null, error => error)
  assert.match(failed.message, /ack lost/)
  assert.equal(commits, 1)

  const blocked = await event(callWithId('case-100'), async () => {
    commits++
    return { isError: false }
  })
  assert.equal(blocked.error.info.code, 'SKY_EXECUTION_UNKNOWN')
  assert.equal(commits, 1)

  const statusTool = tools.get('sky_recovery_status')
  const state = JSON.parse(await statusTool.execute({
    tool: 'create_order',
    argumentsJson: '{"requestId":"case-100"}',
  }))
  assert.equal(state.state, 'unknown')

  const administrator = new ledger.Ledger(join(dir, 'ledger'))
  assert.throws(() => administrator.lock(), /账本锁/)
  // Offline reconciliation shares the same exclusive lock as the plugin.
  closePlugin()
  administrator.lock()
  const evidence = {
    source: 'simulated-test-store',
    observedAt: new Date().toISOString(),
    summary: 'Readback confirms the simulated order exists and was committed',
  }
  const settled = administrator.reconcile(
    'create_order', { requestId: 'case-100' }, 'requestId',
    state.executionId, 'committed', evidence,
  )
  assert.equal(settled.state, 'succeeded')
  administrator.close()

  const reloaded = new ledger.Ledger(join(dir, 'ledger'))
  reloaded.lock()
  assert.equal(reloaded.status('create_order', { requestId: 'case-100' }, 'requestId').state, 'succeeded')
  const blockedAgain = reloaded.claim('create_order', { requestId: 'case-100' }, 'requestId')
  assert.equal(blockedAgain.code, 'SKY_ALREADY_EXECUTED')
  reloaded.close()
}))

test('缺失 keyArg 拒绝执行，不退化为参数指纹', async () => withMockPlugin(async ({ event }) => {
  let actual = 0
  const result = await event({ name: 'create_order', arguments: { sku: 'A' } }, async () => {
    actual++
    return { isError: false }
  })
  assert.equal(result.error.info.code, 'SKY_KEY_MISSING')
  assert.equal(actual, 0)
}))

test('相同业务标识但参数不同，拒绝第二次提交', async () => withMockPlugin(async ({ event }) => {
  let calls = 0
  const execute = async () => { calls++; return { isError: false } }
  await event(callWithId('case-200', { qty: 1 }), execute)
  const blocked = await event(callWithId('case-200', { qty: 999 }), execute)
  assert.equal(blocked.error.info.code, 'SKY_KEY_CONFLICT')
  assert.equal(calls, 1)
}))
