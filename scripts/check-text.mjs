import fs from 'node:fs'
import path from 'node:path'
import { helpRequested } from './lib/cli-help.mjs'

if (helpRequested()) {
  console.log(`Usage:
  pnpm check:text

Checks tracked-source text files for final newlines and trailing whitespace.
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
const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sol',
  '.toml',
  '.yaml',
  '.yml',
])
const textNames = new Set(['.env.example', '.gitignore', 'LICENSE'])

function textFiles(directory) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && (ignoredDirectories.has(entry.name) || entry.name.startsWith('.venv'))) continue
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...textFiles(filePath))
    else if (entry.isFile() && (textNames.has(entry.name) || textExtensions.has(path.extname(entry.name)))) files.push(filePath)
  }
  return files
}

const errors = []
for (const file of textFiles(root).sort()) {
  const source = fs.readFileSync(file, 'utf8')
  const relative = path.relative(root, file)
  if (source && !source.endsWith('\n')) errors.push(`${relative}: missing final newline`)
  for (const [index, line] of source.split(/\n/).entries()) {
    if (/[ \t]+\r?$/.test(line)) errors.push(`${relative}:${index + 1}: trailing whitespace`)
  }
}

if (errors.length) throw new Error(`Text hygiene failed:\n${errors.join('\n')}`)
console.log('text hygiene ok')
