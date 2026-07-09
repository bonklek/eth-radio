import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { numberArg, readArg } from './lib/cli-args.mjs'

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function isNonNegativeInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.isSafeInteger(Number(value))
  return false
}

function nonNegativeInteger(value, label) {
  if (!isNonNegativeInteger(value)) throw new Error(`${label} must be a non-negative integer`)
  return Number(value)
}

function segmentSequence(segment) {
  try {
    return nonNegativeInteger(segment?.sequence, 'sequence')
  } catch {
    return null
  }
}

function readOptionalManifest(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (!Array.isArray(manifest?.segments)) {
      console.warn(`Ignoring invalid generated manifest ${filePath}: segments must be an array`)
      return null
    }
    const invalidIndex = manifest.segments.findIndex((segment) => segmentSequence(segment) == null)
    if (invalidIndex !== -1) {
      console.warn(`Ignoring invalid generated manifest ${filePath}: segment ${invalidIndex} sequence must be a non-negative integer`)
      return null
    }
    return manifest
  } catch (error) {
    console.warn(`Ignoring unreadable generated manifest ${filePath}: ${error.message}`)
    return null
  }
}

function readPublishState(filePath) {
  let state
  try {
    state = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Unreadable publish state ${filePath}: ${error.message}`)
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error(`Invalid publish state ${filePath}: expected an object`)
  }
  if (state.published !== undefined && !Array.isArray(state.published)) {
    throw new Error(`Invalid publish state ${filePath}: published must be an array`)
  }
  if (state.nextSequence !== undefined && !isNonNegativeInteger(state.nextSequence)) {
    throw new Error(`Invalid publish state ${filePath}: nextSequence must be a non-negative integer`)
  }
  const published = state.published === undefined ? [] : state.published
  for (const [index, item] of published.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid publish state ${filePath}: published[${index}] must be an object`)
    }
    nonNegativeInteger(item.sequence, `published[${index}].sequence`)
  }
  return { ...state, published }
}

const streamId = readArg('stream-id', process.env.STREAM_ID || 'rfe-baked-clock-pipe-v6')
const safeStreamId = sanitize(streamId)
const statePath = path.resolve(
  readArg('state', `work/blob-radio-testnet/live-runs/${safeStreamId}/publish-state.json`),
)
const manifestPath = path.resolve(
  readArg('manifest', `work/blob-radio-testnet/live-runs/${safeStreamId}/segments/${safeStreamId}.segments.json`),
)
const staleMs = numberArg('stale-ms', '180000', { integer: true, min: 1 })

if (!fs.existsSync(statePath)) throw new Error(`Publish state not found: ${statePath}`)

const state = readPublishState(statePath)
const published = state.published
const latest = published.at(-1) || null
const manifest = readOptionalManifest(manifestPath)
const generated = manifest ? manifest.segments : []
const latestGenerated = generated.at(-1) || null
const latestAgeMs = latest?.includedAt ? Date.now() - Date.parse(latest.includedAt) : null
const generatedLag = latestGenerated && latest ? segmentSequence(latestGenerated) - nonNegativeInteger(latest.sequence, 'latest published sequence') : null
const ok = Boolean(latest) && (latestAgeMs == null || latestAgeMs <= staleMs)

const summary = {
  streamId,
  ok,
  publishedCount: published.length,
  nextSequence: state.nextSequence,
  latestSequence: latest?.sequence ?? null,
  latestTxHash: latest?.txHash ?? null,
  latestBlockNumber: latest?.blockNumber ?? null,
  latestPayloadBytes: latest?.payloadBytes ?? null,
  latestBlobCount: latest?.blobCount ?? null,
  latestIncludedAt: latest?.includedAt ?? null,
  latestAgeSeconds: latestAgeMs == null ? null : Math.round(latestAgeMs / 1000),
  latestGeneratedSequence: latestGenerated?.sequence ?? null,
  generatedLag,
  staleAfterSeconds: Math.round(staleMs / 1000),
}

console.log(JSON.stringify(summary, null, 2))
process.exit(ok ? 0 : 2)
