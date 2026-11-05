import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Stub DSH registration and the tool event boundary.
function writeMockDependency(root, packageName, contents) {
  const folder = join(root, 'node_modules', packageName)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'package.json'), JSON.stringify({
    name: packageName,
    type: 'module',
    exports: './index.js',
  }))
  writeFileSync(join(folder, 'index.js'), contents)
}

export async function withMockPlugin(run, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sky-recovery-dsh-mock-'))
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
  writeMockDependency(dir, '@deepseek-ai/dsh-tools', 'export const defineTool = value => value')
  writeMockDependency(dir, '@deepseek-ai/schemastery', `
    const entry = { required() { return this }, default() { return this } }
    export default {
      object: () => entry,
      string: () => entry,
      array: () => entry,
    }
  `)
  for (const filename of ['index.js', 'ledger.js', 'demo.js']) {
    copyFileSync(new URL(`../${filename}`, import.meta.url), join(dir, filename))
  }

  const plugin = await import(pathToFileURL(join(dir, 'index.js')).href)
  const ledger = await import(pathToFileURL(join(dir, 'ledger.js')).href)
  const demo = await import(pathToFileURL(join(dir, 'demo.js')).href)
  const tools = new Map()
  const events = new Map()
  let disposer
  const context = {
    logger: options.logger,
    effect(callback) { disposer = callback() },
    on(name, callback) { events.set(name, callback) },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }
  function closePlugin() {
    disposer?.()
    disposer = undefined
  }

  try {
    options.beforeApply?.(dir)
    plugin.apply(context, {
      dataDir: join(dir, 'ledger'),
      rules: [{ tool: 'create_order', keyArg: 'requestId' }],
      ...options.config,
    })
    await run({
      dir,
      demo, context,
      ledger,
      tools,
      events,
      closePlugin,
      event: events.get('tools/execute'),
      tool: tools.get('sky_recovery_status'),
    })
  } finally {
    closePlugin()
    rmSync(dir, { recursive: true, force: true })
  }
}
