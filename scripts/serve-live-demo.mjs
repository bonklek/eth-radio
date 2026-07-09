import 'dotenv/config'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {
  commitmentToVersionedHash,
  createPublicClient,
  getAddress,
  hexToBytes,
  http as viemHttp,
  parseEventLogs,
} from 'viem'
import { mainnet, sepolia } from 'viem/chains'

const root = process.cwd()
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
const maxBlobsPerBlock = envNumber('MAX_BLOBS_PER_BLOCK', 21, { integer: true, min: 1 })
const slotWindow = envNumber('SLOT_WINDOW', 8, { integer: true, min: 1 })
const slotMetricsCacheMs = envNumber('SLOT_METRICS_CACHE_MS', 2000, { integer: true, min: 1 })
const viewerPollMs = envNumber('VIEWER_POLL_MS', 2000, { integer: true, min: 1 })
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
const beaconTimeoutMs = envNumber('BEACON_TIMEOUT_MS', 3500, { integer: true, min: 1 })
const secondsPerSlot = 12n
const stationSegmentsCache = new Map()
const stationSegmentsPromise = new Map()
const slotMetricsCache = new Map()
const slotMetricsPromise = new Map()
const genesisTimeCache = new Map()
const mediaInflight = new Map()

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
    || (integer && !Number.isInteger(value))
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

function cleanHttpUrl(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    if (url.username || url.password) return ''
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().replace(/\/$/, '') : ''
  } catch {
    return ''
  }
}

function contextCacheKey(ctx) {
  return `${ctx.name}:${ctx.endpointPreset || 'env'}:${ctx.executionUrl || ''}:${ctx.beaconUrl || ''}`
}

function publicErrorMessage(error, ctx = null) {
  let text = String(error?.message || error || 'Request failed')
  const endpoints = [ctx?.executionUrl, ctx?.beaconUrl]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  for (const endpoint of endpoints) {
    text = text.split(endpoint).join('[redacted endpoint]')
  }
  return text.replace(/https?:\/\/[^\s"'<>)}\]]+/g, '[redacted endpoint]')
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
  const executionUrl = cleanHttpUrl(options.executionRpcUrl) || envForNetwork(name, 'ETH_RPC_URL', executionFallback)
  const beaconUrl = (cleanHttpUrl(options.beaconRpcUrl) || envForNetwork(name, 'BEACON_RPC_URL', beaconFallback))?.replace(/\/$/, '')
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
  } catch {
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
    compareSegmentOrderPart(a.sequence, b.sequence, 'segment sequence') ||
    compareSegmentOrderPart(a.blockNumber, b.blockNumber, 'segment blockNumber') ||
    compareSegmentOrderPart(a.transactionIndex, b.transactionIndex, 'segment transactionIndex') ||
    compareSegmentOrderPart(a.logIndex, b.logIndex, 'segment logIndex')
  )
}

const defaultHeaders = {
  'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
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

function isBlobHex(value) {
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(String(value || ''))
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

function normalizeCachedSidecars(sidecars, txHash) {
  if (!sidecars || typeof sidecars !== 'object') return null
  const slot = safeSlot(sidecars.slot)
  if (!Array.isArray(sidecars.matches) || sidecars.matches.some((match) => !validSidecarMatch(match))) return null
  return {
    ...sidecars,
    txHash: isTxHash(sidecars.txHash) ? String(sidecars.txHash).toLowerCase() : String(txHash).toLowerCase(),
    slot,
    matches: sidecars.matches,
  }
}

function validSidecarMatch(match) {
  return match
    && typeof match === 'object'
    && !Array.isArray(match)
    && safeSlot(match.index) !== null
    && isBytes32Hex(match.versionedHash)
    && isBlobHex(match.blob)
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

function decimalSafeInteger(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${label} must be a decimal string`)
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe integer range`)
  return number
}

function beaconGenesisTime(response) {
  const data = beaconData(response, 'genesis')
  const genesisTime = data?.genesis_time
  if (!/^\d+$/.test(String(genesisTime || ''))) {
    throw new Error('Invalid beacon genesis response: genesis_time must be a decimal string')
  }
  return BigInt(genesisTime)
}

function beaconHeadSlot(response) {
  const slot = beaconData(response, 'head')?.header?.message?.slot
  return decimalSafeInteger(slot, 'Invalid beacon head response: slot')
}

function sidecarVersionedHash(sidecar) {
  const commitment = sidecar?.kzg_commitment || sidecar?.kzgCommitment
  if (!commitment) return null
  if (!isBytes48Hex(commitment)) throw new Error(`Invalid sidecar KZG commitment: ${commitment}`)
  return commitmentToVersionedHash({ commitment })
}

function safeMediaPath(streamId, sequence) {
  const safeId = safeStreamId(streamId)
  const safeSequence = safeSegmentSequence(sequence)
  if (!safeId || safeSequence == null) return null
  return path.join(reconstructedDir, `${safeId}-${safeSequence}.webm`)
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

function preferredBlobVersionedHashes(tx, segment) {
  const transactionHashes = normalizeBlobVersionedHashes(tx?.blobVersionedHashes)
  if (transactionHashes == null) throw new Error('Invalid transaction blobVersionedHashes')
  return transactionHashes.length ? transactionHashes : segment.blobVersionedHashes
}

function normalizeLocalManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return null
  const streamId = typeof manifest.streamId === 'string' ? manifest.streamId : ''
  const sequence = safeSegmentSequence(manifest.sequence)
  const txHash = String(manifest.txHash || manifest.transactionHash || '')
  const payloadSha256 = String(manifest.payloadSha256 || '').replace(/^0x/, '')
  const blobVersionedHashes = normalizeBlobVersionedHashes(manifest.blobVersionedHashes)
  if (!streamId || sequence == null || !isTxHash(txHash) || !isBytes32Hex(payloadSha256) || blobVersionedHashes == null) return null
  return {
    ...manifest,
    streamId,
    sequence,
    txHash: txHash.toLowerCase(),
    transactionHash: txHash.toLowerCase(),
    payloadSha256: payloadSha256.toLowerCase(),
    payloadSha256Hex: `0x${payloadSha256.toLowerCase()}`,
    blobVersionedHashes,
  }
}

function stationSegmentFromLog(log, ctx, createdAtMs = null) {
  const sequence = nonNegativeSafeInteger(log.args.sequence, 'Station segment sequence')
  const durationMs = nonNegativeSafeInteger(log.args.durationMs, 'Station segment durationMs')
  const payloadBytes = nonNegativeSafeInteger(log.args.payloadBytes, 'Station segment payloadBytes')
  const blobVersionedHashes = normalizeBlobVersionedHashes(log.args.blobVersionedHashes)
  if (blobVersionedHashes == null) throw new Error('Invalid Station segment blobVersionedHashes')
  const payloadSha256 = String(log.args.payloadSha256 || '').replace(/^0x/, '')
  if (!isBytes32Hex(payloadSha256)) throw new Error('Invalid Station segment payloadSha256')
  const mediaPath = safeMediaPath(log.args.streamId, sequence)
  return {
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
    hasMedia: mediaPath ? fs.existsSync(mediaPath) : false,
    mediaUrl: `/media/${encodeURIComponent(log.args.streamId)}/${sequence}.webm`,
    gatewayUrl: `/api/segments/${encodeURIComponent(log.args.streamId)}/${sequence}/payload`,
  }
}

function readProofSegments(id) {
  const safeId = safeStreamId(id)
  const proofPath = path.join(liveRunDir, safeId, 'segments', `${safeId}.segments.json`)
  if (!fs.existsSync(proofPath)) return []
  try {
    const manifest = readJson(proofPath)
    return Array.isArray(manifest.segments)
      ? manifest.segments.filter((segment) => safeSegmentSequence(segment?.sequence) != null)
      : []
  } catch (error) {
    console.warn(`Skipping unreadable proof manifest for ${safeId}: ${error.message}`)
    return []
  }
}

function proofSegmentBySequence(id) {
  const proof = new Map()
  for (const segment of readProofSegments(id)) {
    const sequence = safeSegmentSequence(segment.sequence)
    if (sequence != null) proof.set(sequence, segment)
  }
  return proof
}

function getCachedSidecars(txHash) {
  const sidecarPath = safeSidecarPath(txHash)
  if (!sidecarPath) return null
  if (!fs.existsSync(sidecarPath)) return null
  try {
    const sidecars = normalizeCachedSidecars(readJson(sidecarPath), txHash)
    if (sidecars) return sidecars
    console.warn(`Skipping invalid sidecar cache ${path.basename(sidecarPath)}`)
  } catch (error) {
    console.warn(`Skipping unreadable sidecar cache ${path.basename(sidecarPath)}: ${error.message}`)
  }
  return null
}

function readManifests() {
  if (!fs.existsSync(manifestDir)) return []
  return fs
    .readdirSync(manifestDir)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const manifestPath = path.join(manifestDir, name)
      let manifest
      try {
        manifest = normalizeLocalManifest(readJson(manifestPath))
      } catch (error) {
        console.warn(`Skipping unreadable local segment manifest ${name}: ${error.message}`)
        return []
      }
      if (!manifest) {
        console.warn(`Skipping invalid local segment manifest ${name}`)
        return []
      }
      const mediaPath = safeMediaPath(manifest.streamId, manifest.sequence)
      if (!mediaPath) return []
      const cachedSidecars = getCachedSidecars(manifest.txHash)
      const slot = cachedSidecars?.slot || manifest.slot || null
      return [{
        ...manifest,
        source: manifest.stationAddress ? 'station-manifest' : 'manifest',
        station: manifest.stationAddress,
        slot,
        manifestPath,
        hasMedia: fs.existsSync(mediaPath),
        mediaUrl: `/media/${encodeURIComponent(manifest.streamId)}/${manifest.sequence}.webm`,
        gatewayUrl: `/api/segments/${encodeURIComponent(manifest.streamId)}/${manifest.sequence}/payload`,
        ready: fs.existsSync(mediaPath),
      }]
    })
    .sort(canonicalSegmentSort)
}

async function readStationSegments(ctx = networkContext(defaultNetwork)) {
  if (!ctx.publicClient || !ctx.stationAddress || !ctx.stationAbi) return []

  const logs = await ctx.publicClient.getLogs({
    address: getAddress(ctx.stationAddress),
    fromBlock: ctx.stationFromBlock,
    toBlock: 'latest',
  })
  const parsed = parseEventLogs({
    abi: ctx.stationAbi,
    eventName: 'SegmentPublished',
    logs,
  })
  const blockTimestamps = new Map()
  for (const log of parsed) {
    const key = log.blockNumber.toString()
    if (blockTimestamps.has(key)) continue
    const block = await ctx.publicClient.getBlock({ blockNumber: log.blockNumber })
    blockTimestamps.set(key, blockTimestampMs(block.timestamp, 'Station segment block timestamp'))
  }

  const segments = parsed
    .map((log) => {
      const createdAtMs = blockTimestamps.get(log.blockNumber.toString()) || null
      return stationSegmentFromLog(log, ctx, createdAtMs)
    })
    .sort(canonicalSegmentSort)

  const latestByKey = new Map()
  for (const segment of segments) {
    const key = `${segment.streamId}:${segment.sequence}`
    const previous = latestByKey.get(key)
    const previousOrder = previous
      ? segmentOrderPart(previous.blockNumber, 'previous segment blockNumber') * 1_000_000n
        + segmentOrderPart(previous.logIndex, 'previous segment logIndex')
      : -1n
    const nextOrder = segmentOrderPart(segment.blockNumber, 'segment blockNumber') * 1_000_000n
      + segmentOrderPart(segment.logIndex, 'segment logIndex')
    if (!previous || nextOrder >= previousOrder) latestByKey.set(key, segment)
  }

  return [...latestByKey.values()].sort(
    canonicalSegmentSort,
  )
}

function refreshStationSegments(ctx = networkContext(defaultNetwork)) {
  const cacheKey = contextCacheKey(ctx)
  if (stationSegmentsPromise.has(cacheKey)) return stationSegmentsPromise.get(cacheKey)
  const promise = readStationSegments(ctx)
    .then((segments) => {
      stationSegmentsCache.set(cacheKey, { segments, updatedAt: Date.now() })
      return segments
    })
    .catch((error) => {
      console.warn(`${ctx.name} Station segment feed unavailable: ${error.message}`)
      return stationSegmentsCache.get(cacheKey)?.segments || []
    })
    .finally(() => {
      stationSegmentsPromise.delete(cacheKey)
    })
  stationSegmentsPromise.set(cacheKey, promise)
  return promise
}

async function segmentFeed(ctx = networkContext(defaultNetwork)) {
  const cached = stationSegmentsCache.get(contextCacheKey(ctx))
  if (cached?.segments?.length) {
    if (Date.now() - cached.updatedAt > 10_000) void refreshStationSegments(ctx)
    return cached.segments
  }
  if (ctx.publicClient && ctx.stationAddress && ctx.stationAbi) return refreshStationSegments(ctx)
  void refreshStationSegments(ctx)
  if (ctx.name !== 'sepolia') return []
  return readManifests()
}

function summarizeHealth(id, segments, blobspace, ctx = networkContext(defaultNetwork)) {
  const streamSegments = segments
    .filter((segment) => segment.streamId === id)
    .sort(canonicalSegmentSort)
  const latest = streamSegments.at(-1) || null
  const latestSequence = latest ? nonNegativeSafeInteger(latest.sequence, 'health latest sequence') : null
  const proof = latestSequence == null ? null : proofSegmentBySequence(id).get(latestSequence) || null
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
  const proof = proofSegmentBySequence(segment.streamId).get(sequence) || null
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
    streamId: segment.streamId,
    sequence,
    durationMs,
    payloadBytes,
    payloadSha256: segment.payloadSha256,
    payloadSha256Hex: segment.payloadSha256Hex,
    codec: segment.codec,
    previousSegmentHash: segment.previousSegmentHash || null,
    publisher: segment.publisher,
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
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`)
    return response.json()
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
  return blockTimestampMs(genesisTime + BigInt(safeSlot) * secondsPerSlot, 'beacon slot timestamp')
}

async function latestSlot(ctx = networkContext(defaultNetwork)) {
  if (!ctx.beaconUrl) return null
  const head = await beacon('/eth/v1/beacon/headers/head', ctx)
  return beaconHeadSlot(head)
}

async function sidecarsForSlot(slot, ctx = networkContext(defaultNetwork)) {
  const safeSlot = nonNegativeSafeInteger(slot, 'beacon sidecar slot')
  const started = performance.now()
  const body = await beacon(`/eth/v1/beacon/blob_sidecars/${safeSlot}`, ctx)
  const sidecars = beaconDataArray(body, 'blob sidecars')
  const rows = sidecars.map((sidecar) => {
    const commitment = sidecar.kzg_commitment || sidecar.kzgCommitment
    const versionedHash = sidecarVersionedHash(sidecar)
    return {
      index: sidecarIndex(sidecar.index, 'beacon sidecar index'),
      versionedHash,
      commitment,
      hasBlob: Boolean(sidecar.blob),
    }
  })
  return { slot: safeSlot, fetchMs: Math.round(performance.now() - started), sidecars: rows }
}

function cachedBlobspaceRows(segments) {
  const rows = new Map()
  for (const segment of segments) {
    const cached = getCachedSidecars(segment.txHash)
    if (cached?.slot == null) continue
    const slot = cached.slot
    const row = rows.get(slot) || { slot, source: 'cached proof', fetchMs: null, sidecars: [] }
    for (const match of cached.matches) {
      const sequence = nonNegativeSafeInteger(segment.sequence, 'cached blobspace segment sequence')
      row.sidecars.push({
        index: safeSlot(match.index),
        versionedHash: match.versionedHash,
        streamId: segment.streamId,
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
        sequence: String(segment.sequence),
        txHash: segment.txHash,
      })
    }
  }
  return hashes
}

async function recentBlobTransactionsByHash(ctx, latestBlock, genesisTime, count = 8) {
  const hashes = new Map()
  if (!ctx.publicClient || genesisTime == null || latestBlock?.number == null) return hashes
  const station = ctx.stationAddress ? getAddress(ctx.stationAddress).toLowerCase() : ''
  const latestSlot = (latestBlock.timestamp - genesisTime) / secondsPerSlot
  const minSlot = latestSlot - BigInt(Math.max(0, count + 2))
  const maxBlocks = Math.max(count * 3, count + 8)

  for (let offset = 0; offset < maxBlocks; offset++) {
    const blockNumber = latestBlock.number - BigInt(offset)
    if (blockNumber < 0n) break
    let block = null
    try {
      block = await ctx.publicClient.getBlock({ blockNumber, includeTransactions: true })
    } catch {
      continue
    }
    const slot = (block.timestamp - genesisTime) / secondsPerSlot
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
            ? { streamId: sidecar.streamId, sequence: String(sidecar.sequence), txHash: null }
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
    const latest = (latestBlock.timestamp - genesisTime) / 12n
    const blobTransactions = await recentBlobTransactionsByHash(ctx, latestBlock, genesisTime, count)
    const slots = []
    for (let i = 0; i < count; i++) {
      slots.push(latest - BigInt(i))
    }

    const rows = await Promise.all(slots.map(async (slot) => {
      let sidecars = []
      let error = null
      let blobs = []
      try {
        const result = await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`, ctx)
        sidecars = beaconDataArray(result, 'blob sidecars')
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
    }))

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
      console.warn(`${ctx.name} slot metrics unavailable: ${error.message}`)
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

