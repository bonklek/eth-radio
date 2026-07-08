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
const port = Number(process.env.PORT || 5173)
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
const maxBlobsPerBlock = Number(process.env.MAX_BLOBS_PER_BLOCK || 21)
const slotWindow = Number(process.env.SLOT_WINDOW || 8)
const slotMetricsCacheMs = Number(process.env.SLOT_METRICS_CACHE_MS || 2000)
const viewerPollMs = Number(process.env.VIEWER_POLL_MS || 2000)
const streamId = process.env.STREAM_ID || 'rfe-baked-clock-pipe-v6'
const defaultNetwork = normalizeNetwork(process.env.CHAIN || 'sepolia')
const chains = { mainnet, sepolia }
const beaconTimeoutMs = Number(process.env.BEACON_TIMEOUT_MS || 3500)
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

function networkLabel(network) {
  return normalizeNetwork(network) === 'mainnet' ? 'Mainnet' : 'Sepolia'
}

function envForNetwork(network, name, fallback = '') {
  const prefix = network.toUpperCase()
  return process.env[`${prefix}_${name}`] || process.env[`${name}_${prefix}`] || (network === defaultNetwork ? process.env[name] : '') || fallback
}

function networkContext(networkInput) {
  const name = normalizeNetwork(networkInput)
  const chain = chains[name]
  const executionUrl = envForNetwork(name, 'ETH_RPC_URL', name === 'mainnet' ? 'https://ethereum-rpc.publicnode.com' : '')
  const beaconUrl = envForNetwork(name, 'BEACON_RPC_URL', name === 'mainnet' ? 'https://ethereum-beacon-api.publicnode.com' : '')?.replace(/\/$/, '')
  const deploymentPath = path.join(root, 'work', 'blob-radio-testnet', 'contracts', `Station.${name}.json`)
  const stationDeployment = fs.existsSync(deploymentPath) ? JSON.parse(fs.readFileSync(deploymentPath, 'utf8')) : null
  const stationAddress = envForNetwork(name, 'STATION_ADDRESS', name === 'sepolia' ? canonicalStationAddress : '')
  const stationFromBlock = BigInt(envForNetwork(name, 'STATION_FROM_BLOCK', name === 'sepolia' ? canonicalStationFromBlock : '0'))
  return {
    name,
    label: networkLabel(name),
    chain,
    beaconUrl,
    executionUrl,
    publicClient: chain && executionUrl ? createPublicClient({ chain, transport: viemHttp(executionUrl) }) : null,
    stationAddress,
    stationAbi: stationDeployment?.abi || null,
    stationFromBlock,
    explorerBase: name === 'mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io',
  }
}

function canonicalSegmentSort(a, b) {
  return (
    String(a.streamId || '').localeCompare(String(b.streamId || '')) ||
    Number(a.sequence) - Number(b.sequence) ||
    Number(a.blockNumber || 0) - Number(b.blockNumber || 0) ||
    Number(a.transactionIndex || 0) - Number(b.transactionIndex || 0) ||
    Number(a.logIndex || 0) - Number(b.logIndex || 0)
  )
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, headers)
  response.end(body)
}

