import dotenv from 'dotenv'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  commitmentToVersionedHash,
  createPublicClient,
  getAddress,
  hexToBytes,
  http as viemHttp,
  parseEventLogs,
} from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { executionTimestampSlot, slotStartTimestamp } from '../packages/protocol/browser-kernel.js'
import { endpointSafeErrorMessage } from './lib/endpoint-privacy.mjs'
import { readBoundedJsonFileSync } from './lib/bounded-files.mjs'
import { HttpFileError, openRegularFile, sendHttpFileError, serveOpenedFile } from './lib/http-file-serving.mjs'
import {
  BLOB_DATA_BYTES,
  ensureVerifiedMediaCache,
  isExactBlobHex,
  loadOrFetchValidatedSidecarCache,
  normalizeRequestedBlobHashes,
  openVerifiedMediaFile,
  readBoundedJsonResponse,
  readValidatedSidecarCache,
  validateBeaconSidecars,
  verifyOrDeleteCachedMedia,
} from './lib/live-demo-integrity.mjs'
import {
  mapWithConcurrency,
  scanStationHistory,
  STATION_LOG_AGGREGATE_LIMIT,
  STATION_LOG_RESPONSE_LIMIT,
  STATION_RETAINED_SEGMENT_LIMIT,
  STATION_SCAN_BLOCK_LIMIT,
  STATION_TIMESTAMP_BLOCK_LIMIT,
  stationHistoryScopeKey,
} from './lib/station-history.mjs'
import { createLiveDemoPages } from './lib/live-demo-pages.mjs'
import { helpRequested } from './lib/cli-help.mjs'
import { createLocalManifestIndex } from './lib/local-manifest-index.mjs'
import { checkLoopbackRequest } from './lib/loopback-request-policy.mjs'
import { createProofRunIndex } from './lib/proof-run-index.mjs'
import { streamFilesystemIdentity } from './lib/filesystem-identity.mjs'
import {
  annotateStreamContinuity,
  mediaCacheFilename,
  normalizePublisher,
  proofManifestMatchesChannel,
  segmentRouteUrls,
  selectPublisherScopedChannel,
  UNATTRIBUTED_PUBLISHER,
  withChannelIdentity,
} from './lib/stream-identity-continuity.mjs'

if (helpRequested()) {
  console.log(`Usage:
  pnpm demo:live

Environment:
  PORT, CHAIN, STREAM_ID, ETH_RPC_URL, BEACON_RPC_URL, STATION_ADDRESS,
  optional MAINNET_ETH_RPC_URL, MAINNET_BEACON_RPC_URL, and bounded viewer/cache controls.

The development server binds to 127.0.0.1 only.
`)
  process.exit(0)
}
dotenv.config({ quiet: true })

const root = process.cwd()
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const canonicalViewerDir = path.join(sourceRoot, 'public', 'decentralized')
const port = envNumber('PORT', 5173, { integer: true, min: 1, max: 65535 })
const canonicalStationAddress = '0x060c51d481808b506dfae72f054f39e11e4f4017'
const canonicalStationFromBlock = '11226386'
const manifestDir = path.join(root, 'work', 'blob-radio-testnet', 'manifests')
const mediaDir = path.join(root, 'work', 'blob-radio-testnet', 'media')
const reconstructedDir = path.join(root, 'work', 'blob-radio-testnet', 'reconstructed')
const sidecarDir = path.join(root, 'work', 'blob-radio-testnet', 'sidecars')
const liveRunDir = path.join(root, 'work', 'blob-radio-testnet', 'live-runs')
const overlayAssetDir = fs.existsSync(path.join(root, 'public', 'rfe-assets'))
  ? path.join(root, 'public', 'rfe-assets')
  : path.join(root, 'work', 'radio-free-ethereum', 'final')
const previewVideoFile = process.env.PREVIEW_VIDEO_FILE || ''
const maxBlobsPerBlock = envNumber('MAX_BLOBS_PER_BLOCK', 21, { integer: true, min: 1, max: 64 })
const beaconMaxResponseBytes = envNumber('BEACON_MAX_RESPONSE_BYTES', 8 * 1024 * 1024, {
  integer: true,
  min: 1024,
  max: 32 * 1024 * 1024,
})
const sidecarCacheMaxBytes = envNumber('SIDECAR_CACHE_MAX_BYTES', beaconMaxResponseBytes, {
  integer: true,
  min: 1024,
  max: 32 * 1024 * 1024,
})
// Operational controls are intentionally bounded: these values directly multiply RPC
// calls, timers, retained records, or response work.
const slotWindow = envNumber('SLOT_WINDOW', 8, { integer: true, min: 1, max: 64 })
const slotMetricsConcurrency = envNumber('SLOT_METRICS_CONCURRENCY', 4, { integer: true, min: 1, max: 16 })
const slotMetricsCacheMs = envNumber('SLOT_METRICS_CACHE_MS', 2000, { integer: true, min: 250, max: 60_000 })
const viewerPollMs = envNumber('VIEWER_POLL_MS', 2000, { integer: true, min: 250, max: 60_000 })
const localManifestMaxBytes = envNumber('LOCAL_MANIFEST_MAX_BYTES', 256 * 1024, { integer: true, min: 1024, max: 8 * 1024 * 1024 })
const localManifestMaxFiles = envNumber('LOCAL_MANIFEST_MAX_FILES', 8192, { integer: true, min: 1, max: 50_000 })
const localManifestScanMaxEntries = envNumber('LOCAL_MANIFEST_SCAN_MAX_ENTRIES', 20_000, { integer: true, min: 1, max: 100_000 })
const localManifestAggregateMaxBytes = envNumber('LOCAL_MANIFEST_AGGREGATE_MAX_BYTES', 64 * 1024 * 1024, { integer: true, min: 1024, max: 256 * 1024 * 1024 })
const proofManifestMaxBytes = envNumber('PROOF_MANIFEST_MAX_BYTES', 8 * 1024 * 1024, { integer: true, min: 1024, max: 32 * 1024 * 1024 })
const proofManifestMaxEntries = envNumber('PROOF_MANIFEST_MAX_ENTRIES', 10_000, { integer: true, min: 1, max: 50_000 })
const stationHistoryInitialBlocks = envNumber('STATION_HISTORY_INITIAL_BLOCKS', 8192, { integer: true, min: 1, max: STATION_SCAN_BLOCK_LIMIT })
const stationHistoryRefreshBlocks = envNumber('STATION_HISTORY_REFRESH_BLOCKS', 2048, { integer: true, min: 1, max: 100_000 })
const stationHistoryLogRangeBlocks = envNumber('STATION_HISTORY_LOG_RANGE_BLOCKS', 1024, { integer: true, min: 1, max: 10_000 })
const stationHistoryResponseLogLimit = envNumber('STATION_HISTORY_RESPONSE_LOG_LIMIT', STATION_LOG_RESPONSE_LIMIT, { integer: true, min: 1, max: STATION_LOG_RESPONSE_LIMIT })
const stationHistoryAggregateLogLimit = envNumber('STATION_HISTORY_AGGREGATE_LOG_LIMIT', STATION_LOG_AGGREGATE_LIMIT, { integer: true, min: 1, max: STATION_LOG_AGGREGATE_LIMIT })
const stationHistoryRetainedSegmentLimit = envNumber('STATION_HISTORY_RETAINED_SEGMENT_LIMIT', STATION_RETAINED_SEGMENT_LIMIT, { integer: true, min: 1, max: STATION_RETAINED_SEGMENT_LIMIT })
const stationHistoryTimestampBlockLimit = envNumber('STATION_HISTORY_TIMESTAMP_BLOCK_LIMIT', STATION_TIMESTAMP_BLOCK_LIMIT, { integer: true, min: 1, max: STATION_TIMESTAMP_BLOCK_LIMIT })
// Blocks newer than the finalized cursor remain inside this reconciliation window. Every
// refresh discards and reloads that tail, so replacements/removals from shallow reorgs win.
const stationHistoryReorgBlocks = envNumber('STATION_HISTORY_REORG_BLOCKS', 12, { integer: true, min: 1, max: 1024 })
const stationHistoryTimestampConcurrency = envNumber('STATION_HISTORY_TIMESTAMP_CONCURRENCY', 4, { integer: true, min: 1, max: 32 })
const streamId = process.env.STREAM_ID || 'rfe-baked-clock-pipe-v6'
const defaultNetwork = normalizeNetwork(process.env.CHAIN || 'sepolia')
const chains = { mainnet, sepolia }
const stationEventAbi = [
  {
    type: 'event',
    name: 'SegmentPublished',
    inputs: [
      { name: 'publisher', type: 'address', indexed: true },
      { name: 'streamIdHash', type: 'bytes32', indexed: true },
      { name: 'sequence', type: 'uint256', indexed: true },
      { name: 'streamId', type: 'string', indexed: false },
      { name: 'durationMs', type: 'uint64', indexed: false },
      { name: 'payloadBytes', type: 'uint32', indexed: false },
      { name: 'payloadSha256', type: 'bytes32', indexed: false },
      { name: 'codec', type: 'string', indexed: false },
      { name: 'previousSegmentHash', type: 'bytes32', indexed: false },
      { name: 'blobVersionedHashes', type: 'bytes32[]', indexed: false },
    ],
  },
]
const endpointPresets = {
  public: {
    label: 'Public RPC preset',
    networks: {
      sepolia: {
        executionRpc: 'https://sepolia.drpc.org',
        beaconApi: 'https://ethereum-sepolia-beacon-api.publicnode.com',
      },
      mainnet: {
        executionRpc: 'https://ethereum-rpc.publicnode.com',
        beaconApi: 'https://ethereum-beacon-api.publicnode.com',
      },
    },
  },
}
const beaconTimeoutMs = envNumber('BEACON_TIMEOUT_MS', 3500, { integer: true, min: 250, max: 30_000 })
const stationSegmentsCache = new Map()
const stationSegmentsPromise = new Map()
const slotMetricsCache = new Map()
const slotMetricsPromise = new Map()
const genesisTimeCache = new Map()
const mediaInflight = new Map()
const filesystemWarnings = new Set()
const localDiscoveryComplete = Symbol('localManifestDiscoveryComplete')

