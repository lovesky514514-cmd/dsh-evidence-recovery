import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Ledger } from '../ledger.js'

const admin = fileURLToPath(new URL('../admin.js', import.meta.url))
const tool = 'create_order'
const confirm = ['--confirm', 'I_VERIFIED_READBACK']

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sky-admin-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'ledger')
  const ledger = new Ledger(dir)
  const argsFile = join(root, 'args.json')
  const evidenceFile = join(root, 'evidence.json')
  const args = { requestId: 'private-example-order' }
  writeFileSync(argsFile, JSON.stringify(args))
  function saveEvidence(summary = 'The independent test order readback confirmed the operation.') {
    writeFileSync(evidenceFile, JSON.stringify({
      source: 'private-example-source', observedAt: new Date().toISOString(), summary,
    }))
  }
  const run = (action, options = [], dataDir = dir) => spawnSync(process.execPath, [
    admin, action, '--data-dir', dataDir, ...options,
  ], { encoding: 'utf8', timeout: 5000 })
  const reconciliation = (ticket, decision = 'committed') => [
    '--tool', tool, '--args-file', argsFile, '--key-arg', 'requestId', '--execution-id', ticket.executionId,
    '--decision', decision, '--evidence-file', evidenceFile,
  ]
  const claim = (input = args) => ledger.claim(tool, input, 'requestId')
  return { root, dir, ledger, run, claim, saveEvidence, reconciliation }
}

function output(result, expected = 0) {
  assert.equal(result.status, expected, result.stderr)
  return JSON.parse(result.stdout)
}

test('pending list classifies interrupted and legacy records while redacting untrusted metadata', t => {
  const { ledger, run, claim } = fixture(t)
  ledger.lock()
  const unknown = claim()
  ledger.settle(unknown.key, unknown.executionId, false, 'TOOL_OUTCOME_UNKNOWN', {
    code: 'PRIVATE-SYNTHETIC-VALUE', name: 'PRIVATE-ERROR-NAME',
  })
  const running = claim({ requestId: 'running-example' })
  const success = claim({ requestId: 'success-example' })
  ledger.settle(success.key, success.executionId, true)
  const legacy = claim({ requestId: 'legacy-example' })
  const legacyRecord = ledger.read(legacy.key)
  legacyRecord.state = 'released'
  Object.assign(legacyRecord.attempts[0], {
    state: 'released', reason: 'DSH_NOT_DISPATCHED', dshErrorCode: 'INVALID_ARGS',
  })
  ledger.write(legacyRecord)

  const result = run('list', ['--pending'])
  const { records, errors, complete } = output(result)
  assert.equal(complete, true)
  assert.deepEqual(errors, [])
  const byId = new Map(records.map(record => [record.recordId, record]))
  assert.deepEqual([...byId.keys()].sort(), [unknown.key, running.key, legacy.key].sort())
  assert.equal(byId.get(unknown.key).diagnosticCode, 'OTHER_TOOL_ERROR')
  assert.equal(byId.get(running.key).recordedState, 'running')
  assert.equal(byId.get(legacy.key).legacyRelease, true)
  assert.equal(byId.get(legacy.key).diagnosticCode, 'INVALID_ARGS')
  assert.doesNotMatch(result.stdout, /private-example-order|PRIVATE-SYNTHETIC|PRIVATE-ERROR-NAME|fingerprint/)
  assert.deepEqual(output(run('inspect', ['--record-id', unknown.key])), byId.get(unknown.key))
  assert.equal(run('inspect', ['--record-id', unknown.key, '--tool', tool]).status, 1)
  assert.equal(run('inspect', ['--record-id', '../sample']).status, 1)
  ledger.close()
})

