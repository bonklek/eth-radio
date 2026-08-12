import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { helpRequested } from './lib/cli-help.mjs'

if (helpRequested()) {
  console.log(`Usage:
  pnpm check:syntax

Checks JavaScript module syntax outside ignored/generated directories.
`)
  process.exit(0)
}

const root = process.cwd()
const ignoredDirectories = new Set([
  '.git',
  '.private',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'work',
])

function javascriptFiles(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && (ignoredDirectories.has(entry.name) || entry.name.startsWith('.venv'))) continue
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...javascriptFiles(filePath))
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(filePath)
  }
  return files
}

const files = javascriptFiles(root).sort()
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '')
    process.stderr.write(result.stderr || '')
    throw new Error(`Syntax check failed: ${path.relative(root, file)}`)
  }
}

console.log(`syntax ok: ${files.length} JavaScript modules`)