function sendJson(response, value, status = 200) {
  send(response, status, JSON.stringify(value, null, 2), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function safeStreamId(value) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_')
}

function readProofSegments(id) {
  const safeId = safeStreamId(id)
  const proofPath = path.join(liveRunDir, safeId, 'segments', `${safeId}.segments.json`)
  if (!fs.existsSync(proofPath)) return []
  const manifest = readJson(proofPath)
  return Array.isArray(manifest.segments) ? manifest.segments : []
}

function proofSegmentBySequence(id) {
  const proof = new Map()
  for (const segment of readProofSegments(id)) {
    proof.set(Number(segment.sequence), segment)
  }
  return proof
}

function getCachedSidecars(txHash) {
  const sidecarPath = path.join(sidecarDir, `${txHash}.json`)
  if (!fs.existsSync(sidecarPath)) return null
  return readJson(sidecarPath)
}

function readManifests() {
  if (!fs.existsSync(manifestDir)) return []
  return fs
    .readdirSync(manifestDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const manifestPath = path.join(manifestDir, name)
      const manifest = readJson(manifestPath)
      const mediaPath = path.join(reconstructedDir, `${safeStreamId(manifest.streamId)}-${manifest.sequence}.webm`)
      const cachedSidecars = getCachedSidecars(manifest.txHash)
      const slot = cachedSidecars?.slot || manifest.slot || null
      return {
        ...manifest,
        source: manifest.stationAddress ? 'station-manifest' : 'manifest',
        station: manifest.stationAddress,
        slot,
        manifestPath,
        hasMedia: fs.existsSync(mediaPath),
        mediaUrl: `/media/${encodeURIComponent(manifest.streamId)}/${manifest.sequence}.webm`,
        gatewayUrl: `/api/segments/${encodeURIComponent(manifest.streamId)}/${manifest.sequence}/payload`,
        ready: fs.existsSync(mediaPath),
      }
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
    blockTimestamps.set(key, Number(block.timestamp) * 1000)
  }

  const segments = parsed
    .map((log) => {
      const payloadSha256 = log.args.payloadSha256?.replace(/^0x/, '') || ''
      const mediaPath = path.join(reconstructedDir, `${safeStreamId(log.args.streamId)}-${log.args.sequence}.webm`)
      const createdAtMs = blockTimestamps.get(log.blockNumber.toString()) || null
      return {
        app: 'eth-radio',
        version: 1,
        chain: ctx.name,
        source: 'station',
        station: getAddress(ctx.stationAddress),
        streamId: log.args.streamId,
        sequence: Number(log.args.sequence),
        durationMs: Number(log.args.durationMs),
        payloadBytes: Number(log.args.payloadBytes),
        payloadSha256,
        payloadSha256Hex: log.args.payloadSha256,
        codec: log.args.codec,
        previousSegmentHash: log.args.previousSegmentHash,
        blobCount: log.args.blobVersionedHashes.length,
        txHash: log.transactionHash,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber.toString(),
        blockHash: log.blockHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
        createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
        publisher: log.args.publisher,
        streamIdHash: log.args.streamIdHash,
        blobVersionedHashes: log.args.blobVersionedHashes,
        hasMedia: fs.existsSync(mediaPath),
        mediaUrl: `/media/${encodeURIComponent(log.args.streamId)}/${log.args.sequence}.webm`,
        gatewayUrl: `/api/segments/${encodeURIComponent(log.args.streamId)}/${log.args.sequence}/payload`,
      }
    })
    .sort(canonicalSegmentSort)

  const latestByKey = new Map()
  for (const segment of segments) {
    const key = `${segment.streamId}:${segment.sequence}`
    const previous = latestByKey.get(key)
    const previousOrder = previous ? BigInt(previous.blockNumber) * 1_000_000n + BigInt(previous.logIndex) : -1n
    const nextOrder = BigInt(segment.blockNumber) * 1_000_000n + BigInt(segment.logIndex)
    if (!previous || nextOrder >= previousOrder) latestByKey.set(key, segment)
  }

  return [...latestByKey.values()].sort(
    canonicalSegmentSort,
  )
}

function refreshStationSegments(ctx = networkContext(defaultNetwork)) {
  if (stationSegmentsPromise.has(ctx.name)) return stationSegmentsPromise.get(ctx.name)
  const promise = readStationSegments(ctx)
    .then((segments) => {
      stationSegmentsCache.set(ctx.name, { segments, updatedAt: Date.now() })
      return segments
    })
    .catch((error) => {
      console.warn(`${ctx.name} Station segment feed unavailable: ${error.message}`)
      return stationSegmentsCache.get(ctx.name)?.segments || []
    })
    .finally(() => {
      stationSegmentsPromise.delete(ctx.name)
    })
  stationSegmentsPromise.set(ctx.name, promise)
  return promise
}

async function segmentFeed(ctx = networkContext(defaultNetwork)) {
  const cached = stationSegmentsCache.get(ctx.name)
  if (cached?.segments?.length) {
    if (Date.now() - cached.updatedAt > 10_000) void refreshStationSegments(ctx)
    return cached.segments
  }
  void refreshStationSegments(ctx)
  if (ctx.name !== 'sepolia') return []
  return readManifests()
}

function summarizeHealth(id, segments, blobspace, ctx = networkContext(defaultNetwork)) {
  const streamSegments = segments
    .filter((segment) => segment.streamId === id)
    .sort((a, b) => Number(a.sequence) - Number(b.sequence))
  const latest = streamSegments.at(-1) || null
  const proof = latest ? proofSegmentBySequence(id).get(Number(latest.sequence)) || null : null
  const ageMs = latest?.createdAt ? Date.now() - Date.parse(latest.createdAt) : null
  const expectedCadenceMs = latest?.durationMs ? Math.max(Number(latest.durationMs) * 6, 180_000) : 180_000
  return {
    streamId: id,
    ok: Boolean(latest) && (ageMs == null || ageMs <= expectedCadenceMs),
    latestSequence: latest ? Number(latest.sequence) : null,
    latestTxHash: latest?.txHash || null,
    latestBlockNumber: latest?.blockNumber || null,
    latestPayloadBytes: latest?.payloadBytes || null,
    latestBlobCount: latest?.blobCount || latest?.blobVersionedHashes?.length || null,
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
      warning: blobspace?.warning || null,
    },
  }
}