async function blobspaceRows(segments, count = 8, ctx = networkContext(defaultNetwork)) {
  const streamHashes = new Map()
  for (const segment of segments) {
    const sequence = nonNegativeSafeInteger(segment.sequence, 'blobspace segment sequence')
    for (const hash of segment.blobVersionedHashes) {
      streamHashes.set(hash, { streamId: segment.streamId, sequence })
    }
  }

  if (!ctx.beaconUrl) {
    return {
      mode: 'cached',
      maxBlobsPerBlock,
      ...blobspaceConfig(ctx),
      rows: cachedBlobspaceRows(segments),
      warning: `Set ${ctx.name.toUpperCase()}_BEACON_RPC_URL to watch live blob sidecars from /eth/v1/beacon/blob_sidecars/{slot}.`,
    }
  }

  try {
    const headSlot = await latestSlot(ctx)
    const slots = Array.from({ length: count }, (_, index) => headSlot - index).filter((slot) => slot >= 0)
    const rows = await Promise.all(slots.map(async (slot) => {
      try {
        const row = await sidecarsForSlot(slot, ctx)
        row.source = 'beacon'
        row.sidecars = row.sidecars.map((sidecar) => ({
          ...sidecar,
          ...(streamHashes.get(sidecar.versionedHash) || {}),
        }))
        return row
      } catch (error) {
        return { slot, source: 'beacon', error: publicErrorMessage(error, ctx), sidecars: [] }
      }
    }))
    return { mode: 'live', maxBlobsPerBlock, ...blobspaceConfig(ctx), rows }
  } catch (error) {
    return {
      mode: 'cached',
      maxBlobsPerBlock,
      ...blobspaceConfig(ctx),
      rows: cachedBlobspaceRows(segments),
      warning: publicErrorMessage(error, ctx),
    }
  }
}

async function fetchAndCacheSidecars(segment, ctx = networkContext(segment.chain || defaultNetwork)) {
  if (!isTxHash(segment.txHash)) throw new Error('Invalid segment transaction hash')
  const cached = getCachedSidecars(segment.txHash)
  if (cached) return cached
  if (!ctx.publicClient || !ctx.beaconUrl) throw new Error(`${ctx.name} ETH_RPC_URL and BEACON_RPC_URL are required to fetch uncached blob sidecars`)

  const tx = await ctx.publicClient.getTransaction({ hash: segment.txHash })
  const block = await ctx.publicClient.getBlock({ blockHash: tx.blockHash })
  const genesis = await beacon('/eth/v1/beacon/genesis', ctx)
  const slot = (block.timestamp - beaconGenesisTime(genesis)) / 12n
  const sidecars = await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`, ctx)
  const wanted = new Set(preferredBlobVersionedHashes(tx, segment))
  const matches = []

  for (const sidecar of beaconDataArray(sidecars, 'blob sidecars')) {
    const versionedHash = sidecarVersionedHash(sidecar)
    if (!versionedHash) continue
    if (wanted.has(versionedHash)) matches.push({ ...sidecar, versionedHash })
  }

  const payload = { txHash: segment.txHash, slot: slot.toString(), matches }
  const sidecarPath = safeSidecarPath(segment.txHash)
  if (!sidecarPath) throw new Error('Invalid sidecar cache path')
  fs.mkdirSync(sidecarDir, { recursive: true })
  fs.writeFileSync(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

function reconstructPayload(segment, sidecars) {
  const byHash = new Map()
  if (!Array.isArray(sidecars?.matches)) throw new Error('Invalid sidecar response: matches must be an array')
  for (const [index, match] of sidecars.matches.entries()) {
    if (!validSidecarMatch(match)) throw new Error(`Invalid sidecar match at index ${index}`)
    byHash.set(String(match.versionedHash).toLowerCase(), match.blob)
  }

  const blobs = []
  for (const hash of segment.blobVersionedHashes) {
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
  const payload = Buffer.concat(chunks, decodedLength).subarray(0, payloadBytes)
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex')
  if (sha256 !== segment.payloadSha256) {
    throw new Error(`SHA-256 mismatch: expected ${segment.payloadSha256}, got ${sha256}`)
  }
  return payload
}

async function ensureMedia(segment, ctx = networkContext(segment.chain || defaultNetwork)) {
  const mediaPath = safeMediaPath(segment.streamId, segment.sequence)
  if (!mediaPath) throw new Error('Invalid segment media path')
  if (fs.existsSync(mediaPath)) return mediaPath
  if (mediaInflight.has(mediaPath)) return mediaInflight.get(mediaPath)
  const promise = (async () => {
    if (fs.existsSync(mediaPath)) return mediaPath
    const sidecars = await fetchAndCacheSidecars(segment, ctx)
    const payload = reconstructPayload(segment, sidecars)
    fs.mkdirSync(reconstructedDir, { recursive: true })
    const tempPath = `${mediaPath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tempPath, payload)
    fs.renameSync(tempPath, mediaPath)
    return mediaPath
  })().finally(() => {
    mediaInflight.delete(mediaPath)
  })
  mediaInflight.set(mediaPath, promise)
  return promise
}

