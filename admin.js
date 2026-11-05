import { readFileSync, statSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Ledger, DEFAULT_DIR, LedgerInputError } from './ledger.js'

function readJsonFile(path, maxBytes) {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('JSON 文件类型或大小异常')
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
}

function main() {
  const [action, ...args] = process.argv.slice(2)
  if (action !== 'inspect' && action !== 'reconcile') {
    throw new Error('用法：node admin.js inspect|reconcile --tool TOOL [--args-file FILE | --args-json JSON]')
  }
  const { values } = parseArgs({
    args,
    options: {
      tool: { type: 'string' },
      'args-json': { type: 'string' },
      'args-file': { type: 'string' },
      'key-arg': { type: 'string', default: '' },
      'data-dir': { type: 'string' },
      confirm: { type: 'string' },
      'evidence-file': { type: 'string' },
      decision: { type: 'string' },
      'execution-id': { type: 'string' },
    },
  })
  const {
    tool, confirm, decision, 'args-json': json, 'args-file': argsPath, 'key-arg': keyArg,
    'data-dir': dataDir, 'evidence-file': evidencePath, 'execution-id': executionId,
  } = values
  if (json !== undefined && argsPath !== undefined) throw new Error('只能指定一种工具参数输入方式')
  const originalArgs = argsPath ? readJsonFile(argsPath, 262144) : JSON.parse(json ?? '{}')
  if (action === 'inspect') {
    console.log(JSON.stringify(new Ledger(dataDir || DEFAULT_DIR).status(tool, originalArgs, keyArg), null, 2))
    return
  }

  // This confirmation records operator intent. OS isolation controls access.
  if (confirm !== 'I_VERIFIED_READBACK' || !dataDir || !evidencePath || !executionId) {
    throw new Error('对账需要明确指定数据目录、执行代次、证据文件及 I_VERIFIED_READBACK 确认')
  }
  const evidence = readJsonFile(evidencePath, 16384)
  const ledger = new Ledger(dataDir)
  ledger.lock()
  try {
    console.log(JSON.stringify(ledger.reconcile(tool, originalArgs, keyArg, executionId, decision, evidence), null, 2))
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