function summarizeSegment(segment) {
  const proof = proofSegmentBySequence(segment.streamId).get(Number(segment.sequence)) || null
  return {
    app: segment.app,
    version: segment.version,
    chain: segment.chain,
    source: segment.source || 'manifest',
    station: segment.station,
    streamId: segment.streamId,
    sequence: Number(segment.sequence),
    durationMs: Number(segment.durationMs || 0),
    payloadBytes: Number(segment.payloadBytes || 0),
    payloadSha256: segment.payloadSha256,
    payloadSha256Hex: segment.payloadSha256Hex,
    codec: segment.codec,
    previousSegmentHash: segment.previousSegmentHash || null,
    publisher: segment.publisher,
    blobCount: Number(segment.blobCount || segment.blobVersionedHashes?.length || 0),
    blobVersionedHashes: segment.blobVersionedHashes || [],
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
  const value = BigInt(genesis.data.genesis_time)
  genesisTimeCache.set(ctx.name, value)
  return value
}

function slotTimestampMs(slot, genesisTime) {
  if (genesisTime == null) return null
  return Number((genesisTime + BigInt(slot) * secondsPerSlot) * 1000n)
}

async function latestSlot(ctx = networkContext(defaultNetwork)) {
  if (!ctx.beaconUrl) return null
  const head = await beacon('/eth/v1/beacon/headers/head', ctx)
  return Number(head.data.header.message.slot)
}

async function sidecarsForSlot(slot, ctx = networkContext(defaultNetwork)) {
  const started = performance.now()
  const body = await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`, ctx)
  const sidecars = body.data || []
  const rows = sidecars.map((sidecar) => {
    const commitment = sidecar.kzg_commitment || sidecar.kzgCommitment
    const versionedHash = commitment ? commitmentToVersionedHash({ commitment }) : null
    return {
      index: Number(sidecar.index),
      versionedHash,
      commitment,
      hasBlob: Boolean(sidecar.blob),
    }
  })
  return { slot: Number(slot), fetchMs: Math.round(performance.now() - started), sidecars: rows }
}

function cachedBlobspaceRows(segments) {
  const rows = new Map()
  for (const segment of segments) {
    const cached = getCachedSidecars(segment.txHash)
    if (!cached?.slot) continue
    const slot = Number(cached.slot)
    const row = rows.get(slot) || { slot, source: 'cached proof', fetchMs: null, sidecars: [] }
    for (const match of cached.matches || []) {
      row.sidecars.push({
        index: Number(match.index),
        versionedHash: match.versionedHash,
        streamId: segment.streamId,
        sequence: Number(segment.sequence),
        hasBlob: Boolean(match.blob),
      })
    }
    rows.set(slot, row)
  }
  return [...rows.values()].sort((a, b) => b.slot - a.slot)
}

async function stationStreamBlobHashes(ctx = networkContext(defaultNetwork)) {
  const hashes = new Map()
  const cached = stationSegmentsCache.get(ctx.name)
  const segments = cached?.segments?.length ? cached.segments : await segmentFeed(ctx)
  for (const segment of segments) {
    for (const hash of segment.blobVersionedHashes || []) {
      hashes.set(hash, {
        streamId: segment.streamId,
        sequence: String(segment.sequence),
        txHash: segment.txHash,
      })
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
    const slots = []
    for (let i = 0; i < count; i++) {
      slots.push(latest - BigInt(i))
    }

    const rows = await Promise.all(slots.map(async (slot) => {
      let sidecars = []
      let error = null
      try {
        const result = await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`, ctx)
        sidecars = result.data || []
      } catch (err) {
        error = err.message
      }

      const blobs = sidecars.map((sidecar) => {
        const commitment = sidecar.kzg_commitment || sidecar.kzgCommitment
        const versionedHash = commitment ? commitmentToVersionedHash({ commitment }) : null
        const stream = versionedHash ? streamBlobHashes.get(versionedHash) : null
        return {
          index: Number(sidecar.index),
          versionedHash,
          isStreamBlob: Boolean(stream),
          stream: stream || null,
        }
      })

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
      mode: 'cached',
      rows: cachedBlobspaceRows(await segmentFeed(ctx)),
      warning: error.message,
    }
  }
}

function refreshSlotMetrics(count = 8, ctx = networkContext(defaultNetwork)) {
  if (slotMetricsPromise.has(ctx.name)) return slotMetricsPromise.get(ctx.name)
  const promise = computeSlotMetrics(count, ctx)
    .then((metrics) => {
      slotMetricsCache.set(ctx.name, { metrics, updatedAt: Date.now() })
      return metrics
    })
    .catch((error) => {
      console.warn(`${ctx.name} slot metrics unavailable: ${error.message}`)
      return slotMetricsCache.get(ctx.name)?.metrics || null
    })
    .finally(() => {
      slotMetricsPromise.delete(ctx.name)
    })
  slotMetricsPromise.set(ctx.name, promise)
  return promise
}

async function slotMetrics(count = 8, ctx = networkContext(defaultNetwork)) {
  const cached = slotMetricsCache.get(ctx.name)
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
    for (const hash of segment.blobVersionedHashes || []) {
      streamHashes.set(hash, { streamId: segment.streamId, sequence: Number(segment.sequence) })
    }
  }

  if (!ctx.beaconUrl) {
    return {
      mode: 'cached',
      maxBlobsPerBlock,
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
        return { slot, source: 'beacon', error: error.message, sidecars: [] }
      }
    }))
    return { mode: 'live', maxBlobsPerBlock, rows }
  } catch (error) {
    return {
      mode: 'cached',
      maxBlobsPerBlock,
      rows: cachedBlobspaceRows(segments),
      warning: error.message,
    }
  }
}