test('a partial list fails visibly and exposes no malformed ledger content', t => {
  const { ledger, run, claim } = fixture(t)
  ledger.lock()
  const pending = claim()
  const damagedId = '1'.repeat(64)
  writeFileSync(ledger.pathFor(damagedId), '{"private fixture text":')
  const result = run('list', ['--pending'])
  const { records, errors, complete } = output(result, 2)
  assert.equal(complete, false)
  assert.equal(records[0].recordId, pending.key)
  assert.deepEqual(errors, [{ recordId: damagedId, code: 'SKY_LEDGER_RECORD_UNREADABLE' }])
  assert.doesNotMatch(result.stdout + result.stderr, /private fixture text/)
  ledger.close()
})

test('read-only commands never initialize a missing ledger', t => {
  const { root, run, ledger, claim, saveEvidence, reconciliation } = fixture(t)
  ledger.lock()
  const ticket = claim()
  ledger.close()
  saveEvidence()
  const missing = join(root, 'missing')
  assert.equal(run('list', ['--pending'], missing).status, 1)
  assert.equal(run('inspect', ['--record-id', ticket.key], missing).status, 1)
  assert.equal(run('reconcile', [...reconciliation(ticket), '--dry-run'], missing).status, 1)
  assert.equal(existsSync(missing), false)
})

test('preview is read-only with or without a held lock and matches the confirmed update', t => {
  const { dir, ledger, run, claim, saveEvidence, reconciliation } = fixture(t)
  ledger.lock()
  const ticket = claim()
  ledger.settle(ticket.key, ticket.executionId, false, 'TOOL_OUTCOME_UNKNOWN', { code: 'TOOL_TIMEOUT' })
  saveEvidence()
  const options = reconciliation(ticket)
  const path = ledger.pathFor(ticket.key)
  const before = readFileSync(path)
  const locked = output(run('reconcile', [...options, '--dry-run']))
  assert.equal(locked.state, 'unknown')
  assert.equal(locked.nextState, 'succeeded')
  assert.equal(locked.diagnosticCode, 'TOOL_TIMEOUT')
  assert.equal(ledger.checkOwner(), true)
  assert.equal(run('reconcile', [...options, ...confirm, '--expect-preview', locked.previewToken]).status, 1)
  ledger.close()
  const unlocked = output(run('reconcile', [...options, '--dry-run']))
  assert.deepEqual(unlocked, locked)
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(readdirSync(dir), [ticket.key + '.json'])
  assert.doesNotMatch(JSON.stringify(locked), /private-example-source|independent test order readback/)
  assert.equal(run('reconcile', [...options, '--expect-preview', unlocked.previewToken]).status, 1)
  const applied = output(run('reconcile', [...options, ...confirm, '--expect-preview', unlocked.previewToken]))
  assert.equal(applied.state, unlocked.nextState)
  ledger.lock()
  assert.equal(claim().code, 'SKY_ALREADY_EXECUTED')
  ledger.close()
})

test('expected preview rejects a changed record or changed evidence', t => {
  const { ledger, run, claim, saveEvidence, reconciliation } = fixture(t)
  ledger.lock()
  const ticket = claim()
  saveEvidence()
  const options = reconciliation(ticket, 'not_committed')
  const before = output(run('reconcile', [...options, '--dry-run']))
  assert.equal(before.recordedState, 'running')
  assert.equal(before.nextState, 'released')
  ledger.settle(ticket.key, ticket.executionId, false)
  ledger.close()
  saveEvidence()
  const apply = token => run('reconcile', [...options, ...confirm, '--expect-preview', token])
  assert.match(apply(before.previewToken).stderr, /预览后已变化/)
  const after = output(run('reconcile', [...options, '--dry-run']))
  saveEvidence('A different independent test observation was entered after the preview.')
  assert.match(apply(after.previewToken).stderr, /预览后已变化/)
  assert.equal(ledger.inspectRecord(ticket.key).state, 'unknown')
  assert.equal(run('reconcile', [...reconciliation({ executionId: 'stale' }), '--dry-run']).status, 1)
  saveEvidence('maybe')
  assert.match(run('reconcile', [...options, '--dry-run']).stderr, /证据/)
})
