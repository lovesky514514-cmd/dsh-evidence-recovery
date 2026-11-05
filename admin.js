import { readFileSync, readSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { Ledger, DEFAULT_DIR, LedgerInputError } from './ledger.js'

const text = { type: 'string' }
const inputOptions = {
  tool: text,
  'args-json': text,
  'args-file': text,
  'key-arg': text,
}
const commands = {
  list: { pending: { type: 'boolean' } },
  inspect: { ...inputOptions, 'record-id': text },
  lookup: { tool: text, 'key-stdin': { type: 'boolean' } },
  'lock-status': {},
  reconcile: {
    ...inputOptions,
    'record-id': text,
    confirm: text,
    'evidence-file': text,
    'evidence-stdin': { type: 'boolean' },
    decision: text,
    'execution-id': text,
    'dry-run': { type: 'boolean' },
    'expect-preview': text,
    interactive: { type: 'boolean' },
  },
}

function parseJson(input, label) {
  try {
    return JSON.parse(input.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error(label + '不是有效的 JSON')
  }
}

function readJsonFile(path, maxBytes, label) {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(label + '的文件类型或大小异常')
  return parseJson(readFileSync(path, 'utf8'), label)
}

function readEvidence(path) {
  const limit = 16384
  if (path) return readJsonFile(path, limit, '证据文件')
  return parseJson(readStdin(limit), '证据输入')
}

function readStdin(limit) {
  const input = Buffer.alloc(limit + 1)
  let length = 0
  while (length <= limit) {
    const count = readSync(0, input, length, input.length - length)
    if (!count) break
    length += count
  }
  if (length > limit) throw new Error('标准输入超过大小上限')
  return input.toString('utf8', 0, length)
}

function print(value) {
  console.log(JSON.stringify(value, null, 2))
}

async function withPrompts(run) {
  const reader = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    crlfDelay: Infinity,
  })
  const lines = reader[Symbol.asyncIterator]()
  try {
    return await run(async (label, maxLength) => {
      process.stderr.write(label + '\n')
      const { done, value } = await lines.next()
      if (done) throw new Error('输入结束，操作已取消')
      if (value.length > maxLength) throw new Error('输入超过长度上限')
      return value
    })
  } finally {
    reader.close()
  }
}

function applyReconciliation(ledger, reconcile) {
  ledger.lock()
  try {
    print(reconcile())
  } finally {
    ledger.close()
  }
}

async function interactiveReview(values) {
  const { 'data-dir': dir, 'record-id': recordId, 'execution-id': executionId } = values
  if (!dir || !recordId || !executionId ||
      Object.keys(values).some(key => !['data-dir', 'record-id', 'execution-id', 'interactive'].includes(key))) {
    throw new Error('交互对账仅接受账本目录、记录 ID 和执行代次')
  }
  const ledger = new Ledger(dir, { create: false })
  const record = ledger.inspectRecord(recordId)
  if (record.executionId !== executionId || record.state !== 'unknown') {
    throw new Error('记录已变化或已不在待核查状态，请刷新清单')
  }
  await withPrompts(async ask => {
    print(record)
    const decision = await ask('已独立核查下游？输入 committed 或 not_committed，其他输入取消。', 20)
    if (!['committed', 'not_committed'].includes(decision)) throw new Error('操作已取消')
    const source = (await ask('证据来源', 120)).trim()
    const observedAt = (await ask('实际核查时间（ISO 8601，含时区）', 64)).trim()
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(observedAt)) {
      throw new Error('核查时间须为包含时区的 ISO 8601 时间')
    }
    const summary = (await ask('核查摘要（一行）', 4096)).trim()
    const reference = (await ask('证据编号（可选，回车跳过）', 120)).trim()
    const evidence = { source, observedAt, summary }
    if (reference) evidence.reference = reference
    const preview = ledger.previewRecordReconciliation(recordId, executionId, decision, evidence)
    print(preview)
    const confirm = await ask('确认 DSH 和在途任务均已停止后，输入 I_VERIFIED_READBACK 提交。', 24)
    if (confirm !== 'I_VERIFIED_READBACK') throw new Error('操作已取消')
    // Recheck the preview under the exclusive lock after collecting operator input.
    applyReconciliation(ledger, () =>
      ledger.reconcileRecord(recordId, executionId, decision, evidence, preview.previewToken))
  })
}

