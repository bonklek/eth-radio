import fs from 'node:fs'
import path from 'node:path'

export class HttpFileError extends Error {
  /** @param {number} status @param {string} message @param {Record<string, string>} [headers] */
  constructor(status, message, headers = {}) {
    super(message)
    this.name = 'HttpFileError'
    this.status = status
    this.headers = headers
  }
}

/** @param {number} value */
function safeSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpFileError(500, 'File size is not safely representable')
  return value
}

/** @param {string} value */
function decimal(value) {
  if (!/^\d+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

/**
 * @param {string | undefined} header
 * @param {number} fileSize
 * @returns {{start: number, end: number, length: number} | null}
 */
export function parseSingleByteRange(header, fileSize) {
  const size = safeSize(fileSize)
  if (header == null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match || (!match[1] && !match[2])) {
    throw new HttpFileError(416, 'Range not satisfiable', { 'content-range': `bytes */${size}` })
  }
  if (size === 0) throw new HttpFileError(416, 'Range not satisfiable', { 'content-range': 'bytes */0' })

  if (!match[1]) {
    const suffixLength = decimal(match[2])
    if (suffixLength == null || suffixLength === 0) {
      throw new HttpFileError(416, 'Range not satisfiable', { 'content-range': `bytes */${size}` })
    }
    const length = Math.min(suffixLength, size)
    return { start: size - length, end: size - 1, length }
  }

  const start = decimal(match[1])
  const requestedEnd = match[2] ? decimal(match[2]) : size - 1
  if (start == null || requestedEnd == null || start >= size || requestedEnd < start) {
    throw new HttpFileError(416, 'Range not satisfiable', { 'content-range': `bytes */${size}` })
  }
  const end = Math.min(requestedEnd, size - 1)
  return { start, end, length: end - start + 1 }
}

/** @param {string} rootPath @param {string} candidatePath */
function insideRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** @param {fs.Stats} left @param {fs.Stats} right */
function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * @typedef {{handle: fs.promises.FileHandle, stat: fs.Stats, canonicalPath: string}} OpenedFile
 */

/** @param {unknown} error */
function filesystemErrorCode(error) {
  if (typeof error !== 'object' || error === null || !('code' in error)) return ''
  return typeof error.code === 'string' ? error.code : ''
}

/** @param {string} staticRoot @param {string} candidatePath @returns {Promise<OpenedFile>} */
export async function openValidatedStaticFile(staticRoot, candidatePath) {
  /** @type {fs.promises.FileHandle | undefined} */
  let handle
  try {
    const canonicalRoot = await fs.promises.realpath(staticRoot)
    const canonicalCandidate = await fs.promises.realpath(candidatePath)
    if (!insideRoot(canonicalRoot, canonicalCandidate)) throw new HttpFileError(404, 'Not found')
    handle = await fs.promises.open(canonicalCandidate, 'r')
    const [descriptorStat, pathStat, canonicalAfterOpen] = await Promise.all([
      handle.stat(),
      fs.promises.stat(canonicalCandidate),
      fs.promises.realpath(candidatePath),
    ])
    if (!descriptorStat.isFile() || !sameFile(descriptorStat, pathStat) || canonicalAfterOpen !== canonicalCandidate) {
      throw new HttpFileError(404, 'Not found')
    }
    return { handle, stat: descriptorStat, canonicalPath: canonicalCandidate }
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error instanceof HttpFileError) throw error
    const code = filesystemErrorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      throw new HttpFileError(404, 'Not found')
    }
    throw new HttpFileError(500, 'Unable to open file')
  }
}

/** @param {string} filePath @returns {Promise<OpenedFile>} */
export async function openRegularFile(filePath) {
  /** @type {fs.promises.FileHandle | undefined} */
  let handle
  try {
    handle = await fs.promises.open(filePath, 'r')
    const stat = await handle.stat()
    if (!stat.isFile()) throw new HttpFileError(404, 'Not found')
    return { handle, stat, canonicalPath: filePath }
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error instanceof HttpFileError) throw error
    const code = filesystemErrorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      throw new HttpFileError(404, 'Not found')
    }
    throw new HttpFileError(500, 'Unable to open file')
  }
}

/** @param {import('node:http').ServerResponse} response @param {Error} error */
function endError(response, error) {
  if (response.destroyed) return
  if (response.headersSent) {
    response.destroy(error)
    return
  }
  response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'content-length': 20 })
  response.end('Unable to read file\n')
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {OpenedFile} opened
 * @param {{contentType?: string, headers?: Record<string, string | number>}} [options]
 */
export async function serveOpenedFile(request, response, opened, {
  contentType = 'application/octet-stream',
  headers = {},
} = {}) {
  const { handle, stat } = opened
  let range
  try {
    range = parseSingleByteRange(request.headers.range, stat.size)
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
  const status = range ? 206 : 200
  const length = range?.length ?? safeSize(stat.size)
  const responseHeaders = {
    ...headers,
    'accept-ranges': 'bytes',
    'content-type': contentType,
    'content-length': length,
    ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${stat.size}` } : {}),
  }
  response.writeHead(status, responseHeaders)
  if (request.method === 'HEAD') {
    await handle.close().catch(() => {})
    response.end()
    return
  }

  await new Promise((resolve) => {
    const stream = handle.createReadStream({
      autoClose: false,
      ...(range ? { start: range.start, end: range.end } : {}),
    })
    let settled = false
    /** @param {Error | null} [error] */
    const finish = async (error = null) => {
      if (settled) return
      settled = true
      await handle.close().catch(() => {})
      if (error) endError(response, error)
      resolve(undefined)
    }
    stream.once('error', finish)
    stream.once('end', finish)
    response.once('close', () => {
      if (!stream.destroyed) stream.destroy()
      void finish()
    })
    stream.pipe(response)
  })
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {unknown} error
 * @param {Record<string, string | number>} [headers]
 */
export function sendHttpFileError(response, error, headers = {}) {
  const status = error instanceof HttpFileError ? error.status : 500
  const body = status === 404 ? 'Not found\n' : status === 416 ? 'Range not satisfiable\n' : 'Internal server error\n'
  if (!response.headersSent) {
    response.writeHead(status, {
      ...headers,
      ...(error instanceof HttpFileError ? error.headers : {}),
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    response.end(body)
  } else if (!response.destroyed) {
    response.destroy(error instanceof Error ? error : new Error('HTTP file response failed'))
  }
}
