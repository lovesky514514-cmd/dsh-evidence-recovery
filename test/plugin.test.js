import test from 'node:test'
import assert from 'node:assert/strict'
import { withMockPlugin } from './mock-dsh.js'

test('插件装载、只读查询和成功后拦截重试', async () => withMockPlugin(async ({ event, tool }) => {
  assert.equal(tool.name, 'sky_recovery_status')
  let count = 0
  const exec = { name: 'create_order', arguments: { requestId: 'case-01' } }
  const next = async () => {
    count++
    return { isError: false, content: [{ type: 'text', text: 'OK' }] }
  }
  const first = await event(exec, next)
  assert.equal(first.isError, false)
  const second = await event(exec, next)
  assert.equal(second.error.info.code, 'SKY_ALREADY_EXECUTED')
  assert.equal(count, 1)
  const state = JSON.parse(await tool.execute({
    tool: 'create_order',
    argumentsJson: '{"requestId":"case-01"}',
  }))
  assert.equal(state.state, 'succeeded')
}))

test('规则之外的工具行为不变', async () => withMockPlugin(async ({ event }) => {
  let count = 0
  const result = await event({ name: 'greet', arguments: {} }, async () => {
    count++
    return 'hello'
  })
  assert.equal(result, 'hello')
  assert.equal(count, 1)
}))

test('工具抛错后保留 unknown，阻止重复操作', async () => withMockPlugin(async ({ event }) => {
  let count = 0
  const exec = { name: 'create_order', arguments: { requestId: 'case-02' } }
  await assert.rejects(async () => {
    await event(exec, async () => {
      count++
      throw new Error('connection dropped')
    })
  }, /connection dropped/)
  const blocked = await event(exec, async () => {
    count++
    return { isError: false }
  })
  assert.equal(blocked.error.info.code, 'SKY_EXECUTION_UNKNOWN')
  assert.equal(count, 1)
}))
