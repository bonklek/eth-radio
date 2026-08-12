import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`)
  return value
}

function boundedFileDescriptor(filePath, maxBytes, label) {
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`)
    if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
    return { descriptor, size: stat.size }
  } catch (error) {
    fs.closeSync(descriptor)
    throw error
  }
}

export function readBoundedFileSync(filePath, { maxBytes, label = filePath }) {
  positiveSafeInteger(maxBytes, 'maxBytes')
  const { descriptor, size } = boundedFileDescriptor(filePath, maxBytes, label)
  try {
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const read = fs.readSync(descriptor, bytes, offset, size - offset, offset)
      if (!read) break
      offset += read
    }
    return bytes.subarray(0, offset)
  } finally {
    fs.closeSync(descriptor)
  }
}

export function readBoundedTextFileSync(filePath, options) {
  return readBoundedFileSync(filePath, options).toString('utf8')
}

export function readBoundedJsonFileSync(filePath, options) {
  const label = options?.label || filePath
  try {
    return JSON.parse(readBoundedTextFileSync(filePath, options))
  } catch (error) {
    throw new Error(`Unreadable ${label}: ${error.message}`, { cause: error })
  }
}

export function sha256FileSync(filePath, { maxBytes = undefined, label = filePath, chunkBytes = 64 * 1024 } = {}) {
  if (maxBytes !== undefined) positiveSafeInteger(maxBytes, 'maxBytes')
  positiveSafeInteger(chunkBytes, 'chunkBytes')
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`)
    if (maxBytes !== undefined && stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`)
    const hash = crypto.createHash('sha256')
    const chunk = Buffer.alloc(Math.min(chunkBytes, Math.max(stat.size, 1)))
    let position = 0
    while (position < stat.size) {
      const read = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, stat.size - position), position)
      if (!read) break
      position += read
      hash.update(chunk.subarray(0, read))
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(descriptor)
  }
}

export function forEachBoundedLineSync(filePath, callback, {
  maxBytes,
  maxLineBytes = 256 * 1024,
  label = filePath,
  chunkBytes = 64 * 1024,
}) {
  positiveSafeInteger(maxBytes, 'maxBytes')
  positiveSafeInteger(maxLineBytes, 'maxLineBytes')
  positiveSafeInteger(chunkBytes, 'chunkBytes')
  const { descriptor, size } = boundedFileDescriptor(filePath, maxBytes, label)
  const decoder = new StringDecoder('utf8')
  const chunk = Buffer.alloc(Math.min(chunkBytes, Math.max(size, 1)))
  let carry = ''
  let position = 0
  let lineNumber = 0
  const deliver = (line) => {
    lineNumber += 1
    if (Buffer.byteLength(line) > maxLineBytes) throw new Error(`${label} line ${lineNumber} exceeds ${maxLineBytes} bytes`)
    callback(line, lineNumber)
  }
  try {
    while (position < size) {
      const read = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, size - position), position)
      if (!read) break
      position += read
      const parts = `${carry}${decoder.write(chunk.subarray(0, read))}`.split(/\r?\n/)
      carry = parts.pop() || ''
      if (Buffer.byteLength(carry) > maxLineBytes) throw new Error(`${label} line ${lineNumber + 1} exceeds ${maxLineBytes} bytes`)
      for (const line of parts) deliver(line)
    }
    carry += decoder.end()
    if (carry) deliver(carry)
    return { bytes: size, lines: lineNumber }
  } finally {
    fs.closeSync(descriptor)
  }
}

export function appendRotatingLineSync(filePath, line, {
  maxBytes,
  backupSuffix = '.1',
  mode = 0o600,
}) {
  positiveSafeInteger(maxBytes, 'maxBytes')
  const payload = String(line).endsWith('\n') ? String(line) : `${line}\n`
  const payloadBytes = Buffer.byteLength(payload)
  if (payloadBytes > maxBytes) throw new Error(`Log record exceeds ${maxBytes} bytes`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  let currentBytes = 0
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) throw new Error(`Log path is not a regular file: ${filePath}`)
    currentBytes = stat.size
  }
  let rotated = false
  if (currentBytes + payloadBytes > maxBytes && currentBytes > 0) {
    const backupPath = `${filePath}${backupSuffix}`
    fs.rmSync(backupPath, { force: true })
    fs.renameSync(filePath, backupPath)
    rotated = true
  }
  fs.appendFileSync(filePath, payload, { encoding: 'utf8', mode })
  return { rotated, bytes: payloadBytes }
}