function sendMedia(request, response, mediaPath, contentType = 'video/webm') {
  const stat = fs.statSync(mediaPath)
  const range = request.headers.range
  if (!range) {
    response.writeHead(200, {
      ...defaultHeaders,
      'content-type': contentType,
      'content-length': stat.size,
      'accept-ranges': 'bytes',
    })
    return fs.createReadStream(mediaPath).pipe(response)
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return send(response, 416, 'invalid range')
  const start = match[1] ? Number(match[1]) : 0
  const end = match[2] ? Number(match[2]) : stat.size - 1
  if (start >= stat.size || end >= stat.size || start > end) return send(response, 416, 'range not satisfiable')

  response.writeHead(206, {
    ...defaultHeaders,
    'content-type': contentType,
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${stat.size}`,
    'accept-ranges': 'bytes',
  })
  return fs.createReadStream(mediaPath, { start, end }).pipe(response)
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

function overlayHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Radio Free Ethereum Overlay</title>
  <style>
    :root {
      color-scheme: dark;
      --accent: #8f97e8;
      --link: #c6ccff;
      --text: #f0f1f8;
      --muted: rgba(186, 190, 214, .82);
      --surface-1: rgba(17, 19, 26, .95);
      --surface-2: rgba(48, 51, 67, .92);
      --surface-3: rgba(24, 26, 36, .97);
      --border: #252838;
      --bevel: #06070c;
      --highlight: rgba(255, 255, 255, .07);
      --shadow: rgba(0, 0, 0, .42);
      --other-blob: rgba(198, 204, 255, .42);
      --empty-blob: rgba(198, 204, 255, .095);
      --ui: Arial, "Segoe UI", sans-serif;
      --mono: Consolas, ui-monospace, "SFMono-Regular", Menlo, Monaco, monospace;
    }

    * { box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: transparent;
      font-family: var(--ui);
      color: var(--text);
    }

    body.preview {
      background:
        linear-gradient(135deg, rgba(23, 25, 36, .92), rgba(8, 9, 14, .96)),
        #08090e;
    }

    .viewport {
      position: fixed;
      inset: 0;
      overflow: hidden;
    }

    .overlay {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 1920px;
      height: 1080px;
      transform-origin: 0 0;
      transform: translate(-50%, -50%) scale(var(--scale, 1));
      background: transparent;
    }

    .reference {
      position: absolute;
      inset: 0;
      width: 1920px;
      height: 1080px;
      clip-path: inset(0 0 188px 0);
      pointer-events: none;
      user-select: none;
    }

    .chip, .telemetry-card {
      border: 1px solid var(--border);
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        var(--surface-2);
      background-size: 8px 8px, 8px 8px, auto;
      box-shadow:
        inset 1px 1px 0 var(--highlight),
        3px 0 0 var(--bevel),
        0 4px 0 var(--bevel),
        6px 6px 0 var(--shadow);
    }

    .topbar {
      position: absolute;
      left: 0;
      top: 0;
      width: 1920px;
      height: 112px;
      pointer-events: none;
    }

    .chip {
      position: absolute;
      top: 31px;
      height: 48px;
      display: grid;
      place-items: center;
      padding: 0 13px;
      background-color: var(--surface-2);
      color: var(--link);
      font: 700 29px/1 var(--mono);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: 0;
      z-index: 2;
    }

    .top-telemetry-mask {
      position: absolute;
      left: 660px;
      top: 24px;
      width: 1168px;
      height: 64px;
      background: #181a24;
      z-index: 1;
    }

    #timeUtc { left: 672px; width: 236px; }
    .chip:not(#timeUtc) {
      top: 35px;
      height: 40px;
      padding: 0 11px;
      font-size: 22px;
    }
    #slot { left: 922px; width: 238px; }
    #nonce { left: 1174px; width: 252px; }
    #blockHash { left: 1440px; width: 374px; }

    .network-signal {
      position: absolute;
      left: 113px;
      top: 66px;
      width: 520px;
      height: 31px;
      display: flex;
      align-items: center;
      background: #181a24;
      color: var(--link);
      font: 700 26px/1 var(--mono);
      letter-spacing: 0;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      z-index: 2;
    }

    .lower {
      position: absolute;
      left: 36px;
      top: 948px;
      width: 1848px;
      height: 112px;
      pointer-events: none;
      z-index: 3;
    }

    .lower-panel-mask {
      position: absolute;
      inset: 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        var(--surface-1);
      background-size: 8px 8px, 8px 8px, auto;
      box-shadow: inset -3px -3px 0 rgba(0, 0, 0, .42), inset 2px 2px 0 rgba(255, 255, 255, .04);
      z-index: 0;
    }

    .status-label {
      position: absolute;
      left: 28px;
      top: 18px;
      display: block;
      color: var(--accent);
      font: 900 24px/1 var(--ui);
      text-transform: uppercase;
      letter-spacing: 0;
      z-index: 1;
    }

    .reading-title {
      position: absolute;
      left: 28px;
      top: 59px;
      width: 690px;
      display: block;
      color: var(--text);
      font: 900 42px/1 var(--ui);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: 2px 2px 0 #000;
      z-index: 1;
    }

    .telemetry {
      position: absolute;
      inset: 0;
      margin: 0;
      z-index: 3;
    }

    .telemetry-mask {
      position: absolute;
      left: 792px;
      top: 39px;
      width: 1040px;
      height: 72px;
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        var(--surface-1);
      background-size: 8px 8px, 8px 8px, auto;
      z-index: 0;
    }

    .telemetry-card {
      position: absolute;
      top: 50px;
      height: 54px;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      font-family: var(--mono);
      overflow: hidden;
      z-index: 1;
    }

    .telemetry-card.tx { left: 748px; width: 252px; }
    .telemetry-card.payload { left: 1024px; width: 196px; }
    .telemetry-card.hash { left: 1244px; width: 244px; }
    .telemetry-card.prev { left: 1512px; width: 244px; }

    .telemetry-card dt {
      margin: 0 0 7px;
      color: var(--muted);
      text-transform: uppercase;
      font: 800 15px/1 var(--mono);
    }

    .telemetry-card dd {
      margin: 0;
      min-width: 0;
      color: var(--link);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 800 21px/1 var(--mono);
    }

    .ticker-viewport {
      position: absolute;
      left: 36px;
      top: 876px;
      width: 1242px;
      height: 28px;
      overflow: hidden;
      color: rgba(198, 204, 255, .72);
      font: 700 20px/28px var(--mono);
      white-space: nowrap;
    }

    .ticker-track {
      display: inline-flex;
      gap: 48px;
      min-width: max-content;
      animation: rfe-ticker 34s linear infinite;
    }

    @keyframes rfe-ticker {
      from { transform: translateX(0); }
      to { transform: translateX(-50%); }
    }

    .offline .chip, .offline .telemetry dd {
      color: rgba(198, 204, 255, .52);
    }
  </style>
</head>
<body>
  <div class="viewport">
    <main id="overlay" class="overlay" aria-label="Radio Free Ethereum livestream overlay">
      <img id="overlayShell" class="reference" src="/rfe-assets/overlays/rfe-terminal-1080p.png" alt="" aria-hidden="true" />
      <div id="networkSignal" class="network-signal">PUBLIC SIGNAL / ${networkLabel(defaultNetwork).toUpperCase()}</div>
      <section class="topbar" aria-label="Live stream telemetry">
        <div class="top-telemetry-mask" aria-hidden="true"></div>
        <div id="timeUtc" class="chip">--:--:-- UTC</div>
        <div id="slot" class="chip">SLOT --</div>
        <div id="nonce" class="chip">SEQ --</div>
        <div id="blockHash" class="chip">BLOCK --</div>
      </section>

      <div class="ticker-viewport" aria-hidden="true">
        <div id="ticker" class="ticker-track"><span>Waiting for Station telemetry</span><span>Waiting for Station telemetry</span></div>
      </div>

      <section class="lower" aria-label="Current segment">
        <div class="lower-panel-mask" aria-hidden="true"></div>
        <div class="status-label">Now Reading</div>
        <div id="readingTitle" class="reading-title">The EF Mandate</div>
        <dl class="telemetry">
          <div class="telemetry-mask" aria-hidden="true"></div>
          <div class="telemetry-card tx"><dt>Prev TX</dt><dd id="txHash">--</dd></div>
          <div class="telemetry-card payload"><dt>Payload</dt><dd id="payloadSize">--</dd></div>
          <div class="telemetry-card hash"><dt>Hash</dt><dd id="contentHash">--</dd></div>
          <div class="telemetry-card prev"><dt>Prev</dt><dd id="previousHash">--</dd></div>
        </dl>
      </section>
    </main>
  </div>

  <script>
    const params = new URLSearchParams(location.search)
    const streamId = params.get('streamId') || '${streamId}'
    let selectedNetwork = (params.get('network') || ${JSON.stringify(defaultNetwork)}).toLowerCase() === 'mainnet' ? 'mainnet' : 'sepolia'
    const endpointPreset = params.get('endpointPreset') === 'public' ? 'public' : ''
    let selectedNetworkLabel = selectedNetwork === 'mainnet' ? 'Mainnet' : 'Sepolia'
    const preview = params.has('preview')
    const overlay = document.getElementById('overlay')
    const overlayShell = document.getElementById('overlayShell')
    if (preview) document.body.classList.add('preview')

    const overlayProfiles = {
      '360p': { width: 640, height: 360, src: '/rfe-assets/overlays/rfe-terminal-360p.png' },
      '420p': { width: 746, height: 420, src: '/rfe-assets/overlays/rfe-terminal-420p.png' },
      '480p': { width: 854, height: 480, src: '/rfe-assets/overlays/rfe-terminal-480p.png' },
      '720p': { width: 1280, height: 720, src: '/rfe-assets/overlays/rfe-terminal-720p.png' },
      '1080p': { width: 1920, height: 1080, src: '/rfe-assets/overlays/rfe-terminal-1080p.png' },
    }

    function overlayShellFor(width, height) {
      const explicitProfile = (params.get('profile') || '').toLowerCase()
      if (overlayProfiles[explicitProfile]) return overlayProfiles[explicitProfile].src
      const explicitWidth = Number(params.get('width') || width || 0)
      const explicitHeight = Number(params.get('height') || height || 0)
      const exact = Object.values(overlayProfiles).find((profile) => profile.width === explicitWidth && profile.height === explicitHeight)
      if (exact) return exact.src
      return overlayProfiles['1080p'].src
    }

    overlayShell.src = overlayShellFor()

    function scaleOverlay() {
      const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
      overlay.style.setProperty('--scale', String(scale))
    }

    function utcClock() {
      document.getElementById('timeUtc').textContent = streamClockText()
    }

    function apiUrl(path) {
      const params = new URLSearchParams()
      params.set('network', selectedNetwork)
      if (endpointPreset) params.set('endpointPreset', endpointPreset)
      if (customExecutionRpc) params.set('ethRpcUrl', customExecutionRpc)
      if (customBeaconRpc) params.set('beaconRpcUrl', customBeaconRpc)
      return path + (path.includes('?') ? '&' : '?') + params.toString()
    }

    function liveResponseSegments(data) {
      if (!data || typeof data !== 'object' || !Array.isArray(data.segments)) {
        throw new Error('Live response segments must be an array')
      }
      return data.segments
    }

    function updateNetworkSignal(data) {
      const label = data?.networkLabel || data?.transport?.networkLabel || data?.blobspace?.networkLabel || selectedNetworkLabel
      selectedNetworkLabel = label
      selectedNetwork = (data?.network || data?.transport?.network || data?.blobspace?.chain || selectedNetwork) === 'mainnet' ? 'mainnet' : 'sepolia'
      document.getElementById('networkSignal').textContent = 'PUBLIC SIGNAL / ' + String(label).toUpperCase()
    }

    function shorten(value, head, tail) {
      if (!value) return '--'
      const text = String(value)
      if (text.length <= head + tail + 3) return text
      return text.slice(0, head) + '...' + text.slice(-tail)
    }

    function publicErrorMessage(error) {
      return String(error?.message || error || 'Request failed').replace(/https?:\\/\\/[^\\s"'<>)}\\]]+/g, '[redacted endpoint]')
    }

    function formatBytes(value) {
      const n = Number(value || 0)
      return n ? new Intl.NumberFormat('en-US').format(n) + ' B' : '--'
    }

    function proofOrSequenceLabel(segment, proof) {
      if (proof && proof.nonce) return 'PROOF ' + proof.nonce
      if (segment && segment.sequence != null) return 'SEQ #' + segment.sequence
      return 'SEQ --'
    }

    function latestSegment(segments) {
      return [...(segments || [])].sort((a, b) => Number(a.sequence) - Number(b.sequence)).at(-1) || null
    }

    let streamClock = {
      key: null,
      startMs: null,
      durationMs: null,
      anchorWallMs: null,
    }

    function streamClockText() {
      if (!streamClock.startMs) return new Date().toISOString().slice(11, 19) + ' UTC'
      const elapsed = Math.max(0, Date.now() - streamClock.anchorWallMs)
      const capped = streamClock.durationMs ? Math.min(elapsed, streamClock.durationMs) : elapsed
      return new Date(streamClock.startMs + capped).toISOString().slice(11, 19) + ' UTC'
    }

    function updateStreamClock(segment) {
      if (!segment || !segment.proof || !segment.proof.generatedAt) return
      const key = segment.streamId + ':' + segment.sequence + ':' + segment.proof.generatedAt
      if (streamClock.key === key) return
      const startMs = Date.parse(segment.proof.generatedAt)
      if (!Number.isFinite(startMs)) return
      streamClock = {
        key,
        startMs,
        durationMs: Number(segment.durationMs || 0) || null,
        anchorWallMs: Date.now(),
      }
      utcClock()
    }

    function updateTicker(segment, blobspace, segments) {
      const proof = segment && segment.proof ? segment.proof : {}
      const blockHash = segment && segment.blockHash ? segment.blockHash : proof.block && proof.block.hash
      const content = segment && (segment.payloadSha256Hex || segment.payloadSha256)
      const previous = previousSegment(segment, segments)
      const text = [
        document.getElementById('timeUtc').textContent,
        'SLOT ' + ((segment && segment.slot) || (blobspace && blobspace.latestSlot) || '--'),
        'BLOCK ' + shorten(blockHash, 8, 4),
        proofOrSequenceLabel(segment, proof),
        'PREV TX ' + shorten(previous && previous.txHash, 8, 4),
        'PREV ' + shorten(segment && segment.previousSegmentHash, 8, 4),
        'CONTENT ' + shorten(content, 8, 4),
      ].join(' / ')
      const ticker = document.getElementById('ticker')
      const primary = document.createElement('span')
      const duplicate = document.createElement('span')
      primary.textContent = text
      duplicate.textContent = text
      duplicate.setAttribute('aria-hidden', 'true')
      ticker.replaceChildren(primary, duplicate)
    }

    function previousSegment(segment, segments) {
      if (!segment || segment.sequence == null) return null
      const sequence = Number(segment.sequence)
      return [...(segments || [])]
        .filter((candidate) => Number(candidate.sequence) < sequence)
        .sort((a, b) => Number(a.sequence) - Number(b.sequence))
        .at(-1) || null
    }

    async function poll() {
      try {
        const response = await fetch(apiUrl('/api/streams/' + encodeURIComponent(streamId) + '/live'), { cache: 'no-store' })
        if (!response.ok) throw new Error(await response.text())
        const data = await response.json()
        updateNetworkSignal(data)
        const responseSegments = liveResponseSegments(data)
        const segment = latestSegment(responseSegments)
        const proof = segment && segment.proof ? segment.proof : {}
        const blockHash = segment && segment.blockHash ? segment.blockHash : proof.block && proof.block.hash
        const latestSlot = data.blobspace && data.blobspace.latestSlot
        const previous = previousSegment(segment, responseSegments)
        updateStreamClock(segment)
        overlay.classList.toggle('offline', !segment)
        document.getElementById('slot').textContent = 'SLOT ' + (segment && segment.slot || latestSlot || '--')
        document.getElementById('nonce').textContent = proofOrSequenceLabel(segment, proof)
        document.getElementById('blockHash').textContent = 'BLOCK ' + shorten(blockHash, 8, 4)
        document.getElementById('txHash').textContent = shorten(previous && previous.txHash, 10, 6)
        document.getElementById('payloadSize').textContent = formatBytes(segment && segment.payloadBytes)
        const content = segment && (segment.payloadSha256Hex || segment.payloadSha256)
        document.getElementById('contentHash').textContent = shorten(content, 10, 6)
        document.getElementById('previousHash').textContent = shorten(segment && segment.previousSegmentHash, 10, 6)
        updateTicker(segment, data.blobspace, responseSegments)
      } catch (error) {
        overlay.classList.add('offline')
        document.getElementById('contentHash').textContent = publicErrorMessage(error)
      }
    }

    scaleOverlay()
    utcClock()
    window.addEventListener('resize', scaleOverlay)
    setInterval(utcClock, 1000)
    setInterval(poll, 4000)
    poll()
  </script>
</body>
</html>`
}

function overlayPreviewHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Radio Free Ethereum Overlay Preview</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #08090e;
      --text: #f0f1f8;
      --muted: rgba(186, 190, 214, .82);
      --link: #c6ccff;
      --border: #252838;
      font-family: Arial, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
    }

    .stage {
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        #05060a;
      background-size: 8px 8px, 8px 8px, auto;
    }

    .frame {
      position: relative;
      width: min(100vw, calc(100vh * 16 / 9));
      height: min(100vh, calc(100vw * 9 / 16));
      overflow: hidden;
      background: #000;
    }

    video, .preview-overlay {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
    }

    video {
      object-fit: cover;
      background: #000;
      z-index: 1;
    }

    .preview-overlay {
      pointer-events: none;
      background: transparent;
      z-index: 2;
    }

    .overlay-design {
      position: absolute;
      left: 0;
      top: 0;
      width: 1920px;
      height: 1080px;
      transform-origin: 0 0;
      transform: scale(var(--preview-scale, 1));
      color: #f0f1f8;
      font-family: Arial, "Segoe UI", sans-serif;
    }

    .reference {
      position: absolute;
      inset: 0;
      width: 1920px;
      height: 1080px;
      clip-path: inset(0 0 188px 0);
      pointer-events: none;
      user-select: none;
    }

    .chip, .telemetry-card {
      border: 1px solid #252838;
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        #303343;
      background-size: 8px 8px, 8px 8px, auto;
      box-shadow:
        inset 1px 1px 0 rgba(255, 255, 255, .07),
        3px 0 0 #06070c,
        0 4px 0 #06070c,
        6px 6px 0 rgba(0, 0, 0, .42);
    }

    .chip {
      position: absolute;
      top: 31px;
      height: 48px;
      display: grid;
      place-items: center;
      padding: 0 13px;
      color: #c6ccff;
      font: 700 29px/1 Consolas, ui-monospace, monospace;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      z-index: 2;
    }

    .top-telemetry-mask {
      position: absolute;
      left: 660px;
      top: 24px;
      width: 1168px;
      height: 64px;
      background: #181a24;
      z-index: 1;
    }

    #timeUtc { left: 672px; width: 236px; }
    .chip:not(#timeUtc) {
      top: 35px;
      height: 40px;
      padding: 0 11px;
      font-size: 22px;
    }
    #slot { left: 922px; width: 238px; }
    #nonce { left: 1174px; width: 252px; }
    #blockHash { left: 1440px; width: 374px; }

    .network-signal {
      position: absolute;
      left: 113px;
      top: 66px;
      width: 520px;
      height: 31px;
      display: flex;
      align-items: center;
      background: #181a24;
      color: #c6ccff;
      font: 700 26px/1 Consolas, ui-monospace, monospace;
      letter-spacing: 0;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      z-index: 2;
    }

    .lower-panel-mask {
      position: absolute;
      left: 36px;
      top: 948px;
      width: 1848px;
      height: 112px;
      border: 1px solid #252838;
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        #11131a;
      background-size: 8px 8px, 8px 8px, auto;
      box-shadow: inset -3px -3px 0 rgba(0, 0, 0, .42), inset 2px 2px 0 rgba(255, 255, 255, .04);
      z-index: 2;
    }

    .status-label {
      position: absolute;
      left: 64px;
      top: 966px;
      display: block;
      color: #c6ccff;
      font: 900 24px/1 Arial, "Segoe UI", sans-serif;
      text-transform: uppercase;
      z-index: 3;
    }

    .reading-title {
      position: absolute;
      left: 64px;
      top: 1007px;
      width: 690px;
      display: block;
      color: #f0f1f8;
      font: 900 42px/1 Arial, "Segoe UI", sans-serif;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 2px 2px 0 #000;
      z-index: 3;
    }

    .telemetry {
      position: absolute;
      inset: 0;
      margin: 0;
      z-index: 4;
    }

    .telemetry-mask {
      position: absolute;
      left: 792px;
      top: 987px;
      width: 1040px;
      height: 72px;
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        #11131a;
      background-size: 8px 8px, 8px 8px, auto;
      z-index: 0;
    }

    .telemetry-card {
      position: absolute;
      top: 998px;
      height: 54px;
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      overflow: hidden;
      font-family: Consolas, ui-monospace, monospace;
      z-index: 1;
    }

    .telemetry-card.tx { left: 784px; width: 252px; }
    .telemetry-card.payload { left: 1060px; width: 196px; }
    .telemetry-card.hash { left: 1280px; width: 244px; }
    .telemetry-card.prev { left: 1548px; width: 244px; }

    .telemetry-card dt {
      margin: 0 0 7px;
      color: rgba(186, 190, 214, .82);
      text-transform: uppercase;
      font: 800 15px/1 Consolas, ui-monospace, monospace;
    }

    .telemetry-card dd {
      margin: 0;
      color: #c6ccff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 800 21px/1 Consolas, ui-monospace, monospace;
    }

    .controls {
      position: fixed;
      left: 16px;
      top: 16px;
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: calc(100vw - 32px);
      min-height: 38px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: rgba(17, 19, 26, .88);
      color: var(--muted);
      font: 700 13px/1 Consolas, ui-monospace, monospace;
      box-shadow: 3px 3px 0 #06070c;
      z-index: 3;
    }

    .status-strip {
      color: #f0f1f8;
      white-space: nowrap;
    }

    button {
      border: 1px solid var(--border);
      border-radius: 4px;
      background: #303343;
      color: var(--link);
      font: inherit;
      padding: 5px 9px;
      cursor: pointer;
    }

    button:active, button.is-on {
      transform: translate(1px, 1px);
      box-shadow: inset 2px 2px 0 rgba(0, 0, 0, .28);
    }

    #status {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .debug-drawer {
      position: fixed;
      right: 16px;
      top: 72px;
      width: min(420px, calc(100vw - 32px));
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: rgba(17, 19, 26, .94);
      color: var(--muted);
      font: 700 12px/1.35 Consolas, ui-monospace, monospace;
      box-shadow: 3px 3px 0 #06070c;
      z-index: 4;
    }

    .debug-drawer[hidden] { display: none; }
    body.clean-preview .controls,
    body.clean-preview .debug-drawer {
      display: none;
    }

    body.layer-video .preview-overlay {
      display: none;
    }

    body.layer-overlay video {
      visibility: hidden;
    }

    body.layer-overlay .frame {
      background: #2b2f3a;
    }

    .debug-drawer h2 {
      margin: 0 0 10px;
      color: var(--link);
      font: 900 13px/1 Arial, "Segoe UI", sans-serif;
      text-transform: uppercase;
    }

    .debug-grid {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: 7px 10px;
    }

    .debug-grid dt {
      margin: 0;
      color: #ffaccb;
      text-transform: uppercase;
    }

    .debug-grid dd {
      margin: 0;
      min-width: 0;
      color: #f0f1f8;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  </style>
</head>
<body>
  <main class="stage">
    <div class="frame">
      <video id="video" controls autoplay playsinline></video>
      <div class="preview-overlay" aria-label="Radio Free Ethereum overlay preview">
        <div id="previewDesign" class="overlay-design">
          <img id="overlayShell" class="reference" src="/rfe-assets/overlays/rfe-terminal-1080p.png" alt="" aria-hidden="true" />
          <div id="networkSignal" class="network-signal">PUBLIC SIGNAL / ${networkLabel(defaultNetwork).toUpperCase()}</div>
          <div class="top-telemetry-mask" aria-hidden="true"></div>
          <div id="timeUtc" class="chip">--:--:-- UTC</div>
          <div id="slot" class="chip">SLOT --</div>
          <div id="nonce" class="chip">SEQ --</div>
          <div id="blockHash" class="chip">BLOCK --</div>
          <div class="lower-panel-mask" aria-hidden="true"></div>
          <div class="status-label">Now Reading</div>
          <div class="reading-title">The EF Mandate</div>
          <dl class="telemetry">
            <div class="telemetry-mask" aria-hidden="true"></div>
            <div class="telemetry-card tx"><dt>Prev TX</dt><dd id="txHash">--</dd></div>
            <div class="telemetry-card payload"><dt>Payload</dt><dd id="payloadSize">--</dd></div>
            <div class="telemetry-card hash"><dt>Hash</dt><dd id="contentHash">--</dd></div>
            <div class="telemetry-card prev"><dt>Prev</dt><dd id="previousHash">--</dd></div>
          </dl>
        </div>
      </div>
    </div>
  </main>
  <div class="controls">
    <span id="liveStrip" class="status-strip">WAITING / ${networkLabel(defaultNetwork)} / seq -- / -- blobs / tx -- / age --</span>
    <button id="debugToggle" type="button" aria-expanded="false">Proof</button>
    <span id="status">loading stream</span>
  </div>
  <aside id="debugDrawer" class="debug-drawer" hidden>
    <h2>Proof Debug</h2>
    <dl class="debug-grid">
      <dt>TX</dt><dd id="debugTx">--</dd>
      <dt>Block</dt><dd id="debugBlock">--</dd>
      <dt>Blobs</dt><dd id="debugBlobs">--</dd>
      <dt>Nonce</dt><dd id="debugNonce">--</dd>
      <dt>Content</dt><dd id="debugContent">--</dd>
      <dt>Generated</dt><dd id="debugGenerated">--</dd>
      <dt>Latest Slot</dt><dd id="debugSlot">--</dd>
    </dl>
  </aside>

  <script>
    const params = new URLSearchParams(location.search)
    const streamId = params.get('streamId') || '${streamId}'
    if (params.get('source') === 'clean') document.body.classList.add('clean-preview')
    if (params.get('layer') === 'video') document.body.classList.add('layer-video')
    if (params.get('layer') === 'overlay') document.body.classList.add('layer-overlay')
    const localVideoMode = params.get('video') === 'local'
    let selectedNetwork = (params.get('network') || ${JSON.stringify(defaultNetwork)}).toLowerCase() === 'mainnet' ? 'mainnet' : 'sepolia'
    const endpointPreset = params.get('endpointPreset') === 'public' ? 'public' : ''
    let selectedNetworkLabel = selectedNetwork === 'mainnet' ? 'Mainnet' : 'Sepolia'
    const video = document.getElementById('video')
    const frame = document.querySelector('.frame')
    const previewDesign = document.getElementById('previewDesign')
    const overlayShell = document.getElementById('overlayShell')
    const status = document.getElementById('status')
    const liveStrip = document.getElementById('liveStrip')
    const debugToggle = document.getElementById('debugToggle')
    const debugDrawer = document.getElementById('debugDrawer')
    const pollMs = 3500
    const segments = new Map()
    const payloads = new Map()
    let latestBlobspace = null
    let currentSequence = null
    let activeSegment = null
    let isPlaying = false
    let streamClock = { key: null, startMs: null, durationMs: null, anchorWallMs: null }

    const overlayProfiles = {
      '360p': { width: 640, height: 360, src: '/rfe-assets/overlays/rfe-terminal-360p.png' },
      '420p': { width: 746, height: 420, src: '/rfe-assets/overlays/rfe-terminal-420p.png' },
      '480p': { width: 854, height: 480, src: '/rfe-assets/overlays/rfe-terminal-480p.png' },
      '720p': { width: 1280, height: 720, src: '/rfe-assets/overlays/rfe-terminal-720p.png' },
      '1080p': { width: 1920, height: 1080, src: '/rfe-assets/overlays/rfe-terminal-1080p.png' },
    }

    function overlayShellFor(width, height) {
      const explicitProfile = (params.get('profile') || '').toLowerCase()
      if (overlayProfiles[explicitProfile]) return overlayProfiles[explicitProfile].src
      const explicitWidth = Number(params.get('width') || width || 0)
      const explicitHeight = Number(params.get('height') || height || 0)
      const exact = Object.values(overlayProfiles).find((profile) => profile.width === explicitWidth && profile.height === explicitHeight)
      if (exact) return exact.src
      return overlayProfiles['1080p'].src
    }

    function updateOverlayShell(width, height) {
      overlayShell.src = overlayShellFor(width, height)
    }

    updateOverlayShell()

    function scalePreviewOverlay() {
      const rect = frame.getBoundingClientRect()
      previewDesign.style.setProperty('--preview-scale', String(Math.min(rect.width / 1920, rect.height / 1080)))
    }

    function shorten(value, head, tail) {
      if (!value) return '--'
      const text = String(value)
      if (text.length <= head + tail + 3) return text
      return text.slice(0, head) + '...' + text.slice(-tail)
    }

    function publicErrorMessage(error) {
      return String(error?.message || error || 'Request failed').replace(/https?:\\/\\/[^\\s"'<>)}\\]]+/g, '[redacted endpoint]')
    }

    function formatBytes(value) {
      const n = Number(value || 0)
      return n ? new Intl.NumberFormat('en-US').format(n) + ' B' : '--'
    }

    function proofOrSequenceLabel(segment, proof) {
      if (proof && proof.nonce) return 'PROOF ' + proof.nonce
      if (segment && segment.sequence != null) return 'SEQ #' + segment.sequence
      return 'SEQ --'
    }

    function streamClockText() {
      if (!streamClock.startMs) return new Date().toISOString().slice(11, 19) + ' UTC'
      const elapsed = Math.max(0, Date.now() - streamClock.anchorWallMs)
      const capped = streamClock.durationMs ? Math.min(elapsed, streamClock.durationMs) : elapsed
      return new Date(streamClock.startMs + capped).toISOString().slice(11, 19) + ' UTC'
    }

    function tickClock() {
      document.getElementById('timeUtc').textContent = streamClockText()
    }

    function updateStreamClock(segment) {
      if (!segment || !segment.proof || !segment.proof.generatedAt) return
      const key = segment.streamId + ':' + segment.sequence + ':' + segment.proof.generatedAt
      if (streamClock.key === key) return
      const startMs = Date.parse(segment.proof.generatedAt)
      if (!Number.isFinite(startMs)) return
      streamClock = {
        key,
        startMs,
        durationMs: Number(segment.durationMs || 0) || null,
        anchorWallMs: Date.now(),
      }
      tickClock()
    }

    function orderedSegments() {
      return [...segments.values()]
        .sort((a, b) => Number(a.sequence) - Number(b.sequence))
    }

    function latestSegment() {
      return orderedSegments().at(-1) || null
    }

    function previousSegment(segment) {
      if (!segment || segment.sequence == null) return null
      return orderedSegments()
        .filter((candidate) => Number(candidate.sequence) < Number(segment.sequence))
        .at(-1) || null
    }

    function segmentUrl(sequence) {
      return '/api/segments/' + encodeURIComponent(streamId) + '/' + encodeURIComponent(sequence) + '/payload'
    }

    function apiUrl(path) {
      const params = new URLSearchParams()
      params.set('network', selectedNetwork)
      if (endpointPreset) params.set('endpointPreset', endpointPreset)
      return path + (path.includes('?') ? '&' : '?') + params.toString()
    }

    function liveResponseSegments(data) {
      if (!data || typeof data !== 'object' || !Array.isArray(data.segments)) {
        throw new Error('Live response segments must be an array')
      }
      return data.segments
    }

    function updateNetworkSignal(data) {
      const label = data?.networkLabel || data?.transport?.networkLabel || data?.blobspace?.networkLabel || selectedNetworkLabel
      selectedNetworkLabel = label
      selectedNetwork = (data?.network || data?.transport?.network || data?.blobspace?.chain || selectedNetwork) === 'mainnet' ? 'mainnet' : 'sepolia'
      document.getElementById('networkSignal').textContent = 'PUBLIC SIGNAL / ' + String(label).toUpperCase()
    }

    function ageText(segment) {
      const created = Date.parse(segment && segment.createdAt || '')
      if (!Number.isFinite(created)) return '--'
      const seconds = Math.max(0, Math.round((Date.now() - created) / 1000))
      if (seconds < 90) return seconds + 's'
      const minutes = Math.round(seconds / 60)
      if (minutes < 90) return minutes + 'm'
      return Math.round(minutes / 60) + 'h'
    }

    function setStatusStrip(segment, state) {
      const seq = segment ? '#' + segment.sequence : '--'
      const blobs = segment ? segment.blobCount + ' blobs' : '-- blobs'
      const tx = segment ? shorten(segment.txHash, 8, 6) : '--'
      liveStrip.textContent = state + ' / ' + selectedNetworkLabel + ' / seq ' + seq + ' / ' + blobs + ' / tx ' + tx + ' / age ' + ageText(segment)
    }

    function updateDebug(segment, data) {
      const proof = segment && segment.proof ? segment.proof : {}
      document.getElementById('debugTx').textContent = segment && segment.txHash || '--'
      document.getElementById('debugBlock').textContent = segment && segment.blockNumber || proof.block && proof.block.number || '--'
      document.getElementById('debugBlobs').textContent = segment ? String(segment.blobCount || '--') : '--'
      document.getElementById('debugNonce').textContent = proof.nonce || '--'
      document.getElementById('debugContent').textContent = segment && (segment.payloadSha256Hex || segment.payloadSha256) || '--'
      document.getElementById('debugGenerated').textContent = proof.generatedAt || '--'
      document.getElementById('debugSlot').textContent = data && data.blobspace && data.blobspace.latestSlot || '--'
    }

    function updateTelemetry(segment, data) {
      if (!segment) {
        setStatusStrip(null, 'WAITING')
        updateDebug(null, data)
        return
      }
      const proof = segment.proof || {}
      const blockHash = segment.blockHash || (proof.block && proof.block.hash)
      const previous = previousSegment(segment)
      updateStreamClock(segment)
      document.getElementById('slot').textContent = 'SLOT ' + (segment.slot || (data && data.blobspace && data.blobspace.latestSlot) || '--')
      document.getElementById('nonce').textContent = proofOrSequenceLabel(segment, proof)
      document.getElementById('blockHash').textContent = 'BLOCK ' + shorten(blockHash, 8, 4)
      document.getElementById('txHash').textContent = shorten(previous && previous.txHash, 10, 6)
      document.getElementById('payloadSize').textContent = formatBytes(segment.payloadBytes)
      document.getElementById('contentHash').textContent = shorten(segment.payloadSha256Hex || segment.payloadSha256, 10, 6)
      document.getElementById('previousHash').textContent = shorten(segment.previousSegmentHash, 10, 6)
      setStatusStrip(segment, isPlaying ? 'LIVE' : 'WAITING')
      updateDebug(segment, data)
    }

    async function pollLive() {
      const response = await fetch(apiUrl('/api/streams/' + encodeURIComponent(streamId) + '/live'), { cache: 'no-store' })
      if (!response.ok) throw new Error(await response.text())
      const data = await response.json()
      updateNetworkSignal(data)
      latestBlobspace = data.blobspace || null
      for (const segment of liveResponseSegments(data)) {
        segments.set(Number(segment.sequence), segment)
      }
      const latest = latestSegment()
      updateTelemetry(activeSegment || latest, data)
      if (localVideoMode) {
        status.textContent = latest ? 'playing local preview video / seq ' + latest.sequence : 'playing local preview video'
        setStatusStrip(latest, 'PREVIEW')
        return
      }
      if (!latest) {
        status.textContent = 'waiting for Station metadata'
        return
      }
      if (currentSequence === null && !isPlaying) {
        await playSegment(latest)
        return
      }
      const next = segments.get(Number(currentSequence) + 1)
      if (next) {
        prefetchSegment(next)
        if (!isPlaying) await playSegment(next)
      } else if (!isPlaying) {
        status.textContent = 'waiting for seq ' + (Number(currentSequence) + 1)
        setStatusStrip(activeSegment || latest, 'WAITING')
      }
    }

    function prunePayloads() {
      for (const [sequence, entry] of payloads) {
        if (currentSequence !== null && Number(sequence) < Number(currentSequence) - 1 && entry.url) {
          URL.revokeObjectURL(entry.url)
          payloads.delete(sequence)
        }
      }
    }

    function prefetchSegment(segment) {
      const sequence = Number(segment.sequence)
      if (payloads.has(sequence)) return payloads.get(sequence).promise
      const promise = fetch(apiUrl(segmentUrl(sequence)), { cache: 'no-store' })
        .then((response) => {
          if (!response.ok) throw new Error('payload ' + sequence + ': ' + response.status)
          return response.blob()
        })
        .then((blob) => {
          const entry = payloads.get(sequence) || {}
          entry.url = URL.createObjectURL(blob)
          payloads.set(sequence, entry)
          return entry.url
        })
        .catch((error) => {
          payloads.delete(sequence)
          throw error
        })
      payloads.set(sequence, { promise, url: null })
      return promise
    }

    async function playSegment(segment) {
      currentSequence = Number(segment.sequence)
      activeSegment = segment
      updateTelemetry(segment, { blobspace: latestBlobspace })
      status.textContent = 'fetching seq ' + segment.sequence
      const url = await prefetchSegment(segment)
      video.loop = false
      video.src = url
      video.muted = true
      status.textContent = 'playing seq ' + segment.sequence
      isPlaying = true
      setStatusStrip(segment, 'LIVE')
      const next = segments.get(Number(segment.sequence) + 1)
      if (next) prefetchSegment(next)
      prunePayloads()
      try {
        await video.play()
      } catch {
        status.textContent = 'seq ' + segment.sequence + ' ready / press play for video and audio'
      }
    }

    async function playNext() {
      isPlaying = false
      const next = segments.get(Number(currentSequence) + 1)
      if (next) {
        await playSegment(next)
        return
      }
      status.textContent = 'waiting for seq ' + (Number(currentSequence) + 1)
      setStatusStrip(activeSegment || latestSegment(), 'WAITING')
    }

    debugToggle.addEventListener('click', () => {
      const open = debugDrawer.hasAttribute('hidden')
      debugDrawer.toggleAttribute('hidden', !open)
      debugToggle.classList.toggle('is-on', open)
      debugToggle.setAttribute('aria-expanded', String(open))
    })
    if (localVideoMode) {
      video.loop = true
      video.muted = true
      video.src = apiUrl('/preview-video')
      video.play().catch(() => {
        status.textContent = 'local preview video ready / press play'
      })
    }
    video.addEventListener('loadedmetadata', () => {
      updateOverlayShell(video.videoWidth, video.videoHeight)
    })
    video.addEventListener('playing', () => {
      isPlaying = true
      status.textContent = 'playing seq ' + (currentSequence ?? '--')
      setStatusStrip(activeSegment, 'LIVE')
    })
    video.addEventListener('waiting', () => {
      status.textContent = 'buffering seq ' + (currentSequence ?? '--')
    })
    video.addEventListener('ended', () => playNext().catch((error) => { status.textContent = publicErrorMessage(error) }))
    window.addEventListener('resize', scalePreviewOverlay)
    scalePreviewOverlay()
    tickClock()
    setInterval(tickClock, 1000)
    setInterval(() => {
      const segment = activeSegment || latestSegment()
      if (segment) setStatusStrip(segment, isPlaying ? 'LIVE' : 'WAITING')
    }, 1000)
    setInterval(() => pollLive().catch((error) => { status.textContent = publicErrorMessage(error) }), pollMs)
    pollLive().catch((error) => { status.textContent = publicErrorMessage(error) })
  </script>
</body>
</html>`
}

function indexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Radio Free Ethereum</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: "MS Sans Serif", "Segoe UI", ui-sans-serif, system-ui, Arial, sans-serif;
      background: #0a0b10;
      color: #f4f1f7;
      --window: #151723;
      --window-2: #1c1f2d;
      --surface: #232638;
      --surface-2: #2f3448;
      --line: #393e5d;
      --line-dark: #07080d;
      --highlight: rgba(255, 255, 255, .13);
      --muted: rgba(244, 241, 247, .66);
      --text: #f4f1f7;
      --title: #202a76;
      --title-2: #3c2d82;
      --live: #63d46e;
      --warn: #f0b84f;
      --bad: #ff6f9f;
      --accent: #8f97e8;
      --accent-2: #75d6ff;
      --milady: #ff8fb3;
      --milady-2: #c76693;
      --other: #8690b4;
      --mono: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
    }

    body.light {
      color-scheme: light;
      --window: #f4f1f7;
      --window-2: #ebe7f2;
      --surface: #ded8e8;
      --surface-2: #d8d2e2;
      --line: #9a94bc;
      --line-dark: #4e4a66;
      --highlight: rgba(255, 255, 255, .72);
      --muted: rgba(31, 29, 42, .68);
      --text: #1b1924;
      --title: #d9d3f1;
      --title-2: #f2c7dc;
      --accent: #555fc1;
      --accent-2: #066f91;
      --other: #8d94ae;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      overflow: hidden;
      background:
        repeating-linear-gradient(0deg, rgba(143, 151, 232, .035), rgba(143, 151, 232, .035) 1px, transparent 1px, transparent 8px),
        repeating-linear-gradient(90deg, rgba(199, 102, 147, .025), rgba(199, 102, 147, .025) 1px, transparent 1px, transparent 8px),
        #0a0b10;
    }
    body.light {
      background:
        repeating-linear-gradient(0deg, rgba(85, 95, 193, .06), rgba(85, 95, 193, .06) 1px, transparent 1px, transparent 8px),
        repeating-linear-gradient(90deg, rgba(199, 102, 147, .045), rgba(199, 102, 147, .045) 1px, transparent 1px, transparent 8px),
        #f3f0f6;
    }
    button { font: inherit; }
    .app {
      height: 100vh;
      height: 100dvh;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 372px;
      gap: 14px;
      padding: 14px;
      overflow: hidden;
    }
    .stage {
      min-width: 0;
      min-height: 0;
      padding: 0;
      display: grid;
      grid-template-rows: max-content minmax(0, 1fr) max-content;
      gap: 12px;
      overflow: hidden;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 54px;
      border: 2px solid var(--line);
      border-right-color: var(--line-dark);
      border-bottom-color: var(--line-dark);
      border-radius: 6px;
      padding: 7px;
      background: linear-gradient(90deg, var(--title), var(--title-2));
      box-shadow:
        inset 2px 2px 0 var(--highlight),
        6px 6px 0 rgba(0, 0, 0, .22);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .theme-toggle {
      width: 34px;
      height: 34px;
      flex: 0 0 auto;
      border: 2px solid #b8bddf;
      border-right-color: #07080d;
      border-bottom-color: #07080d;
      border-radius: 4px;
      background: #d8d2d9;
      color: #171521;
      display: grid;
      place-items: center;
      cursor: pointer;
      box-shadow: inset 2px 2px 0 rgba(255, 255, 255, .7);
    }
    .theme-toggle:hover { background: #fff; color: #202a76; }
    .theme-toggle:active {
      border-color: #07080d #b8bddf #b8bddf #07080d;
      box-shadow: inset 2px 2px 0 rgba(0,0,0,.34);
      transform: translate(1px, 1px);
    }
    .theme-toggle svg {
      width: 19px;
      height: 19px;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
    }
    .network-toggle {
      width: 82px;
      height: 34px;
      position: relative;
      display: grid;
      grid-template-columns: 1fr 1fr;
      align-items: center;
      border: 2px solid #a9afd8;
      border-right-color: #07080d;
      border-bottom-color: #07080d;
      background:
        linear-gradient(135deg, rgba(143, 151, 232, .34), rgba(17, 19, 26, .96)),
        #181a24;
      border-radius: 4px;
      color: #d7dbff;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0;
      box-shadow: inset 1px 1px 0 rgba(255, 255, 255, .16);
      cursor: pointer;
      padding: 0;
      overflow: hidden;
    }
    .network-toggle:active {
      border-color: #07080d #a9afd8 #a9afd8 #07080d;
      transform: translate(1px, 1px);
    }
    .network-toggle::before {
      content: "";
      position: absolute;
      inset: 3px auto 3px 3px;
      width: calc(50% - 4px);
      border-radius: 3px;
      background: #ffbdd4;
      border: 1px solid rgba(255,255,255,.65);
      box-shadow: 1px 1px 0 rgba(0,0,0,.45);
      transition: transform .18s ease;
    }
    .network-toggle.is-sepolia::before {
      transform: translateX(calc(100% + 2px));
      background: #bfeeff;
    }
    .network-toggle span {
      position: relative;
      z-index: 1;
      text-align: center;
      opacity: .45;
      color: #ffffff;
      text-shadow: 1px 1px 0 #000;
    }
    .network-toggle:not(.is-sepolia) .eth,
    .network-toggle.is-sepolia .sep {
      opacity: 1;
      color: #181019;
      text-shadow: none;
    }
    h1 {
      margin: 0;
      color: #ffffff;
      font-size: 18px;
      line-height: 1.1;
      letter-spacing: 0;
      text-shadow: 1px 1px 0 #000000;
    }
    .sub { color: rgba(255, 255, 255, .72); font-size: 12px; margin-top: 3px; }
    .top-status {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }
    .status-pill,
    .utc-clock {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      min-height: 36px;
      padding: 0 12px;
      border: 2px solid #b8bddf;
      border-right-color: #07080d;
      border-bottom-color: #07080d;
      background: #d8d2d9;
      color: #101014;
      border-radius: 4px;
      font-family: var(--mono);
      font-weight: 900;
      text-transform: uppercase;
      font-size: 12px;
      letter-spacing: 0;
      white-space: nowrap;
      box-shadow: inset 2px 2px 0 rgba(255, 255, 255, .7);
    }
    .utc-clock {
      min-width: 112px;
      justify-content: center;
      gap: 0;
      color: #202a76;
      background: #f8d5e3;
    }
    .status-dot {
      width: 9px;
      height: 9px;
      border-radius: 99px;
      background: var(--muted);
    }
    .state-live .status-dot, .state-replay .status-dot { background: var(--live); box-shadow: 0 0 16px rgba(99, 230, 152, .8); }
    .state-buffering .status-dot, .state-lagging .status-dot { background: var(--warn); box-shadow: 0 0 16px rgba(243, 196, 92, .7); }
    .state-offline .status-dot, .state-interrupted .status-dot { background: var(--bad); box-shadow: 0 0 16px rgba(255, 127, 122, .65); }
    .player-shell {
      min-height: 0;
      display: grid;
      grid-template-rows: minmax(0, 1fr) max-content;
      border: 2px solid var(--line);
      border-right-color: var(--line-dark);
      border-bottom-color: var(--line-dark);
      background: var(--window);
      border-radius: 6px;
      overflow: hidden;
      box-shadow:
        inset 2px 2px 0 var(--highlight),
        6px 6px 0 rgba(0, 0, 0, .22);
    }
    .video-wrap {
      position: relative;
      min-height: 0;
      overflow: hidden;
      padding: 10px;
      background:
        linear-gradient(180deg, rgba(255,255,255,.04), transparent 44px),
        #0b0d13;
      display: grid;
      place-items: center;
    }
    video {
      width: auto;
      max-width: 100%;
      height: 100%;
      max-height: none;
      object-fit: contain;
      background: #050607;
      border: 1px solid #07080d;
      display: block;
    }
    .video-overlay {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      pointer-events: none;
      background: linear-gradient(180deg, rgba(5,6,7,.18), rgba(5,6,7,.42));
    }
    .video-overlay.hidden { display: none; }
    .tune-card {
      width: min(560px, calc(100% - 40px));
      border: 2px solid #5f668f;
      border-right-color: #090a10;
      border-bottom-color: #090a10;
      background:
        linear-gradient(135deg, rgba(143, 151, 232, .16), rgba(16, 17, 24, .94)),
        #11131a;
      border-radius: 6px;
      padding: 18px;
      text-align: center;
      box-shadow:
        inset 2px 2px 0 rgba(255,255,255,.06),
        6px 6px 0 rgba(0, 0, 0, .28);
    }
    .tune-title { margin: 0 0 8px; color: #f8d5e3; font-size: 18px; text-shadow: 1px 1px 0 #000; }
    .tune-copy { margin: 0; color: var(--muted); line-height: 1.5; font-size: 14px; }
    .controls {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 14px;
      padding: 14px;
      border-top: 2px solid var(--line);
      background:
        linear-gradient(180deg, rgba(143, 151, 232, .1), rgba(255,255,255,0)),
        var(--window-2);
    }
    .now { min-width: 0; }
    .now strong { display: block; color: #ffffff; font-size: 15px; margin-bottom: 4px; text-shadow: 1px 1px 0 #000; }
    .now span { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
    .btns { display: flex; align-items: center; gap: 8px; }
    .volume-slider {
      width: 96px;
      height: 38px;
      accent-color: #ff8fb3;
      cursor: pointer;
    }
    .volume-slider:disabled {
      opacity: .42;
      cursor: not-allowed;
      filter: grayscale(1);
    }
    .icon-btn {
      width: 38px;
      height: 38px;
      border-radius: 4px;
      border: 2px solid #b8bddf;
      border-right-color: #07080d;
      border-bottom-color: #07080d;
      background: #d8d2d9;
      color: #11131a;
      cursor: pointer;
      display: grid;
      place-items: center;
      font-family: var(--mono);
      font-weight: 900;
      box-shadow: inset 2px 2px 0 rgba(255,255,255,.72);
    }
    .icon-btn svg {
      width: 20px;
      height: 20px;
      stroke: currentColor;
      stroke-width: 2.25;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
    }
    #refresh.is-spinning svg {
      animation: refresh-spin .8s linear infinite;
      transform-origin: 50% 50%;
    }
    @keyframes refresh-spin {
      to { transform: rotate(360deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      #refresh.is-spinning svg { animation: none; }
    }
    .icon-btn:hover { background: #ffffff; color: #202a76; }
    .icon-btn:active,
    .icon-btn.is-pressed,
    .live-btn.is-live,
    .loop-btn.is-on {
      border-color: #07080d #b8bddf #b8bddf #07080d;
      box-shadow:
        inset 2px 2px 0 rgba(0,0,0,.35),
        inset -1px -1px 0 rgba(255,255,255,.38);
      transform: translate(1px, 1px);
    }
    .live-btn {
      width: auto;
      min-width: 56px;
      padding: 0 10px;
      background: #ffbdd4;
      border-color: #ffd9e8 #64243c #64243c #ffd9e8;
      color: #201014;
      font-family: var(--mono);
      font-size: 12px;
      letter-spacing: 0;
    }
    .live-btn.is-live {
      background: #9ff5d7;
      border-color: #d7ffef #174635 #174635 #d7ffef;
    }
    .loop-btn {
      width: auto;
      min-width: 58px;
      padding: 0 10px;
      font-size: 12px;
    }
    .loop-btn.is-on {
      background: #bfeeff;
      color: #101315;
    }
    .live-btn.is-live, .loop-btn.is-on {
      border-color: #07080d #b8bddf #b8bddf #07080d;
      box-shadow:
        inset 2px 2px 0 rgba(0,0,0,.35),
        inset -1px -1px 0 rgba(255,255,255,.38);
      transform: translate(1px, 1px);
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(120px, 1fr));
      gap: 8px;
      min-height: 0;
    }
    .metric {
      border: 1px solid rgba(143, 151, 232, .34);
      background: rgba(17, 19, 26, .66);
      border-radius: 4px;
      padding: 7px 9px;
      min-height: 48px;
      box-shadow: none;
    }
    .metric label {
      display: block;
      color: rgba(255, 189, 212, .78);
      font-family: var(--mono);
      font-size: 9px;
      margin-bottom: 5px;
      text-transform: uppercase;
    }
    .metric strong { display: block; color: #d7dbff; font-family: var(--mono); font-size: 13px; line-height: 1.1; overflow-wrap: anywhere; }
    .rail {
      border: 2px solid var(--line);
      border-right-color: var(--line-dark);
      border-bottom-color: var(--line-dark);
      border-radius: 6px;
      background:
        linear-gradient(180deg, rgba(143, 151, 232, .08), rgba(255,255,255,0) 90px),
        var(--window);
      min-width: 0;
      min-height: 0;
      padding: 12px;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr) minmax(176px, var(--segments-pane-height, 190px));
      gap: 0;
      box-shadow:
        inset 2px 2px 0 var(--highlight),
        6px 6px 0 rgba(0, 0, 0, .22);
    }
    .rail-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    .rail h2 { margin: 0; color: #ffffff; font-size: 17px; letter-spacing: 0; text-shadow: 1px 1px 0 #000; }
    .rail .sub { max-width: 250px; line-height: 1.35; }
    .station-link {
      color: #bfeeff;
      font-family: var(--mono);
      font-size: 11px;
      text-decoration: none;
    }
    .station-link:hover { color: #ffffff; text-decoration: underline; }
    .rail-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .endpoint-settings {
      width: 24px;
      height: 24px;
      border: 1px solid #30364e;
      border-right-color: #07080d;
      border-bottom-color: #07080d;
      border-radius: 3px;
      background: #11131a;
      color: #ffbdd4;
      display: grid;
      place-items: center;
      cursor: pointer;
      padding: 0;
    }
    .endpoint-settings svg {
      width: 15px;
      height: 15px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .endpoint-settings[aria-expanded="true"] {
      background: #ffbdd4;
      color: #201014;
      border-color: #ffd3e1 #64243c #64243c #ffd3e1;
    }
    .legend {
      display: flex;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      margin: 12px 0 16px;
      padding: 7px;
      border: 1px solid rgba(143,151,232,.3);
      background: rgba(16, 17, 24, .58);
      border-radius: 4px;
    }
    .legend span { display: inline-flex; align-items: center; gap: 5px; }
    .swatch { width: 10px; height: 10px; border-radius: 2px; background: var(--other); }
    .swatch.m { background: var(--milady); }
    .swatch.e { background: transparent; border: 1px solid #3d464b; }
    .endpoint-panel {
      display: none;
      border: 1px solid rgba(255, 189, 212, .48);
      border-right-color: rgba(100, 36, 60, .72);
      border-bottom-color: rgba(100, 36, 60, .72);
      border-radius: 4px;
      background: linear-gradient(135deg, rgba(255, 189, 212, .13), rgba(16, 17, 24, .9));
      padding: 10px;
      margin: -6px 0 12px;
      color: #f4f1f7;
      font-size: 12px;
      line-height: 1.35;
    }
    .endpoint-panel.is-visible {
      display: grid;
      gap: 8px;
    }
    .endpoint-panel strong {
      color: #ffffff;
      font-size: 12px;
      font-weight: 900;
      text-shadow: 1px 1px 0 #000;
    }
    .endpoint-panel p {
      margin: 0;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .endpoint-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
    }
    .endpoint-fields {
      display: grid;
      gap: 7px;
    }
    .endpoint-fields label {
      display: grid;
      gap: 3px;
      color: #ffbdd4;
      font: 900 10px/1 var(--mono);
      text-transform: uppercase;
    }
    .endpoint-input {
      min-width: 0;
      height: 26px;
      border: 1px solid #30364e;
      border-right-color: #07080d;
      border-bottom-color: #07080d;
      border-radius: 3px;
      background: #080a10;
      color: #d7dbff;
      font: 700 10px/1 var(--mono);
      padding: 0 7px;
      outline: none;
    }
    .endpoint-input::placeholder {
      color: rgba(244, 241, 247, .46);
    }
    .endpoint-apply {
      min-height: 28px;
      border: 1px solid #bfeeff;
      border-right-color: #285163;
      border-bottom-color: #285163;
      border-radius: 3px;
      background: #bfeeff;
      color: #102633;
      font: 900 10px/1 var(--mono);
      padding: 0 8px;
      cursor: pointer;
    }
    .endpoint-preset {
      min-height: 28px;
      border: 1px solid #ffd3e1;
      border-right-color: #64243c;
      border-bottom-color: #64243c;
      border-radius: 3px;
      background: #ffbdd4;
      color: #201014;
      font: 900 10px/1 var(--mono);
      padding: 0 8px;
      cursor: pointer;
    }
    .endpoint-preset.is-active {
      background: #bfeeff;
      border-color: #e6fbff #285163 #285163 #e6fbff;
    }
    .slot {
      border: 2px solid #3c425f;
      border-right-color: #090a10;
      border-bottom-color: #090a10;
      background:
        linear-gradient(135deg, rgba(143, 151, 232, .08), rgba(17, 19, 26, .96)),
        #11131a;
      border-radius: 6px;
      padding: 11px;
      margin-bottom: 10px;
      box-shadow: inset 1px 1px 0 rgba(255,255,255,.07);
    }
    #slots {
      min-height: 0;
      max-height: none;
      overflow-y: auto;
      overflow-x: hidden;
      padding-right: 4px;
      margin-right: -2px;
      scrollbar-width: thin;
    }
    .rail.resizing,
    .rail.resizing * {
      user-select: none;
    }
    .slot-top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 13px;
    }
    .slot-top strong, .slot-link { color: #f8d5e3; font-family: var(--mono); font-size: 13px; font-weight: 900; text-decoration: none; }
    .slot-link:hover, .slot-link:focus-visible { color: #9ff5d7; text-decoration: underline; outline: none; }
    .slot-top span { color: var(--muted); }
    .slot-time {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
    }
    .slot-time span {
      min-width: 0;
    }
    .slot-time strong {
      color: #d7dbff;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 700;
    }
    .blob-grid {
      display: grid;
      grid-template-columns: repeat(21, minmax(7px, 1fr));
      gap: 3px;
      min-height: 20px;
    }
    .blob-cell {
      height: 20px;
      border: 1px solid #30364e;
      border-right-color: #07080d;
      border-bottom-color: #07080d;
      background: #0f1118;
      border-radius: 2px;
      display: grid;
      place-items: center;
      color: #111;
      font-size: 10px;
      font-weight: 900;
      line-height: 1;
      box-shadow: inset 1px 1px 0 rgba(255,255,255,.05);
      text-decoration: none;
    }
    .blob-cell[href], .slot-jump, .segment-jump { cursor: pointer; }
    .blob-cell[href]:hover { filter: brightness(1.18); transform: translateY(-1px); }
    .blob-cell.other { background: var(--other); border-color: #aab0ca #33384c #33384c #aab0ca; color: #101315; }
    .blob-cell.milady { background: var(--milady); border-color: #ffd3e1 #64243c #64243c #ffd3e1; color: #201014; }
    .slot-jump, .segment-jump {
      border: 1px solid #ffd3e1;
      border-right-color: #64243c;
      border-bottom-color: #64243c;
      border-radius: 3px;
      background: #ffbdd4;
      color: #201014;
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 900;
      padding: 3px 6px;
      box-shadow: inset 1px 1px 0 rgba(255,255,255,.5);
    }
    .slot-jump[disabled], .segment-jump[disabled] {
      cursor: not-allowed;
      opacity: .45;
      filter: grayscale(.4);
    }
    .slot-jump:active, .segment-jump:active {
      border-color: #64243c #ffd3e1 #ffd3e1 #64243c;
      box-shadow: inset 1px 1px 0 rgba(0,0,0,.35);
      transform: translate(1px, 1px);
    }
    .slot-error { color: var(--bad); font-size: 12px; margin-top: 8px; overflow-wrap: anywhere; }
    .segments {
      position: relative;
      margin-top: 0;
      border: 2px solid var(--line);
      border-right-color: var(--line-dark);
      border-bottom-color: var(--line-dark);
      border-radius: 6px;
      overflow: hidden;
      background: #11131a;
      min-height: 176px;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
    }
    .segments::before {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      top: -6px;
      height: 12px;
      cursor: ns-resize;
      z-index: 3;
    }
    .segments:hover {
      border-top-color: #ffbdd4;
    }
    .segments-title {
      padding: 8px 12px 6px;
      color: #ffffff;
      font-size: 13px;
      font-weight: 900;
      text-shadow: 1px 1px 0 #000;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: center;
    }
    .segments-title > span {
      white-space: nowrap;
    }
    .explorer-jump {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 5px;
      min-width: 0;
    }
    .explorer-input {
      min-width: 0;
      height: 24px;
      border: 1px solid #30364e;
      border-right-color: #07080d;
      border-bottom-color: #07080d;
      border-radius: 3px;
      background: #080a10;
      color: #d7dbff;
      font: 700 10px/1 var(--mono);
      padding: 0 7px;
      outline: none;
    }
    .explorer-input::placeholder {
      color: rgba(244, 241, 247, .46);
    }
    .explorer-input[aria-invalid="true"] {
      border-color: #ff6f9f;
    }
    .explorer-watch {
      height: 24px;
      border: 1px solid #ffd3e1;
      border-right-color: #64243c;
      border-bottom-color: #64243c;
      border-radius: 3px;
      background: #ffbdd4;
      color: #201014;
      font: 900 10px/1 var(--mono);
      padding: 0 7px;
      cursor: pointer;
    }
    .explorer-message {
      grid-column: 1 / -1;
      min-height: 18px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .explorer-message.is-error { color: var(--bad); }
    .explorer-message.is-ok { color: #9ff5d7; }
    #segments {
      min-height: 0;
      overflow-y: auto;
    }
    .segments-head {
      display: grid;
      grid-template-columns: 46px 86px minmax(0, 1fr) 58px 52px;
      gap: 10px;
      padding: 8px 12px;
      border-bottom: 1px solid #30364e;
      color: #ffbdd4;
      font-family: var(--mono);
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .segment-row {
      display: grid;
      grid-template-columns: 46px 86px minmax(0, 1fr) 58px 52px;
      gap: 10px;
      align-items: center;
      padding: 10px 12px;
      border-top: 1px solid #30364e;
      font-size: 13px;
    }
    .segment-row:first-child { border-top: 0; }
    .segment-row.current { background: #2b2140; box-shadow: inset 4px 0 0 var(--milady); }
    .segment-row .empty { grid-column: 1 / -1; }
    .segment-row.empty-row {
      min-height: 42px;
      color: var(--muted);
    }
    .segment-row.empty-row span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    code, .tx-link {
      min-width: 0;
      color: #bfeeff;
      font-family: var(--mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tx-link {
      display: block;
      text-decoration: none;
    }
    .tx-link:hover {
      color: #ffffff;
      text-decoration: underline;
    }
    body.light .topbar {
      color: #1b1924;
      box-shadow: inset 2px 2px 0 rgba(255,255,255,.75), 4px 4px 0 rgba(68, 60, 92, .12);
    }
    body.light h1 { color: #1b1924; text-shadow: none; }
    body.light .sub { color: rgba(31, 29, 42, .72); }
    body.light .mark {
      background: #f7f4fa;
      color: #35305b;
      border-color: #fff #6f688c #6f688c #fff;
    }
    body.light .rail,
    body.light .player-shell {
      background:
        linear-gradient(180deg, rgba(85, 95, 193, .08), rgba(255,255,255,0) 90px),
        #f8f6fb;
      box-shadow: inset 1px 1px 0 rgba(255,255,255,.75), 4px 4px 0 rgba(68, 60, 92, .12);
    }
    body.light .rail h2 {
      color: #201b33;
      text-shadow: none;
    }
    body.light .rail .sub,
    body.light .legend,
    body.light .endpoint-panel p,
    body.light .slot-top span,
    body.light .slot-time {
      color: rgba(31, 29, 42, .72);
    }
    body.light .station-link,
    body.light .tx-link,
    body.light code {
      color: #145f80;
    }
    body.light .station-link:hover,
    body.light .tx-link:hover {
      color: #201b33;
    }
    body.light .legend,
    body.light .endpoint-panel,
    body.light .metric {
      border-color: rgba(85, 95, 193, .28);
      background: rgba(255, 255, 255, .68);
    }
    body.light .endpoint-panel strong {
      color: #201b33;
      text-shadow: none;
    }
    body.light .slot,
    body.light .segments {
      color: #201b33;
      background:
        linear-gradient(135deg, rgba(255, 255, 255, .78), rgba(238, 234, 246, .94)),
        #f8f6fb;
      border-color: #b9b3d2 #6f688c #6f688c #ffffff;
      box-shadow: inset 1px 1px 0 rgba(255,255,255,.85);
    }
    body.light .slot-top strong,
    body.light .slot-time strong,
    body.light .segments-head,
    body.light .segments-title,
    body.light .metric label {
      color: #8a2452;
    }
    body.light .segments-title {
      text-shadow: none;
    }
    body.light .explorer-input {
      background: #ffffff;
      color: #201b33;
      border-color: #b9b3d2 #6f688c #6f688c #ffffff;
    }
    body.light .endpoint-input {
      background: #ffffff;
      color: #201b33;
      border-color: #b9b3d2 #6f688c #6f688c #ffffff;
    }
    body.light .explorer-input::placeholder {
      color: rgba(31, 29, 42, .52);
    }
    body.light .blob-cell {
      background: #e4dfec;
      border-color: #b9b3d2 #6f688c #6f688c #ffffff;
    }
    body.light .blob-cell.other {
      background: #8d94ae;
      border-color: #b6bdd4 #4e556f #4e556f #eef0f7;
    }
    body.light .blob-cell.milady {
      background: #ff8fb3;
      border-color: #ffd6e5 #8f3b5d #8f3b5d #ffffff;
    }
    body.light .segments-head,
    body.light .segment-row {
      color: #201b33;
      border-color: rgba(85, 95, 193, .24);
    }
    body.light .segment-row.current {
      background: #f5deeb;
    }
    body.light .metric strong,
    body.light .now strong {
      color: #201b33;
      text-shadow: none;
    }
    body.light .now span { color: rgba(31, 29, 42, .72); }
    body.light .controls {
      background:
        linear-gradient(180deg, rgba(85, 95, 193, .08), rgba(255,255,255,0)),
        #eeeaf5;
    }
    .muted { color: var(--muted); }
    @media (max-width: 980px) {
      body { overflow: auto; }
      .app {
        height: auto;
        min-height: 100vh;
        grid-template-columns: 1fr;
        overflow: visible;
      }
      .stage { overflow: visible; }
      .rail { max-height: none; }
      #slots { max-height: min(44vh, 520px); }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .app { padding: 10px; }
      video {
        width: 100%;
        height: auto;
        max-height: none;
      }
    }
    @media (max-width: 560px) {
      .topbar, .controls { grid-template-columns: 1fr; display: grid; }
      .status-pill { width: 100%; justify-content: center; }
      .metrics { grid-template-columns: 1fr; }
      .segments-title { grid-template-columns: 1fr; }
      .segment-row { grid-template-columns: 52px 1fr; }
      .segment-row code, .segment-row .tx-link { grid-column: 1 / -1; }
    }
  </style>
</head>
<body class="state-offline">
  <main class="app">
    <section class="stage">
      <header class="topbar">
        <div class="brand">
          <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Switch to light mode" title="Switch theme"></button>
          <button class="network-toggle" id="network-toggle" type="button" aria-label="Switch blob feed network">
            <span class="eth">ETH</span><span class="sep">SEP</span>
          </button>
          <div>
            <h1>Radio Free Ethereum</h1>
            <div class="sub">Milady stream tuned through live Ethereum blobspace</div>
          </div>
        </div>
        <div class="top-status">
          <div class="status-pill"><span class="status-dot"></span><span id="status">offline</span></div>
          <div class="utc-clock" id="utc-clock">--:--:-- UTC</div>
        </div>
      </header>

      <section class="player-shell">
        <div class="video-wrap">
          <video id="video" controls autoplay muted playsinline></video>
          <div class="video-overlay" id="overlay">
            <div class="tune-card">
              <h2 class="tune-title" id="overlay-title">Tuning Ethereum blobspace</h2>
              <p class="tune-copy" id="overlay-copy">The tuner is waiting for segment announcements, then it will fetch blob sidecars from the beacon API and reconstruct AV1/WebM bytes.</p>
            </div>
          </div>
        </div>
        <div class="controls">
          <div class="now">
            <strong id="now-title">Waiting for stream segments</strong>
            <span id="now-detail">Execution RPC announces segments; beacon sidecars carry the bytes.</span>
          </div>
          <div class="btns">
            <button class="icon-btn live-btn is-live" id="go-live" type="button" title="Return to live stream">LIVE</button>
            <button class="icon-btn loop-btn" id="loop-toggle" type="button" title="Loop replay queue" aria-pressed="false">LOOP</button>
            <button class="icon-btn" id="refresh" type="button" title="Refresh" aria-label="Refresh stream">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12a9 9 0 0 1-15.1 6.6" />
                <path d="M3 12A9 9 0 0 1 18.1 5.4" />
                <path d="M18 2v4h4" />
                <path d="M6 22v-4H2" />
              </svg>
            </button>
            <button class="icon-btn" id="mute" type="button" title="Toggle mute" aria-label="Toggle mute"></button>
            <input class="volume-slider" id="volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume" />
          </div>
        </div>
      </section>

      <section class="metrics" aria-label="stream metrics">
        <div class="metric"><label>Segment</label><strong id="metric-segment">-</strong></div>
        <div class="metric"><label>Payload</label><strong id="metric-payload">-</strong></div>
        <div class="metric"><label>Blobs</label><strong id="metric-blobs">-</strong></div>
        <div class="metric"><label>Latency</label><strong id="metric-latency">-</strong></div>
        <div class="metric"><label>Fetch / Decode</label><strong id="metric-timing">-</strong></div>
      </section>
    </section>

    <aside class="rail">
      <div class="rail-head">
        <div>
          <h2>Blobspace Feed</h2>
          <div class="sub" id="rail-mode">Watching recent slots for blob sidecars.</div>
        </div>
        <div class="rail-actions">
          <a class="station-link" id="station-link" href="${networkContext(defaultNetwork).explorerBase}/address/${networkContext(defaultNetwork).stationAddress || canonicalStationAddress}" target="_blank" rel="noopener noreferrer">Station</a>
          <button class="endpoint-settings" id="endpoint-settings" type="button" aria-label="Endpoint settings" aria-expanded="false" title="Endpoint settings">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 1 1 4.2 17l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 1 1 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
            </svg>
          </button>
        </div>
      </div>
      <div class="legend">
        <span><i class="swatch m"></i> Station/Milady</span>
        <span><i class="swatch"></i> other blob</span>
        <span><i class="swatch e"></i> unused</span>
      </div>
      <div class="endpoint-panel" id="endpoint-panel" aria-live="polite">
        <strong id="endpoint-title">Blobspace endpoints missing</strong>
        <p id="endpoint-copy">Use a preset to fill the execution RPC and beacon API for this viewer.</p>
        <div class="endpoint-actions">
          <button class="endpoint-preset" type="button" data-network="sepolia" data-preset="public">Use Sepolia Preset</button>
          <button class="endpoint-preset" type="button" data-network="mainnet" data-preset="public">Use Mainnet Preset</button>
        </div>
        <div class="endpoint-fields">
          <label>Execution RPC
            <input class="endpoint-input" id="endpoint-execution" type="url" autocomplete="off" spellcheck="false" placeholder="https://sepolia.drpc.org" />
          </label>
          <label>Beacon API
            <input class="endpoint-input" id="endpoint-beacon" type="url" autocomplete="off" spellcheck="false" placeholder="https://ethereum-sepolia-beacon-api.publicnode.com" />
          </label>
          <button class="endpoint-apply" id="endpoint-apply" type="button">Apply Endpoints</button>
        </div>
      </div>
      <div id="slots" aria-label="recent blob slots"></div>
      <div class="segments" aria-label="station segment arrivals">
        <div class="segments-title">
          <span>Stream Segments</span>
          <div class="explorer-jump">
            <input class="explorer-input" id="explorer-input" type="text" autocomplete="off" spellcheck="false" placeholder="Paste tx URL, hash, or block" aria-label="Paste block explorer transaction or block" />
            <button class="explorer-watch" id="explorer-watch" type="button">WATCH</button>
          </div>
          <div class="explorer-message" id="explorer-message" aria-live="polite"></div>
        </div>
        <div class="segments-head"><span>Seq</span><span>Arrived</span><span>Tx</span><span>Blobs</span><span>Play</span></div>
        <div id="segments"></div>
      </div>
    </aside>
  </main>

  <script>
    const initialParams = new URLSearchParams(window.location.search)
    let streamId = initialParams.get('streamId') || ${JSON.stringify(streamId)}
    let selectedNetwork = (initialParams.get('network') || ${JSON.stringify(defaultNetwork)}).toLowerCase() === 'mainnet' ? 'mainnet' : 'sepolia'
    let endpointPreset = initialParams.get('endpointPreset') === 'public' ? 'public' : ''
    let customExecutionRpc = initialParams.get('ethRpcUrl') || ''
    let customBeaconRpc = initialParams.get('beaconRpcUrl') || ''
    let explorerBase = selectedNetwork === 'mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io'
    const endpointPresets = ${JSON.stringify(endpointPresets)}
    const startBuffer = 0
    const segmentTimeoutMs = 150_000
    const pollMs = ${viewerPollMs}
    const video = document.querySelector('#video')
    const statusEl = document.querySelector('#status')
    const overlay = document.querySelector('#overlay')
    let suppressPlayerOverlay = streamId.startsWith('rfe-baked-')
    const overlayTitle = document.querySelector('#overlay-title')
    const overlayCopy = document.querySelector('#overlay-copy')
    const nowTitle = document.querySelector('#now-title')
    const nowDetail = document.querySelector('#now-detail')
    const goLive = document.querySelector('#go-live')
    const loopToggle = document.querySelector('#loop-toggle')
    const refresh = document.querySelector('#refresh')
    const mute = document.querySelector('#mute')
    const volume = document.querySelector('#volume')
    const utcClockEl = document.querySelector('#utc-clock')
    const slotsEl = document.querySelector('#slots')
    const segmentsEl = document.querySelector('#segments')
    const segmentsPanel = document.querySelector('.segments')
    const rail = document.querySelector('.rail')
    const railMode = document.querySelector('#rail-mode')
    const explorerInput = document.querySelector('#explorer-input')
    const explorerWatch = document.querySelector('#explorer-watch')
    const explorerMessage = document.querySelector('#explorer-message')
    const themeToggle = document.querySelector('#theme-toggle')
    const networkToggle = document.querySelector('#network-toggle')
    const stationLink = document.querySelector('#station-link')
    const endpointSettings = document.querySelector('#endpoint-settings')
    const endpointPanel = document.querySelector('#endpoint-panel')
    const endpointTitle = document.querySelector('#endpoint-title')
    const endpointCopy = document.querySelector('#endpoint-copy')
    const endpointExecution = document.querySelector('#endpoint-execution')
    const endpointBeacon = document.querySelector('#endpoint-beacon')
    const endpointApply = document.querySelector('#endpoint-apply')
    const sunIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></svg>'
    const moonIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>'
    const volumeOnIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15 9.5a4 4 0 0 1 0 5" /><path d="M18 6.5a8 8 0 0 1 0 11" /></svg>'
    const volumeOffIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="m16 10 5 5" /><path d="m21 10-5 5" /></svg>'
    const renderMuteIcon = () => {
      mute.innerHTML = video.muted ? volumeOffIcon : volumeOnIcon
      mute.setAttribute('aria-pressed', video.muted ? 'true' : 'false')
      mute.title = video.muted ? 'Unmute' : 'Mute'
      volume.disabled = video.muted
    }
    const metrics = {
      segment: document.querySelector('#metric-segment'),
      payload: document.querySelector('#metric-payload'),
      blobs: document.querySelector('#metric-blobs'),
      latency: document.querySelector('#metric-latency'),
      timing: document.querySelector('#metric-timing'),
    }

    let segments = []
    let playable = new Map()
    let preparing = new Map()
    let currentIndex = -1
    let fetchTimings = new Map()
    let decodeTimings = new Map()
    let lastEventAt = 0
    let state = 'offline'
    let polling = false
    let blobSignal = { count: 0, latestSlot: null }
    let liveMode = true
    let loopReplay = false
    let refreshSpinTimer = null
    let endpointSettingsOpen = false
    const segmentsPaneHeightKey = 'rfe-segments-pane-height'
    let lastBlobspaceUpdateAt = 0

    const fmtBytes = (bytes) => bytes ? (bytes / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' KB' : '-'
    const fmtMs = (ms) => Number.isFinite(ms) ? Math.round(ms) + ' ms' : '-'
    const shortHash = (hash) => hash ? hash.slice(0, 10) + '...' + hash.slice(-6) : '-'
    const displaySeq = (sequence) => Number(sequence) + 1
    const blobLabel = (count) => count + ' ' + (Number(count) === 1 ? 'blob' : 'blobs')
    const txUrl = (hash) => hash ? explorerBase + '/tx/' + encodeURIComponent(hash) : ''
    const slotUrl = (slot) => {
      const base = selectedNetwork === 'mainnet' ? 'https://beaconscan.com/slot/' : 'https://sepolia.beaconcha.in/slot/'
      return base + encodeURIComponent(slot)
    }
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]))
    const publicErrorMessage = (error) => String(error?.message || error || 'Request failed').replace(/https?:\\/\\/[^\\s"'<>)}\\]]+/g, '[redacted endpoint]')

    function updateUtcClock() {
      utcClockEl.textContent = new Date().toISOString().slice(11, 19) + ' UTC'
    }

    function setExplorerMessage(message = '', kind = '') {
      explorerMessage.textContent = message
      explorerMessage.classList.toggle('is-error', kind === 'error')
      explorerMessage.classList.toggle('is-ok', kind === 'ok')
    }

    function setNetworkToggle() {
      networkToggle.classList.toggle('is-sepolia', selectedNetwork === 'sepolia')
      networkToggle.setAttribute('aria-pressed', selectedNetwork === 'sepolia' ? 'true' : 'false')
      networkToggle.title = selectedNetwork === 'mainnet' ? 'Watching Mainnet blobs' : 'Watching Sepolia blobs'
    }

    function apiUrl(path) {
      const params = new URLSearchParams()
      params.set('network', selectedNetwork)
      if (endpointPreset) params.set('endpointPreset', endpointPreset)
      return path + (path.includes('?') ? '&' : '?') + params.toString()
    }

    function updateLocation() {
      const params = new URLSearchParams()
      if (streamId) params.set('streamId', streamId)
      params.set('network', selectedNetwork)
      if (endpointPreset) params.set('endpointPreset', endpointPreset)
      history.replaceState(null, '', '?' + params.toString())
    }

    function setNetwork(nextNetwork) {
      selectedNetwork = nextNetwork === 'mainnet' ? 'mainnet' : 'sepolia'
      explorerBase = selectedNetwork === 'mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io'
      setNetworkToggle()
      updateLocation()
      segments = []
      playable = new Map()
      preparing = new Map()
      fetchTimings = new Map()
      decodeTimings = new Map()
      currentIndex = -1
      liveMode = true
      blackoutVideo()
      renderSegments()
      setState('buffering', 'Switching blob feed', 'Changing the execution and beacon RPC targets to ' + (selectedNetwork === 'mainnet' ? 'Mainnet' : 'Sepolia') + '.')
      void poll(true)
    }

    function presetEndpoints(network = selectedNetwork, preset = endpointPreset) {
      return preset ? endpointPresets[preset]?.networks?.[network] || null : null
    }

    function syncEndpointInputs() {
      const preset = presetEndpoints()
      endpointExecution.value = customExecutionRpc || preset?.executionRpc || ''
      endpointBeacon.value = customBeaconRpc || preset?.beaconApi || ''
    }

    function resetForEndpointChange(title, detail) {
      setNetworkToggle()
      updateLocation()
      syncEndpointInputs()
      segments = []
      playable = new Map()
      preparing = new Map()
      fetchTimings = new Map()
      decodeTimings = new Map()
      currentIndex = -1
      liveMode = true
      blackoutVideo()
      renderSegments()
      setState('buffering', title, detail)
      void poll(true)
    }

    function renderEndpointPanel(blobspace = {}) {
      const missingExecution = blobspace.executionRpcConfigured === false
      const missingBeacon = blobspace.beaconApiConfigured === false
      const needsSetup = blobspace.mode !== 'live' && blobspace.presetAvailable && (missingExecution || missingBeacon || Boolean(blobspace.warning))
      const shouldShow = endpointSettingsOpen || needsSetup
      endpointPanel.classList.toggle('is-visible', shouldShow)
      endpointSettings.setAttribute('aria-expanded', shouldShow ? 'true' : 'false')
      if (!shouldShow) return
      const networkLabel = blobspace.networkLabel || (selectedNetwork === 'mainnet' ? 'Mainnet' : 'Sepolia')
      const missing = [
        missingExecution ? 'execution RPC' : '',
        missingBeacon ? 'beacon API' : '',
      ].filter(Boolean).join(' and ')
      endpointTitle.textContent = missing ? networkLabel + ' ' + missing + ' missing' : networkLabel + ' blobspace feed needs endpoints'
      const active = blobspace.endpointPresetLabel ? ' Active preset: ' + blobspace.endpointPresetLabel + '.' : ''
      endpointCopy.textContent = (blobspace.warning || 'Use a preset to fetch live blob sidecars from the viewer without editing .env.') + active
      syncEndpointInputs()
      endpointPanel.querySelectorAll('.endpoint-preset').forEach((button) => {
        const isActive = button.dataset.network === selectedNetwork && button.dataset.preset === endpointPreset
        button.classList.toggle('is-active', isActive)
        button.textContent = isActive
          ? (button.dataset.network === 'mainnet' ? 'Mainnet Preset Active' : 'Sepolia Preset Active')
          : (button.dataset.network === 'mainnet' ? 'Use Mainnet Preset' : 'Use Sepolia Preset')
      })
    }

    function endpointLabel(network = selectedNetwork, preset = endpointPreset) {
      const configured = presetEndpoints(network, preset)
      if (!configured) return ''
      return endpointPresets[preset]?.label || preset
    }

    function setEndpointPreset(nextPreset, nextNetwork = selectedNetwork) {
      endpointSettingsOpen = true
      selectedNetwork = nextNetwork === 'mainnet' ? 'mainnet' : 'sepolia'
      endpointPreset = presetEndpoints(selectedNetwork, nextPreset) ? nextPreset : ''
      customExecutionRpc = ''
      customBeaconRpc = ''
      explorerBase = selectedNetwork === 'mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io'
      const label = endpointLabel()
      resetForEndpointChange('Applying endpoint preset', label ? 'Using ' + label + ' for ' + (selectedNetwork === 'mainnet' ? 'Mainnet' : 'Sepolia') + ' execution and beacon reads.' : 'Returning to environment-configured endpoints.')
    }

    function applyEndpointInputs() {
      endpointSettingsOpen = true
      customExecutionRpc = endpointExecution.value.trim()
      customBeaconRpc = endpointBeacon.value.trim()
      endpointPreset = ''
      resetForEndpointChange('Applying custom endpoints', 'Using the entered execution RPC and beacon API for live blob reads.')
    }

    function setTheme(theme) {
      const light = theme === 'light'
      document.body.classList.toggle('light', light)
      themeToggle.innerHTML = light ? moonIcon : sunIcon
      themeToggle.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode')
      themeToggle.title = light ? 'Dark mode' : 'Light mode'
      try { localStorage.setItem('rfe-theme', light ? 'light' : 'dark') } catch {}
    }

    function initTheme() {
      let saved = ''
      try { saved = localStorage.getItem('rfe-theme') || '' } catch {}
      setTheme(saved === 'light' ? 'light' : 'dark')
    }

    let localSlotTime = null
    let localSegmentTime = null
    try {
      localSlotTime = new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      })
      localSegmentTime = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      })
    } catch {}
    const utcSegmentTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    const utcSlotTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })

    function slotTimeMarkup(timestampMs, action = '') {
      if (!timestampMs) return '<div class="slot-time"><span>Time unavailable</span>' + action + '</div>'
      const when = new Date(Number(timestampMs))
      let label = 'Local'
      let value = ''
      try {
        value = localSlotTime ? localSlotTime.format(when) : ''
      } catch {}
      if (!value) {
        label = 'UTC'
        value = utcSlotTime.format(when) + ' UTC'
      }
      return '<div class="slot-time">' +
        '<span><strong>' + label + '</strong> ' + value + '</span>' +
        action +
      '</div>'
    }

    function segmentTimeText(createdAt) {
      const t = Date.parse(createdAt || '')
      if (!Number.isFinite(t)) return '--:--:--'
      const when = new Date(t)
      try {
        if (localSegmentTime) return localSegmentTime.format(when)
      } catch {}
      return utcSegmentTime.format(when)
    }

    function setState(next, title, copy) {
      state = next
      document.body.classList.remove('state-offline', 'state-buffering', 'state-live', 'state-lagging', 'state-interrupted', 'state-replay')
      document.body.classList.add('state-' + next)
      statusEl.textContent = next
      overlay.classList.toggle('hidden', suppressPlayerOverlay || (next === 'live' && !video.paused))
      if (title) overlayTitle.textContent = title
      if (copy) overlayCopy.textContent = copy
      if (next !== 'live' && next !== 'replay') blackoutVideo()
    }

    function recentEnough(segment) {
      if (!segment) return false
      const t = Date.parse(segment.createdAt || '')
      if (!Number.isFinite(t)) return false
      return Date.now() - t < segmentTimeoutMs
    }

    async function fetchJson(path) {
      const response = await fetch(path, { cache: 'no-store' })
      if (!response.ok) throw new Error(await response.text())
      return response.json()
    }

    function liveResponseSegments(data) {
      if (!data || typeof data !== 'object' || !Array.isArray(data.segments)) {
        throw new Error('Live response segments must be an array')
      }
      return data.segments
    }

    async function prepareSegment(segment) {
      if (playable.has(segment.sequence)) return playable.get(segment.sequence)
      if (preparing.has(segment.sequence)) return preparing.get(segment.sequence)
      const pending = (async () => {
      const started = performance.now()
      const response = await fetch(apiUrl(segment.gatewayUrl), { cache: 'no-store' })
      fetchTimings.set(segment.sequence, performance.now() - started)
      if (!response.ok) throw new Error(await response.text())
      const decodeStarted = performance.now()
      const blob = await response.blob()
      decodeTimings.set(segment.sequence, performance.now() - decodeStarted)
      const objectUrl = URL.createObjectURL(blob)
      const ready = { ...segment, objectUrl }
      playable.set(segment.sequence, ready)
      return ready
      })().finally(() => {
        preparing.delete(segment.sequence)
      })
      preparing.set(segment.sequence, pending)
      return pending
    }

    function prefetchAround(index, ahead = 2) {
      const nextSegments = segments.slice(index + 1, index + 1 + ahead)
      void Promise.allSettled(nextSegments.map(prepareSegment)).then(renderSegments)
    }

    function liveTargetIndex() {
      return Math.max(0, segments.length - Math.max(1, startBuffer))
    }

    function liveBufferSegments() {
      if (!segments.length) return []
      const start = Math.max(0, liveTargetIndex() - 1)
      return segments.slice(start)
    }

    async function fillBuffer() {
      const candidates = liveMode ? liveBufferSegments() : segments.slice(0, Math.max(startBuffer + 1, 3))
      await Promise.allSettled(candidates.map(prepareSegment))
    }

    function updateMetrics(segment) {
      metrics.segment.textContent = segment ? '#' + displaySeq(segment.sequence) : '-'
      metrics.payload.textContent = segment ? fmtBytes(segment.payloadBytes) : '-'
      metrics.blobs.textContent = segment ? segment.blobCount + ' / 21' : '-'
      if (segment?.createdAt) {
        const age = Math.max(0, Date.now() - Date.parse(segment.createdAt))
        metrics.latency.textContent = Math.round(age / 1000) + ' s'
      } else {
        metrics.latency.textContent = '-'
      }
      const fetchMs = segment ? fetchTimings.get(segment.sequence) : undefined
      const decodeMs = segment ? decodeTimings.get(segment.sequence) : undefined
      metrics.timing.textContent = fmtMs(fetchMs) + ' / ' + fmtMs(decodeMs)
    }

    function blackoutVideo() {
      video.pause()
      video.srcObject = null
      video.removeAttribute('src')
      video.src = ''
      video.load()
    }

    function setLiveButton() {
      goLive.classList.toggle('is-live', liveMode)
      video.loop = loopReplay && !liveMode
    }

    function setLoopButton() {
      loopToggle.classList.toggle('is-on', loopReplay)
      loopToggle.setAttribute('aria-pressed', loopReplay ? 'true' : 'false')
      loopToggle.title = loopReplay ? 'Replay loop on' : 'Loop replay segment'
      video.loop = loopReplay && !liveMode
    }

    function playReady(index, ready, mode) {
      currentIndex = index
      video.src = ready.objectUrl
      video.play().catch(() => {})
      setState(mode === 'replay' ? 'replay' : 'live')
      nowTitle.textContent = ready.streamId + ' - seq #' + displaySeq(ready.sequence)
      nowDetail.textContent = fmtBytes(ready.payloadBytes) + ' - ' + blobLabel(ready.blobCount) + ' - ' + shortHash(ready.txHash)
      updateMetrics(ready)
      renderSegments()
      prefetchAround(index)
      setLiveButton()
      video.loop = loopReplay && mode === 'replay'
    }

    async function jumpToSequence(sequence) {
      const index = segments.findIndex((segment) => Number(segment.sequence) === Number(sequence))
      if (index === -1) return
      liveMode = false
      setLiveButton()
      const segment = segments[index]
      nowTitle.textContent = segment.streamId + ' - loading seq #' + displaySeq(segment.sequence)
      nowDetail.textContent = fmtBytes(segment.payloadBytes) + ' - ' + blobLabel(segment.blobCount) + ' - ' + shortHash(segment.txHash)
      setState('buffering', 'Loading blob replay', 'Fetching this historical blob segment from Ethereum sidecars.')
      updateMetrics(segment)
      const ready = await prepareSegment(segment)
      playReady(index, ready, 'replay')
    }

    async function tuneStreamAndJump(nextStreamId, sequence) {
      if (!nextStreamId) return
      if (nextStreamId !== streamId) {
        streamId = nextStreamId
        suppressPlayerOverlay = streamId.startsWith('rfe-baked-')
        updateLocation()
        segments = []
        playable = new Map()
        preparing = new Map()
        fetchTimings = new Map()
        decodeTimings = new Map()
        currentIndex = -1
        blackoutVideo()
        renderSegments()
      }
      nowTitle.textContent = 'Tuning ' + streamId
      nowDetail.textContent = sequence != null
        ? 'Fetching stream playlist, then jumping to seq #' + displaySeq(sequence) + '.'
        : 'Fetching stream playlist from Station events.'
      setState('buffering', 'Tuning stream from blobspace', 'The feed found this stream id from blob metadata and is loading its canonical sequence playlist.')
      await poll(true)
      if (sequence != null && sequence !== '') await jumpToSequence(sequence)
    }

    function findSegmentFromExplorerText(value, candidates = segments) {
      const text = String(value || '').trim()
      if (!text) return null
      const hash = text.match(/0x[a-fA-F0-9]{64}/)?.[0]?.toLowerCase()
      if (hash) {
        const byTx = candidates.find((segment) =>
          String(segment.txHash || segment.transactionHash || '').toLowerCase() === hash
        )
        if (byTx) return byTx
        return candidates.find((segment) =>
          String(segment.blockHash || segment.proof?.block?.hash || '').toLowerCase() === hash
        ) || candidates.find((segment) =>
          (segment.blobVersionedHashes || []).some((versionedHash) => String(versionedHash).toLowerCase() === hash)
        ) || null
      }
      const blockNumber = text.match(/(?:\\/block\\/|block(?:number)?[=:\\s]+)(\\d+)/i)?.[1] ||
        (/^\\d{5,}$/.test(text) ? text : '')
      if (blockNumber) {
        return candidates.find((segment) =>
          String(segment.blockNumber || segment.proof?.block?.number || '') === blockNumber
        ) || null
      }
      return null
    }

    async function lookupStationSegment(value) {
      const params = new URLSearchParams()
      params.set('value', value)
      params.set('network', selectedNetwork)
      if (endpointPreset) params.set('endpointPreset', endpointPreset)
      const response = await fetch('/api/station/lookup?' + params.toString(), { cache: 'no-store' })
      if (!response.ok) throw new Error(await response.text())
      const result = await response.json()
      return result.segment || null
    }

    async function watchFromExplorerPaste() {
      const value = explorerInput.value.trim()
      if (!value) return
      explorerInput.removeAttribute('aria-invalid')
      setExplorerMessage('Searching recent Station segments...', '')
      explorerWatch.disabled = true
      try {
        let match = findSegmentFromExplorerText(value)
        if (!match) {
          await poll()
          match = findSegmentFromExplorerText(value)
        }
        if (!match) {
          setExplorerMessage('Checking Station transaction...', '')
          match = await lookupStationSegment(value)
        }
        if (!match) {
          explorerInput.setAttribute('aria-invalid', 'true')
          setExplorerMessage('No Station segment found for that tx, block, or blob hash.', 'error')
          explorerInput.select()
          return
        }
        if (match.streamId && match.streamId !== streamId) {
          setExplorerMessage('Found transaction in stream ' + match.streamId + '. Tuning and jumping...', 'ok')
          await tuneStreamAndJump(match.streamId, match.sequence)
        } else {
          setExplorerMessage('Found segment #' + displaySeq(match.sequence) + '. Loading replay...', 'ok')
          await jumpToSequence(match.sequence)
        }
        explorerInput.value = ''
        explorerInput.placeholder = 'Paste tx URL, hash, or block'
      } finally {
        explorerWatch.disabled = false
      }
    }

    function playIndex(index) {
      const segment = segments[index]
      const ready = segment && playable.get(segment.sequence)
      if (!ready) {
        blackoutVideo()
        setState('lagging', 'Segment boundary reached', 'The next announced segment is not reconstructed yet, so playback is waiting on blob sidecars.')
        return
      }
      playReady(index, ready, 'live')
      return
      currentIndex = index
      video.src = ready.objectUrl
      video.play().catch(() => {})
      setState('live')
      nowTitle.textContent = ready.streamId + ' · seq #' + displaySeq(ready.sequence)
      nowDetail.textContent = fmtBytes(ready.payloadBytes) + ' · ' + blobLabel(ready.blobCount) + ' · ' + shortHash(ready.txHash)
      updateMetrics(ready)
      renderSegments()
    }

    function chooseState() {
      if (!liveMode) return
      const latest = segments.at(-1)
      if (!segments.length || (!suppressPlayerOverlay && !recentEnough(latest))) {
        if (latest) {
          setState('interrupted', 'Segment cadence interrupted', 'Milady blobs were detected, but recent Station announcements stopped arriving. The tuner cuts out instead of replaying stale video.')
        } else if (blobSignal.count > 0) {
          setState('buffering', 'Station blob signal detected', 'Ethereum blobspace contains Station blobs. The tuner is waiting for stream metadata and two reconstructed WebM segments before playback.')
        } else {
          setState('offline', 'No recent station signal', 'No recent segment announcements are available. The viewer stays idle until Ethereum carries new blobs for this stream.')
        }
        blackoutVideo()
        currentIndex = -1
        if (latest) {
          nowTitle.textContent = latest.streamId + ' · last seq #' + displaySeq(latest.sequence)
          nowDetail.textContent = fmtBytes(latest.payloadBytes) + ' · ' + blobLabel(latest.blobCount) + ' · ' + shortHash(latest.txHash)
          updateMetrics(latest)
        } else {
          nowTitle.textContent = 'Waiting for stream segments'
          nowDetail.textContent = 'Execution RPC announces segments; beacon sidecars carry the bytes.'
          updateMetrics(null)
        }
        return
      }

      const readyCount = liveBufferSegments().filter((segment) => playable.has(segment.sequence)).length
      if (readyCount < Math.max(1, startBuffer)) {
        blackoutVideo()
        setState('buffering', 'Building the 2-segment buffer', 'Segment events exist, but fewer than two playable WebM segments have been reconstructed from blobs.')
        nowTitle.textContent = segments[0].streamId + ' · seq #' + displaySeq(segments[0].sequence)
        nowDetail.textContent = fmtBytes(segments[0].payloadBytes) + ' · ' + blobLabel(segments[0].blobCount) + ' · ' + shortHash(segments[0].txHash)
        updateMetrics(segments[0])
        const target = segments[liveTargetIndex()]
        nowTitle.textContent = target.streamId + ' - seq #' + displaySeq(target.sequence)
        nowDetail.textContent = fmtBytes(target.payloadBytes) + ' - ' + blobLabel(target.blobCount) + ' - ' + shortHash(target.txHash)
        updateMetrics(target)
        return
      }

      if (currentIndex === -1) {
        playIndex(liveTargetIndex())
        return
      }

      if ((state === 'lagging' || state === 'interrupted') && currentIndex + 1 < segments.length) {
        playIndex(currentIndex + 1)
      }
    }

    function renderSegments() {
      if (!segments.length) {
        segmentsEl.innerHTML = '<div class="segment-row empty-row"><strong>-</strong><span>Waiting</span><span class="muted">No stream segments yet</span><span>-</span><span>-</span></div>'
        return
      }
      segmentsEl.innerHTML = segments.map((segment, index) => {
        const ready = playable.has(segment.sequence)
        const queued = preparing.has(segment.sequence)
        const current = index === currentIndex ? ' current' : ''
        return '<div class="segment-row' + current + '">' +
          '<strong>#' + escapeHtml(displaySeq(segment.sequence)) + '</strong>' +
          '<span>' + escapeHtml(segmentTimeText(segment.createdAt)) + '</span>' +
          '<a class="tx-link" href="' + escapeHtml(txUrl(segment.txHash)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(shortHash(segment.txHash)) + '</a>' +
          '<span>' + escapeHtml(blobLabel(segment.blobCount)) + '</span>' +
          '<button class="segment-jump" type="button" data-sequence="' + escapeHtml(segment.sequence) + '">JUMP</button>' +
        '</div>'
      }).join('')
    }

    function renderRail(blobspace) {
      renderEndpointPanel(blobspace)
      if (blobspace.chain) {
        selectedNetwork = blobspace.chain === 'mainnet' ? 'mainnet' : 'sepolia'
        explorerBase = blobspace.explorerBase || (selectedNetwork === 'mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io')
        const label = blobspace.networkLabel || (selectedNetwork === 'mainnet' ? 'Mainnet' : 'Sepolia')
        setNetworkToggle()
        if (blobspace.station) {
          stationLink.href = explorerBase + '/address/' + encodeURIComponent(blobspace.station)
          stationLink.textContent = label
          stationLink.classList.remove('hidden')
        } else {
          stationLink.href = explorerBase
          stationLink.textContent = label
        }
      }
      railMode.textContent = blobspace.mode === 'live'
        ? 'Live beacon sidecars from /eth/v1/beacon/blob_sidecars/{slot}.'
        : blobspace.mode === 'warming'
          ? 'Warming recent slot history from beacon sidecars.'
        : blobspace.warning || 'Cached sidecars from the local proof transaction.'
      const fallbackMax = blobspace.maxBlobsPerBlock || 21
      const rows = [...(blobspace.rows || [])].sort((a, b) => Number(b.slot) - Number(a.slot))
      let streamBlobTotal = 0
      let latestStreamSlot = null
      slotsEl.innerHTML = rows.map((row) => {
        const blobs = row.blobs || row.sidecars || []
        const max = row.maxBlobs || fallbackMax
        const blobMatchesStream = (blob) => Boolean(blob?.isStreamBlob)
        const streamBlobs = blobs.filter(blobMatchesStream)
        const jumpBlob = streamBlobs.find((blob) => (blob?.stream?.sequence ?? blob?.sequence) != null)
        const jumpSequence = jumpBlob?.stream?.sequence ?? jumpBlob?.sequence
        const jumpStreamId = jumpBlob?.stream?.streamId || jumpBlob?.streamId || ''
        const watchBlob = streamBlobs.find((blob) => blob?.stream?.txHash || blob?.txHash)
        const watchTx = watchBlob?.stream?.txHash || watchBlob?.txHash || ''
        const byIndex = new Map(blobs.map((blob) => [Number(blob.index), blob]))
        const rowSlotUrl = blobspace.beaconSlotBase
          ? blobspace.beaconSlotBase + encodeURIComponent(row.slot)
          : slotUrl(row.slot)
        const cells = Array.from({ length: max }, (_, index) => {
          const blob = byIndex.get(index)
          const isStreamBlob = blobMatchesStream(blob)
          const kind = isStreamBlob ? 'milady' : blob ? 'other' : ''
          const text = ''
          const title = blob ? ' title="' + escapeHtml(blob.versionedHash || 'blob') + '"' : ''
          const blobTx = blob?.stream?.txHash || blob?.txHash
          if (blobTx) {
            return '<a class="blob-cell ' + kind + '"' + title + ' href="' + escapeHtml(txUrl(blobTx)) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>'
          }
          if (blob) {
            return '<a class="blob-cell ' + kind + '"' + title + ' href="' + escapeHtml(rowSlotUrl) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>'
          }
          return '<span class="blob-cell ' + kind + '"' + title + '>' + text + '</span>'
        }).join('')
        const used = row.blobCount != null ? Number(row.blobCount) : blobs.length
        const streamUsed = streamBlobs.length
        streamBlobTotal += Number(streamUsed || 0)
        if (streamUsed && latestStreamSlot == null) latestStreamSlot = row.slot
        const action = jumpSequence != null
          ? '<button class="slot-jump" type="button" data-sequence="' + escapeHtml(jumpSequence) + '" data-stream-id="' + escapeHtml(jumpStreamId) + '" title="Tune this stream and jump to this segment">JUMP</button>'
          : watchTx
            ? '<button class="slot-jump" type="button" data-tx-hash="' + escapeHtml(watchTx) + '" title="Find and jump to the Station segment for this blob transaction">JUMP</button>'
            : ''
        return '<section class="slot" data-slot-url="' + escapeHtml(rowSlotUrl) + '">' +
          '<div class="slot-top"><strong>Slot ' + row.slot + '</strong><span>' + used + ' / ' + max + ' blobs' + (streamUsed ? ' · ' + streamUsed + ' Station/Milady' : '') + '</span></div>' +
          slotTimeMarkup(row.timestampMs, action) +
          '<div class="blob-grid">' + cells + '</div>' +
          (row.error ? '<div class="slot-error">' + escapeHtml(row.error) + '</div>' : '') +
        '</section>'
      }).join('') || '<div class="muted">' + escapeHtml(blobspace.warning || 'No blob sidecar rows available yet.') + '</div>'
      for (const slot of slotsEl.querySelectorAll('.slot[data-slot-url]')) {
        const label = slot.querySelector('.slot-top strong')
        if (!label) continue
        const link = document.createElement('a')
        link.className = 'slot-link'
        link.href = slot.dataset.slotUrl
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        link.textContent = label.textContent
        label.replaceWith(link)
      }
      blobSignal = { count: streamBlobTotal, latestSlot: latestStreamSlot }
    }

    function setSegmentsPaneHeight(height) {
      const railRect = rail.getBoundingClientRect()
      const min = 176
      const max = Math.max(min, railRect.height - 190)
      const next = Math.round(Math.min(max, Math.max(min, height)))
      rail.style.setProperty('--segments-pane-height', next + 'px')
      return next
    }

    function restoreSegmentsPaneHeight() {
      let saved = ''
      try { saved = localStorage.getItem(segmentsPaneHeightKey) || '' } catch {}
      const height = Number(saved)
      if (Number.isFinite(height) && height > 0) setSegmentsPaneHeight(height)
    }

    function setSegmentsPaneHeightFromClientY(clientY) {
      const railRect = rail.getBoundingClientRect()
      const railPaddingBottom = Number.parseFloat(getComputedStyle(rail).paddingBottom) || 0
      return setSegmentsPaneHeight(railRect.bottom - railPaddingBottom - clientY)
    }

    function persistSegmentsPaneHeight() {
      try {
        const value = getComputedStyle(rail).getPropertyValue('--segments-pane-height').trim()
        if (value) localStorage.setItem(segmentsPaneHeightKey, value.replace('px', ''))
      } catch {}
    }

    function isSegmentsResizeEdge(event) {
      const rect = segmentsPanel.getBoundingClientRect()
      return event.clientY >= rect.top - 8 && event.clientY <= rect.top + 12
    }

    function startRailResize(event) {
      if (!segmentsPanel || window.matchMedia('(max-width: 980px)').matches) return
      if (!isSegmentsResizeEdge(event)) return
      if (rail.classList.contains('resizing')) return
      event.preventDefault()
      rail.classList.add('resizing')
      segmentsPanel.setPointerCapture?.(event.pointerId)
      const startY = event.clientY
      const startHeight = segmentsPanel.getBoundingClientRect().height
      const onMove = (moveEvent) => {
        setSegmentsPaneHeight(startHeight - (moveEvent.clientY - startY))
      }
      const onUp = () => {
        rail.classList.remove('resizing')
        segmentsPanel.releasePointerCapture?.(event.pointerId)
        persistSegmentsPaneHeight()
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, { once: true })
    }

    function startRailMouseResize(event) {
      if (!segmentsPanel || window.matchMedia('(max-width: 980px)').matches) return
      if (!isSegmentsResizeEdge(event)) return
      if (rail.classList.contains('resizing')) return
      event.preventDefault()
      rail.classList.add('resizing')
      const startY = event.clientY
      const startHeight = segmentsPanel.getBoundingClientRect().height
      const onMove = (moveEvent) => {
        setSegmentsPaneHeight(startHeight - (moveEvent.clientY - startY))
      }
      const onUp = () => {
        rail.classList.remove('resizing')
        persistSegmentsPaneHeight()
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp, { once: true })
    }

    async function poll(force = false) {
      if (polling && !force) return
      polling = true
      clearTimeout(refreshSpinTimer)
      refresh.classList.add('is-spinning')
      const tunedStreamId = streamId
      const tunedNetwork = selectedNetwork
      try {
        const data = await fetchJson(apiUrl('/api/streams/' + encodeURIComponent(tunedStreamId) + '/live'))
        if (tunedStreamId !== streamId || tunedNetwork !== selectedNetwork) return
        const latestStation = data.stationLatest || null
        if (liveMode && latestStation?.streamId && latestStation.streamId !== streamId) {
          streamId = latestStation.streamId
          suppressPlayerOverlay = streamId.startsWith('rfe-baked-')
          updateLocation()
          segments = []
          playable = new Map()
          preparing = new Map()
          fetchTimings = new Map()
          decodeTimings = new Map()
          currentIndex = -1
          blackoutVideo()
          renderSegments()
          setState('buffering', 'Following latest Station stream', 'New Station blobs are publishing under ' + streamId + '.')
          void poll(true)
          return
        }
        segments = liveResponseSegments(data)
        if (segments.length) lastEventAt = Date.parse(segments.at(-1).createdAt || Date.now())
        renderRail(data.blobspace || { rows: [], maxBlobsPerBlock: 21 })
        lastBlobspaceUpdateAt = Date.now()
        renderSegments()
        await fillBuffer().catch((error) => {
          nowDetail.textContent = 'Blobspace feed is live; media prefetch is retrying: ' + publicErrorMessage(error)
        })
        renderSegments()
        chooseState()
      } catch (error) {
        if (lastBlobspaceUpdateAt && Date.now() - lastBlobspaceUpdateAt < 15_000) {
          statusEl.textContent = 'retrying'
          nowDetail.textContent = 'Blobspace feed is still visible; retrying API fetch: ' + publicErrorMessage(error)
          overlayTitle.textContent = 'Retrying tuner fetch'
          overlayCopy.textContent = publicErrorMessage(error)
        } else {
          blackoutVideo()
          setState('interrupted', 'Tuner interrupted', publicErrorMessage(error))
        }
      } finally {
        polling = false
        refreshSpinTimer = setTimeout(() => refresh.classList.remove('is-spinning'), 650)
      }
    }

    video.addEventListener('ended', () => {
      const next = currentIndex + 1
      if (!liveMode) {
        if (next < segments.length) void jumpToSequence(segments[next].sequence)
        else if (loopReplay && segments.length) void jumpToSequence(segments[0].sequence)
        else {
          blackoutVideo()
          setState('replay', 'Replay ended', 'Select another blob segment or press LIVE to return to the Station feed.')
        }
        return
      }
      if (next < segments.length) playIndex(next)
      else {
        blackoutVideo()
        setState('lagging', 'Waiting for the next slot', 'Playback reached the reconstructed edge. The tuner is waiting for the next segment announcement and blob sidecars.')
      }
    })
    if (suppressPlayerOverlay) overlay.classList.add('hidden')
    video.addEventListener('play', () => overlay.classList.add('hidden'))
    video.addEventListener('pause', () => {
      if (!suppressPlayerOverlay && state === 'live') {
        overlayTitle.textContent = 'Playback paused'
        overlayCopy.textContent = 'The blob stream remains tuned in while the player is paused.'
        overlay.classList.remove('hidden')
      }
    })
    refresh.addEventListener('click', poll)
    goLive.addEventListener('click', () => {
      liveMode = true
      video.loop = false
      setLiveButton()
      currentIndex = -1
      blackoutVideo()
      setState('buffering', 'Returning to LIVE', 'The tuner is switching back to the live Station feed.')
      void poll()
    })
    loopToggle.addEventListener('click', () => {
      loopReplay = !loopReplay
      setLoopButton()
    })
    segmentsEl.addEventListener('click', (event) => {
      const button = event.target.closest('.segment-jump')
      if (!button) return
      void jumpToSequence(button.dataset.sequence)
    })
    slotsEl.addEventListener('click', (event) => {
      const button = event.target.closest('.slot-jump')
      if (!button) return
      if (button.dataset.txHash) {
        explorerInput.value = button.dataset.txHash
        void watchFromExplorerPaste()
        return
      }
      if (!button.dataset.streamId) {
        setState('interrupted', 'Stream metadata unavailable', 'This blob slot is marked as stream data, but the Station event metadata has not resolved a stream id yet.')
        return
      }
      void tuneStreamAndJump(button.dataset.streamId, button.dataset.sequence)
    })
    segmentsPanel.addEventListener('pointerdown', startRailResize)
    segmentsPanel.addEventListener('mousedown', startRailMouseResize)
    explorerWatch.addEventListener('click', () => {
      void watchFromExplorerPaste()
    })
    explorerInput.addEventListener('input', () => {
      explorerInput.removeAttribute('aria-invalid')
      setExplorerMessage('', '')
    })
    explorerInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      void watchFromExplorerPaste()
    })
    themeToggle.addEventListener('click', () => {
      setTheme(document.body.classList.contains('light') ? 'dark' : 'light')
    })
    networkToggle.addEventListener('click', () => {
      setNetwork(selectedNetwork === 'mainnet' ? 'sepolia' : 'mainnet')
    })
    endpointSettings.addEventListener('click', () => {
      endpointSettingsOpen = !endpointSettingsOpen
      endpointPanel.classList.toggle('is-visible', endpointSettingsOpen)
      endpointSettings.setAttribute('aria-expanded', endpointSettingsOpen ? 'true' : 'false')
      if (endpointSettingsOpen) syncEndpointInputs()
    })
    endpointPanel.addEventListener('click', (event) => {
      const button = event.target.closest('.endpoint-preset')
      if (!button) return
      setEndpointPreset(button.dataset.preset || '', button.dataset.network || selectedNetwork)
    })
    endpointApply.addEventListener('click', applyEndpointInputs)
    endpointExecution.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      applyEndpointInputs()
    })
    endpointBeacon.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      applyEndpointInputs()
    })
    mute.addEventListener('click', () => {
      video.muted = !video.muted
      renderMuteIcon()
    })
    volume.addEventListener('input', () => {
      video.volume = Number(volume.value)
      if (video.volume > 0 && video.muted) video.muted = false
      renderMuteIcon()
    })
    video.addEventListener('volumechange', () => {
      if (Math.abs(Number(volume.value) - video.volume) > 0.01) volume.value = String(video.volume)
      renderMuteIcon()
    })
    initTheme()
    setNetworkToggle()
    syncEndpointInputs()
    updateLocation()
    restoreSegmentsPaneHeight()
    video.volume = Number(volume.value)
    updateUtcClock()
    renderMuteIcon()
    setLiveButton()
    setLoopButton()

    poll()
    setInterval(poll, pollMs)
    setInterval(updateUtcClock, 1000)
    setInterval(() => {
      if (!suppressPlayerOverlay && lastEventAt && Date.now() - lastEventAt > segmentTimeoutMs && (state === 'live' || state === 'lagging')) {
        blackoutVideo()
        setState('interrupted', 'Segment cadence interrupted', 'Expected segments stopped arriving within the live timeout window.')
      }
    }, 1000)
  </script>
</body>
</html>`
}

const server = http.createServer(async (request, response) => {
  let ctx = null
  try {
    const parsed = new URL(request.url, 'http://127.0.0.1')
    ctx = networkContext(parsed.searchParams.get('network') || defaultNetwork, {
      endpointPreset: parsed.searchParams.get('endpointPreset') || '',
      executionRpcUrl: parsed.searchParams.get('ethRpcUrl') || '',
      beaconRpcUrl: parsed.searchParams.get('beaconRpcUrl') || '',
    })

    if (parsed.pathname === '/') {
      return send(response, 200, indexHtml(), { 'content-type': 'text/html; charset=utf-8' })
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
      const allSegments = await segmentFeed(ctx)
      const segments = allSegments.filter((segment) => segment.streamId === id).map(summarizeSegment)
      const latestStationSegment = latestPublishedSegment(allSegments)
      const stationLatest = latestStationSegment ? summarizeSegment(latestStationSegment) : null
      return sendJson(response, {
        streamId: id,
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
      const allSegments = await segmentFeed(ctx)
      const blobspace = await slotMetrics(slotWindow, ctx)
      return sendJson(response, summarizeHealth(id, allSegments, blobspace, ctx))
    }

    const payloadMatch = parsed.pathname.match(/^\/api\/segments\/([^/]+)\/(\d+)\/payload$/)
    if (payloadMatch) {
      const id = decodePathParam(response, payloadMatch[1])
      if (id == null) return
      const sequence = Number(payloadMatch[2])
      const segment = (await segmentFeed(ctx)).find(
        (candidate) => candidate.streamId === id && Number(candidate.sequence) === sequence,
      )
      if (!segment) return send(response, 404, 'segment not found')
      const mediaPath = await ensureMedia(segment, ctx)
      return sendMedia(request, response, mediaPath)
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
      const mediaPath = safeMediaPath(id, sequence)
      if (!mediaPath) return send(response, 404, 'media not found')
      if (!fs.existsSync(mediaPath)) return send(response, 404, 'media not found')
      return sendMedia(request, response, mediaPath)
    }

    send(response, 404, 'not found')
  } catch (error) {
    console.error(error)
    sendJson(response, { error: publicErrorMessage(error, ctx) }, 500)
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
  void refreshStationSegments(sepoliaCtx)
  void refreshSlotMetrics(slotWindow, sepoliaCtx)
  if (mainnetCtx.publicClient || mainnetCtx.beaconUrl) void refreshSlotMetrics(slotWindow, mainnetCtx)
})
