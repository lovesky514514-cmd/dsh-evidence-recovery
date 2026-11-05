import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Ledger } from '../ledger.js'

const option = { type: 'string' }
const { values } = parseArgs({
  options: {
    root: option, executable: option, entry: option, browser: option,
    playwright: option, electron: { type: 'boolean' }, removed: { type: 'boolean' },
    'guest-peer': { type: 'boolean' },
  },
})
if (!values.root || !values.executable || !values.playwright) {
  throw new Error('Supply --root, --executable and --playwright. Use an isolated sky-web-audit Profile.')
}
const root = resolve(values.root)
const homeDir = join(root, 'home')
const profile = 'sky-web-audit'
const profileManifest = join(homeDir, 'profiles', profile, 'package.json')
if (!existsSync(profileManifest)) throw new Error('Isolated test Profile is missing.')
const fixture = mkdtempSync(join(root, 'browser-audit-'))
// Keep DSH from assigning the shutdown plugin to the nearest source package.
writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'sky-browser-audit-fixture', private: true }))
const { chromium } = createRequire(import.meta.url)(values.playwright)
const checks = []
const wait = ms => new Promise(done => setTimeout(done, ms))
const tool = 'sky_demo_create_order'
const args = { requestId: 'isolated-web-audit' }
const ledger = new Ledger(join(fixture, 'ledger'))
ledger.lock()
const ticket = ledger.claim(tool, args, 'requestId')
ledger.settle(ticket.key, ticket.executionId, false, 'TOOL_OUTCOME_UNKNOWN', { code: 'TOOL_TIMEOUT' })
ledger.close()
const stop = join(fixture, 'stop')
const guestProbe = join(fixture, 'guest-probe')
const guestResult = join(fixture, 'guest-result')
const runtimeProbe = join(fixture, 'runtime-probe')
const runtimeResult = join(fixture, 'runtime-result')
const orders = join(fixture, 'orders')
writeFileSync(join(fixture, 'stop.mjs'), [
  "import { existsSync, writeFileSync } from 'node:fs'",
  'export function apply(ctx) {',
  '  const timer = setInterval(() => {',
  '    if (!existsSync(' + JSON.stringify(stop) + ')) return',
  '    clearInterval(timer)',
  "    process.emit('SIGINT')",
  '  }, 100)',
  '  ctx.effect(() => () => clearInterval(timer))',
  ...(values.removed ? [] : [
    "  ctx.inject(['tools'], child => {",
    '    const probe = setInterval(async () => {',
    '      if (!existsSync(' + JSON.stringify(runtimeProbe) + ')) return',
    '      clearInterval(probe)',
    '      const run = callId => child.tools.execute({',
    '        callId, name: ' + JSON.stringify(tool) + ', signal: new AbortController().signal,',
    '        arguments: { requestId: "runtime-audit", outcome: "success" },',
    '      })',
    '      const first = await run("runtime-audit-first")',
    '      const repeat = await run("runtime-audit-repeat")',
    '      const result = { firstOk: first.isError === false, repeatCode: repeat.error?.info?.code }',
    '      writeFileSync(' + JSON.stringify(runtimeResult) + ', JSON.stringify(result))',
    '    }, 100)',
    '    child.effect(() => () => clearInterval(probe))',
    '  })',
  ]),
  ...(values['guest-peer'] && !values.removed ? [
    "  ctx.inject(['typertGateway', 'connection'], child => {",
    '    const probe = setInterval(async () => {',
    '      if (!existsSync(' + JSON.stringify(guestProbe) + ')) return',
    '      clearInterval(probe)',
    '      const peer = child.connection.createPeer({ principal: { kind: "sky-audit-guest" } })',
    '      try {',
    '        const reply = await child.typertGateway.invokeRpc("skyRecoveryWizard/snapshot", { args: {} }, null, peer)',
    '        const code = reply.ok ? "unexpected-success" : reply.error.code',
    '        writeFileSync(' + JSON.stringify(guestResult) + ', code)',
    '      } finally { await peer.dispose() }',
    '    }, 100)',
    '    child.effect(() => () => clearInterval(probe))',
    '  })',
  ] : []),
  '}',
].join('\n'))
const patch = join(fixture, 'audit.patch.yml')
writeFileSync(patch, [
  '- id: ui-settings-account',
  '  disabled: true',
  ...(values.removed ? [] : [
    '- id: sky-evidence-recovery',
    '  config:',
    '    dataDir: ' + JSON.stringify(ledger.dir),
    '    rules:',
    '      - tool: ' + tool,
    '        keyArg: requestId',
  ]),
  '- insert:',
  ...(values.removed ? [] : [
    '    - id: sky-evidence-recovery-demo',
    '      name: sky-evidence-recovery/demo',
    '      config:',
    '        dataDir: ' + JSON.stringify(orders),
  ]),
  '    - id: sky-audit-stop',
  '      name: ./stop.mjs',
].join('\n'))

