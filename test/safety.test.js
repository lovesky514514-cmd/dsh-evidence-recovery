import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ledger, LedgerInputError, identity } from '../ledger.js'
import { withMockPlugin } from './mock-dsh.js'

const tool = 'create_order'
const args = { requestId: 'example' }
const exec = { name: tool, arguments: args }
const ok = () => ({ isError: false })
const evidence = () => ({
  source: 'simulated-test-store',
  observedAt: new Date().toISOString(),
  summary: 'The simulated downstream query confirms that the order is absent.',
})

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'sky-safety-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('legacy metadata release is blocked until fresh offline reconciliation', t => {
  const ledger = new Ledger(fixture(t))
  ledger.lock()
  const ticket = ledger.claim(tool, args)
  const path = ledger.pathFor(ticket.key)
  const record = JSON.parse(readFileSync(path))
  record.state = 'released'
  Object.assign(record.attempts[0], {
    state: 'released',
    reason: 'DSH_NOT_DISPATCHED',
    dshErrorCode: 'INVALID_ARGS',
    finishedAt: record.updatedAt,
  })
  writeFileSync(path, JSON.stringify(record))
  ledger.close()

  const restarted = new Ledger(ledger.dir)
  restarted.lock()
  assert.equal(restarted.status(tool, args).state, 'unknown')
  assert.equal(restarted.claim(tool, args).code, 'SKY_EXECUTION_UNKNOWN')
  assert.equal(restarted.reconcile(tool, args, undefined, ticket.executionId, 'not_committed', evidence())
    .state, 'released')
  assert.equal(restarted.read(ticket.key).attempts[0].dshErrorCode, 'INVALID_ARGS')
  assert.notEqual(restarted.claim(tool, args).executionId, ticket.executionId)
  restarted.close()
})

test('malformed released record fails closed', t => {
  const ledger = new Ledger(fixture(t))
  ledger.lock()
  const ticket = ledger.claim(tool, args)
  const path = ledger.pathFor(ticket.key)
  const record = JSON.parse(readFileSync(path))
  record.state = 'released'
  record.attempts[0].state = 'released'
  writeFileSync(path, JSON.stringify(record))
  assert.throws(() => ledger.claim(tool, args), /账本损坏/)
  ledger.close()
})

test('directory links in ancestors are refused before creating storage', t => {
  const dir = fixture(t)
  const target = join(dir, 'target')
  const link = join(dir, 'link')
  mkdirSync(target)
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => new Ledger(join(link, 'ledger')), /链接/)
  assert.equal(existsSync(join(target, 'ledger')), false)
})

test('a replaced ledger directory invalidates ownership', t => {
  const dir = fixture(t)
  const ledger = new Ledger(join(dir, 'ledger'))
  ledger.lock()
  renameSync(ledger.dir, join(dir, 'old-ledger'))
  mkdirSync(ledger.dir)
  assert.equal(ledger.checkOwner(), false)
  assert.throws(() => ledger.lock(), /已被替换/)
})

test('a byte-identical replacement lock is refused and kept', t => {
  const ledger = new Ledger(fixture(t))
  ledger.lock()
  const content = readFileSync(ledger.lockPath)
  renameSync(ledger.lockPath, join(ledger.dir, 'old-lock'))
  writeFileSync(ledger.lockPath, content)
  assert.equal(ledger.checkOwner(), false)
  ledger.close()
  assert.deepEqual(readFileSync(ledger.lockPath), content)
})

test('lock loss stays latched even if the path is available again', t => {
  const ledger = new Ledger(fixture(t))
  ledger.lock()
  unlinkSync(ledger.lockPath)
  assert.equal(ledger.checkOwner(), false)
  assert.equal(ledger.tryLock(), false)
  assert.equal(existsSync(ledger.lockPath), false)
})

test('bad key ownership and deep or sparse input produce input errors', () => {
  Object.prototype.skyTestInheritedKey = 'inherited'
  try {
    assert.throws(() => identity(tool, {}, 'skyTestInheritedKey'), { code: 'SKY_KEY_MISSING' })
  } finally {
    delete Object.prototype.skyTestInheritedKey
  }
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => identity(tool, cyclic), LedgerInputError)
  assert.throws(() => identity(tool, { sparse: new Array(1) }), LedgerInputError)
})

test('startup I/O failure blocks protected calls without exposing the storage path', () => withMockPlugin(
  async ({ event, dir, tools }) => {
    const blocked = await event(exec, () => assert.fail('Unexpected dispatch'))
    assert.equal(blocked.error.info.code, 'SKY_LEDGER_UNAVAILABLE')
    assert.equal(blocked.error.message.includes(dir), false)
    const health = JSON.parse(await tools.get('sky_recovery_health').execute({}))
    assert.equal(health.ledgerLocked, false)
  },
  { beforeApply(dir) { writeFileSync(join(dir, 'ledger'), 'file') } },
))

