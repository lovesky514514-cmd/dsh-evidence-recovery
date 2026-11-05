import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, readSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const DEFAULT_DIR = join(homedir(), '.sky-evidence-recovery')
const MAX_ARGUMENT_BYTES = 65536
const MAX_RECORD_BYTES = 524288
const sha = value => createHash('sha256').update(value).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/
const recordFilename = /^[a-f0-9]{64}\.json$/
const executionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const evidenceReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
const attemptStates = ['running', 'unknown', 'succeeded', 'released']
const parseDate = value => typeof value === 'string' ? Date.parse(value) : NaN
const diagnosticCodes = new Set([
  'ABORTED', 'ABORTED_BEFORE_DISPATCH', 'INVALID_ARGS', 'INVALID_TOOL_OUTPUT', 'TOOL_TIMEOUT', 'UNKNOWN_TOOL',
])

export class LedgerInputError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LedgerInputError'
    this.code = code
  }
}

function canonical(value, depth = 0) {
  if (depth > 64) throw new LedgerInputError('SKY_INVALID_INPUT', '工具参数嵌套过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  const child = item => canonical(item, depth + 1)
  if (Array.isArray(value)) return '[' + Array.from(value, child).join(',') + ']'
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + child(value[key]))
    return '{' + entries.join(',') + '}'
  }
  throw new LedgerInputError('SKY_INVALID_INPUT', '工具参数包含无法安全序列化的值')
}

function businessKey(tool, businessId) {
  if (typeof businessId !== 'string' || !businessId.trim() || businessId.length > 1024) {
    throw new LedgerInputError('SKY_KEY_MISSING', '缺少有效业务身份字段')
  }
  return sha(tool + '\u0000' + businessId)
}

export function identity(tool, args, keyArg) {
  if (typeof tool !== 'string' || !tool || !args || typeof args !== 'object' || Array.isArray(args)) {
    throw new LedgerInputError('SKY_INVALID_INPUT', '工具名称或参数格式无效')
  }
  const normalized = canonical({ tool, args })
  if (Buffer.byteLength(normalized, 'utf8') > MAX_ARGUMENT_BYTES) {
    throw new LedgerInputError('SKY_ARGUMENT_TOO_LARGE', '工具参数超出保护上限')
  }
  const fingerprint = sha(normalized)
  const businessId = Object.hasOwn(args, keyArg) ? args[keyArg] : undefined
  const key = keyArg ? businessKey(tool, businessId) : sha(tool + '\u0000' + fingerprint)
  return { key, fingerprint }
}

function directoryChain(dir, create = false) {
  const parent = dirname(dir)
  const ancestors = parent === dir ? [] : directoryChain(parent, create)
  let stat
  try {
    stat = lstatSync(dir, { bigint: true })
  } catch (error) {
    if (!create || error.code !== 'ENOENT') throw error
    try {
      mkdirSync(dir, { mode: 0o700 })
    } catch (mkdirError) {
      if (mkdirError.code !== 'EEXIST') throw mkdirError
    }
    stat = lstatSync(dir, { bigint: true })
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('账本目录路径包含非目录或链接')
  return [...ancestors, stat]
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino
}

function syncDirectory(dir) {
  // Windows does not expose a portable directory fsync through Node.
  if (process.platform === 'win32') return
  const fd = openSync(dir, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeNew(path, content) {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, content)
    fsyncSync(fd)
    return fstatSync(fd, { bigint: true })
  } finally {
    closeSync(fd)
  }
}

function readJson(path, limit) {
  let stat
  try {
    stat = lstatSync(path, { bigint: true })
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(limit)) {
    throw new Error('账本文件类型或大小异常')
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (!sameFile(stat, fstatSync(fd, { bigint: true }))) throw new Error('账本文件已被替换')
    const buffer = Buffer.alloc(Number(stat.size) + 1)
    let offset = 0
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null)
      if (!bytes) break
      offset += bytes
    }
    const after = lstatSync(path, { bigint: true })
    if (!sameFile(stat, after) || after.mtimeNs !== stat.mtimeNs || offset !== Number(stat.size)) {
      throw new Error('账本文件在读取期间发生变化')
    }
    return { stat, value: JSON.parse(buffer.subarray(0, offset).toString('utf8')) }
  } finally {
    closeSync(fd)
  }
}

function legacyRelease(attempt) {
  return attempt.state === 'released' && attempt.reason === 'DSH_NOT_DISPATCHED'
}

function stateOf(record) {
  // Old releases based on result metadata require fresh operator evidence.
  const current = record.attempts.at(-1)
  if (record.state === 'running' || (legacyRelease(current) && !current.reconciledAt)) return 'unknown'
  return record.state
}