function normalizeNetwork(value) {
  const text = String(value || '').toLowerCase()
  if (text === 'mainnet' || text === 'ethereum' || text === 'eth') return 'mainnet'
  return 'sepolia'
}

function envNumber(name, fallback, { integer = false, min = undefined, max = undefined } = {}) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  const invalid = !Number.isFinite(value)
    || (integer && !Number.isSafeInteger(value))
    || (min !== undefined && value < min)
    || (max !== undefined && value > max)
  if (!invalid) return value
  const constraints = [
    integer ? 'integer' : 'number',
    min !== undefined ? `>= ${min}` : '',
    max !== undefined ? `<= ${max}` : '',
  ].filter(Boolean).join(' ')
  console.warn(`Ignoring invalid ${name}: expected ${constraints}, got ${raw}`)
  return fallback
}

function networkLabel(network) {
  return normalizeNetwork(network) === 'mainnet' ? 'Mainnet' : 'Sepolia'
}

function envForNetwork(network, name, fallback = '') {
  const prefix = network.toUpperCase()
  return process.env[`${prefix}_${name}`] || process.env[`${name}_${prefix}`] || (network === defaultNetwork ? process.env[name] : '') || fallback
}

function endpointPresetFor(network, presetKey) {
  const key = endpointPresets[presetKey] ? presetKey : ''
  const endpoints = key ? endpointPresets[key].networks[network] : null
  return endpoints ? { key, ...endpoints } : { key: '', executionRpc: '', beaconApi: '' }
}

function readStationDeployment(name) {
  const deploymentPath = path.join(root, 'work', 'blob-radio-testnet', 'contracts', `Station.${name}.json`)
  if (!fs.existsSync(deploymentPath)) return null
  try {
    const deployment = readJson(deploymentPath)
    if (Array.isArray(deployment?.abi)) return deployment
    console.warn(`Ignoring invalid Station deployment metadata for ${name}: missing abi array`)
  } catch (error) {
    console.warn(`Ignoring unreadable Station deployment metadata for ${name}: ${error.message}`)
  }
  return null
}

function envBlockNumber(network, name, fallback = '0') {
  const value = envForNetwork(network, name, fallback)
  try {
    const block = BigInt(value)
    return block >= 0n ? block : BigInt(fallback)
  } catch {
    console.warn(`Ignoring invalid ${network.toUpperCase()}_${name}: expected a non-negative integer`)
    return BigInt(fallback)
  }
}

function contextCacheKey(ctx) {
  const stationScope = stationHistoryScopeKey(ctx.name, ctx.stationAddress)
  return `${stationScope}:${ctx.stationFromBlock ?? 0n}:${ctx.endpointPreset || 'env'}:${ctx.executionUrl || ''}:${ctx.beaconUrl || ''}`
}

function publicErrorMessage(error, ctx = null) {
  const endpoints = [ctx?.executionUrl, ctx?.beaconUrl]
    .filter(Boolean)
  return endpointSafeErrorMessage(error, endpoints)
}

function blobspaceConfig(ctx) {
  return {
    endpointPreset: ctx.endpointPreset || '',
    endpointPresetLabel: ctx.endpointPreset ? endpointPresets[ctx.endpointPreset]?.label || ctx.endpointPreset : '',
    presetAvailable: Boolean(endpointPresets.public?.networks?.[ctx.name]),
    executionRpcConfigured: Boolean(ctx.publicClient),
    beaconApiConfigured: Boolean(ctx.beaconUrl),
    beaconSlotBase: ctx.beaconSlotBase,
  }
}

function networkContext(networkInput, options = {}) {
  const name = normalizeNetwork(networkInput)
  const chain = chains[name]
  const preset = endpointPresetFor(name, options.endpointPreset || '')
  const executionFallback = preset.executionRpc || (name === 'mainnet' ? 'https://ethereum-rpc.publicnode.com' : '')
  const beaconFallback = preset.beaconApi || (name === 'mainnet' ? 'https://ethereum-beacon-api.publicnode.com' : '')
  const executionUrl = envForNetwork(name, 'ETH_RPC_URL', executionFallback)
  const beaconUrl = envForNetwork(name, 'BEACON_RPC_URL', beaconFallback)?.replace(/\/$/, '')
  const stationDeployment = readStationDeployment(name)
  const stationAddress = envForNetwork(name, 'STATION_ADDRESS', name === 'sepolia' ? canonicalStationAddress : '')
  const stationFromBlock = envBlockNumber(name, 'STATION_FROM_BLOCK', name === 'sepolia' ? canonicalStationFromBlock : '0')
  return {
    name,
    label: networkLabel(name),
    chain,
    endpointPreset: preset.key,
    beaconUrl,
    executionUrl,
    publicClient: chain && executionUrl ? createPublicClient({ chain, transport: viemHttp(executionUrl) }) : null,
    stationAddress,
    stationAbi: stationDeployment?.abi || stationEventAbi,
    stationFromBlock,
    explorerBase: name === 'mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io',
    beaconSlotBase: name === 'mainnet' ? 'https://beaconscan.com/slot/' : 'https://sepolia.beaconcha.in/slot/',
  }
}

function segmentOrderPart(value, label) {
  if (value == null || value === '') return 0n
  try {
    const order = BigInt(value)
    if (order >= 0n) return order
  } catch (error) {
    throw new Error(`${label} must be a non-negative integer`, { cause: error })
  }
  throw new Error(`${label} must be a non-negative integer`)
}

function compareSegmentOrderPart(left, right, label) {
  const a = segmentOrderPart(left, label)
  const b = segmentOrderPart(right, label)
  return a < b ? -1 : a > b ? 1 : 0
}

function canonicalSegmentSort(a, b) {
  return (
    String(a.streamId || '').localeCompare(String(b.streamId || '')) ||
    String(a.publisher || '').localeCompare(String(b.publisher || '')) ||
    compareSegmentOrderPart(a.sequence, b.sequence, 'segment sequence') ||
    compareSegmentOrderPart(a.blockNumber, b.blockNumber, 'segment blockNumber') ||
    compareSegmentOrderPart(a.transactionIndex, b.transactionIndex, 'segment transactionIndex') ||
    compareSegmentOrderPart(a.logIndex, b.logIndex, 'segment logIndex')
  )
}

const defaultHeaders = {
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...defaultHeaders,
    ...headers,
  })
  response.end(body)
}

function sendJson(response, value, status = 200) {
  send(response, status, JSON.stringify(value, null, 2), {
    'content-type': 'application/json; charset=utf-8',
  })
}

function decodePathParam(response, value) {
  try {
    return decodeURIComponent(value)
  } catch {
    send(response, 400, 'bad request')
    return null
  }
}

function warnFilesystemOnce(key, message) {
  if (filesystemWarnings.has(key)) return
  filesystemWarnings.add(key)
  console.warn(message)
}

function readJson(filePath, { maxBytes = 1024 * 1024, label = `JSON file ${filePath}` } = {}) {
  return readBoundedJsonFileSync(filePath, { maxBytes, label })
}

function safeStreamId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function isTxHash(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || ''))
}

function isBytes32Hex(value) {
  return /^[0-9a-fA-F]{64}$/.test(String(value || '').replace(/^0x/, ''))
}

function isBytes48Hex(value) {
  return /^0x[0-9a-fA-F]{96}$/.test(String(value || ''))
}

function safeSegmentSequence(value) {
  const sequence = Number(value)
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null
  return sequence
}

function nonNegativeSafeInteger(value, label) {
  if (typeof value === 'bigint') {
    if (value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
  } else if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return value
  } else if (/^\d+$/.test(String(value || ''))) {
    const number = Number(value)
    if (Number.isSafeInteger(number)) return number
  }
  throw new Error(`${label} must be a non-negative safe integer`)
}

function optionalNonNegativeSafeInteger(value, label) {
  if (value == null) return null
  return nonNegativeSafeInteger(value, label)
}

