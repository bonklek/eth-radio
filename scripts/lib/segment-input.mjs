import fs from 'node:fs'
import path from 'node:path'
import {
  readBoundedSegmentManifest,
  segmentManifestEntries,
} from './live-segment-manifest.mjs'
import { readDirectoryBoundedSync } from './bounded-directory.mjs'

export {
  MAX_SEGMENT_MANIFEST_BYTES,
  MAX_SEGMENT_MANIFEST_ENTRIES,
  readBoundedSegmentManifest,
} from './live-segment-manifest.mjs'

/**
 * @typedef {object} SegmentWaitOptions
 * @property {AbortSignal} [signal]
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 * @property {(message: string) => void} [warn]
 */

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pollDelay(pollMs) {
  return Math.min(1000, Math.max(250, pollMs))
}

function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const error = new Error(reason instanceof Error ? reason.message : 'Segment input wait aborted', {
    cause: reason instanceof Error ? reason : undefined,
  })
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal)
}

function defaultSleep(ms, signal) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, ms)
    function done() {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', aborted)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

/** @param {number} pollMs @param {SegmentWaitOptions} [options] */
async function wait(pollMs, { signal, sleep = defaultSleep } = {}) {
  throwIfAborted(signal)
  await sleep(pollDelay(pollMs), signal)
  throwIfAborted(signal)
}

export function segmentEntries(dir, filePrefix, { maxDirectoryEntries = 50_000 } = {}) {
  const pattern = new RegExp(`^${escapeRegExp(filePrefix)}-(\\d+)\\.webm$`)
  return readDirectoryBoundedSync(dir, {
    maxEntries: maxDirectoryEntries,
    label: `segment input directory ${dir}`,
  }).entries
    .map((name) => {
      const match = name.match(pattern)
      return match ? { sequence: Number(match[1]), file: path.join(dir, name) } : null
    })
    .filter(Boolean)
    .sort((left, right) => left.sequence - right.sequence)
}

export function segmentEntry(dir, filePrefix, sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Segment sequence must be a non-negative safe integer')
  const name = `${filePrefix}-${String(sequence).padStart(6, '0')}.webm`
  const file = path.join(dir, name)
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? { sequence, file } : null
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

export function manifestSegmentFile({ dir, filePrefix, sequence, segment }) {
  const fileValue = String(segment.file || '')
  if (!fileValue) throw new Error(`Manifest segment ${sequence} is missing file`)

  const file = path.isAbsolute(fileValue) ? path.resolve(fileValue) : path.resolve(dir, fileValue)
  const root = path.resolve(dir)
  const expectedName = `${filePrefix}-${String(sequence).padStart(6, '0')}.webm`
  if (path.dirname(file) !== root || path.basename(file) !== expectedName) {
    throw new Error(`Manifest segment ${sequence} points outside the watched segment file: ${fileValue}`)
  }
  return file
}

export function manifestSegments(manifestPath, manifest) {
  return segmentManifestEntries(manifest, manifestPath)
}

export function manifestNonNegativeInteger(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const number = Number(value)
    if (Number.isSafeInteger(number)) return number
  }
  throw new Error(`${label} must be a non-negative integer`)
}

export function manifestSegmentSequence(entry, index, manifestPath) {
  return manifestNonNegativeInteger(entry?.sequence, `Manifest ${manifestPath} segment ${index} sequence`)
}

export function manifestSegmentBytes(segment, sequence) {
  const bytes = manifestNonNegativeInteger(segment.bytes, `Manifest segment ${sequence} bytes`)
  if (bytes <= 0) throw new Error(`Manifest segment ${sequence} bytes must be greater than zero`)
  return bytes
}

/** @param {string} file @param {number} pollMs @param {SegmentWaitOptions} [options] */
export async function waitForStableFile(file, pollMs, options = {}) {
  let previous = null
  while (true) {
    throwIfAborted(options.signal)
    const current = fs.statSync(file)
    if (current.size > 0 && previous && previous.size === current.size && previous.mtimeMs === current.mtimeMs) {
      return current
    }
    previous = { size: current.size, mtimeMs: current.mtimeMs }
    await wait(pollMs, options)
  }
}

/** @param {string} dir @param {string} filePrefix @param {number} sequence @param {number} pollMs @param {boolean} required @param {SegmentWaitOptions} [options] */
export async function waitForManifestSegment(dir, filePrefix, sequence, pollMs, required, options = {}) {
  const manifestPath = path.join(dir, `${filePrefix}.segments.json`)
  const warn = options.warn || console.warn
  let warned = false
  while (required || fs.existsSync(manifestPath)) {
    throwIfAborted(options.signal)
    if (!fs.existsSync(manifestPath)) {
      await wait(pollMs, options)
      continue
    }

    try {
      const manifest = readBoundedSegmentManifest(manifestPath)
      const segment = manifestSegments(manifestPath, manifest)
        .find((entry, index) => manifestSegmentSequence(entry, index, manifestPath) === sequence)
      if (segment) {
        const bytes = manifestSegmentBytes(segment, sequence)
        const file = manifestSegmentFile({ dir, filePrefix, sequence, segment })
        if (fs.existsSync(file)) {
          const stat = fs.statSync(file)
          if (stat.size === bytes) return { ...segment, file, bytes }
        }
      }
    } catch (error) {
      if (!warned) {
        const mode = required
          ? (error instanceof SyntaxError ? 'waiting for a valid manifest' : 'failing because --require-manifest is set')
          : 'falling back to segment file'
        warn(`Ignoring invalid segment manifest ${manifestPath}: ${error.message}; ${mode}`)
        warned = true
      }
      if (!required) return null
      if (!(error instanceof SyntaxError)) throw error
      await wait(pollMs, options)
      continue
    }
    await wait(pollMs, options)
  }
  return null
}