function validRecord(record, key) {
  if (!record || record.version !== 1 || record.key !== key || !hashPattern.test(record.fingerprint) ||
      typeof record.tool !== 'string' || !record.tool || !Number.isFinite(parseDate(record.updatedAt)) ||
      !Array.isArray(record.attempts) || !record.attempts.length) return false

  const current = record.attempts.at(-1)
  return record.attempts.every(attempt => attempt && typeof attempt.executionId === 'string' &&
    attempt.executionId && Number.isFinite(parseDate(attempt.startedAt)) && attemptStates.includes(attempt.state) &&
    (attempt.fingerprint === undefined || hashPattern.test(attempt.fingerprint)) &&
    (!attempt.reconciledAt ||
      (Number.isFinite(parseDate(attempt.reconciledAt)) && hashPattern.test(attempt.readbackEvidenceSha256))) &&
    (attempt.state !== 'released' || legacyRelease(attempt) || attempt.reconciledAt)) &&
    current.executionId === record.executionId && current.state === record.state
}

function operatorSummary(record) {
  const current = record.attempts.at(-1)
  const state = stateOf(record)
  const { dshErrorCode, reason } = current
  if (!executionIdPattern.test(record.executionId)) throw new Error('账本执行代次格式无效')
  const summary = {
    recordId: record.key,
    tool: record.tool,
    executionId: record.executionId,
    state,
    recordedState: record.state,
    updatedAt: new Date(parseDate(record.updatedAt)).toISOString(),
    legacyRelease: state === 'unknown' && legacyRelease(current),
    reason: ['TOOL_OUTCOME_UNKNOWN', 'TOOL_DISPATCH_THROWN', 'DSH_NOT_DISPATCHED'].includes(reason) ? reason : null,
    // A syntactically valid error identifier can still contain private data.
    diagnosticCode: diagnosticCodes.has(dshErrorCode) ? dshErrorCode : (dshErrorCode ? 'OTHER_TOOL_ERROR' : null),
  }
  const observedAt = parseDate(current.readbackObservedAt)
  if (Number.isFinite(observedAt)) summary.readbackObservedAt = new Date(observedAt).toISOString()
  if (typeof current.readbackReference === 'string' && evidenceReferencePattern.test(current.readbackReference)) {
    summary.readbackReference = current.readbackReference
  }
  return summary
}

export class Ledger {
  constructor(dir = DEFAULT_DIR, { create = true } = {}) {
    this.dir = resolve(dir)
    this.lockPath = join(this.dir, '.active.lock')
    this.locked = false
    this.lockNote = ''
    this.owner = randomUUID()
    this.directories = directoryChain(this.dir, create)
    this.lostOwnership = false
  }

  assertDirectory() {
    const current = directoryChain(this.dir)
    if (!current.every((stat, index) => sameFile(stat, this.directories[index]))) {
      throw new Error('账本目录已被替换')
    }
  }

  lock() {
    if (this.locked) return this.assertOwner()
    if (this.lostOwnership) throw new Error(this.lockNote)
    try {
      this.assertDirectory()
      const data = JSON.stringify({ pid: process.pid, owner: this.owner, startedAt: new Date().toISOString() })
      this.lockStat = writeNew(this.lockPath, data)
      syncDirectory(this.dir)
      this.locked = true
      this.lockNote = ''
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('账本锁 .active.lock 已存在，请确认实例退出后人工核查')
      throw error
    }
  }

  tryLock() {
    try {
      this.lock()
      return true
    } catch (error) {
      this.lockNote = error.code ? '无法取得账本独占锁' : error.message
      return false
    }
  }

  assertOwner() {
    if (!this.locked) throw new Error(this.lockNote || '未取得账本独占锁')
    try {
      this.assertDirectory()
      const lock = readJson(this.lockPath, 1024)
      if (!lock) throw new Error('账本锁 .active.lock 已消失，必须核查原因后重启')
      if (!sameFile(lock.stat, this.lockStat) || lock.value?.owner !== this.owner || lock.value?.pid !== process.pid) {
        throw new Error('账本锁 .active.lock 所有权不匹配，禁止继续执行')
      }
    } catch (error) {
      this.locked = false
      this.lostOwnership = true
      this.lockNote = error instanceof SyntaxError
        ? '账本锁 .active.lock 内容损坏，禁止继续执行'
        : '无法验证账本锁：' + (error.code || error.message)
      throw new Error(this.lockNote, { cause: error })
    }
  }

  checkOwner() {
    try {
      this.assertOwner()
      return true
    } catch {
      return false
    }
  }

