import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
  const run = (action, options = [], dataDir = dir, input) => spawnSync(process.execPath, [
    admin, action, '--data-dir', dataDir, ...options,
  ], { encoding: 'utf8', timeout: 5000, input })
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
  assert.equal(run('lookup', ['--tool', tool], missing).status, 1)
  assert.equal(run('lock-status', [], missing).status, 1)
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

test('record ID reconciliation reads evidence from stdin and requires the correct preview', t => {
  const { dir, ledger, run, claim, reconciliation } = fixture(t)
  ledger.lock()
  const ticket = claim()
  ledger.settle(ticket.key, ticket.executionId, false)
  ledger.close()
  const proof = JSON.stringify({
    source: 'test-readback',
    observedAt: new Date().toISOString(),
    summary: '独立核实模拟请求未提交且已终止。',
    reference: 'TEST-001',
  })
  const options = [
    '--record-id', ticket.key, '--execution-id', ticket.executionId,
    '--decision', 'not_committed', '--evidence-stdin',
  ]
  const runReview = (extra, evidence = proof) => run('reconcile', [...options, ...extra], dir, evidence)
  assert.match(runReview(confirm).stderr, /预览令牌/)
  assert.match(runReview(['--dry-run'], '{').stderr, /证据输入不是有效的 JSON/)
  assert.match(runReview(['--dry-run', '--tool', tool]).stderr, /不能与工具参数/)
  const preview = output(runReview(['--dry-run']))
  assert.equal(preview.nextState, 'released')
  const toolOptions = reconciliation(ticket, 'not_committed').slice(0, -2)
  const toolPreview = output(run('reconcile', [...toolOptions, '--evidence-stdin', '--dry-run'], dir, proof))
  assert.deepEqual(preview, toolPreview)
  assert.match(runReview([...confirm, '--expect-preview', '0'.repeat(64)]).stderr, /预览后已变化/)
  const result = output(runReview([...confirm, '--expect-preview', preview.previewToken]))
  assert.equal(result.state, 'released')
  assert.equal(ledger.inspectRecord(ticket.key).readbackReference, 'TEST-001')
  assert.equal(ledger.inspectRecord(ticket.key).readbackObservedAt, JSON.parse(proof).observedAt)
  ledger.lock()
  const corrected = claim({ requestId: 'private-example-order', corrected: true })
  assert.equal(corrected.ok, true)
  assert.equal(corrected.key, ticket.key)
  assert.notEqual(corrected.executionId, ticket.executionId)
  const { attempts } = ledger.read(ticket.key)
  assert.equal(attempts[0].executionId, ticket.executionId)
  assert.notEqual(attempts[0].fingerprint, attempts[1].fingerprint)
  ledger.close()
})

test('interactive review applies only after preview, confirmation and lock acquisition', t => {
  const { dir, ledger, run, claim } = fixture(t)
  ledger.lock()
  const ticket = claim()
  ledger.settle(ticket.key, ticket.executionId, false)
  const options = ['--record-id', ticket.key, '--execution-id', ticket.executionId, '--interactive']
  const fields = [
    'not_committed', '独立模拟回读', new Date().toISOString(), '已核实旧请求没有提交且已终止。', 'TEST-READBACK-002',
  ]
  const submit = [...fields, 'I_VERIFIED_READBACK']
  const review = (input, extra = []) => {
    return run('reconcile', [...options, ...extra], dir, input.join('\r\n') + '\r\n')
  }
  const before = readFileSync(ledger.pathFor(ticket.key))
  assert.match(review(submit).stderr, /账本锁/)
  ledger.close()
  assert.match(review(fields).stderr, /取消/)
  assert.match(review([...fields, 'n']).stderr, /取消/)
  const noZone = submit.map((field, index) => index === 2 ? field.slice(0, -1) : field)
  assert.match(review(noZone).stderr, /时区/)
  assert.match(review(submit, ['--evidence-stdin']).stderr, /仅接受/)
  assert.deepEqual(readFileSync(ledger.pathFor(ticket.key)), before)
  const result = review(submit)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /"nextState": "released"/)
  assert.match(result.stdout, /"state": "released"/)
  assert.doesNotMatch(result.stdout, /独立模拟回读|已核实旧请求/)
  assert.equal(ledger.inspectRecord(ticket.key).state, 'released')
  assert.deepEqual(readdirSync(dir), [ticket.key + '.json'])
})

test('business ID lookup matches legacy keys without saving or emitting the supplied ID', t => {
  const { dir, ledger, run, claim } = fixture(t)
  const key = '  合成订单-一  '
  ledger.lock()
  const ticket = claim({ requestId: key, unrelated: true })
  ledger.settle(ticket.key, ticket.executionId, false)
  ledger.close()
  const expected = createHash('sha256').update(tool + '\u0000' + key).digest('hex')
  assert.equal(ticket.key, expected)
  const before = readFileSync(ledger.pathFor(ticket.key))
  const lookup = run('lookup', ['--tool', tool], dir, key + '\n')
  assert.deepEqual(output(lookup), { found: true, record: ledger.inspectRecord(expected) })
  assert.doesNotMatch(lookup.stdout, /合成订单/)
  const jsonLookup = value => run('lookup', ['--tool', tool, '--key-stdin'], dir, JSON.stringify(value))
  assert.deepEqual(output(jsonLookup(key)), output(lookup))
  assert.deepEqual(output(jsonLookup(key.trim())), { found: false })
  assert.equal(jsonLookup({ requestId: key }).status, 1)
  assert.deepEqual(readFileSync(ledger.pathFor(ticket.key)), before)
  assert.doesNotMatch(before.toString(), /合成订单/)
  assert.equal(existsSync(ledger.lockPath), false)
})

test('lock diagnosis reports a visible PID and a crash leftover without modifying the lock', t => {
  const { dir, ledger, run, claim } = fixture(t)
  assert.deepEqual(output(run('lock-status')), { state: 'absent' })
  ledger.lock()
  const ticket = claim()
  const lock = output(run('lock-status'))
  assert.equal(lock.state, 'present')
  assert.equal(lock.pid, process.pid)
  assert.equal(lock.processStatus, 'visible')
  assert.deepEqual(Object.keys(lock).sort(), ['pid', 'processStatus', 'startedAt', 'state'])
  ledger.close()
  const module = new URL('../ledger.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const { Ledger } = await import(process.argv[1]); new Ledger(process.argv[2]).lock();', module, dir,
  ], { encoding: 'utf8', timeout: 5000 })
  assert.equal(child.status, 0, child.stderr)
  const before = readFileSync(ledger.lockPath)
  assert.equal(output(run('lock-status')).processStatus, 'not_found')
  assert.deepEqual(readFileSync(ledger.lockPath), before)
  assert.equal(ledger.inspectRecord(ticket.key).state, 'unknown')
  assert.throws(() => new Ledger(dir).lock(), /账本锁/)
  writeFileSync(ledger.lockPath, '{SYNTHETIC_PRIVATE_TEXT')
  const malformed = run('lock-status')
  assert.deepEqual(output(malformed), { state: 'invalid' })
  assert.doesNotMatch(malformed.stdout, /SYNTHETIC_PRIVATE_TEXT/)
})
