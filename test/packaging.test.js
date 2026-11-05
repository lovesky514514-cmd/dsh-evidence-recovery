import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = new URL('../DSH_本地试跑.ps1', import.meta.url)

test('PowerShell 5.1 启动脚本保留 UTF-8 BOM', () => {
  const contents = readFileSync(script)
  assert.deepEqual([...contents.subarray(0, 3)], [0xef, 0xbb, 0xbf])
})

test('npm bundle allowlist excludes the operator CLI and test fixtures', () => {
  const { files } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const name of ['admin.js', 'test', 'scripts', '启动SKY向导.cmd', 'SKY_新手向导.ps1']) {
    assert.equal(files.includes(name), false)
  }
  const runtime = [
    'index.js', 'ledger.js', 'demo.js', 'cordis.patch.yml', 'web-client.js', 'web-host.js', 'web-access.js',
  ]
  for (const name of runtime) {
    assert.ok(files.includes(name))
  }
})

function fakeDsh(t) {
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'sky-launch test-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const bin = join(temp, 'Programs', 'DeepSeek Harness Test', 'bin')
  mkdirSync(bin, { recursive: true })
  const cli = join(bin, 'dsh.cmd')
  const mock = join(bin, 'mock.cjs')
  const log = join(temp, 'calls.jsonl')
  writeFileSync(cli, '@echo off\r\n"' + process.execPath + '" "' + mock + '" %*\r\n')
  writeFileSync(mock, [
    "const fs = require('node:fs')",
    'const args = process.argv.slice(2)',
    'const call = { args, home: process.env.DSH_HOME }',
    "fs.appendFileSync(process.env.SKY_TEST_CLI_LOG, JSON.stringify(call) + '\\n')",
    "if (args.includes('--patch') && args.includes('--dump-config')) {",
    "  process.stdout.write(fs.readFileSync(args[args.indexOf('--patch') + 1], 'utf8'))",
    '}',
  ].join('\n'))

  const system = process.env.SystemRoot
  const powershell = join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const withoutPath = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
  const env = {
    ...withoutPath,
    DSH_CLI: '',
    DSH_HOME: 'unused-test-home',
    TEMP: temp,
    TMP: temp,
    LOCALAPPDATA: temp,
    Path: join(system, 'System32'),
    SKY_TEST_CLI_LOG: log,
  }
  const launch = (...args) => spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(script), ...args,
  ], { env, encoding: 'utf8', timeout: 15000 })
  const oneClick = missing => spawnSync(powershell, [
    '-NoProfile', '-Command', '& $env:SKY_LAUNCHER -DshPath $env:SKY_TEST_DSH; exit $LASTEXITCODE',
  ], {
    env: {
      ...env,
      SKY_LAUNCHER: fileURLToPath(new URL('../启动DSH测试.cmd', import.meta.url)),
      SKY_TEST_DSH: missing ? cli + '.missing' : cli,
    },
    input: '\r\n', encoding: 'utf8', timeout: 15000,
  })
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { cli, launch, oneClick, calls, temp }
}

const windows = { skip: process.platform !== 'win32' }

test('PowerShell 5.1 discovers a fake desktop CLI off PATH and defaults to preflight', windows, t => {
  const { launch, calls, temp } = fakeDsh(t)
  const run = launch()
  assert.equal(run.status, 0, run.stdout + run.stderr)
  const [init, install, dump] = calls()
  assert.equal(calls().length, 3)
  assert.ok(init.args.includes('--from-default-profile'))
  assert.equal(install.args[0], 'plugin')
  assert.ok(install.args.includes('add'))
  assert.ok(install.args.some(arg => arg.startsWith('file:')))
  assert.ok(dump.args.includes('--dump-config'))
  assert.ok(init.home.startsWith(join(temp, 'sky-evidence-smoke-')))
  assert.equal(install.home, init.home)
  assert.equal(dump.home, init.home)
  const patch = dump.args[dump.args.indexOf('--patch') + 1]
  assert.ok(patch.startsWith(join(temp, 'sky-evidence-smoke-')))
})

test('PowerShell 5.1 explicit CLI path requires Web opt-in and isolates each run', windows, t => {
  const { launch, calls, cli } = fakeDsh(t)
  const preflight = launch('-DshPath', cli, '-ConfigOnly', '-IsolatedWeb')
  assert.equal(preflight.status, 0, preflight.stdout + preflight.stderr)
  assert.equal(calls().length, 3)
  const web = launch('-DshPath', cli, '-IsolatedWeb')
  assert.equal(web.status, 0, web.stdout + web.stderr)
  const recorded = calls()
  assert.equal(recorded.length, 7)
  assert.notEqual(recorded[0].home, recorded[3].home)
  assert.ok(recorded[6].args.includes('--no-open'))
})

test('PowerShell 5.1 rejects a missing explicit CLI path', windows, t => {
  const { launch, cli } = fakeDsh(t)
  const run = launch('-DshPath', cli + '.missing')
  assert.equal(run.status, 1)
})

test('one-click launcher exits on success and propagates preflight failure', windows, t => {
  const { oneClick, calls } = fakeDsh(t)
  const success = oneClick(false)
  assert.equal(success.status, 0, success.stdout + success.stderr)
  assert.equal(calls().length, 3)
  const failure = oneClick(true)
  assert.equal(failure.status, 1, failure.stdout + failure.stderr)
  assert.match(failure.stdout, /DSH preflight failed/)
})
