import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const DEFAULT_DIR = join(homedir(), '.sky-evidence-recovery')
const MAX_ARGUMENT_BYTES = 65536
const MAX_RECORD_BYTES = 524288
const sha = value => createHash('sha256').update(value).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/
const attemptStates = ['running', 'unknown', 'succeeded', 'released']
const parseDate = value => typeof value === 'string' ? Date.parse(value) : NaN

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

export function identity(tool, args, keyArg) {
  if (typeof tool !== 'string' || !tool || !args || typeof args !== 'object' || Array.isArray(args)) {
    throw new LedgerInputError('SKY_INVALID_INPUT', '工具名称或参数格式无效')
  }
  const normalized = canonical({ tool, args })
  if (Buffer.byteLength(normalized, 'utf8') > MAX_ARGUMENT_BYTES) {
    throw new LedgerInputError('SKY_ARGUMENT_TOO_LARGE', '工具参数超出保护上限')
  }
  const businessId = Object.hasOwn(args, keyArg) ? args[keyArg] : undefined
  if (keyArg && (typeof businessId !== 'string' || !businessId.trim() || businessId.length > 1024)) {
    throw new LedgerInputError('SKY_KEY_MISSING', '缺少有效业务身份字段')
  }
  const fingerprint = sha(normalized)
  return { key: sha(tool + '\u0000' + (keyArg ? businessId : fingerprint)), fingerprint }
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
    (!attempt.reconciledAt ||
      (Number.isFinite(parseDate(attempt.reconciledAt)) && hashPattern.test(attempt.readbackEvidenceSha256))) &&
    (attempt.state !== 'released' || legacyRelease(attempt) || attempt.reconciledAt)) &&
    current.executionId === record.executionId && current.state === record.state
}

export class Ledger {
  constructor(dir = DEFAULT_DIR) {
    this.dir = resolve(dir)
    this.lockPath = join(this.dir, '.active.lock')
    this.locked = false
    this.lockNote = ''
    this.owner = randomUUID()
    this.directories = directoryChain(this.dir, true)
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

  claim(tool, args, keyArg) {
    this.assertOwner()
    const { key, fingerprint } = identity(tool, args, keyArg)
    const previous = this.read(key)
    if (previous && previous.fingerprint !== fingerprint) return { ok: false, code: 'SKY_KEY_CONFLICT' }
    const state = previous ? stateOf(previous) : 'new'
    if (state !== 'new' && state !== 'released') {
      const code = state === 'succeeded' ? 'SKY_ALREADY_EXECUTED' : 'SKY_EXECUTION_UNKNOWN'
      return { ok: false, code }
    }
    const now = new Date().toISOString()
    const executionId = randomUUID()
    const record = previous || { version: 1, key, fingerprint, tool, attempts: [] }
    record.executionId = executionId
    record.state = 'running'
    record.updatedAt = now
    record.attempts.push({ executionId, startedAt: now, state: 'running' })
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

  reconcile(tool, args, keyArg, executionId, decision, evidence) {
    this.assertOwner()
    if (!['committed', 'not_committed'].includes(decision)) throw new Error('非法对账结论')
    const { key, fingerprint } = identity(tool, args, keyArg)
    const record = this.read(key)
    if (!record || record.fingerprint !== fingerprint || record.executionId !== executionId) {
      throw new Error('执行代次或参数指纹不匹配，禁止对账')
    }
    if (stateOf(record) !== 'unknown') throw new Error('只有未知状态可以对账')
    const current = record.attempts.at(-1)
    const observedAt = parseDate(evidence?.observedAt)
    if (typeof evidence?.source !== 'string' || !evidence.source.trim() || evidence.source.length > 120 ||
        !Number.isFinite(observedAt) || observedAt < parseDate(record.updatedAt) || observedAt > Date.now() ||
        typeof evidence.summary !== 'string' || evidence.summary.trim().length < 8 || evidence.summary.length > 4096) {
      throw new Error('证据需要有效 source、summary 及本次执行后的 observedAt')
    }
    record.state = decision === 'committed' ? 'succeeded' : 'released'
    record.updatedAt = new Date().toISOString()
    current.state = record.state
    current.reconciledAt = record.updatedAt
    current.reconciliationDecision = decision
    current.readbackEvidenceSha256 = sha(JSON.stringify(evidence))
    this.write(record)
    return { state: record.state, executionId, evidenceSha256: current.readbackEvidenceSha256 }
  }
}