async function fetchAndCacheSidecars(segment) {
  const cached = getCachedSidecars(segment.txHash)
  if (cached) return cached
  const ctx = networkContext(segment.chain || defaultNetwork)
  if (!ctx.publicClient || !ctx.beaconUrl) throw new Error(`${ctx.name} ETH_RPC_URL and BEACON_RPC_URL are required to fetch uncached blob sidecars`)

  const tx = await ctx.publicClient.getTransaction({ hash: segment.txHash })
  const block = await ctx.publicClient.getBlock({ blockHash: tx.blockHash })
  const genesis = await beacon('/eth/v1/beacon/genesis', ctx)
  const slot = (block.timestamp - BigInt(genesis.data.genesis_time)) / 12n
  const sidecars = await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`, ctx)
  const wanted = new Set(tx.blobVersionedHashes || segment.blobVersionedHashes || [])
  const matches = []

  for (const sidecar of sidecars.data || []) {
    const commitment = sidecar.kzg_commitment || sidecar.kzgCommitment
    if (!commitment) continue
    const versionedHash = commitmentToVersionedHash({ commitment })
    if (wanted.has(versionedHash)) matches.push({ ...sidecar, versionedHash })
  }

  const payload = { txHash: segment.txHash, slot: slot.toString(), matches }
  fs.mkdirSync(sidecarDir, { recursive: true })
  fs.writeFileSync(path.join(sidecarDir, `${segment.txHash}.json`), `${JSON.stringify(payload, null, 2)}\n`)
  return payload
}

function reconstructPayload(segment, sidecars) {
  const byHash = new Map()
  for (const match of sidecars.matches || []) {
    if (match.versionedHash && match.blob) byHash.set(match.versionedHash, match.blob)
  }

  const blobs = []
  for (const hash of segment.blobVersionedHashes || []) {
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

  const payload = Buffer.concat(chunks, decodedLength).subarray(0, Number(segment.payloadBytes))
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex')
  if (sha256 !== segment.payloadSha256) {
    throw new Error(`SHA-256 mismatch: expected ${segment.payloadSha256}, got ${sha256}`)
  }
  return payload
}

async function ensureMedia(segment) {
  const mediaPath = path.join(reconstructedDir, `${safeStreamId(segment.streamId)}-${segment.sequence}.webm`)
  if (fs.existsSync(mediaPath)) return mediaPath
  if (mediaInflight.has(mediaPath)) return mediaInflight.get(mediaPath)
  const promise = (async () => {
    if (fs.existsSync(mediaPath)) return mediaPath
    const sidecars = await fetchAndCacheSidecars(segment)
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

function sendMedia(request, response, mediaPath) {
  const stat = fs.statSync(mediaPath)
  const range = request.headers.range
  if (!range) {
    response.writeHead(200, {
      'content-type': 'video/webm',
      'content-length': stat.size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    })
    return fs.createReadStream(mediaPath).pipe(response)
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return send(response, 416, 'invalid range')
  const start = match[1] ? Number(match[1]) : 0
  const end = match[2] ? Number(match[2]) : stat.size - 1
  if (start >= stat.size || end >= stat.size || start > end) return send(response, 416, 'range not satisfiable')

  response.writeHead(206, {
    'content-type': 'video/webm',
    'content-length': end - start + 1,
    'content-range': `bytes ${start}-${end}/${stat.size}`,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  })
  return fs.createReadStream(mediaPath, { start, end }).pipe(response)
}

function assetContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.js') return 'text/javascript; charset=utf-8'
  return 'application/octet-stream'
}

function sendOverlayAsset(response, name) {
  const allowed = new Set(['rfe-terminal-final.png', 'rfe-logo-milxdy.png', 'rfe-style-tokens.json'])
  if (!allowed.has(name)) return send(response, 404, 'asset not found')
  const filePath = path.join(overlayAssetDir, name)
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
      pointer-events: none;
      user-select: none;
    }

    .chip, .telemetry-card {
      border: 1px solid var(--border);
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        var(--surface-1);
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
    }

    #timeUtc { left: 672px; width: 236px; }
    .chip:not(#timeUtc) {
      top: 35px;
      height: 40px;
      padding: 0 11px;
      font-size: 22px;
    }
    #slot { left: 922px; width: 198px; }
    #nonce { left: 1135px; width: 252px; }
    #blockHash { left: 1402px; width: 412px; }

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
      top: 916px;
      width: 1848px;
      height: 144px;
      pointer-events: none;
    }

    .status-label {
      position: absolute;
      left: 28px;
      top: 19px;
      display: none;
      color: var(--accent);
      font: 900 24px/1 var(--ui);
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .reading-title {
      position: absolute;
      left: 28px;
      top: 91px;
      width: 740px;
      display: none;
      color: var(--text);
      font: 900 42px/1 var(--ui);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-shadow: 2px 2px 0 #000;
    }

    .telemetry {
      position: absolute;
      inset: 0;
    }

    .telemetry-mask {
      position: absolute;
      left: 746px;
      top: 78px;
      width: 992px;
      height: 66px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        #11131a;
      background-size: 8px 8px, 8px 8px, auto;
      z-index: 1;
    }

    .telemetry-card {
      position: absolute;
      top: 83px;
      height: 58px;
      padding: 10px 13px 8px;
      background-color: var(--surface-2);
      font-family: var(--mono);
      overflow: hidden;
      z-index: 2;
    }

    .telemetry-card.tx { left: 746px; width: 238px; }
    .telemetry-card.payload { left: 1000px; width: 202px; }
    .telemetry-card.hash { left: 1218px; width: 250px; }
    .telemetry-card.prev { left: 1484px; width: 250px; }

    .telemetry-card dt {
      margin: 0 0 4px;
      color: var(--muted);
      text-transform: uppercase;
      font: 700 15px/1 var(--mono);
    }

    .telemetry-card dd {
      margin: 0;
      min-width: 0;
      color: var(--link);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 700 19px/1 var(--mono);
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
      <img class="reference" src="/rfe-assets/rfe-terminal-final.png" alt="" aria-hidden="true" />
      <div id="networkSignal" class="network-signal">PUBLIC SIGNAL / ${networkLabel(defaultNetwork).toUpperCase()}</div>
      <section class="topbar" aria-label="Live stream telemetry">
        <div id="timeUtc" class="chip">--:--:-- UTC</div>
        <div id="slot" class="chip">SLOT --</div>
        <div id="nonce" class="chip">SEQ --</div>
        <div id="blockHash" class="chip">BLOCK --</div>
      </section>

      <div class="ticker-viewport" aria-hidden="true">
        <div id="ticker" class="ticker-track"><span>Waiting for Station telemetry</span><span>Waiting for Station telemetry</span></div>
      </div>

      <section class="lower" aria-label="Current segment">
        <div class="status-label">Now Reading</div>
        <div id="readingTitle" class="reading-title">The Ethereum Foundation Mandate</div>
        <dl class="telemetry">
          <div class="telemetry-mask" aria-hidden="true"></div>
          <div class="telemetry-card tx"><dt>TX</dt><dd id="txHash">--</dd></div>
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
    let selectedNetworkLabel = selectedNetwork === 'mainnet' ? 'Mainnet' : 'Sepolia'
    const preview = params.has('preview')
    const overlay = document.getElementById('overlay')
    if (preview) document.body.classList.add('preview')

    function scaleOverlay() {
      const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
      overlay.style.setProperty('--scale', String(scale))
    }

    function utcClock() {
      document.getElementById('timeUtc').textContent = streamClockText()
    }

    function apiUrl(path) {
      return path + (path.includes('?') ? '&' : '?') + 'network=' + encodeURIComponent(selectedNetwork)
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

    function updateTicker(segment, blobspace) {
      const proof = segment && segment.proof ? segment.proof : {}
      const blockHash = segment && segment.blockHash ? segment.blockHash : proof.block && proof.block.hash
      const content = segment && (segment.payloadSha256Hex || segment.payloadSha256)
      const text = [
        document.getElementById('timeUtc').textContent,
        'SLOT ' + ((segment && segment.slot) || (blobspace && blobspace.latestSlot) || '--'),
        'BLOCK ' + shorten(blockHash, 8, 4),
        proofOrSequenceLabel(segment, proof),
        'TX ' + shorten(segment && segment.txHash, 8, 4),
        'PREV ' + shorten(segment && segment.previousSegmentHash, 8, 4),
        'CONTENT ' + shorten(content, 8, 4),
      ].join(' / ')
      document.getElementById('ticker').innerHTML = '<span>' + text + '</span><span aria-hidden="true">' + text + '</span>'
    }

    async function poll() {
      try {
        const response = await fetch(apiUrl('/api/streams/' + encodeURIComponent(streamId) + '/live'), { cache: 'no-store' })
        if (!response.ok) throw new Error(await response.text())
        const data = await response.json()
        updateNetworkSignal(data)
        const segment = latestSegment(data.segments)
        const proof = segment && segment.proof ? segment.proof : {}
        const blockHash = segment && segment.blockHash ? segment.blockHash : proof.block && proof.block.hash
        const latestSlot = data.blobspace && data.blobspace.latestSlot
        updateStreamClock(segment)
        overlay.classList.toggle('offline', !segment)
        document.getElementById('slot').textContent = 'SLOT ' + (segment && segment.slot || latestSlot || '--')
        document.getElementById('nonce').textContent = proofOrSequenceLabel(segment, proof)
        document.getElementById('blockHash').textContent = 'BLOCK ' + shorten(blockHash, 8, 4)
        document.getElementById('txHash').textContent = shorten(segment && segment.txHash, 10, 6)
        document.getElementById('payloadSize').textContent = formatBytes(segment && segment.payloadBytes)
        const content = segment && (segment.payloadSha256Hex || segment.payloadSha256)
        document.getElementById('contentHash').textContent = shorten(content, 10, 6)
        document.getElementById('previousHash').textContent = shorten(segment && segment.previousSegmentHash, 10, 6)
        updateTicker(segment, data.blobspace)
      } catch (error) {
        overlay.classList.add('offline')
        document.getElementById('contentHash').textContent = error.message
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
      pointer-events: none;
      user-select: none;
    }

    .chip, .telemetry-card {
      border: 1px solid #252838;
      border-radius: 6px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        rgba(48, 51, 67, .92);
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
    }

    #timeUtc { left: 672px; width: 236px; }
    .chip:not(#timeUtc) {
      top: 35px;
      height: 40px;
      padding: 0 11px;
      font-size: 22px;
    }
    #slot { left: 922px; width: 198px; }
    #nonce { left: 1135px; width: 252px; }
    #blockHash { left: 1402px; width: 412px; }

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

    .status-label {
      position: absolute;
      left: 64px;
      top: 936px;
      display: none;
      color: #c6ccff;
      font: 900 24px/1 Arial, "Segoe UI", sans-serif;
      text-transform: uppercase;
    }

    .reading-title {
      position: absolute;
      left: 64px;
      top: 1007px;
      width: 740px;
      display: none;
      color: #f0f1f8;
      font: 900 42px/1 Arial, "Segoe UI", sans-serif;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 2px 2px 0 #000;
    }

    .telemetry-mask {
      position: absolute;
      left: 782px;
      top: 994px;
      width: 992px;
      height: 66px;
      background:
        linear-gradient(rgba(143, 151, 232, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(143, 151, 232, .028) 1px, transparent 1px),
        #11131a;
      background-size: 8px 8px, 8px 8px, auto;
      z-index: 1;
    }

    .telemetry-card {
      position: absolute;
      top: 999px;
      height: 58px;
      padding: 10px 13px 8px;
      overflow: hidden;
      font-family: Consolas, ui-monospace, monospace;
      z-index: 2;
    }

    .telemetry-card.tx { left: 782px; width: 238px; }
    .telemetry-card.payload { left: 1036px; width: 202px; }
    .telemetry-card.hash { left: 1254px; width: 250px; }
    .telemetry-card.prev { left: 1520px; width: 250px; }

    .telemetry-card dt {
      margin: 0 0 4px;
      color: rgba(186, 190, 214, .82);
      text-transform: uppercase;
      font: 700 15px/1 Consolas, ui-monospace, monospace;
    }

    .telemetry-card dd {
      margin: 0;
      color: #c6ccff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 700 19px/1 Consolas, ui-monospace, monospace;
    }

    .controls {
      position: fixed;
      left: 16px;
      bottom: 16px;
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
      bottom: 72px;
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
          <img class="reference" src="/rfe-assets/rfe-terminal-final.png" alt="" aria-hidden="true" />
          <div id="networkSignal" class="network-signal">PUBLIC SIGNAL / ${networkLabel(defaultNetwork).toUpperCase()}</div>
          <div id="timeUtc" class="chip">--:--:-- UTC</div>
          <div id="slot" class="chip">SLOT --</div>
          <div id="nonce" class="chip">SEQ --</div>
          <div id="blockHash" class="chip">BLOCK --</div>
          <div class="status-label">Now Reading</div>
          <div class="reading-title">The Ethereum Foundation Mandate</div>
          <dl>
            <div class="telemetry-mask" aria-hidden="true"></div>
            <div class="telemetry-card tx"><dt>TX</dt><dd id="txHash">--</dd></div>
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
    let selectedNetwork = (params.get('network') || ${JSON.stringify(defaultNetwork)}).toLowerCase() === 'mainnet' ? 'mainnet' : 'sepolia'
    let selectedNetworkLabel = selectedNetwork === 'mainnet' ? 'Mainnet' : 'Sepolia'
    const video = document.getElementById('video')
    const frame = document.querySelector('.frame')
    const previewDesign = document.getElementById('previewDesign')
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

    function segmentUrl(sequence) {
      return '/api/segments/' + encodeURIComponent(streamId) + '/' + encodeURIComponent(sequence) + '/payload'
    }

    function apiUrl(path) {
      return path + (path.includes('?') ? '&' : '?') + 'network=' + encodeURIComponent(selectedNetwork)
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
      updateStreamClock(segment)
      document.getElementById('slot').textContent = 'SLOT ' + (segment.slot || (data && data.blobspace && data.blobspace.latestSlot) || '--')
      document.getElementById('nonce').textContent = proofOrSequenceLabel(segment, proof)
      document.getElementById('blockHash').textContent = 'BLOCK ' + shorten(blockHash, 8, 4)
      document.getElementById('txHash').textContent = shorten(segment.txHash, 10, 6)
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
      for (const segment of data.segments || []) {
        segments.set(Number(segment.sequence), segment)
      }
      const latest = latestSegment()
      updateTelemetry(activeSegment || latest, data)
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
    video.addEventListener('playing', () => {
      isPlaying = true
      status.textContent = 'playing seq ' + (currentSequence ?? '--')
      setStatusStrip(activeSegment, 'LIVE')
    })
    video.addEventListener('waiting', () => {
      status.textContent = 'buffering seq ' + (currentSequence ?? '--')
    })
    video.addEventListener('ended', () => playNext().catch((error) => { status.textContent = error.message }))
    window.addEventListener('resize', scalePreviewOverlay)
    scalePreviewOverlay()
    tickClock()
    setInterval(tickClock, 1000)
    setInterval(() => {
      const segment = activeSegment || latestSegment()
      if (segment) setStatusStrip(segment, isPlaying ? 'LIVE' : 'WAITING')
    }, 1000)
    setInterval(() => pollLive().catch((error) => { status.textContent = error.message }), pollMs)
    pollLive().catch((error) => { status.textContent = error.message })
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
      grid-template-rows: auto auto minmax(120px, 1fr) 12px minmax(96px, var(--segments-pane-height, 190px));
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
    .rail-resizer {
      position: relative;
      margin: 5px 0;
      min-height: 12px;
      cursor: ns-resize;
      border-top: 1px solid rgba(143,151,232,.3);
      border-bottom: 1px solid rgba(7,8,13,.9);
    }
    .rail-resizer::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      width: 54px;
      height: 4px;
      transform: translate(-50%, -50%);
      border-top: 1px solid #ffbdd4;
      border-bottom: 1px solid #5f668f;
      opacity: .9;
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
    .slot-top strong { color: #f8d5e3; font-family: var(--mono); font-size: 13px; }
    .slot-top span { color: var(--muted); }
    .slot-time {
      display: grid;
      gap: 2px;
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
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
      margin-top: 0;
      border: 2px solid var(--line);
      border-right-color: var(--line-dark);
      border-bottom-color: var(--line-dark);
      border-radius: 6px;
      overflow: hidden;
      background: #11131a;
      min-height: 0;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
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
    body.light .metric {
      border-color: rgba(85, 95, 193, .28);
      background: rgba(255, 255, 255, .68);
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
        <a class="station-link" id="station-link" href="${networkContext(defaultNetwork).explorerBase}/address/${networkContext(defaultNetwork).stationAddress || canonicalStationAddress}" target="_blank" rel="noopener noreferrer">Station</a>
      </div>
      <div class="legend">
        <span><i class="swatch m"></i> Milady</span>
        <span><i class="swatch"></i> other blob</span>
        <span><i class="swatch e"></i> unused</span>
      </div>
      <div id="slots" aria-label="recent blob slots"></div>
      <div class="rail-resizer" id="rail-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize segment list"></div>
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
    let explorerBase = selectedNetwork === 'mainnet' ? 'https://etherscan.io' : 'https://sepolia.etherscan.io'
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
    const rail = document.querySelector('.rail')
    const railResizer = document.querySelector('#rail-resizer')
    const railMode = document.querySelector('#rail-mode')
    const explorerInput = document.querySelector('#explorer-input')
    const explorerWatch = document.querySelector('#explorer-watch')
    const explorerMessage = document.querySelector('#explorer-message')
    const themeToggle = document.querySelector('#theme-toggle')
    const networkToggle = document.querySelector('#network-toggle')
    const stationLink = document.querySelector('#station-link')
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
    const segmentsPaneHeightKey = 'rfe-segments-pane-height'

    const fmtBytes = (bytes) => bytes ? (bytes / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' KB' : '-'
    const fmtMs = (ms) => Number.isFinite(ms) ? Math.round(ms) + ' ms' : '-'
    const shortHash = (hash) => hash ? hash.slice(0, 10) + '...' + hash.slice(-6) : '-'
    const displaySeq = (sequence) => Number(sequence) + 1
    const blobLabel = (count) => count + ' ' + (Number(count) === 1 ? 'blob' : 'blobs')
    const txUrl = (hash) => hash ? explorerBase + '/tx/' + encodeURIComponent(hash) : ''

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
      return path + (path.includes('?') ? '&' : '?') + 'network=' + encodeURIComponent(selectedNetwork)
    }

    function updateLocation() {
      const params = new URLSearchParams()
      if (streamId) params.set('streamId', streamId)
      params.set('network', selectedNetwork)
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

    function slotTimeMarkup(timestampMs) {
      if (!timestampMs) return '<div class="slot-time"><span>Time unavailable</span></div>'
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

    function findSegmentFromExplorerText(value) {
      const text = String(value || '').trim()
      if (!text) return null
      const hash = text.match(/0x[a-fA-F0-9]{64}/)?.[0]?.toLowerCase()
      if (hash) {
        const byTx = segments.find((segment) =>
          String(segment.txHash || segment.transactionHash || '').toLowerCase() === hash
        )
        if (byTx) return byTx
        return segments.find((segment) =>
          String(segment.blockHash || segment.proof?.block?.hash || '').toLowerCase() === hash
        ) || null
      }
      const blockNumber = text.match(/(?:\\/block\\/|block(?:number)?[=:\\s]+)(\\d+)/i)?.[1] ||
        (/^\\d{5,}$/.test(text) ? text : '')
      if (blockNumber) {
        return segments.find((segment) =>
          String(segment.blockNumber || segment.proof?.block?.number || '') === blockNumber
        ) || null
      }
      return null
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
          explorerInput.setAttribute('aria-invalid', 'true')
          setExplorerMessage('No matching stream segment found in the currently loaded Station history. Check the tx, block, or stream segment and try again.', 'error')
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
          setState('buffering', 'Milady blob signal detected', 'Ethereum blobspace contains blobs for this stream. The tuner is waiting for matching recent Station announcements and two reconstructed WebM segments before playback.')
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
        segmentsEl.innerHTML = '<div class="segment-row"><span class="muted empty">No stream segments yet</span></div>'
        return
      }
      segmentsEl.innerHTML = segments.map((segment, index) => {
        const ready = playable.has(segment.sequence)
        const queued = preparing.has(segment.sequence)
        const current = index === currentIndex ? ' current' : ''
        return '<div class="segment-row' + current + '">' +
          '<strong>#' + displaySeq(segment.sequence) + '</strong>' +
          '<span>' + segmentTimeText(segment.createdAt) + '</span>' +
          '<a class="tx-link" href="' + txUrl(segment.txHash) + '" target="_blank" rel="noopener noreferrer">' + shortHash(segment.txHash) + '</a>' +
          '<span>' + blobLabel(segment.blobCount) + '</span>' +
          '<button class="segment-jump" type="button" data-sequence="' + segment.sequence + '">JUMP</button>' +
        '</div>'
      }).join('')
    }

    function renderRail(blobspace) {
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
        const byIndex = new Map(blobs.map((blob) => [Number(blob.index), blob]))
        const cells = Array.from({ length: max }, (_, index) => {
          const blob = byIndex.get(index)
          const isStreamBlob = blobMatchesStream(blob)
          const kind = isStreamBlob ? 'milady' : blob ? 'other' : ''
          const text = ''
          const title = blob ? ' title="' + (blob.versionedHash || 'blob') + '"' : ''
          const blobTx = blob?.stream?.txHash || blob?.txHash
          if (blobTx) {
            return '<a class="blob-cell ' + kind + '"' + title + ' href="' + txUrl(blobTx) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>'
          }
          return '<span class="blob-cell ' + kind + '"' + title + '>' + text + '</span>'
        }).join('')
        const used = row.blobCount != null ? Number(row.blobCount) : blobs.length
        const streamUsed = streamBlobs.length
        streamBlobTotal += Number(streamUsed || 0)
        if (streamUsed && latestStreamSlot == null) latestStreamSlot = row.slot
        const jump = jumpSequence != null
          ? '<button class="slot-jump" type="button" data-sequence="' + jumpSequence + '" data-stream-id="' + jumpStreamId + '" title="Tune this stream and jump to this segment">JUMP</button>'
          : ''
        return '<section class="slot">' +
          '<div class="slot-top"><strong>Slot ' + row.slot + '</strong><span>' + used + ' / ' + max + ' blobs' + (streamUsed ? ' · ' + streamUsed + ' Milady' : '') + '</span></div>' +
          jump +
          slotTimeMarkup(row.timestampMs) +
          '<div class="blob-grid">' + cells + '</div>' +
          (row.error ? '<div class="slot-error">' + row.error + '</div>' : '') +
        '</section>'
      }).join('') || '<div class="muted">' + (blobspace.warning || 'No blob sidecar rows available yet.') + '</div>'
      blobSignal = { count: streamBlobTotal, latestSlot: latestStreamSlot }
    }

    function setSegmentsPaneHeight(height) {
      const railRect = rail.getBoundingClientRect()
      const min = 96
      const max = Math.max(min, railRect.height - 245)
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

    function startRailResize(event) {
      if (!railResizer || window.matchMedia('(max-width: 980px)').matches) return
      event.preventDefault()
      const startY = event.clientY
      const startHeight = document.querySelector('.segments').getBoundingClientRect().height
      rail.classList.add('resizing')
      railResizer.setPointerCapture?.(event.pointerId)
      const onMove = (moveEvent) => {
        setSegmentsPaneHeight(startHeight - (moveEvent.clientY - startY))
      }
      const onUp = () => {
        rail.classList.remove('resizing')
        try {
          const value = getComputedStyle(rail).getPropertyValue('--segments-pane-height').trim()
          if (value) localStorage.setItem(segmentsPaneHeightKey, value.replace('px', ''))
        } catch {}
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp, { once: true })
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
        segments = data.segments || []
        if (segments.length) lastEventAt = Date.parse(segments.at(-1).createdAt || Date.now())
        renderRail(data.blobspace || { rows: [], maxBlobsPerBlock: 21 })
        renderSegments()
        await fillBuffer()
        renderSegments()
        chooseState()
      } catch (error) {
        blackoutVideo()
        setState('interrupted', 'Tuner interrupted', error.message)
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
      if (!button.dataset.streamId) {
        setState('interrupted', 'Stream metadata unavailable', 'This blob slot is marked as stream data, but the Station event metadata has not resolved a stream id yet.')
        return
      }
      void tuneStreamAndJump(button.dataset.streamId, button.dataset.sequence)
    })
    railResizer.addEventListener('pointerdown', startRailResize)
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
  const parsed = new URL(request.url, 'http://127.0.0.1')
  const ctx = networkContext(parsed.searchParams.get('network') || defaultNetwork)

  try {
    if (parsed.pathname === '/') {
      return send(response, 200, indexHtml(), { 'content-type': 'text/html; charset=utf-8' })
    }

    if (parsed.pathname === '/overlay') {
      return send(response, 200, overlayHtml(), { 'content-type': 'text/html; charset=utf-8' })
    }

    if (parsed.pathname === '/overlay-preview') {
      return send(response, 200, overlayPreviewHtml(), { 'content-type': 'text/html; charset=utf-8' })
    }

    const assetMatch = parsed.pathname.match(/^\/rfe-assets\/([^/]+)$/)
    if (assetMatch) {
      return sendOverlayAsset(response, decodeURIComponent(assetMatch[1]))
    }

    const streamMatch = parsed.pathname.match(/^\/api\/streams\/([^/]+)\/live$/)
    if (streamMatch) {
      const id = decodeURIComponent(streamMatch[1])
      const allSegments = await segmentFeed(ctx)
      const segments = allSegments.filter((segment) => segment.streamId === id).map(summarizeSegment)
      return sendJson(response, {
        streamId: id,
        network: ctx.name,
        networkLabel: ctx.label,
        transport: {
          network: ctx.name,
          networkLabel: ctx.label,
          executionRpcConfigured: Boolean(ctx.publicClient),
          beaconApiConfigured: Boolean(ctx.beaconUrl),
          stationConfigured: Boolean(ctx.stationAddress && ctx.stationAbi),
          station: ctx.stationAddress ? getAddress(ctx.stationAddress) : null,
          stationFromBlock: ctx.stationFromBlock.toString(),
          blobSidecarsPath: '/eth/v1/beacon/blob_sidecars/{slot}',
          reconstruction: 'drop byte 0 from each 32-byte field element, concat 31-byte chunks, trim to payloadBytes, verify sha256',
        },
        segments,
        blobspace: await slotMetrics(slotWindow, ctx),
      })
    }

    const healthMatch = parsed.pathname.match(/^\/api\/streams\/([^/]+)\/health$/)
    if (healthMatch) {
      const id = decodeURIComponent(healthMatch[1])
      const allSegments = await segmentFeed(ctx)
      const blobspace = await slotMetrics(slotWindow, ctx)
      return sendJson(response, summarizeHealth(id, allSegments, blobspace, ctx))
    }

    const payloadMatch = parsed.pathname.match(/^\/api\/segments\/([^/]+)\/(\d+)\/payload$/)
    if (payloadMatch) {
      const id = decodeURIComponent(payloadMatch[1])
      const sequence = Number(payloadMatch[2])
      const segment = (await segmentFeed(ctx)).find(
        (candidate) => candidate.streamId === id && Number(candidate.sequence) === sequence,
      )
      if (!segment) return send(response, 404, 'segment not found')
      const mediaPath = await ensureMedia(segment)
      return sendMedia(request, response, mediaPath)
    }

    if (parsed.pathname === '/source-media/test-stream.mp4') {
      const mediaPath = path.join(mediaDir, 'test-stream.mp4')
      if (!fs.existsSync(mediaPath)) return send(response, 404, 'source media not found')
      return sendMedia(request, response, mediaPath)
    }

    const mediaMatch = parsed.pathname.match(/^\/media\/([^/]+)\/(\d+)\.webm$/)
    if (mediaMatch) {
      const id = decodeURIComponent(mediaMatch[1])
      const sequence = Number(mediaMatch[2])
      const mediaPath = path.join(reconstructedDir, `${safeStreamId(id)}-${sequence}.webm`)
      if (!fs.existsSync(mediaPath)) return send(response, 404, 'media not found')
      return sendMedia(request, response, mediaPath)
    }

    send(response, 404, 'not found')
  } catch (error) {
    console.error(error)
    sendJson(response, { error: error.message }, 500)
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