function blockTimestampMs(value, label) {
  let milliseconds
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`${label} must be a non-negative safe integer`)
    milliseconds = value * 1000n
  } else {
    const seconds = nonNegativeSafeInteger(value, label)
    milliseconds = BigInt(seconds) * 1000n
  }
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} milliseconds must be a safe integer`)
  return Number(milliseconds)
}

function safeSlot(value) {
  const slot = Number(value)
  if (!Number.isSafeInteger(slot) || slot < 0) return null
  return slot
}

function sidecarIndex(value, label = 'sidecar index') {
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return index
}

function safeSidecarPath(txHash) {
  if (!isTxHash(txHash)) return null
  return path.join(sidecarDir, `${String(txHash).toLowerCase()}.json`)
}

function validSidecarMatch(match) {
  return match
    && typeof match === 'object'
    && !Array.isArray(match)
    && safeSlot(match.index) !== null
    && isBytes32Hex(match.versionedHash)
    && isExactBlobHex(match.blob)
}

function beaconData(response, label) {
  if (!response || typeof response !== 'object' || Array.isArray(response) || !('data' in response)) {
    throw new Error(`Invalid beacon ${label} response: missing data`)
  }
  return response.data
}

function beaconDataArray(response, label) {
  const data = beaconData(response, label)
  if (!Array.isArray(data)) throw new Error(`Invalid beacon ${label} response: data must be an array`)
  return data
}

function beaconGenesisTime(response) {
  const data = beaconData(response, 'genesis')
  const genesisTime = data?.genesis_time
  if (!/^\d+$/.test(String(genesisTime || ''))) {
    throw new Error('Invalid beacon genesis response: genesis_time must be a decimal string')
  }
  return BigInt(genesisTime)
}

function sidecarVersionedHash(sidecar) {
  const commitment = sidecar?.kzg_commitment || sidecar?.kzgCommitment
  if (!commitment) return null
  if (!isBytes48Hex(commitment)) throw new Error(`Invalid sidecar KZG commitment: ${commitment}`)
  return commitmentToVersionedHash({ commitment: /** @type {`0x${string}`} */ (commitment) })
}

function safeMediaPath(segment, ctx = {}) {
  try {
    return path.join(reconstructedDir, mediaCacheFilename(segment, ctx))
  } catch {
    return null
  }
}

function sendLocalDiscoveryPending(response, streamId) {
  sendJson(response, {
    error: 'local manifest discovery is still in progress; retry this request',
    streamId,
    discoveryComplete: false,
    retryable: true,
  }, 503)
}

function indexedChannelRequest(response, streamId, publisher) {
  if (publisher == null || publisher === '') return { streamId }
  try {
    return { streamId, publisher: normalizePublisher(publisher) }
  } catch (error) {
    sendJson(response, { error: error.message }, 400)
    return null
  }
}

function selectedApiChannel(response, segments, streamId, publisher) {
  let selection
  try {
    selection = selectPublisherScopedChannel(segments, { streamId, publisher })
  } catch (error) {
    sendJson(response, { error: error.message }, 400)
    return null
  }
  if (selection.status === 'ambiguous') {
    sendJson(response, {
      error: 'publisher query parameter is required because this streamId has multiple publishers',
      streamId,
      publishers: selection.publishers,
    }, 409)
    return null
  }
  if (segments[localDiscoveryComplete] === false
    && (selection.status === 'not-found' || (!publisher && selection.status !== 'ambiguous'))) {
    sendLocalDiscoveryPending(response, streamId)
    return null
  }
  return selection
}

function normalizeBlobVersionedHashes(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const hashes = []
  for (const hash of value) {
    if (!isBytes32Hex(hash)) return null
    hashes.push(String(hash).toLowerCase())
  }
  return hashes
}

function normalizeLocalManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null
  const streamId = typeof manifest.streamId === 'string' ? manifest.streamId : ''
  const sequence = safeSegmentSequence(manifest.sequence)
  const txHash = String(manifest.txHash || manifest.transactionHash || '')
  const payloadSha256 = String(manifest.payloadSha256 || '').replace(/^0x/, '')
  const blobVersionedHashes = normalizeBlobVersionedHashes(manifest.blobVersionedHashes)
  if (!streamId || sequence == null || !isTxHash(txHash) || !isBytes32Hex(payloadSha256) || blobVersionedHashes == null) return null
  return withChannelIdentity({
    ...manifest,
    streamId,
    sequence,
    txHash: txHash.toLowerCase(),
    transactionHash: txHash.toLowerCase(),
    payloadSha256: payloadSha256.toLowerCase(),
    payloadSha256Hex: `0x${payloadSha256.toLowerCase()}`,
    blobVersionedHashes,
  }, { allowUnattributed: true })
}

function stationSegmentFromLog(log, ctx, createdAtMs = null) {
  const sequence = nonNegativeSafeInteger(log.args.sequence, 'Station segment sequence')
  const durationMs = nonNegativeSafeInteger(log.args.durationMs, 'Station segment durationMs')
  const payloadBytes = nonNegativeSafeInteger(log.args.payloadBytes, 'Station segment payloadBytes')
  const blobVersionedHashes = normalizeBlobVersionedHashes(log.args.blobVersionedHashes)
  if (blobVersionedHashes == null) throw new Error('Invalid Station segment blobVersionedHashes')
  const payloadSha256 = String(log.args.payloadSha256 || '').replace(/^0x/, '')
  if (!isBytes32Hex(payloadSha256)) throw new Error('Invalid Station segment payloadSha256')
  const segment = withChannelIdentity({
    app: 'eth-radio',
    version: 1,
    chain: ctx.name,
    source: 'station',
    station: getAddress(ctx.stationAddress),
    streamId: log.args.streamId,
    sequence,
    durationMs,
    payloadBytes,
    payloadSha256: payloadSha256.toLowerCase(),
    payloadSha256Hex: `0x${payloadSha256.toLowerCase()}`,
    codec: log.args.codec,
    previousSegmentHash: log.args.previousSegmentHash,
    blobCount: blobVersionedHashes.length,
    txHash: log.transactionHash,
    transactionHash: log.transactionHash,
    blockNumber: log.blockNumber.toString(),
    blockHash: log.blockHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
    publisher: log.args.publisher,
    streamIdHash: log.args.streamIdHash,
    blobVersionedHashes,
  })
  Object.assign(segment, segmentRouteUrls(segment))
  const mediaPath = safeMediaPath(segment, ctx)
  return { ...segment, hasMedia: mediaPath ? fs.existsSync(mediaPath) : false }
}

const proofRunIndex = createProofRunIndex({
  directory: liveRunDir,
  maxEntriesPerBatch: 256,
  maxCacheEntries: 10_000,
  loadMarker: (markerPath) => readJson(markerPath, {
    maxBytes: 64 * 1024,
    label: `stream identity marker ${markerPath}`,
  }),
})

function readProofSegments(id, publisher) {
  const safeId = safeStreamId(id)
  const normalizedPublisher = normalizePublisher(publisher, { allowUnattributed: true })
  if (!fs.existsSync(liveRunDir)) return []
  const candidateDirectories = proofRunIndex.query({ streamId: id, publisher: normalizedPublisher, scan: false }).directories
  const legacyDirectory = path.join(liveRunDir, safeId)
  if (normalizedPublisher === UNATTRIBUTED_PUBLISHER
    && fs.existsSync(legacyDirectory)
    && !candidateDirectories.includes(legacyDirectory)) {
    candidateDirectories.push(legacyDirectory)
  }
  if (candidateDirectories.length !== 1) return []
  const segmentDirectory = path.join(candidateDirectories[0], 'segments')
  if (!fs.existsSync(segmentDirectory)) return []
  const scopedName = `${streamFilesystemIdentity(id).key}.segments.json`
  const possiblePaths = [path.join(segmentDirectory, scopedName), path.join(segmentDirectory, `${safeId}.segments.json`)]
  const existingPaths = [...new Set(possiblePaths)].filter((candidate) => fs.existsSync(candidate))
  if (existingPaths.length !== 1) return []
  const proofPath = existingPaths[0]
  try {
    const manifest = readJson(proofPath, { maxBytes: proofManifestMaxBytes, label: `proof manifest ${proofPath}` })
    if (!proofManifestMatchesChannel(manifest, { streamId: id, publisher: normalizedPublisher })) return []
    if (!Array.isArray(manifest.segments)) return []
    const validSegments = manifest.segments
      .filter((segment) => safeSegmentSequence(segment?.sequence) != null)
      .sort((left, right) => safeSegmentSequence(left.sequence) - safeSegmentSequence(right.sequence))
    if (validSegments.length > proofManifestMaxEntries) {
      warnFilesystemOnce(
        `proof-entries:${proofPath}`,
        `Proof manifest ${path.basename(proofPath)} has ${validSegments.length} entries; retaining newest ${proofManifestMaxEntries}.`,
      )
    }
    return validSegments.slice(-proofManifestMaxEntries)
  } catch (error) {
    console.warn(`Skipping unreadable proof manifest for ${safeId}: ${error.message}`)
    return []
  }
}

function proofSegmentBySequence(id, publisher) {
  const proof = new Map()
  for (const segment of readProofSegments(id, publisher)) {
    const sequence = safeSegmentSequence(segment.sequence)
    if (sequence != null) proof.set(sequence, segment)
  }
  return proof
}

function getCachedSidecars(segment) {
  const sidecarPath = safeSidecarPath(segment?.txHash)
  if (!sidecarPath) return null
  return readValidatedSidecarCache(sidecarPath, {
    txHash: segment.txHash,
    wantedHashes: segment.blobVersionedHashes,
    maxSidecars: maxBlobsPerBlock,
    maxCacheBytes: sidecarCacheMaxBytes,
    onInvalid: (error) => console.warn(`Deleting invalid sidecar cache ${path.basename(sidecarPath)}: ${error.message}`),
  })
}

const localManifestIndex = createLocalManifestIndex({
  directoryPath: manifestDir,
  maxManifestBytes: localManifestMaxBytes,
  maxCacheEntries: localManifestMaxFiles,
  maxCacheBytes: localManifestAggregateMaxBytes,
  maxScanEntries: localManifestScanMaxEntries,
  loadManifest: (manifestPath, candidate) => normalizeLocalManifest(readJson(manifestPath, {
    maxBytes: localManifestMaxBytes,
    label: `local segment manifest ${candidate.name}`,
  })),
  onWarning: warnFilesystemOnce,
  onTrace: process.env.LOCAL_MANIFEST_TRACE === '1'
    ? (event) => console.warn(`local-manifest-trace ${JSON.stringify(event)}`)
    : undefined,
})

function readManifests(request = {}) {
  const indexed = localManifestIndex.query(request)
  if (indexed.complete && indexed.cacheEntries < indexed.eligibleCount) {
    warnFilesystemOnce(
      'local-retention-limit',
      `Local manifest fallback retained newest ${indexed.cacheEntries} of ${indexed.eligibleCount} candidates within ${localManifestAggregateMaxBytes} bytes.`,
    )
  }
  const segments = indexed.manifests
    .flatMap((manifest) => {
      const mediaPath = safeMediaPath(manifest, { name: manifest.chain || defaultNetwork })
      if (!mediaPath) return []
      const cachedSidecars = getCachedSidecars(manifest)
      const slot = cachedSidecars?.slot || manifest.slot || null
      return [{
        ...manifest,
        source: manifest.stationAddress ? 'station-manifest' : 'manifest',
        station: manifest.stationAddress,
        slot,
        hasMedia: fs.existsSync(mediaPath),
        ...segmentRouteUrls(manifest),
        ready: fs.existsSync(mediaPath),
      }]
    })
    .sort(canonicalSegmentSort)
  const result = annotateStreamContinuity(segments)
  Object.defineProperty(result, localDiscoveryComplete, { value: indexed.complete })
  return result
}

async function readStationSegments(ctx = networkContext(defaultNetwork), previousState = null) {
  if (!ctx.publicClient || !ctx.stationAddress || !ctx.stationAbi) {
    return { segments: [], cursorBlock: null, blockTimestamps: new Map() }
  }

  const state = await scanStationHistory({
    previousState,
    deploymentBlock: ctx.stationFromBlock,
    historyBlockLimit: stationHistoryInitialBlocks,
    refreshBlockLimit: stationHistoryRefreshBlocks,
    logRangeBlockLimit: stationHistoryLogRangeBlocks,
    reorgBlockWindow: stationHistoryReorgBlocks,
    timestampConcurrency: stationHistoryTimestampConcurrency,
    responseLogLimit: stationHistoryResponseLogLimit,
    aggregateLogLimit: stationHistoryAggregateLogLimit,
    retainedSegmentLimit: stationHistoryRetainedSegmentLimit,
    timestampBlockLimit: stationHistoryTimestampBlockLimit,
    scanBlockLimit: STATION_SCAN_BLOCK_LIMIT,
    getLatestBlockNumber: () => ctx.publicClient.getBlockNumber(),
    getLogs: async ({ fromBlock, toBlock }) => {
      return ctx.publicClient.getLogs({
        address: getAddress(ctx.stationAddress),
        fromBlock,
        toBlock,
      })
    },
    parseLogs: (logs) => parseEventLogs({
        abi: ctx.stationAbi,
        eventName: 'SegmentPublished',
        logs,
      }),
    getBlockTimestampMs: async (blockNumber) => {
      const block = await ctx.publicClient.getBlock({ blockNumber })
      return blockTimestampMs(block.timestamp, 'Station segment block timestamp')
    },
    decodeLog: (log, createdAtMs) => stationSegmentFromLog(log, ctx, createdAtMs),
  })
  return { ...state, segments: annotateStreamContinuity(state.segments).sort(canonicalSegmentSort) }
}

function refreshStationSegments(ctx = networkContext(defaultNetwork)) {
  const cacheKey = contextCacheKey(ctx)
  if (stationSegmentsPromise.has(cacheKey)) return stationSegmentsPromise.get(cacheKey)
  const previousState = stationSegmentsCache.get(cacheKey) || null
  const promise = readStationSegments(ctx, previousState)
    .then((state) => {
      stationSegmentsCache.set(cacheKey, { ...state, updatedAt: Date.now() })
      return state.segments
    })
    .catch((error) => {
      console.warn(`${ctx.name} Station segment feed unavailable: ${publicErrorMessage(error, ctx)}`)
      return stationSegmentsCache.get(cacheKey)?.segments || []
    })
    .finally(() => {
      stationSegmentsPromise.delete(cacheKey)
    })
  stationSegmentsPromise.set(cacheKey, promise)
  return promise
}

async function segmentFeed(ctx = networkContext(defaultNetwork), request = {}) {
  if (!ctx.publicClient || !ctx.stationAddress || !ctx.stationAbi) {
    return ctx.name === 'sepolia' ? readManifests(request) : []
  }
  const cached = stationSegmentsCache.get(contextCacheKey(ctx))
  if (cached) {
    if (Date.now() - cached.updatedAt > 10_000) void refreshStationSegments(ctx)
    return cached.segments
  }
  return refreshStationSegments(ctx)
}

function summarizeHealth(id, publisher, segments, blobspace, ctx = networkContext(defaultNetwork)) {
  const streamSegments = [...segments].sort(canonicalSegmentSort)
  const latest = streamSegments.at(-1) || null
  const latestSequence = latest ? nonNegativeSafeInteger(latest.sequence, 'health latest sequence') : null
  const proof = latestSequence == null ? null : proofSegmentBySequence(id, publisher).get(latestSequence) || null
  const ageMs = latest?.createdAt ? Date.now() - Date.parse(latest.createdAt) : null
  const latestDurationMs = optionalNonNegativeSafeInteger(latest?.durationMs, 'health latest durationMs')
  const latestPayloadBytes = optionalNonNegativeSafeInteger(latest?.payloadBytes ?? latest?.bytes, 'health latest payloadBytes')
  const latestBlobCount = optionalNonNegativeSafeInteger(
    latest?.blobCount ?? latest?.estimatedBlobs ?? latest?.blobVersionedHashes?.length,
    'health latest blobCount',
  )
  const expectedCadenceMs = latestDurationMs ? Math.max(latestDurationMs * 6, 180_000) : 180_000
  return {
    streamId: id,
    publisher,
    ok: Boolean(latest) && (ageMs == null || ageMs <= expectedCadenceMs),
    latestSequence,
    latestTxHash: latest?.txHash || null,
    latestBlockNumber: latest?.blockNumber || null,
    latestPayloadBytes,
    latestBlobCount,
    latestCreatedAt: latest?.createdAt || null,
    latestAgeMs: ageMs,
    expectedCadenceMs,
    proof: proof
      ? {
          generatedAt: proof.generatedAt || null,
          nonce: proof.nonce || null,
          block: proof.blockProof || null,
        }
      : null,
    segmentCount: streamSegments.length,
    transport: {
      network: ctx.name,
      networkLabel: ctx.label,
      endpointPreset: ctx.endpointPreset || '',
      endpointPresetLabel: ctx.endpointPreset ? endpointPresets[ctx.endpointPreset]?.label || ctx.endpointPreset : '',
      executionRpcConfigured: Boolean(ctx.publicClient),
      beaconApiConfigured: Boolean(ctx.beaconUrl),
      stationConfigured: Boolean(ctx.stationAddress && ctx.stationAbi),
      station: ctx.stationAddress ? getAddress(ctx.stationAddress) : null,
      stationFromBlock: ctx.stationFromBlock.toString(),
    },
    blobspace: {
      mode: blobspace?.mode || null,
      chain: blobspace?.chain || ctx.name,
      networkLabel: blobspace?.networkLabel || ctx.label,
      latestSlot: blobspace?.latestSlot || null,
      maxBlobsPerBlock: blobspace?.maxBlobsPerBlock || maxBlobsPerBlock,
      endpointPreset: blobspace?.endpointPreset || ctx.endpointPreset || '',
      endpointPresetLabel: blobspace?.endpointPresetLabel || (ctx.endpointPreset ? endpointPresets[ctx.endpointPreset]?.label || ctx.endpointPreset : ''),
      presetAvailable: blobspace?.presetAvailable ?? Boolean(endpointPresets.public?.networks?.[ctx.name]),
      executionRpcConfigured: blobspace?.executionRpcConfigured ?? Boolean(ctx.publicClient),
      beaconApiConfigured: blobspace?.beaconApiConfigured ?? Boolean(ctx.beaconUrl),
      warning: blobspace?.warning || null,
    },
  }
}

function summarizeSegment(segment) {
  const blobVersionedHashes = normalizeBlobVersionedHashes(segment.blobVersionedHashes)
  if (blobVersionedHashes == null) throw new Error('Invalid segment blobVersionedHashes')
  const sequence = nonNegativeSafeInteger(segment.sequence, 'segment sequence')
  const proof = proofSegmentBySequence(segment.streamId, segment.publisher).get(sequence) || null
  const durationMs = optionalNonNegativeSafeInteger(segment.durationMs, 'segment durationMs') ?? 0
  const payloadBytes = optionalNonNegativeSafeInteger(segment.payloadBytes ?? segment.bytes, 'segment payloadBytes') ?? 0
  const blobCount = optionalNonNegativeSafeInteger(
    segment.blobCount ?? segment.estimatedBlobs ?? blobVersionedHashes.length,
    'segment blobCount',
  ) ?? 0
  return {
    app: segment.app,
    version: segment.version,
    chain: segment.chain,
    source: segment.source || 'manifest',
    station: segment.station,
    channelKey: segment.channelKey,
    streamId: segment.streamId,
    streamIdHash: segment.streamIdHash,
    sequence,
    durationMs,
    payloadBytes,
    payloadSha256: segment.payloadSha256,
    payloadSha256Hex: segment.payloadSha256Hex,
    codec: segment.codec,
    previousSegmentHash: segment.previousSegmentHash || null,
    publisher: segment.publisher,
    payloadValidity: segment.payloadValidity || 'unknown',
    continuity: segment.continuity || { status: 'unknown', reason: 'not-evaluated' },
    quarantined: segment.quarantined === true,
    blobCount,
    blobVersionedHashes,
    txHash: segment.txHash,
    transactionHash: segment.transactionHash || segment.txHash,
    blockHash: segment.blockHash,
    blockNumber: segment.blockNumber,
    slot: segment.slot,
    createdAt: segment.createdAt,
    hasMedia: segment.hasMedia,
    mediaUrl: segment.mediaUrl,
    gatewayUrl: segment.gatewayUrl,
    proof: proof
      ? {
          nonce: proof.nonce || null,
          generatedAt: proof.generatedAt || null,
          inputStartSeconds: proof.inputStartSeconds ?? null,
          block: proof.blockProof || null,
        }
      : null,
  }
}

async function summarizeStationLog(log, ctx) {
  const block = await ctx.publicClient.getBlock({ blockNumber: log.blockNumber })
  return summarizeSegment(stationSegmentFromLog(log, ctx, blockTimestampMs(block.timestamp, 'Station segment block timestamp')))
}

async function lookupStationSegmentTargeted(value, ctx) {
  if (!ctx.publicClient || !ctx.stationAddress || !ctx.stationAbi) return null
  const text = String(value || '').trim()
  if (!text) return null
  const hash = text.match(/0x[a-fA-F0-9]{64}/)?.[0]

  if (hash) {
    const receipt = await ctx.publicClient.getTransactionReceipt({ hash }).catch(() => null)
    if (receipt?.logs?.length) {
      const parsed = parseEventLogs({
        abi: ctx.stationAbi,
        eventName: 'SegmentPublished',
        logs: receipt.logs.filter((log) => String(log.address).toLowerCase() === String(ctx.stationAddress).toLowerCase()),
      })
      if (parsed[0]) return summarizeStationLog(parsed[0], ctx)
    }

    const blockLogs = await ctx.publicClient.getLogs({
      address: getAddress(ctx.stationAddress),
      blockHash: hash,
    }).catch(() => [])
    if (blockLogs.length) {
      const parsed = parseEventLogs({ abi: ctx.stationAbi, eventName: 'SegmentPublished', logs: blockLogs })
      if (parsed[0]) return summarizeStationLog(parsed[0], ctx)
    }
    return null
  }

  const blockNumberText = text.match(/(?:\/block\/|block(?:number)?[=:\s]+)(\d+)/i)?.[1] ||
    (/^\d{5,}$/.test(text) ? text : '')
  if (!blockNumberText) return null
  const blockNumber = BigInt(blockNumberText)
  const logs = await ctx.publicClient.getLogs({
    address: getAddress(ctx.stationAddress),
    fromBlock: blockNumber,
    toBlock: blockNumber,
  })
  const parsed = parseEventLogs({ abi: ctx.stationAbi, eventName: 'SegmentPublished', logs })
  return parsed[0] ? summarizeStationLog(parsed[0], ctx) : null
}

function findSegmentFromText(value, candidates) {
  const text = String(value || '').trim()
  if (!text) return null
  const hash = text.match(/0x[a-fA-F0-9]{64}/)?.[0]?.toLowerCase()
  if (hash) {
    return candidates.find((segment) =>
      String(segment.txHash || segment.transactionHash || '').toLowerCase() === hash
    ) || candidates.find((segment) =>
      String(segment.blockHash || segment.proof?.block?.hash || '').toLowerCase() === hash
    ) || candidates.find((segment) =>
      (segment.blobVersionedHashes || []).some((versionedHash) => String(versionedHash).toLowerCase() === hash)
    ) || null
  }
  const blockNumber = text.match(/(?:\/block\/|block(?:number)?[=:\s]+)(\d+)/i)?.[1] ||
    (/^\d{5,}$/.test(text) ? text : '')
  if (blockNumber) {
    return candidates.find((segment) =>
      String(segment.blockNumber || segment.proof?.block?.number || '') === blockNumber
    ) || null
  }
  return null
}

function latestPublishedSegment(segments) {
  return [...segments].sort((a, b) => (
    compareSegmentOrderPart(a.blockNumber, b.blockNumber, 'segment blockNumber') ||
    compareSegmentOrderPart(a.transactionIndex, b.transactionIndex, 'segment transactionIndex') ||
    compareSegmentOrderPart(a.logIndex, b.logIndex, 'segment logIndex')
  )).at(-1) || null
}

async function beacon(pathname, ctx = networkContext(defaultNetwork), timeoutMs = beaconTimeoutMs) {
  if (!ctx.beaconUrl) throw new Error(`${ctx.name} BEACON_RPC_URL is not configured`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${ctx.beaconUrl}${pathname}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    return readBoundedJsonResponse(response, {
      maxBytes: beaconMaxResponseBytes,
      label: 'Beacon response',
    })
  } finally {
    clearTimeout(timer)
  }
}

async function getBeaconGenesisTime(ctx = networkContext(defaultNetwork)) {
  if (genesisTimeCache.has(ctx.name)) return genesisTimeCache.get(ctx.name)
  if (!ctx.beaconUrl) return null
  const genesis = await beacon('/eth/v1/beacon/genesis', ctx)
  const value = beaconGenesisTime(genesis)
  genesisTimeCache.set(ctx.name, value)
  return value
}

function slotTimestampMs(slot, genesisTime) {
  if (genesisTime == null) return null
  const safeSlot = nonNegativeSafeInteger(slot, 'beacon slot')
  return blockTimestampMs(slotStartTimestamp(BigInt(safeSlot), genesisTime), 'beacon slot timestamp')
}

function cachedBlobspaceRows(segments) {
  const rows = new Map()
  for (const segment of segments) {
    const cached = getCachedSidecars(segment)
    if (cached?.slot == null) continue
    const slot = cached.slot
    const row = rows.get(slot) || { slot, source: 'cached proof', fetchMs: null, sidecars: [] }
    for (const match of cached.matches) {
      const sequence = nonNegativeSafeInteger(segment.sequence, 'cached blobspace segment sequence')
      row.sidecars.push({
        index: safeSlot(match.index),
        versionedHash: match.versionedHash,
        streamId: segment.streamId,
        publisher: segment.publisher,
        sequence,
        hasBlob: Boolean(match.blob),
      })
    }
    rows.set(slot, row)
  }
  return [...rows.values()].sort((a, b) => b.slot - a.slot)
}

async function stationStreamBlobHashes(ctx = networkContext(defaultNetwork)) {
  const hashes = new Map()
  const cached = stationSegmentsCache.get(contextCacheKey(ctx))
  const segments = cached?.segments?.length ? cached.segments : await segmentFeed(ctx)
  for (const segment of segments) {
    for (const hash of segment.blobVersionedHashes) {
      hashes.set(hash, {
        streamId: segment.streamId,
        publisher: segment.publisher,
        sequence: String(segment.sequence),
        txHash: segment.txHash,
      })
    }
  }
  return hashes
}

/**
 * @param {ReturnType<typeof networkContext>} ctx
 * @param {{number: bigint, timestamp: bigint}} latestBlock
 * @param {bigint | null} genesisTime
 * @param {number} [count]
 */
async function recentBlobTransactionsByHash(ctx, latestBlock, genesisTime, count = 8) {
  const hashes = new Map()
  if (!ctx.publicClient || genesisTime == null || latestBlock?.number == null) return hashes
  const station = ctx.stationAddress ? getAddress(ctx.stationAddress).toLowerCase() : ''
  const latestSlot = executionTimestampSlot(latestBlock.timestamp, genesisTime)
  const minSlot = latestSlot - BigInt(Math.max(0, count + 2))
  const maxBlocks = Math.max(count * 3, count + 8)

  for (let offset = 0; offset < maxBlocks; offset++) {
    const blockNumber = latestBlock.number - BigInt(offset)
    if (blockNumber < 0n) break
    let block
    try {
      block = await ctx.publicClient.getBlock({ blockNumber, includeTransactions: true })
    } catch {
      continue
    }
    const slot = executionTimestampSlot(block.timestamp, genesisTime)
    if (slot < minSlot) break
    const transactions = Array.isArray(block.transactions) ? block.transactions : []
    for (const tx of transactions) {
      const blobHashes = normalizeBlobVersionedHashes(tx?.blobVersionedHashes)
      if (blobHashes == null) throw new Error('Invalid recent transaction blobVersionedHashes')
      if (!blobHashes.length) continue
      if (!isTxHash(tx.hash)) throw new Error('Invalid recent transaction hash')
      const txHash = String(tx.hash).toLowerCase()
      const to = tx.to ? String(tx.to) : ''
      for (const versionedHash of blobHashes) {
        hashes.set(versionedHash, {
          txHash,
          to,
          blockNumber: block.number?.toString(),
          slot: slot.toString(),
          isStationTx: Boolean(station && to && to.toLowerCase() === station),
        })
      }
    }
  }

  return hashes
}

async function computeSlotMetrics(count = 8, ctx = networkContext(defaultNetwork)) {
  const streamBlobHashes = await stationStreamBlobHashes(ctx)
  const genesisTime = await getBeaconGenesisTime(ctx).catch(() => null)
  if (!ctx.publicClient || !ctx.beaconUrl) {
    return {
      chain: ctx.name,
      networkLabel: ctx.label,
      latestExecutionBlock: null,
      latestSlot: null,
      station: ctx.stationAddress,
      explorerBase: ctx.explorerBase,
      streamKnownBlobHashes: streamBlobHashes.size,
      maxBlobsPerBlock,
      ...blobspaceConfig(ctx),
      mode: 'cached',
      rows: cachedBlobspaceRows(await segmentFeed(ctx)).map((row) => ({
        slot: String(row.slot),
        timestampMs: slotTimestampMs(row.slot, genesisTime),
        blobCount: row.sidecars.length,
        maxBlobs: maxBlobsPerBlock,
        streamBlobCount: row.sidecars.length,
        blobs: row.sidecars.map((sidecar) => ({
          index: sidecar.index,
          versionedHash: sidecar.versionedHash,
          isStreamBlob: Boolean(sidecar.streamId),
          stream: sidecar.streamId
            ? { streamId: sidecar.streamId, publisher: sidecar.publisher, sequence: String(sidecar.sequence), txHash: null }
            : null,
        })),
        error: null,
      })),
      warning: `Set ${ctx.name.toUpperCase()}_ETH_RPC_URL and ${ctx.name.toUpperCase()}_BEACON_RPC_URL to watch live blob metrics.`,
    }
  }

  try {
    const latestBlock = await ctx.publicClient.getBlock({ blockTag: 'latest' })
    if (genesisTime == null) throw new Error('Beacon genesis time unavailable')
    const latest = executionTimestampSlot(latestBlock.timestamp, genesisTime)
    const blobTransactions = await recentBlobTransactionsByHash(ctx, latestBlock, genesisTime, count)
    const slots = []
    for (let i = 0; i < count; i++) {
      slots.push(latest - BigInt(i))
    }

    const rows = await mapWithConcurrency(slots, slotMetricsConcurrency, async (slot) => {
      let error = null
      let blobs = []
      try {
        const result = await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`, ctx)
        const sidecars = validateBeaconSidecars(beaconDataArray(result, 'blob sidecars'), maxBlobsPerBlock)
        blobs = sidecars.map((sidecar) => {
          const versionedHash = sidecarVersionedHash(sidecar)
          const stream = versionedHash ? streamBlobHashes.get(versionedHash) : null
          const tx = versionedHash ? blobTransactions.get(versionedHash) : null
          return {
            index: sidecarIndex(sidecar.index, 'beacon sidecar index'),
            versionedHash,
            txHash: tx?.txHash || stream?.txHash || null,
            to: tx?.to || null,
            blockNumber: tx?.blockNumber || null,
            isStationTx: Boolean(tx?.isStationTx),
            isStreamBlob: Boolean(stream || tx?.isStationTx),
            stream: stream || (tx?.isStationTx ? { txHash: tx.txHash, stationOnly: true } : null),
          }
        })
      } catch (err) {
        error = publicErrorMessage(err, ctx)
      }

      return {
        slot: slot.toString(),
        timestampMs: slotTimestampMs(slot, genesisTime),
        blobCount: blobs.length,
        maxBlobs: maxBlobsPerBlock,
        streamBlobCount: blobs.filter((blob) => blob.isStreamBlob).length,
        blobs,
        error,
      }
    })

    return {
      chain: ctx.name,
      networkLabel: ctx.label,
      latestExecutionBlock: latestBlock.number.toString(),
      latestSlot: latest.toString(),
      station: ctx.stationAddress ? getAddress(ctx.stationAddress) : null,
      explorerBase: ctx.explorerBase,
      streamKnownBlobHashes: streamBlobHashes.size,
      maxBlobsPerBlock,
      ...blobspaceConfig(ctx),
      mode: 'live',
      rows,
    }
  } catch (error) {
    return {
      chain: ctx.name,
      networkLabel: ctx.label,
      latestExecutionBlock: null,
      latestSlot: null,
      station: ctx.stationAddress,
      explorerBase: ctx.explorerBase,
      streamKnownBlobHashes: streamBlobHashes.size,
      maxBlobsPerBlock,
      ...blobspaceConfig(ctx),
      mode: 'cached',
      rows: cachedBlobspaceRows(await segmentFeed(ctx)),
      warning: publicErrorMessage(error, ctx),
    }
  }
}

