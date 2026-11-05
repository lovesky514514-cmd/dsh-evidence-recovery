import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger, identity } from '../ledger.js'

function withLedger(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sky-recovery-'))
  const ledger = new Ledger(dir)
  ledger.lock()
  try {
    return fn(ledger, dir)
  } finally {
    ledger.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('排序不改变参数指纹；不支持 undefined 等模糊类型', () => {
  assert.deepEqual(identity('create', { a: 1, b: 2 }), identity('create', { b: 2, a: 1 }))
  assert.throws(() => identity('create', { a: undefined }))
})

test('首次执行先落盘；成功后重复执行被拒绝', () => withLedger(l => {
  const x = l.claim('create_order', { orderId: '1' })
  assert.equal(x.ok, true)
  assert.equal(l.status('create_order', { orderId: '1' }).state, 'unknown')
  l.settle(x.key, x.executionId, true)
  assert.equal(l.status('create_order', { orderId: '1' }).state, 'succeeded')
  assert.equal(l.claim('create_order', { orderId: '1' }).code, 'SKY_ALREADY_EXECUTED')
}))

test('异常与进程重启均保留 unknown；不能盲目重试', () => withLedger((l, dir) => {
  const x = l.claim('create_order', { orderId: '2' })
  l.settle(x.key, x.executionId, false)
  const reopened = new Ledger(dir)
  assert.equal(reopened.status('create_order', { orderId: '2' }).state, 'unknown')
  assert.equal(l.claim('create_order', { orderId: '2' }).code, 'SKY_EXECUTION_UNKNOWN')
}))

test('同业务身份不同参数不能被另一请求覆盖', () => withLedger(l => {
  l.claim('create_order', { requestId: 'x', amount: 1 }, 'requestId')
  assert.equal(l.claim('create_order', { requestId: 'x', amount: 2 }, 'requestId').code, 'SKY_KEY_CONFLICT')
}))

test('对账必须匹配执行代次与证据；确认未提交后才允许下一次', () => withLedger(l => {
  const args = { orderId: '42' }
  const ticket = l.claim('create_order', args)
  const evidence = {
    source: 'independent-order-query',
    observedAt: new Date().toISOString(),
    summary: 'Business record absent in authoritative system.',
  }
  assert.throws(() => l.reconcile('create_order', args, undefined, 'old-execution', 'not_committed', evidence))
  assert.throws(() => l.reconcile('create_order', args, undefined, ticket.executionId, 'not_committed', {}))
  const result = l.reconcile('create_order', args, undefined, ticket.executionId, 'not_committed', evidence)
  assert.equal(result.state, 'released')
  const next = l.claim('create_order', args)
  assert.equal(next.ok, true)
  assert.notEqual(next.executionId, ticket.executionId)
  assert.throws(() => l.reconcile('create_order', args, undefined, ticket.executionId, 'committed', evidence))
}))

test('确认已提交将阻止再次执行', () => withLedger(l => {
  const args = { id: 5 }
  const x = l.claim('notify', args)
  const evidence = {
    source: 'verified-message-api',
    observedAt: new Date().toISOString(),
    summary: 'Delivery has been independently confirmed.',
  }
  l.reconcile('notify', args, undefined, x.executionId, 'committed', evidence)
  assert.equal(l.claim('notify', args).code, 'SKY_ALREADY_EXECUTED')
}))

test('锁禁止多实例同时改写账本', () => withLedger((l, dir) => {
  const another = new Ledger(dir)
  assert.throws(() => another.lock(), /账本锁/)
}))

test('删除锁文件后关闭不会抛错，且不会创建新锁', () => withLedger(l => {
  unlinkSync(l.lockPath)
  assert.doesNotThrow(() => l.close())
  assert.equal(existsSync(l.lockPath), false)
}))


test('运行中丢失锁文件时，健康检查立即降级且不可重新取得锁', () => withLedger(l => {
  assert.equal(l.checkOwner(), true)
  unlinkSync(l.lockPath)
  assert.equal(l.checkOwner(), false)
  assert.equal(l.locked, false)
  assert.match(l.lockNote, /\.active\.lock.*消失/)
  assert.throws(() => l.claim('create', { requestId: 'lost-lock' }), /账本锁/)
  assert.equal(existsSync(l.lockPath), false)
}))

test('运行中锁所有权被替换时降级，不能删除其他实例的锁', () => withLedger(l => {
  const contents = JSON.parse(readFileSync(l.lockPath, 'utf8'))
  writeFileSync(l.lockPath, JSON.stringify({ ...contents, owner: 'another-owner' }))
  assert.equal(l.checkOwner(), false)
  assert.match(l.lockNote, /所有权不匹配/)
  assert.equal(l.locked, false)
  l.close()
  assert.equal(existsSync(l.lockPath), true)
}))

test('运行中锁内容损坏时降级，保留文件等待人工核查', () => withLedger(l => {
  writeFileSync(l.lockPath, '{')
  assert.equal(l.checkOwner(), false)
  assert.match(l.lockNote, /内容损坏/)
  assert.equal(existsSync(l.lockPath), true)
  assert.throws(() => l.claim('create', {}), /账本锁/)
}))
