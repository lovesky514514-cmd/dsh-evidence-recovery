import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Scan first-party JavaScript only.
const root = new URL('../', import.meta.url)
const sourceFolders = ['.', 'test', 'scripts']
const maxLineLength = 120
const separators = new RegExp('='.repeat(9) + '|' + '-'.repeat(11))
let errors = 0

for (const folder of sourceFolders) {
  const absolute = new URL(folder + '/', root)
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue
    const relative = join(folder, entry.name)
    const text = readFileSync(new URL(entry.name, absolute), 'utf8')
    const lines = text.split(/\r?\n/)
    const header = text.trimStart().match(/^(?:\/\*[\s\S]*?\*\/|(?:\/\/[^\r\n]*\r?\n)+)/)?.[0]
    if (header && header.trimEnd().split(/\r?\n/).length > 3) {
      console.error(`${relative}: 文件开头解释过长`)
      errors++
    }
    lines.forEach((line, index) => {
      if (line.length > maxLineLength) {
        console.error(`${relative}:${index + 1}: 行长 ${line.length} 超出 ${maxLineLength}`)
        errors++
      }
      if (separators.test(line)) {
        console.error(`${relative}:${index + 1}: 存在长分隔符`)
        errors++
      }
    })
  }
}

if (errors > 0) {
  console.error(`源码规范检查未通过：${errors} 个问题`)
  process.exitCode = 1
} else {
  console.log('源码规范检查通过：行长、文件头与长分隔符均合格')
}