function refreshSlotMetrics(count = 8, ctx = networkContext(defaultNetwork)) {
  const cacheKey = contextCacheKey(ctx)
  if (slotMetricsPromise.has(cacheKey)) return slotMetricsPromise.get(cacheKey)
  const promise = computeSlotMetrics(count, ctx)
    .then((metrics) => {
      slotMetricsCache.set(cacheKey, { metrics, updatedAt: Date.now() })
      return metrics
    })
    .catch((error) => {
      console.warn(`${ctx.name} slot metrics unavailable: ${publicErrorMessage(error, ctx)}`)
      return slotMetricsCache.get(cacheKey)?.metrics || null
    })
    .finally(() => {
      slotMetricsPromise.delete(cacheKey)
    })
  slotMetricsPromise.set(cacheKey, promise)
  return promise
}

async function slotMetrics(count = 8, ctx = networkContext(defaultNetwork)) {
  const cached = slotMetricsCache.get(contextCacheKey(ctx))
  if (cached?.metrics) {
    if (Date.now() - cached.updatedAt > slotMetricsCacheMs) void refreshSlotMetrics(count, ctx)
    return cached.metrics
  }
  void refreshSlotMetrics(count, ctx)
  const fallbackGenesisTime = await getBeaconGenesisTime(ctx).catch(() => null)
  return {
    chain: ctx.name,
    latestExecutionBlock: null,
    latestSlot: null,
    station: ctx.stationAddress,
    explorerBase: ctx.explorerBase,
    streamKnownBlobHashes: 0,
    maxBlobsPerBlock,
    ...blobspaceConfig(ctx),
    mode: 'warming',
    rows: cachedBlobspaceRows(await segmentFeed(ctx)).map((row) => ({
      slot: String(row.slot),
      timestampMs: slotTimestampMs(row.slot, fallbackGenesisTime),
      blobCount: row.sidecars.length,
      maxBlobs: maxBlobsPerBlock,
      streamBlobCount: row.sidecars.filter((sidecar) => sidecar.streamId).length,
      blobs: row.sidecars.map((sidecar) => ({
        index: sidecar.index,
        versionedHash: sidecar.versionedHash,
        isStreamBlob: Boolean(sidecar.streamId),
        stream: sidecar.streamId
          ? { streamId: sidecar.streamId, sequence: String(sidecar.sequence), txHash: sidecar.txHash || null }
          : null,
      })),
      error: null,
    })),
    warning: `Warming ${ctx.name} slot metrics from execution RPC and beacon sidecars.`,
  }
}

