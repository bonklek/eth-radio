import fs from 'node:fs'
import path from 'node:path'
import { readDirectoryBoundedSync } from './bounded-directory.mjs'

const MAX_OUTPUT_DIRECTORY_ENTRIES = 50_000

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function segmentFilePattern(filePrefix) {
  return new RegExp(`^${escapeRegExp(filePrefix)}-(\\d+)\\.webm$`)
}

export function prepareSegmentOutputDirectory(outDir, filePrefix) {
  fs.mkdirSync(outDir, { recursive: true })
  const pattern = segmentFilePattern(filePrefix)
  const names = readDirectoryBoundedSync(outDir, {
    maxEntries: MAX_OUTPUT_DIRECTORY_ENTRIES,
    label: `segment output directory ${outDir}`,
  }).entries
  for (const name of names) {
    if (pattern.test(name)) fs.rmSync(path.join(outDir, name), { force: true })
  }
  fs.rmSync(path.join(outDir, `${filePrefix}.segments.json`), { force: true })
}

export function segmentOutputEntries(outDir, filePrefix) {
  const pattern = segmentFilePattern(filePrefix)
  const names = readDirectoryBoundedSync(outDir, {
    maxEntries: MAX_OUTPUT_DIRECTORY_ENTRIES,
    label: `segment output directory ${outDir}`,
  }).entries
  const entries = names.flatMap((name) => {
    const match = name.match(pattern)
    if (!match) return []
    const sequence = Number(match[1])
    const canonicalDigits = Number.isSafeInteger(sequence) && sequence >= 0
      ? String(sequence).padStart(6, '0')
      : ''
    if (!canonicalDigits || match[1] !== canonicalDigits) {
      throw new Error(`Invalid segment output filename: ${name}`)
    }
    const file = path.join(outDir, name)
    if (!fs.statSync(file).isFile()) throw new Error(`Segment output is not a file: ${file}`)
    return [{ sequence, file, bytes: fs.statSync(file).size }]
  }).sort((left, right) => left.sequence - right.sequence)

  for (const [index, entry] of entries.entries()) {
    if (entry.sequence !== index) {
      throw new Error(`Segment output sequence gap: expected ${index}, found ${entry.sequence}`)
    }
  }
  return entries
}