  inspectLock() {
    this.assertDirectory()
    let lock
    try {
      lock = readJson(this.lockPath, 1024)
    } catch (error) {
      return { state: error instanceof SyntaxError ? 'invalid' : 'unreadable' }
    }
    if (!lock) return { state: 'absent' }
    const { pid, startedAt } = lock.value ?? {}
    if (!Number.isInteger(pid) || pid < 1 || pid > 0x7fffffff ||
        typeof lock.value.owner !== 'string' || !executionIdPattern.test(lock.value.owner) ||
        !Number.isFinite(parseDate(startedAt))) return { state: 'invalid' }

    // Signal zero probes PID visibility; a recycled PID can belong to another process.
    let processStatus = 'visible'
    try {
      process.kill(pid, 0)
    } catch (error) {
      processStatus = error.code === 'ESRCH' ? 'not_found' : 'unverified'
    }
    return { state: 'present', pid, startedAt: new Date(parseDate(startedAt)).toISOString(), processStatus }
  }

  close() {
    if (!this.checkOwner()) return
    try {
      unlinkSync(this.lockPath)
      syncDirectory(this.dir)
    } finally {
      this.locked = false
    }
  }

  pathFor(key) {
    if (typeof key !== 'string' || !hashPattern.test(key)) throw new Error('非法账本键')
    return join(this.dir, key + '.json')
  }

  read(key) {
    this.assertDirectory()
    const entry = readJson(this.pathFor(key), MAX_RECORD_BYTES)
    if (!entry) return null
    if (!validRecord(entry.value, key)) throw new Error('账本损坏，必须先人工核查')
    return entry.value
  }