async function fetchAndCacheSidecars(segment, ctx = networkContext(segment.chain || defaultNetwork)) {
  if (!isTxHash(segment.txHash)) throw new Error('Invalid segment transaction hash')
  const wantedHashes = normalizeRequestedBlobHashes(segment.blobVersionedHashes, maxBlobsPerBlock)
  const sidecarPath = safeSidecarPath(segment.txHash)
  if (!sidecarPath) throw new Error('Invalid sidecar cache path')
  return loadOrFetchValidatedSidecarCache({
    cachePath: sidecarPath,
    txHash: segment.txHash,
    wantedHashes,
    maxSidecars: maxBlobsPerBlock,
    maxCacheBytes: sidecarCacheMaxBytes,
    onInvalid: (error) => console.warn(`Deleting invalid sidecar cache ${path.basename(sidecarPath)}: ${error.message}`),
    fetchPayload: async () => {
      if (!ctx.publicClient || !ctx.beaconUrl) throw new Error(`${ctx.name} ETH_RPC_URL and BEACON_RPC_URL are required to fetch uncached blob sidecars`)
      const tx = await ctx.publicClient.getTransaction({ hash: segment.txHash })
      const transactionHashes = normalizeBlobVersionedHashes(tx?.blobVersionedHashes)
      if (transactionHashes == null) throw new Error('Invalid transaction blobVersionedHashes')
      if (transactionHashes.length) {
        const normalizedTransactionHashes = normalizeRequestedBlobHashes(transactionHashes, maxBlobsPerBlock)
        if (normalizedTransactionHashes.length !== wantedHashes.length
          || normalizedTransactionHashes.some((hash, index) => hash !== wantedHashes[index])) {
          throw new Error('Transaction blobVersionedHashes do not match the segment')
        }
      }
      const block = await ctx.publicClient.getBlock({ blockHash: tx.blockHash })
      const genesis = await beacon('/eth/v1/beacon/genesis', ctx)
      const genesisTime = beaconGenesisTime(genesis)
      const slot = executionTimestampSlot(block.timestamp, genesisTime)
      const response = await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`, ctx)
      const sidecars = validateBeaconSidecars(beaconDataArray(response, 'blob sidecars'), maxBlobsPerBlock)
      const wanted = new Set(wantedHashes)
      const matches = []

      for (const sidecar of sidecars) {
        const versionedHash = sidecarVersionedHash(sidecar)
        if (!versionedHash) throw new Error(`Beacon sidecar ${sidecar.index} is missing a KZG commitment`)
        if (wanted.has(versionedHash)) matches.push({ ...sidecar, versionedHash })
      }
      return { txHash: segment.txHash, slot: slot.toString(), matches }
    },
  })
}

function reconstructPayload(segment, sidecars) {
  const requestedHashes = normalizeRequestedBlobHashes(segment.blobVersionedHashes, maxBlobsPerBlock)
  const byHash = new Map()
  if (!Array.isArray(sidecars?.matches)) throw new Error('Invalid sidecar response: matches must be an array')
  const matches = validateBeaconSidecars(sidecars.matches, maxBlobsPerBlock)
  for (const [index, match] of matches.entries()) {
    if (!validSidecarMatch(match)) throw new Error(`Invalid sidecar match at index ${index}`)
    byHash.set(String(match.versionedHash).toLowerCase(), match.blob)
  }

  const blobs = []
  for (const hash of requestedHashes) {
    const blob = byHash.get(hash)
    if (!blob) throw new Error(`Missing sidecar for blob versioned hash ${hash}`)
    blobs.push(blob)
  }

  const chunks = []
  let decodedLength = 0
  for (const blob of blobs) {
    const bytes = hexToBytes(blob)
    for (let offset = 0; offset < bytes.length; offset += 32) {
      const fieldElement = bytes.subarray(offset, offset + 32)
      if (fieldElement.length === 0) continue
      if (fieldElement[0] !== 0) {
        throw new Error(`Invalid blob encoding at byte offset ${offset}: field element prefix is not zero`)
      }
      const data = fieldElement.subarray(1)
      chunks.push(data)
      decodedLength += data.length
    }
  }

  const payloadBytes = optionalNonNegativeSafeInteger(segment.payloadBytes ?? segment.bytes, 'segment payloadBytes')
  if (payloadBytes == null) throw new Error('segment payloadBytes is required for reconstruction')
  const maximumPayloadBytes = requestedHashes.length * BLOB_DATA_BYTES
  if (payloadBytes > maximumPayloadBytes) {
    throw new Error(`segment payloadBytes exceeds ${maximumPayloadBytes} decoded bytes available from its blobs`)
  }
  if (decodedLength < payloadBytes) {
    throw new Error(`Decoded blob payload is truncated: expected ${payloadBytes} bytes, found ${decodedLength}`)
  }
  const payload = Buffer.concat(chunks, decodedLength).subarray(0, payloadBytes)
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex')
  if (sha256 !== segment.payloadSha256) {
    throw new Error(`SHA-256 mismatch: expected ${segment.payloadSha256}, got ${sha256}`)
  }
  return payload
}

async function ensureMedia(segment, ctx = networkContext(segment.chain || defaultNetwork)) {
  const mediaPath = safeMediaPath(segment, ctx)
  if (!mediaPath) throw new Error('Invalid segment media path')
  const expectedMedia = {
    payloadBytes: segment.payloadBytes ?? segment.bytes,
    payloadSha256: segment.payloadSha256Hex || `0x${segment.payloadSha256}`,
  }
  if (await verifyOrDeleteCachedMedia(mediaPath, expectedMedia)) return mediaPath
  if (mediaInflight.has(mediaPath)) return mediaInflight.get(mediaPath)
  const promise = (async () => {
    return ensureVerifiedMediaCache(mediaPath, expectedMedia, async () => {
      const sidecars = await fetchAndCacheSidecars(segment, ctx)
      return reconstructPayload(segment, sidecars)
    })
  })().finally(() => {
    mediaInflight.delete(mediaPath)
  })
  mediaInflight.set(mediaPath, promise)
  return promise
}

function expectedSegmentMedia(segment) {
  return {
    payloadBytes: segment.payloadBytes ?? segment.bytes,
    payloadSha256: segment.payloadSha256Hex || `0x${segment.payloadSha256}`,
  }
}

async function sendMedia(request, response, mediaPath, contentType = 'video/webm', expected = null) {
  try {
    const opened = expected
      ? await openVerifiedMediaFile(mediaPath, expected, { root: reconstructedDir })
      : await openRegularFile(mediaPath)
    await serveOpenedFile(request, response, opened, { contentType, headers: defaultHeaders })
  } catch (error) {
    sendHttpFileError(response, error, defaultHeaders)
  }
}

function assetContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.js') return 'text/javascript; charset=utf-8'
  return 'application/octet-stream'
}

function sendOverlayAsset(response, name) {
  const normalized = name.replace(/\\/g, '/')
  const allowed = new Set([
    'rfe-terminal-final.png',
    'rfe-logo-milxdy.png',
    'rfe-style-tokens.json',
    'overlays/rfe-terminal-360p.png',
    'overlays/rfe-terminal-420p.png',
    'overlays/rfe-terminal-480p.png',
    'overlays/rfe-terminal-720p.png',
    'overlays/rfe-terminal-1080p.png',
  ])
  if (!allowed.has(normalized)) return send(response, 404, 'asset not found')
  const filePath = path.join(overlayAssetDir, ...normalized.split('/'))
  if (!fs.existsSync(filePath)) return send(response, 404, 'asset not found')
  send(response, 200, fs.readFileSync(filePath), {
    'content-type': assetContentType(filePath),
    'cache-control': 'no-store',
  })
}

const canonicalViewerFiles = new Set(['index.html', 'app.js', 'styles.css', 'static-client-core.js', 'static-client-io.js'])

function sendCanonicalViewer(response, name) {
  if (!canonicalViewerFiles.has(name)) return send(response, 404, 'asset not found')
  const filePath = path.join(canonicalViewerDir, name)
  return send(response, 200, fs.readFileSync(filePath), {
    'content-type': assetContentType(filePath),
    'cache-control': 'no-store',
  })
}

const { overlayHtml, overlayPreviewHtml } = createLiveDemoPages({
  canonicalStationAddress,
  defaultNetwork,
  endpointPresets,
  networkContext,
  networkLabel,
  streamId,
  viewerPollMs,
})
const server = http.createServer(async (request, response) => {
  let ctx = null
  try {
    const policy = checkLoopbackRequest(request, { port })
    if (!policy.ok) return send(response, policy.status, policy.message, {
      ...policy.headers,
      'content-type': 'text/plain; charset=utf-8',
    })
    try {
      proofRunIndex.advance()
    } catch (error) {
      warnFilesystemOnce('proof-run-scan', `Proof run discovery is unavailable: ${error.message}`)
    }
    const parsed = new URL(request.url, 'http://127.0.0.1')
    ctx = networkContext(parsed.searchParams.get('network') || defaultNetwork, {
      endpointPreset: parsed.searchParams.get('endpointPreset') || '',
    })

    if (parsed.pathname === '/') {
      return sendCanonicalViewer(response, 'index.html')
    }

    const viewerAsset = parsed.pathname.match(/^\/(app\.js|styles\.css|static-client-(?:core|io)\.js)$/)
    if (viewerAsset) return sendCanonicalViewer(response, viewerAsset[1])

    if (parsed.pathname === '/packages/protocol/browser-kernel.js') {
      return send(response, 200, fs.readFileSync(path.join(sourceRoot, 'packages', 'protocol', 'browser-kernel.js')), {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      })
    }

    if (parsed.pathname === '/overlay') {
      return send(response, 200, overlayHtml(), { 'content-type': 'text/html; charset=utf-8' })
    }

    if (parsed.pathname === '/overlay-preview') {
      return send(response, 200, overlayPreviewHtml(), { 'content-type': 'text/html; charset=utf-8' })
    }

    if (parsed.pathname === '/api/station/lookup') {
      const value = parsed.searchParams.get('value') || ''
      const segment = await lookupStationSegmentTargeted(value, ctx)
      const cached = stationSegmentsCache.get(contextCacheKey(ctx))?.segments || []
      const cachedSegment = findSegmentFromText(value, cached)
      const result = segment || (cachedSegment ? summarizeSegment(cachedSegment) : null)
      return sendJson(response, {
        ok: Boolean(result),
        segment: result,
      })
    }

    if (parsed.pathname === '/preview-video') {
      if (!previewVideoFile) return send(response, 404, 'PREVIEW_VIDEO_FILE not configured')
      if (!fs.existsSync(previewVideoFile)) return send(response, 404, 'preview video not found')
      return sendMedia(request, response, previewVideoFile, assetContentType(previewVideoFile))
    }

    const assetMatch = parsed.pathname.match(/^\/rfe-assets\/(.+)$/)
    if (assetMatch) {
      const assetName = decodePathParam(response, assetMatch[1])
      if (assetName == null) return
      return sendOverlayAsset(response, assetName)
    }

    const streamMatch = parsed.pathname.match(/^\/api\/streams\/([^/]+)\/live$/)
    if (streamMatch) {
      const id = decodePathParam(response, streamMatch[1])
      if (id == null) return
      const publisher = parsed.searchParams.get('publisher')
      const channelRequest = indexedChannelRequest(response, id, publisher)
      if (!channelRequest) return
      const allSegments = await segmentFeed(ctx, channelRequest)
      const selection = selectedApiChannel(response, allSegments, id, publisher)
      if (!selection) return
      const segments = selection.segments.map(summarizeSegment)
      const latestStationSegment = latestPublishedSegment(selection.segments)
      const stationLatest = latestStationSegment ? summarizeSegment(latestStationSegment) : null
      return sendJson(response, {
        streamId: id,
        publisher: selection.publisher,
        discoveryComplete: allSegments[localDiscoveryComplete] !== false,
        network: ctx.name,
        networkLabel: ctx.label,
        transport: {
          network: ctx.name,
          networkLabel: ctx.label,
          endpointPreset: ctx.endpointPreset || '',
          endpointPresetLabel: ctx.endpointPreset ? endpointPresets[ctx.endpointPreset]?.label || ctx.endpointPreset : '',
          executionRpcConfigured: Boolean(ctx.publicClient),
          beaconApiConfigured: Boolean(ctx.beaconUrl),
          stationConfigured: Boolean(ctx.stationAddress && ctx.stationAbi),
          station: ctx.stationAddress ? getAddress(ctx.stationAddress) : null,
          stationFromBlock: ctx.stationFromBlock.toString(),
          stationHistory: {
            initialBlockLimit: stationHistoryInitialBlocks,
            refreshBlockLimit: stationHistoryRefreshBlocks,
            logRangeBlockLimit: stationHistoryLogRangeBlocks,
            reorgReconciliationBlocks: stationHistoryReorgBlocks,
            timestampConcurrency: stationHistoryTimestampConcurrency,
            responseLogLimit: stationHistoryResponseLogLimit,
            aggregateLogLimit: stationHistoryAggregateLogLimit,
            retainedSegmentLimit: stationHistoryRetainedSegmentLimit,
            timestampBlockLimit: stationHistoryTimestampBlockLimit,
          },
          blobSidecarsPath: '/eth/v1/beacon/blob_sidecars/{slot}',
          reconstruction: 'drop byte 0 from each 32-byte field element, concat 31-byte chunks, trim to payloadBytes, verify sha256',
        },
        segments,
        stationLatest,
        blobspace: await slotMetrics(slotWindow, ctx),
      })
    }

    const healthMatch = parsed.pathname.match(/^\/api\/streams\/([^/]+)\/health$/)
    if (healthMatch) {
      const id = decodePathParam(response, healthMatch[1])
      if (id == null) return
      const publisher = parsed.searchParams.get('publisher')
      const channelRequest = indexedChannelRequest(response, id, publisher)
      if (!channelRequest) return
      const allSegments = await segmentFeed(ctx, channelRequest)
      const selection = selectedApiChannel(response, allSegments, id, publisher)
      if (!selection) return
      const blobspace = await slotMetrics(slotWindow, ctx)
      return sendJson(response, {
        ...summarizeHealth(id, selection.publisher, selection.segments, blobspace, ctx),
        discoveryComplete: allSegments[localDiscoveryComplete] !== false,
      })
    }

    const payloadMatch = parsed.pathname.match(/^\/api\/segments\/([^/]+)\/(\d+)\/payload$/)
    if (payloadMatch) {
      const id = decodePathParam(response, payloadMatch[1])
      if (id == null) return
      const sequence = Number(payloadMatch[2])
      const publisher = parsed.searchParams.get('publisher')
      const channelRequest = indexedChannelRequest(response, id, publisher)
      if (!channelRequest) return
      const allSegments = await segmentFeed(ctx, channelRequest)
      const selection = selectedApiChannel(response, allSegments, id, publisher)
      if (!selection) return
      const segment = selection.segments.find((candidate) => Number(candidate.sequence) === sequence)
      if (!segment) {
        if (allSegments[localDiscoveryComplete] === false) return sendLocalDiscoveryPending(response, id)
        return send(response, 404, 'segment not found')
      }
      if (segment.quarantined) {
        return sendJson(response, { error: 'segment continuity is invalid', continuity: segment.continuity }, 409)
      }
      const mediaPath = await ensureMedia(segment, ctx)
      return sendMedia(request, response, mediaPath, 'video/webm', expectedSegmentMedia(segment))
    }

    if (parsed.pathname === '/source-media/test-stream.mp4') {
      const mediaPath = path.join(mediaDir, 'test-stream.mp4')
      if (!fs.existsSync(mediaPath)) return send(response, 404, 'source media not found')
      return sendMedia(request, response, mediaPath)
    }

    const mediaMatch = parsed.pathname.match(/^\/media\/([^/]+)\/(\d+)\.webm$/)
    if (mediaMatch) {
      const id = decodePathParam(response, mediaMatch[1])
      if (id == null) return
      const sequence = Number(mediaMatch[2])
      const publisher = parsed.searchParams.get('publisher')
      const channelRequest = indexedChannelRequest(response, id, publisher)
      if (!channelRequest) return
      const allSegments = await segmentFeed(ctx, channelRequest)
      const selection = selectedApiChannel(response, allSegments, id, publisher)
      if (!selection) return
      const segment = selection.segments.find((candidate) => Number(candidate.sequence) === sequence)
      if (!segment) {
        if (allSegments[localDiscoveryComplete] === false) return sendLocalDiscoveryPending(response, id)
        return send(response, 404, 'media not found')
      }
      if (segment.quarantined) {
        return sendJson(response, { error: 'segment continuity is invalid', continuity: segment.continuity }, 409)
      }
      const mediaPath = await ensureMedia(segment, ctx)
      return sendMedia(request, response, mediaPath, 'video/webm', expectedSegmentMedia(segment))
    }

    send(response, 404, 'not found')
  } catch (error) {
    if (error instanceof HttpFileError) {
      sendHttpFileError(response, error, defaultHeaders)
      return
    }
    console.error(publicErrorMessage(error, ctx))
    if (!response.headersSent) sendJson(response, { error: publicErrorMessage(error, ctx) }, 500)
    else if (!response.destroyed) response.destroy(error)
  }
})

server.listen(port, '127.0.0.1', () => {
  const sepoliaCtx = networkContext('sepolia')
  const mainnetCtx = networkContext('mainnet')
  console.log(`Radio Free Ethereum: http://127.0.0.1:${port}/`)
  console.log(`stream id: ${streamId}`)
  console.log(`sepolia execution RPC: ${sepoliaCtx.publicClient ? 'configured' : 'not configured'}`)
  console.log(`sepolia beacon API: ${sepoliaCtx.beaconUrl ? 'configured' : 'not configured'}`)
  console.log(`mainnet execution RPC: ${mainnetCtx.publicClient ? 'configured' : 'not configured'}`)
  console.log(`mainnet beacon API: ${mainnetCtx.beaconUrl ? 'configured' : 'not configured'}`)
  console.log(`Station history bounds: initial ${stationHistoryInitialBlocks} blocks, refresh ${stationHistoryRefreshBlocks} blocks, RPC ranges ${stationHistoryLogRangeBlocks} blocks`)
  console.log(`Station record bounds: ${stationHistoryResponseLogLimit}/response, ${stationHistoryAggregateLogLimit}/scan, ${stationHistoryRetainedSegmentLimit} retained, ${stationHistoryTimestampBlockLimit} timestamp blocks`)
  console.log(`Slot metric bounds: ${slotWindow} slots, ${slotMetricsConcurrency} concurrent requests, ${beaconTimeoutMs}ms beacon timeout, ${slotMetricsCacheMs}ms cache`)
  console.log(`Station reorg reconciliation window: ${stationHistoryReorgBlocks} unfinalized blocks; timestamp concurrency ${stationHistoryTimestampConcurrency}`)
  void refreshStationSegments(sepoliaCtx)
  void refreshSlotMetrics(slotWindow, sepoliaCtx)
  if (mainnetCtx.publicClient || mainnetCtx.beaconUrl) void refreshSlotMetrics(slotWindow, mainnetCtx)
})