test('invalid protection rules warn once and duplicates block dispatch', () => {
  const warnings = []
  return withMockPlugin(
    async ({ event, tools }) => {
      const health = JSON.parse(await tools.get('sky_recovery_health').execute({}))
      assert.deepEqual(health.invalidRules, [tool, 'sky_recovery_health', ''])
      assert.equal(warnings.length, 1)
      assert.match(warnings[0], /SKY_INVALID_RULE/)
      const result = await event(exec, () => assert.fail('Unexpected dispatch'))
      assert.equal(result.error.info.code, 'SKY_INVALID_RULE')
      assert.equal((await event({ name: 'sky_recovery_health', arguments: {} }, ok)).isError, false)
    },
    {
      logger: { warn(message) { warnings.push(message) } },
      config: { rules: [{ tool }, { tool }, { tool: 'sky_recovery_health' }, { tool: '' }] },
    },
  )
})

test('disposing stops new calls and retains the lock until an in-flight call settles', () => withMockPlugin(
  async ({ event, closePlugin, dir }) => {
    const { promise, resolve } = Promise.withResolvers()
    const call = event(exec, () => promise)
    try {
      closePlugin()
      const reopened = new Ledger(join(dir, 'ledger'))
      assert.equal(reopened.tryLock(), false)
      assert.equal((await event(exec, ok)).error.info.code, 'SKY_LEDGER_UNAVAILABLE')
    } finally {
      resolve(ok())
      await call
    }
    const reopened = new Ledger(join(dir, 'ledger'))
    assert.equal(reopened.status(tool, args, 'requestId').state, 'succeeded')
    assert.equal(reopened.tryLock(), true)
    reopened.close()
  },
))

for (const code of ['ABORTED', 'TOOL_TIMEOUT']) {
  test(code + ' after a simulated commit leaves the operation unknown', () => withMockPlugin(
    async ({ event, ledger, dir }) => {
      let commits = 0
      const result = { isError: true, error: { info: { code, name: 'TestError' } } }
      assert.equal(await event(exec, () => {
        commits++
        return result
      }), result)
      assert.equal((await event(exec, () => assert.fail('Unexpected retry'))).error.info.code,
        'SKY_EXECUTION_UNKNOWN')
      assert.equal(commits, 1)
      const store = new ledger.Ledger(join(dir, 'ledger'))
      const status = store.status(tool, args, 'requestId')
      assert.equal(store.read(status.key).attempts[0].dshErrorCode, code)
    },
  ))
}

test('actual demo tools persist the simulated commit and expose only readback after loss', () => withMockPlugin(
  async ({ demo, context, tools, event, dir }) => {
    demo.apply(context, { dataDir: join(dir, 'orders') })
    const create = tools.get('sky_demo_create_order')
    const readback = tools.get('sky_demo_readback')
    const request = { requestId: 'simulated', outcome: 'lost' }
    const call = { name: create.name, arguments: request }
    await assert.rejects(event(call, () => create.execute(request)), /SIMULATED_RESPONSE_LOST_AFTER_COMMIT/)
    const blocked = await event(call, () => assert.fail('Unexpected retry'))
    assert.equal(blocked.error.info.code, 'SKY_EXECUTION_UNKNOWN')
    assert.equal(JSON.parse(await readback.execute(request)).committed, true)
    assert.deepEqual([...tools.keys()].sort(), [
      'sky_demo_create_order', 'sky_demo_readback', 'sky_recovery_health', 'sky_recovery_status',
    ])
  },
  { config: { rules: [{ tool: 'sky_demo_create_order', keyArg: 'requestId' }] } },
))

test('offline admin CLI rejects held lock, stale generation and weak evidence before reconciling', t => {
  const dir = fixture(t)
  const ledger = new Ledger(dir)
  const proof = join(dir, 'proof.json')
  const argsFile = join(dir, 'args.json')
  writeFileSync(argsFile, JSON.stringify(args))
  const admin = fileURLToPath(new URL('../admin.js', import.meta.url))
  ledger.lock()
  const ticket = ledger.claim(tool, args)
  ledger.settle(ticket.key, ticket.executionId, false)
  function reconcile(id, body) {
    writeFileSync(proof, JSON.stringify(body))
    return spawnSync(process.execPath, [
      admin, 'reconcile', '--data-dir', dir, '--tool', tool, '--args-file', argsFile,
      '--decision', 'not_committed', '--execution-id', id, '--evidence-file', proof,
      '--confirm', 'I_VERIFIED_READBACK',
    ], { encoding: 'utf8', timeout: 5000 })
  }

  const held = reconcile(ticket.executionId, evidence())
  assert.equal(held.status, 1)
  assert.match(held.stderr, /账本锁/)
  ledger.close()
  const stale = reconcile('stale-generation', evidence())
  assert.equal(stale.status, 1)
  assert.match(stale.stderr, /代次/)
  const weak = reconcile(ticket.executionId, { ...evidence(), summary: 'maybe' })
  assert.equal(weak.status, 1)
  assert.match(weak.stderr, /证据/)
  const early = reconcile(ticket.executionId, { ...evidence(), observedAt: '2000-01-01T00:00:00Z' })
  assert.equal(early.status, 1)
  assert.match(early.stderr, /observedAt/)
  assert.equal(ledger.status(tool, args).state, 'unknown')
  const released = reconcile(ticket.executionId, evidence())
  assert.equal(released.status, 0, released.stderr)
  assert.equal(JSON.parse(released.stdout).state, 'released')
  assert.equal(existsSync(ledger.lockPath), false)
})
