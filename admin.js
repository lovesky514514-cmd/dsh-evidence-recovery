import { readFileSync, statSync } from 'node:fs'
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
  reconcile: {
    ...inputOptions,
    confirm: text,
    'evidence-file': text,
    decision: text,
    'execution-id': text,
    'dry-run': { type: 'boolean' },
    'expect-preview': text,
  },
}

function readJsonFile(path, maxBytes) {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('JSON 文件类型或大小异常')
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
}

function print(value) {
  console.log(JSON.stringify(value, null, 2))
}

function main() {
  const [action, ...args] = process.argv.slice(2)
  if (!Object.hasOwn(commands, action)) {
    throw new Error('用法：node admin.js list --pending | inspect --record-id ID | reconcile [选项]')
  }
  const { values } = parseArgs({ args, options: { ...commands[action], 'data-dir': text } })
  const {
    tool, confirm, decision, 'args-json': json, 'args-file': argsPath, 'key-arg': keyArg,
    'data-dir': dataDir, 'evidence-file': evidencePath, 'execution-id': executionId,
    'record-id': recordId, 'dry-run': dryRun, 'expect-preview': expectedPreview,
  } = values
  const dir = dataDir || DEFAULT_DIR

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
    print(new Ledger(dir, { create: false }).inspectRecord(recordId))
    return
  }

  if (json !== undefined && argsPath !== undefined) throw new Error('只能指定一种工具参数输入方式')
  const originalArgs = argsPath ? readJsonFile(argsPath, 262144) : JSON.parse(json ?? '{}')
  if (action === 'inspect') {
    print(new Ledger(dir, { create: false }).status(tool, originalArgs, keyArg))
    return
  }

  if (!dataDir || !evidencePath || !executionId || !decision) {
    throw new Error('对账需要明确指定数据目录、执行代次、结论及证据文件')
  }
  const evidence = readJsonFile(evidencePath, 16384)
  const reconciliation = [tool, originalArgs, keyArg, executionId, decision, evidence]
  if (dryRun) {
    if (expectedPreview !== undefined) throw new Error('预览不能指定 --expect-preview')
    print(new Ledger(dir, { create: false }).previewReconciliation(...reconciliation))
    return
  }

  // This confirmation records operator intent. OS isolation controls access.
  if (confirm !== 'I_VERIFIED_READBACK') throw new Error('实际对账需要 I_VERIFIED_READBACK 确认')
  const ledger = new Ledger(dir, { create: false })
  ledger.lock()
  try {
    print(ledger.reconcile(...reconciliation, expectedPreview))
  } finally {
    ledger.close()
  }
}

try {
  main()
} catch (error) {
  const message = error instanceof SyntaxError || error.code?.startsWith('ERR_PARSE_ARGS')
    ? '命令参数或 JSON 无效'
    : error.code && !(error instanceof LedgerInputError) ? '文件操作失败：' + error.code : error.message
  console.error(message)
  process.exitCode = 1
}