const socket = createServer()
await new Promise((done, reject) => socket.listen(0, '127.0.0.1', done).once('error', reject))
const { port } = socket.address()
await new Promise(done => socket.close(done))
const entry = values.electron ? ['--expose-internals', values.entry] : values.entry ? [values.entry] : []
const child = spawn(values.executable, [
  ...entry, '--profile', profile, '--patch', patch, '--port', String(port), '--no-open',
], {
  cwd: fixture,
  windowsHide: true,
  env: {
    ...process.env, DSH_HOME: homeDir, DEEPSEEK_API_KEY: '',
    ...(values.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  },
})
let output = ''
child.stdout.on('data', chunk => { output += chunk })
child.stderr.on('data', chunk => { output += chunk })
let browser

function runAdmin(options, input) {
  const cli = fileURLToPath(new URL('../admin.js', import.meta.url))
  const result = spawnSync(process.execPath, [cli, ...options], { encoding: 'utf8', timeout: 8000, input })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

try {
  let url
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error('Isolated DSH exited before serving its Web UI.')
    url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)?.[0]
    if (url) break
    await wait(250)
  }
  assert.ok(url, 'Isolated DSH did not advertise its authenticated loopback URL.')
  browser = await chromium.launch({ headless: true, executablePath: values.browser })
  const page = await browser.newPage({
    viewport: { width: 1200, height: 850 }, acceptDownloads: true, serviceWorkers: 'block',
  })
  page.setDefaultTimeout(12000)
  const pageErrors = []
  page.on('pageerror', () => pageErrors.push('pageerror'))
  await page.goto(url)
  for (const name of [/^继续$|^Continue$/, /^稍后配置$|^Set up later$/]) {
    const button = page.getByRole('button', { name })
    await button.click({ timeout: 5000 }).catch(() => {})
    await button.waitFor({ state: 'hidden' })
  }
  const settings = page.getByRole('button', { name: /^设置$|^Settings$/ })
  if (await settings.first().isVisible()) await settings.first().click()
  else await page.keyboard.press('Control+Alt+,')
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const nav = dialog.getByRole('button', { name: 'SKY Evidence Recovery', exact: true })
  const isSnapshot = request => Boolean(request.postData()?.includes('skyRecoveryWizard/snapshot'))
  if (values.removed) {
    if (await nav.count()) {
      const [response] = await Promise.all([page.waitForResponse(res => isSnapshot(res.request())), nav.click()])
      const body = await response.json().catch(() => null)
      const code = body?.result?.error?.code
      const tag = typeof code === 'string' && /^[a-z/-]{1,80}$/.test(code) ? code : 'none'
      throw new Error('Uninstalled settings entry: HTTP ' + response.status() + ', RPC code: ' + tag)
    }
    checks.push('settings-entry-removed')
  } else {
    const [request] = await Promise.all([page.waitForRequest(isSnapshot), nav.click()])
    const wizard = page.getByRole('region', { name: 'SKY Evidence Recovery 向导' })
    await wizard.getByText('插件已加载', { exact: true }).waitFor()
    checks.push('settings-entry-mounted', 'owner-snapshot')
    await wizard.getByText('账本锁已持有', { exact: true }).waitFor()
    await wizard.getByText('已配置保护规则：' + tool, { exact: true }).waitFor()
    await wizard.getByText('未发现无效规则', { exact: true }).waitFor()
    checks.push('ledger-lock', 'protected-rules')
    writeFileSync(runtimeProbe, '')
    for (let i = 0; !existsSync(runtimeResult) && i < 80; i++) await wait(100)
    assert.ok(existsSync(runtimeResult), 'Real ToolRuntime did not return a result.')
    const runtime = JSON.parse(readFileSync(runtimeResult, 'utf8'))
    assert.deepEqual(runtime, { firstOk: true, repeatCode: 'SKY_ALREADY_EXECUTED' })
    assert.equal(readdirSync(orders).length, 1)
    checks.push('real-tool-runtime-blocks-repeat')
    const initial = await wizard.boundingBox()
    const guest = await browser.newContext()
    try {
      const result = await guest.request.post(request.url(), {
        data: request.postData(), headers: { 'content-type': 'application/json' },
      })
      assert.ok([401, 403].includes(result.status()), 'Unauthenticated request was not rejected.')
    } finally {
      await guest.close()
    }
    checks.push('unauthenticated-denied')
    if (values['guest-peer']) {
      writeFileSync(guestProbe, '')
      for (let i = 0; !existsSync(guestResult) && i < 80; i++) await wait(100)
      assert.ok(existsSync(guestResult), 'DSH guest Peer probe did not return a result.')
      assert.equal(readFileSync(guestResult, 'utf8'), 'remote-access/denied')
      checks.push('non-owner-peer-denied')
    }
    let rpcError
    const routeSnapshot = route => {
      if (!isSnapshot(route.request())) return route.continue()
      if (rpcError === 'http-404') return route.fulfill({ status: 404 })
      return route.fulfill({ json: {
        type: 'server-response',
        rpcId: route.request().postDataJSON().rpcId,
        result: { ok: false, error: { code: rpcError, message: 'PRIVATE_GATEWAY_DETAIL', details: {} } },
      } })
    }
    await page.route(request.url(), routeSnapshot)
    const refresh = wizard.getByRole('button', { name: '刷新', exact: true })
    const codes = ['sky/owner-required', 'gateway/lookup-not-found', 'gateway/service-unavailable', 'gateway/internal']
    for (const code of codes) {
      rpcError = code
      await refresh.click()
      await wizard.getByRole('alert').filter({ hasText: code }).waitFor()
      assert.equal(await wizard.getByText('PRIVATE_GATEWAY_DETAIL', { exact: false }).count(), 0)
    }
    rpcError = 'http-404'
    await refresh.click()
    await wizard.getByRole('alert').filter({ hasText: 'gateway/lookup-not-found' }).waitFor()
    await page.unroute(request.url(), routeSnapshot)
    await refresh.click()
    await wizard.getByText('账本锁已持有', { exact: true }).waitFor()
    checks.push('gateway-diagnostics-redacted')
    await wizard.getByRole('button', { name: '查看待核查记录' }).click()
    await wizard.getByText('1 笔待核查记录。', { exact: true }).waitFor()
    const record = wizard.getByRole('button', { name: /sky_demo_create_order.*TOOL_TIMEOUT/ })
    await record.click()
    await wizard.getByText('执行代次 ' + ticket.executionId, { exact: true }).waitFor()
    checks.push('pending-list', 'record-selection')
    await wizard.getByText('在终端直接录入证据', { exact: true }).click()
    const command = wizard.getByText(/--record-id.*--interactive/)
    await command.waitFor()
    assert.ok((await command.innerText()).includes(ticket.executionId))
    checks.push('interactive-command')
    const lookup = JSON.parse(runAdmin(
      ['lookup', '--data-dir', ledger.dir, '--tool', tool, '--key-stdin'], JSON.stringify(args.requestId),
    ))
    assert.equal(lookup.record.recordId, ticket.key)
    assert.equal(JSON.parse(runAdmin(['lock-status', '--data-dir', ledger.dir])).processStatus, 'visible')
    checks.push('lookup-and-lock-diagnosis')
    const save = wizard.getByRole('button', { name: '保存证据 JSON' })
    assert.equal(await save.isEnabled(), false)
    await wizard.getByLabel('实际核查结论').selectOption('not_committed')
    await wizard.getByLabel('证据来源').fill('isolated-test-readback')
    const now = new Date()
    const local = new Date(now.valueOf() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
    await wizard.getByLabel('实际核查时间（本地时间）').fill(local)
    await wizard.getByLabel('核查摘要').fill('独立核查确认模拟操作已终止且从未提交。')
    await wizard.getByLabel('证据编号（可选）').fill('invalid ref')
    assert.equal(await save.isEnabled(), false)
    await wizard.getByLabel('证据编号（可选）').fill('TEST-READBACK-01')
    checks.push('evidence-validation')
    const [download] = await Promise.all([page.waitForEvent('download'), save.click()])
    const evidenceFile = join(fixture, 'readback.json')
    await download.saveAs(evidenceFile)
    const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'))
    assert.deepEqual(Object.keys(evidence).sort(), ['observedAt', 'reference', 'source', 'summary'])
    assert.equal(evidence.source, 'isolated-test-readback')
    assert.equal(evidence.reference, 'TEST-READBACK-01')
    await wizard.getByText(/--record-id.*--dry-run/).waitFor()
    assert.equal((await wizard.boundingBox()).height, initial.height)
    checks.push('evidence-download', 'fixed-panel-size')
    assert.equal(ledger.inspectRecord(ticket.key).state, 'unknown')
    assert.deepEqual(pageErrors, [])

    const offline = [
      'reconcile', '--data-dir', ledger.dir, '--record-id', ticket.key, '--execution-id', ticket.executionId,
      '--decision', 'not_committed', '--evidence-file', evidenceFile,
    ]
    const preview = JSON.parse(runAdmin([...offline, '--dry-run']))
    assert.equal(preview.nextState, 'released')
    assert.equal(ledger.inspectRecord(ticket.key).state, 'unknown')
    checks.push('browser-and-preview-read-only')
    writeFileSync(stop, '')
    for (let i = 0; child.exitCode === null && i < 100; i++) await wait(100)
    assert.notEqual(child.exitCode, null, 'Isolated DSH failed to stop.')
    assert.equal(existsSync(ledger.lockPath), false, 'Isolated DSH retained the ledger lock.')
    assert.equal(JSON.parse(runAdmin(['lock-status', '--data-dir', ledger.dir])).state, 'absent')
    const interactive = ['reconcile', '--data-dir', ledger.dir, '--record-id', ticket.key,
      '--execution-id', ticket.executionId, '--interactive']
    const input = ['not_committed', evidence.source, evidence.observedAt, evidence.summary,
      evidence.reference, 'I_VERIFIED_READBACK', ''].join('\n')
    const transcript = runAdmin(interactive, input)
    assert.match(transcript, /"nextState": "released"/)
    assert.equal(ledger.inspectRecord(ticket.key).state, 'released')
    ledger.lock()
    const retry = ledger.claim(tool, { ...args, corrected: true }, 'requestId')
    assert.equal(retry.ok, true)
    assert.notEqual(retry.executionId, ticket.executionId)
    assert.equal(ledger.read(ticket.key).attempts[0].executionId, ticket.executionId)
    ledger.close()
    checks.push('offline-reconciliation-and-corrected-retry')
  }
  console.log(JSON.stringify({ passed: checks.length, checks }))
} catch (error) {
  // The launch URL carries a disposable browser credential.
  console.error(String(error.message).replace(/token=[^\s"'&]+/gi, 'token=[REDACTED]'))
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (child.exitCode === null) {
    writeFileSync(stop, '')
    for (let i = 0; child.exitCode === null && i < 30; i++) await wait(100)
    if (child.exitCode === null) child.kill()
  }
}
