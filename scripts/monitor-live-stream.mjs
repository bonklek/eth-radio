import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { numberArg, readArg } from './lib/cli-args.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import { resolveRunDirectory, scopedStreamFilesystemIdentity, streamFilesystemIdentity } from './lib/filesystem-identity.mjs'
import { readBoundedSegmentManifest, segmentManifestEntries } from './lib/live-segment-manifest.mjs'
import { readPublisherStateSnapshot } from './lib/publisher-state.mjs'

if (helpRequested()) {
  console.log(`Usage:
  pnpm live:monitor -- [--stream-id <id>] [--state <state.json>]
                         [--manifest <segments.json>] [--stale-ms 180000]
`)
  process.exit(0)
}
dotenv.config({ quiet: true })

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

function inclusionTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return { state: 'missing', timestampMs: null }
  const timestampMs = Date.parse(value)
  if (!Number.isFinite(timestampMs)) return { state: 'invalid', timestampMs: null }
  if (new Date(timestampMs).toISOString() !== value) return { state: 'invalid', timestampMs: null }
  return { state: 'valid', timestampMs }
}

function inclusionHealth(value, staleMs, now = Date.now()) {
  const parsed = inclusionTimestamp(value)
  if (parsed.state !== 'valid') return { ...parsed, ageMs: null }
  const ageMs = now - parsed.timestampMs
  if (ageMs < 0) return { state: 'future', timestampMs: parsed.timestampMs, ageMs }
  if (ageMs > staleMs) return { state: 'stale', timestampMs: parsed.timestampMs, ageMs }
  return { state: 'fresh', timestampMs: parsed.timestampMs, ageMs }
}

function readOptionalManifest(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    const manifest = readBoundedSegmentManifest(filePath)
    const segments = segmentManifestEntries(manifest, filePath)
    const invalidIndex = manifest.segments.findIndex((segment) => segmentSequence(segment) == null)
    if (invalidIndex !== -1) {
      console.warn(`Ignoring invalid generated manifest ${filePath}: segment ${invalidIndex} sequence must be a non-negative integer`)
      return null
    }
    return { ...manifest, segments }
  } catch (error) {
    console.warn(`Ignoring unreadable generated manifest ${filePath}: ${error.message}`)
    return null
  }
}

function readPublishState(filePath) {
  return readPublisherStateSnapshot(filePath, { label: `publish state ${filePath}` })
}

const streamId = readArg('stream-id', process.env.STREAM_ID || 'rfe-baked-clock-pipe-v6')
const filePrefix = streamFilesystemIdentity(streamId).key
const publisher = process.env.PRIVATE_KEY
  ? privateKeyToAccount(/** @type {`0x${string}`} */ (process.env.PRIVATE_KEY)).address
  : process.env.PUBLISHER_ADDRESS
const runIdentity = scopedStreamFilesystemIdentity({ chain: process.env.CHAIN || 'sepolia', station: process.env.STATION_ADDRESS, publisher, streamId })
const stateArg = readArg('state')
const manifestArg = readArg('manifest')
const defaultRunDir = stateArg && manifestArg
  ? path.join(path.resolve('work/blob-radio-testnet/live-runs'), runIdentity.key)
  : resolveRunDirectory({ baseDir: path.resolve('work/blob-radio-testnet/live-runs'), streamId, identity: runIdentity })
const statePath = path.resolve(
  stateArg || path.join(defaultRunDir, 'publish-state.json'),
)
const manifestPath = path.resolve(
  manifestArg || path.join(defaultRunDir, 'segments', `${filePrefix}.segments.json`),
)
const staleMs = numberArg('stale-ms', '180000', { integer: true, min: 1 })

if (!fs.existsSync(statePath)) throw new Error(`Publish state not found: ${statePath}`)

const state = readPublishState(statePath)
const published = state.published
  .map((item) => ({
    ...item,
    sequence: nonNegativeInteger(item.sequence, 'published sequence'),
    inclusion: inclusionTimestamp(item.includedAt),
  }))
  .sort((left, right) =>
    left.sequence - right.sequence
    || (left.inclusion.timestampMs ?? -1) - (right.inclusion.timestampMs ?? -1))
const latest = published.at(-1) || null
const manifest = readOptionalManifest(manifestPath)
const generated = manifest
  ? manifest.segments
      .map((segment) => ({ ...segment, sequence: nonNegativeInteger(segment.sequence, 'generated sequence') }))
      .sort((left, right) => left.sequence - right.sequence)
  : []
const latestGenerated = generated.at(-1) || null
const latestInclusion = latest ? inclusionHealth(latest.includedAt, staleMs) : { state: 'missing', timestampMs: null, ageMs: null }
const latestAgeMs = latestInclusion.ageMs
const generatedLag = latestGenerated && latest ? segmentSequence(latestGenerated) - nonNegativeInteger(latest.sequence, 'latest published sequence') : null
const ok = Boolean(latest) && latestInclusion.state === 'fresh'
const compactedPublishedCount = state.historyAnchor == null
  ? 0
  : nonNegativeInteger(state.historyAnchor?.publishedCount, 'historyAnchor publishedCount')
const publishedCount = compactedPublishedCount + published.length
if (!Number.isSafeInteger(publishedCount)) throw new Error('total published count exceeds JavaScript safe integer range')

const summary = {
  streamId,
  ok,
  publishedCount,
  nextSequence: state.nextSequence,
  latestSequence: latest?.sequence ?? null,
  latestTxHash: latest?.txHash ?? null,
  latestBlockNumber: latest?.blockNumber ?? null,
  latestPayloadBytes: latest?.payloadBytes ?? null,
  latestBlobCount: latest?.blobCount ?? null,
  latestIncludedAt: latest?.includedAt ?? null,
  latestAgeSeconds: latestAgeMs == null ? null : Math.round(latestAgeMs / 1000),
  latestInclusionState: latestInclusion.state,
  invalidIncludedAtCount: published.filter((item) => item.inclusion.state !== 'valid').length,
  latestGeneratedSequence: latestGenerated?.sequence ?? null,
  generatedLag,
  staleAfterSeconds: Math.round(staleMs / 1000),
}

console.log(JSON.stringify(summary, null, 2))
process.exit(ok ? 0 : 2)