  write(record) {
    this.assertOwner()
    const target = this.pathFor(record.key)
    const temporary = target + '.' + randomUUID() + '.tmp'
    const content = JSON.stringify(record, null, 2) + '\n'
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES) throw new Error('账本记录达到上限，拒绝执行')
    const written = writeNew(temporary, content)
    try {
      this.assertOwner()
      renameSync(temporary, target)
      syncDirectory(this.dir)
      this.assertOwner()
    } catch (error) {
      // Clean up only the temporary file created by this write.
      if (this.checkOwner()) {
        try {
          if (sameFile(written, lstatSync(temporary, { bigint: true }))) unlinkSync(temporary)
        } catch (cleanup) {
          if (cleanup.code !== 'ENOENT') throw new AggregateError([error, cleanup], '账本写入与清理失败')
        }
      }
      throw error
    }
  }

  status(tool, args, keyArg) {
    const { key, fingerprint } = identity(tool, args, keyArg)
    const record = this.read(key)
    if (!record) return { state: 'new', key, fingerprint }
    if (record.fingerprint !== fingerprint) return { state: 'key_conflict', key, fingerprint }
    return { state: stateOf(record), key, fingerprint, executionId: record.executionId, updatedAt: record.updatedAt }
  }

  inspectRecord(recordId) {
    const record = this.read(recordId)
    if (!record) throw new Error('找不到对应账本记录')
    return operatorSummary(record)
  }

  lookupBusinessId(tool, businessId) {
    if (typeof tool !== 'string' || !tool) throw new LedgerInputError('SKY_INVALID_INPUT', '请指定工具名称')
    const record = this.read(businessKey(tool, businessId))
    if (!record || record.tool !== tool) return { found: false }
    return { found: true, record: operatorSummary(record) }
  }

  listPending() {
    this.assertDirectory()
    const records = []
    const errors = []
    for (const name of readdirSync(this.dir)) {
      if (!recordFilename.test(name)) continue
      const recordId = name.slice(0, -5)
      try {
        const record = this.inspectRecord(recordId)
        if (record.state === 'unknown') records.push(record)
      } catch {
        errors.push({ recordId, code: 'SKY_LEDGER_RECORD_UNREADABLE' })
      }
    }
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.recordId.localeCompare(b.recordId))
    return { records, errors, complete: errors.length === 0 }
  }

  claim(tool, args, keyArg) {
    this.assertOwner()
    const { key, fingerprint } = identity(tool, args, keyArg)
    const previous = this.read(key)
    const state = previous ? stateOf(previous) : 'new'
    const prior = previous?.attempts.at(-1)
    const verifiedRelease = state === 'released' && prior.reconciliationDecision === 'not_committed'
    if (previous && previous.fingerprint !== fingerprint && !verifiedRelease) {
      return { ok: false, code: 'SKY_KEY_CONFLICT' }
    }
    if (state !== 'new' && state !== 'released') {
      const code = state === 'succeeded' ? 'SKY_ALREADY_EXECUTED' : 'SKY_EXECUTION_UNKNOWN'
      return { ok: false, code }
    }
    const now = new Date().toISOString()
    const executionId = randomUUID()
    const record = previous || { version: 1, key, fingerprint, tool, attempts: [] }
    if (prior) prior.fingerprint ??= record.fingerprint
    record.fingerprint = fingerprint
    record.executionId = executionId
    record.state = 'running'
    record.updatedAt = now
    record.attempts.push({ executionId, fingerprint, startedAt: now, state: 'running' })
    this.write(record)
    return { ok: true, key, executionId }
  }

  settle(key, executionId, success, reason, info) {
    this.assertOwner()
    const record = this.read(key)
    if (!record || record.executionId !== executionId || record.state !== 'running') {
      throw new Error('执行代次冲突，禁止改写账本')
    }
    record.state = success ? 'succeeded' : 'unknown'
    record.updatedAt = new Date().toISOString()
    const current = record.attempts.at(-1)
    current.state = record.state
    current.finishedAt = record.updatedAt
    if (!success) {
      current.reason = reason || 'TOOL_OUTCOME_UNKNOWN'
      // Retain diagnostic identifiers without persisting raw messages or paths.
      const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
      if (identifier(info?.code)) current.dshErrorCode = info.code
      if (identifier(info?.name)) current.dshErrorName = info.name
    }
    this.write(record)
  }

  #recordByArgs(tool, args, keyArg) {
    const { key, fingerprint } = identity(tool, args, keyArg)
    const record = this.read(key)
    if (!record || record.fingerprint !== fingerprint) throw new Error('执行代次或参数指纹不匹配，禁止对账')
    return record
  }

  #reconciliation(record, executionId, decision, evidence) {
    if (!['committed', 'not_committed'].includes(decision)) throw new Error('非法对账结论')
    if (!record) throw new Error('找不到对应账本记录，请刷新待核查列表')
    if (record.executionId !== executionId) {
      throw new Error('执行代次或参数指纹不匹配，禁止对账')
    }
    if (stateOf(record) !== 'unknown') throw new Error('只有未知状态可以对账')
    const observedAt = parseDate(evidence?.observedAt)
    if (typeof evidence?.source !== 'string' || !evidence.source.trim() || evidence.source.length > 120 ||
        !Number.isFinite(observedAt) || observedAt < parseDate(record.updatedAt) || observedAt > Date.now() ||
        typeof evidence.summary !== 'string' || evidence.summary.trim().length < 8 || evidence.summary.length > 4096) {
      throw new Error('证据需要有效 source、summary 及本次执行后的 observedAt')
    }
    const reference = evidence.reference
    if (reference !== undefined &&
        (typeof reference !== 'string' || !evidenceReferencePattern.test(reference))) {
      throw new Error('证据编号仅支持字母、数字、点、下划线和连字符')
    }
    const nextState = decision === 'committed' ? 'succeeded' : 'released'
    const evidenceSha256 = sha(JSON.stringify(evidence))
    const previewToken = sha(JSON.stringify([record, decision, evidenceSha256]))
    return { record, nextState, observedAt, reference, evidenceSha256, previewToken }
  }

  previewReconciliation(tool, args, keyArg, executionId, decision, evidence) {
    const record = this.#recordByArgs(tool, args, keyArg)
    return this.#preview(record, executionId, decision, evidence)
  }

  previewRecordReconciliation(recordId, executionId, decision, evidence) {
    return this.#preview(this.read(recordId), executionId, decision, evidence)
  }

  #preview(record, executionId, decision, evidence) {
    const plan = this.#reconciliation(record, executionId, decision, evidence)
    return {
      ...operatorSummary(plan.record),
      nextState: plan.nextState,
      observedAt: new Date(plan.observedAt).toISOString(),
      previewToken: plan.previewToken,
    }
  }

  reconcile(tool, args, keyArg, executionId, decision, evidence, expectedPreview) {
    this.assertOwner()
    const record = this.#recordByArgs(tool, args, keyArg)
    return this.#applyReconciliation(record, executionId, decision, evidence, expectedPreview)
  }

  reconcileRecord(recordId, executionId, decision, evidence, expectedPreview) {
    this.assertOwner()
    if (typeof expectedPreview !== 'string' || !hashPattern.test(expectedPreview)) {
      throw new Error('请先预览对账并提交预览令牌')
    }
    return this.#applyReconciliation(this.read(recordId), executionId, decision, evidence, expectedPreview)
  }

  #applyReconciliation(record, executionId, decision, evidence, expectedPreview) {
    const plan = this.#reconciliation(record, executionId, decision, evidence)
    if (expectedPreview !== undefined && expectedPreview !== plan.previewToken) {
      throw new Error('对账记录或证据在预览后已变化，请重新预览')
    }
    const { nextState, evidenceSha256 } = plan
    const current = record.attempts.at(-1)
    record.state = nextState
    record.updatedAt = new Date().toISOString()
    current.state = record.state
    current.reconciledAt = record.updatedAt
    current.reconciliationDecision = decision
    current.readbackEvidenceSha256 = evidenceSha256
    current.readbackObservedAt = new Date(plan.observedAt).toISOString()
    if (plan.reference !== undefined) current.readbackReference = plan.reference
    this.write(record)
    return { state: record.state, executionId, evidenceSha256 }
  }
}