async function main() {
  const [action, ...args] = process.argv.slice(2)
  if (!Object.hasOwn(commands, action)) {
    throw new Error('用法：node admin.js list --pending | inspect | lookup | lock-status | reconcile [选项]')
  }
  const { values } = parseArgs({ args, options: { ...commands[action], 'data-dir': text } })
  const {
    tool, confirm, decision, 'args-json': json, 'args-file': argsPath, 'key-arg': keyArg,
    'data-dir': dataDir, 'evidence-file': evidencePath, 'execution-id': executionId,
    'record-id': recordId, 'dry-run': dryRun, 'expect-preview': expectedPreview,
    'evidence-stdin': evidenceStdin,
  } = values
  const dir = dataDir || DEFAULT_DIR
  if (action === 'lock-status') {
    print(new Ledger(dir, { create: false }).inspectLock())
    return
  }
  if (action === 'lookup') {
    if (!tool) throw new Error('查找需要 --tool')
    const ledger = new Ledger(dir, { create: false })
    const businessId = values['key-stdin']
      ? parseJson(readStdin(8192), '业务标识')
      : await withPrompts(ask => ask('输入业务标识（按原样匹配）', 1024))
    print(ledger.lookupBusinessId(tool, businessId))
    return
  }
  if (values.interactive) return interactiveReview(values)

  if (action === 'list') {
    if (!values.pending) throw new Error('待处理清单需要 --pending')
    const result = new Ledger(dir, { create: false }).listPending()
    print(result)
    if (!result.complete) process.exitCode = 2
    return
  }

  if (recordId !== undefined) {
    if (Object.keys(inputOptions).some(key => Object.hasOwn(values, key))) {
      throw new Error('--record-id 不能与工具参数选项同时使用')
    }
    if (action === 'inspect') {
      print(new Ledger(dir, { create: false }).inspectRecord(recordId))
      return
    }
  }

  if (json !== undefined && argsPath !== undefined) throw new Error('只能指定一种工具参数输入方式')
  const originalArgs = argsPath ? readJsonFile(argsPath, 262144, '参数文件') : parseJson(json ?? '{}', '工具参数')
  if (action === 'inspect') {
    print(new Ledger(dir, { create: false }).status(tool, originalArgs, keyArg))
    return
  }

  if (!dataDir || !executionId || !decision || (recordId === undefined && !tool)) {
    throw new Error('请指定账本目录、记录 ID 或工具、执行代次及对账结论')
  }
  if (Boolean(evidencePath) === Boolean(evidenceStdin)) {
    throw new Error('请通过证据文件或标准输入提供证据，二选一')
  }
  if (!dryRun && !expectedPreview) throw new Error('请先预览对账并提交预览令牌')
  const evidence = readEvidence(evidencePath)
  if (dryRun) {
    if (expectedPreview !== undefined) throw new Error('预览不能指定 --expect-preview')
    const ledger = new Ledger(dir, { create: false })
    print(recordId === undefined
      ? ledger.previewReconciliation(tool, originalArgs, keyArg, executionId, decision, evidence)
      : ledger.previewRecordReconciliation(recordId, executionId, decision, evidence))
    return
  }

  // This confirmation records operator intent. OS isolation controls access.
  if (confirm !== 'I_VERIFIED_READBACK') throw new Error('实际对账需要 I_VERIFIED_READBACK 确认')
  const ledger = new Ledger(dir, { create: false })
  applyReconciliation(ledger, () => recordId === undefined
    ? ledger.reconcile(tool, originalArgs, keyArg, executionId, decision, evidence, expectedPreview)
    : ledger.reconcileRecord(recordId, executionId, decision, evidence, expectedPreview))
}

try {
  await main()
} catch (error) {
  const message = error.code?.startsWith('ERR_PARSE_ARGS')
    ? '命令选项无效或缺少选项值，请检查参数'
    : error.code && !(error instanceof LedgerInputError) ? '文件操作失败：' + error.code : error.message
  console.error(message)
  process.exitCode = 1
}
