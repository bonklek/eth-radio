const CHAIN_PRESETS = {
  sepolia: {
    label: 'Sepolia',
    streamId: 'rfe-baked-clock-pipe-v6',
    stationAddress: '0x060c51d481808b506dfae72f054f39e11e4f4017',
    fromBlock: '11226386',
    executionRpcs: ['https://sepolia.drpc.org', 'https://ethereum-sepolia-rpc.publicnode.com'],
    beaconApis: ['https://ethereum-sepolia-beacon-api.publicnode.com'],
  },
  mainnet: {
    label: 'Mainnet',
    streamId: 'rfe-mainnet-live',
    stationAddress: '',
    fromBlock: '0',
    executionRpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth-mainnet.g.alchemy.com/public'],
    beaconApis: ['https://ethereum-beacon-api.publicnode.com'],
  },
}

const DEFAULTS = {
  chainPreset: 'sepolia',
  streamId: 'rfe-baked-clock-pipe-v6',
  stationAddress: '0x060c51d481808b506dfae72f054f39e11e4f4017',
  fromBlock: '11226386',
  logWindowBlocks: 12000,
  cacheLimitMb: 512,
  executionRpcs: ['https://sepolia.drpc.org', 'https://ethereum-sepolia-rpc.publicnode.com'],
  beaconApis: ['https://ethereum-sepolia-beacon-api.publicnode.com'],
  archiveTemplates: [],
}

const EVENT_TOPIC = '0xfd61253da387da4d87d036a0276340bc4f04ff7c1173999c8392b158030f04c3'
const DB_NAME = 'radio-free-ethereum'
const DB_VERSION = 3
const MAX_BLOBS_PER_BLOCK = 21
const SLOT_WINDOW = 10
const els = {
  form: document.querySelector('#settings'),
  chainPreset: document.querySelector('#chain-preset'),
  streamId: document.querySelector('#stream-id'),
  stationAddress: document.querySelector('#station-address'),
  fromBlock: document.querySelector('#from-block'),
  executionRpcs: document.querySelector('#execution-rpcs'),
  beaconApis: document.querySelector('#beacon-apis'),
  archiveTemplates: document.querySelector('#archive-templates'),
  cacheLimit: document.querySelector('#cache-limit'),
  refresh: document.querySelector('#refresh'),
  streamToggle: document.querySelector('#stream-toggle'),
  loopToggle: document.querySelector('#loop-toggle'),
  muteToggle: document.querySelector('#mute-toggle'),
  volume: document.querySelector('#volume'),
  playLatest: document.querySelector('#play-latest'),
  stationState: document.querySelector('#station-state'),
  utcClock: document.querySelector('#utc-clock'),
  networkLabel: document.querySelector('#network-label'),
  nowTitle: document.querySelector('#now-title'),
  nowDetail: document.querySelector('#now-detail'),
  segmentLookup: document.querySelector('#segment-lookup'),
  watchSegment: document.querySelector('#watch-segment'),
  metricSegment: document.querySelector('#metric-segment'),
  metricPayload: document.querySelector('#metric-payload'),
  metricBlobs: document.querySelector('#metric-blobs'),
  metricLatency: document.querySelector('#metric-latency'),
  metricFetch: document.querySelector('#metric-fetch'),
  exportIndex: document.querySelector('#export-index'),
  clearCache: document.querySelector('#clear-cache'),
  status: document.querySelector('#status'),
  player: document.querySelector('#player'),
  empty: document.querySelector('#empty-state'),
  knownCount: document.querySelector('#known-count'),
  verifiedCount: document.querySelector('#verified-count'),
  headBlock: document.querySelector('#head-block'),
  headSlot: document.querySelector('#head-slot'),
  cacheSize: document.querySelector('#cache-size'),
  metadataAge: document.querySelector('#metadata-age'),
  executionHealth: document.querySelector('#execution-health'),
  beaconHealth: document.querySelector('#beacon-health'),
  railMode: document.querySelector('#rail-mode'),
  slots: document.querySelector('#slots'),
  segments: document.querySelector('#segments'),
}

let state = {
  config: loadConfig(),
  segments: [],
  verified: new Map(),
  objectUrls: new Map(),
  activeExecutionRpc: '',
  activeBeaconApi: '',
  blobspace: { mode: 'warming', rows: [], warning: '' },
  metadataUpdatedAt: '',
  currentRecordKey: '',
  streaming: false,
  loopReplay: false,
  busy: false,
  refreshTimer: null,
  prefetching: new Set(),
}

function parseLines(value) {
  return String(value || '').split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean)
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function loadConfig() {
  const saved = JSON.parse(localStorage.getItem('rfe-static-config') || '{}')
  const preset = CHAIN_PRESETS[saved.chainPreset] ? saved.chainPreset : DEFAULTS.chainPreset
  const presetDefaults = CHAIN_PRESETS[preset]
  return {
    ...DEFAULTS,
    ...presetDefaults,
    ...saved,
    chainPreset: preset,
    executionRpcs: unique(saved.executionRpcs || saved.executionRpc ? parseLines(saved.executionRpcs || saved.executionRpc) : presetDefaults.executionRpcs),
    beaconApis: unique(saved.beaconApis || saved.beaconApi ? parseLines(saved.beaconApis || saved.beaconApi) : presetDefaults.beaconApis),
    archiveTemplates: unique(saved.archiveTemplates ? parseLines(saved.archiveTemplates) : DEFAULTS.archiveTemplates),
    logWindowBlocks: Number(saved.logWindowBlocks || DEFAULTS.logWindowBlocks),
    cacheLimitMb: Number(saved.cacheLimitMb || DEFAULTS.cacheLimitMb),
  }
}

function saveConfig(config) {
  localStorage.setItem('rfe-static-config', JSON.stringify(config))
}

function setStatus(value) {
  els.status.textContent = value
}

function on(element, eventName, handler) {
  if (element) element.addEventListener(eventName, handler)
}

function normalizeHex(value) {
  return String(value || '').toLowerCase()
}

function strip0x(value) {
  return String(value || '').replace(/^0x/i, '')
}

function hexToBytes(value) {
  const hex = strip0x(value)
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes) {
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function concatBytes(chunks, totalLength) {
  const out = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return bytesToHex(new Uint8Array(digest))
}

async function versionedHashFromCommitment(commitment) {
  const digest = hexToBytes(await sha256Hex(hexToBytes(commitment)))
  digest[0] = 1
  return bytesToHex(digest)
}

function shortHash(value) {
  const text = String(value || '')
  return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-6)}` : text
}

function fmtBytes(bytes) {
  const value = Number(bytes || 0)
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function fmtAge(iso) {
  if (!iso) return '-'
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.round(minutes / 60)}h`
}

function fmtTime(timestampMs) {
  if (!timestampMs) return '-'
  return new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(timestampMs))
}

function fmtLocalTime(timestampMs) {
  if (!timestampMs) return '-'
  return new Intl.DateTimeFormat([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestampMs))
}

function fmtUtcClock(date = new Date()) {
  return `${date.toISOString().slice(11, 19)} UTC`
}

function fmtLatency(segment) {
  if (!segment?.createdAt) return '-'
  return fmtAge(segment.createdAt)
}

function segmentArrived(segment) {
  if (!segment?.createdAt) return `block ${segment.blockNumber}`
  return fmtLocalTime(Date.parse(segment.createdAt))
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])
}

function readWord(data, wordIndex) {
  return BigInt(`0x${data.slice(wordIndex * 64, wordIndex * 64 + 64)}`)
}

function readBytes32(data, wordIndex) {
  return `0x${data.slice(wordIndex * 64, wordIndex * 64 + 64)}`
}

function readString(data, wordIndex) {
  const offset = Number(readWord(data, wordIndex))
  const length = Number(readWord(data, offset / 32))
  const start = offset * 2 + 64
  return new TextDecoder().decode(hexToBytes(data.slice(start, start + length * 2)))
}

function readBytes32Array(data, wordIndex) {
  const offset = Number(readWord(data, wordIndex))
  const length = Number(readWord(data, offset / 32))
  const startWord = offset / 32 + 1
  return Array.from({ length }, (_, index) => readBytes32(data, startWord + index))
}

function topicAddress(topic) {
  return `0x${strip0x(topic).slice(24)}`
}

function decodeSegmentLog(log) {
  const data = strip0x(log.data)
  const segment = {
    app: 'eth-radio',
    version: 1,
    source: 'station',
    publisher: topicAddress(log.topics[1]),
    streamIdHash: log.topics[2],
    sequence: Number(BigInt(log.topics[3])),
    streamId: readString(data, 0),
    durationMs: Number(readWord(data, 1)),
    payloadBytes: Number(readWord(data, 2)),
    payloadSha256Hex: readBytes32(data, 3),
    payloadSha256: strip0x(readBytes32(data, 3)),
    codec: readString(data, 4),
    previousSegmentHash: readBytes32(data, 5),
    blobVersionedHashes: readBytes32Array(data, 6).map(normalizeHex),
    txHash: log.transactionHash,
    transactionHash: log.transactionHash,
    blockNumber: Number(BigInt(log.blockNumber)),
    blockHash: log.blockHash,
    transactionIndex: Number(BigInt(log.transactionIndex || '0x0')),
    logIndex: Number(BigInt(log.logIndex || '0x0')),
  }
  segment.blobCount = segment.blobVersionedHashes.length
  segment.cacheKey = `${segment.streamId}:${segment.sequence}:${segment.txHash}`
  return segment
}

async function withEndpointFallback(kind, endpoints, request) {
  const failures = []
  for (const endpoint of endpoints) {
    try {
      const result = await request(endpoint.replace(/\/$/, ''))
      if (kind === 'execution') state.activeExecutionRpc = endpoint
      if (kind === 'beacon') state.activeBeaconApi = endpoint
      renderHealth()
      return result
    } catch (error) {
      failures.push(`${endpoint}: ${error.message}`)
    }
  }
  throw new Error(`${kind} endpoints failed: ${failures.join(' | ')}`)
}

async function rpc(method, params = []) {
  return withEndpointFallback('execution', state.config.executionRpcs, async (endpoint) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    if (body.error) throw new Error(body.error.message || 'RPC error')
    return body.result
  })
}

async function beacon(pathname) {
  return withEndpointFallback('beacon', state.config.beaconApis, async (endpoint) => {
    const response = await fetch(`${endpoint}${pathname}`, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    if (!body?.data) throw new Error('no data')
    return body.data
  })
}

async function beaconGenesisTime() {
  const genesis = await beacon('/eth/v1/beacon/genesis')
  return BigInt(genesis.genesis_time)
}

function slotTimestampMs(slot, genesisTime) {
  if (genesisTime == null) return null
  return Number((genesisTime + BigInt(slot) * 12n) * 1000n)
}

async function latestBeaconSlot() {
  const head = await beacon('/eth/v1/beacon/headers/head')
  return Number(head.header.message.slot)
}

function toBlockHex(block) {
  return `0x${BigInt(block).toString(16)}`
}

async function fetchLogs() {
  if (!state.config.stationAddress) throw new Error(`Set a Station address for ${state.config.chainPreset}.`)
  const headHex = await rpc('eth_blockNumber')
  const head = BigInt(headHex)
  els.headBlock.textContent = head.toString()
  const configuredFrom = BigInt(state.config.fromBlock || DEFAULTS.fromBlock)
  const windowBlocks = BigInt(Math.max(1, Number(state.config.logWindowBlocks || DEFAULTS.logWindowBlocks)))
  const fromBlock = head - windowBlocks > configuredFrom ? head - windowBlocks : configuredFrom
  const logs = await rpc('eth_getLogs', [{
    address: state.config.stationAddress,
    fromBlock: toBlockHex(fromBlock),
    toBlock: toBlockHex(head),
    topics: [EVENT_TOPIC],
  }])
  return logs
    .map(decodeSegmentLog)
    .filter((segment) => segment.streamId === state.config.streamId)
    .sort((a, b) => a.sequence - b.sequence || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
}

async function segmentSlot(segment) {
  if (segment.slot) return segment.slot
  const tx = await rpc('eth_getTransactionByHash', [segment.txHash])
  const block = await rpc('eth_getBlockByHash', [tx.blockHash, false])
  const genesis = await beaconGenesisTime()
  return Number((BigInt(block.timestamp) - genesis) / 12n)
}

async function sidecarsForSlot(slot) {
  const cacheKey = slotSidecarsKey(slot)
  const cached = await getRecord('sidecars', cacheKey)
  const cacheAgeMs = cached?.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : Number.POSITIVE_INFINITY
  if (cached?.sidecars?.length || cacheAgeMs < 30_000) return cached

  const started = performance.now()
  const rows = await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`)
  const sidecars = await Promise.all((rows || []).map(async (sidecar) => {
    const commitment = sidecar.kzg_commitment || sidecar.kzgCommitment
    const versionedHash = commitment ? normalizeHex(await versionedHashFromCommitment(commitment)) : null
    return {
      index: Number(sidecar.index),
      versionedHash,
      commitment,
      blob: sidecar.blob || null,
    }
  }))
  const record = {
    cacheKey,
    chainPreset: state.config.chainPreset,
    slot: Number(slot),
    sidecars,
    fetchMs: Math.round(performance.now() - started),
    fetchedAt: new Date().toISOString(),
  }
  await putRecord('sidecars', record)
  return record
}

async function sidecarsForSegment(segment) {
  const slot = await segmentSlot(segment)
  const wanted = new Set(segment.blobVersionedHashes.map(normalizeHex))
  const matches = []
  const record = await sidecarsForSlot(slot)
  for (const sidecar of record.sidecars) {
    if (wanted.has(normalizeHex(sidecar.versionedHash))) matches.push(sidecar)
  }
  return { slot, matches }
}

async function reconstructPayload(segment, sidecars) {
  const byHash = new Map(sidecars.matches.map((match) => [normalizeHex(match.versionedHash), match.blob]))
  const chunks = []
  let decodedLength = 0
  for (const hash of segment.blobVersionedHashes) {
    const blob = byHash.get(normalizeHex(hash))
    if (!blob) throw new Error(`Missing sidecar ${shortHash(hash)}`)
    const bytes = hexToBytes(blob)
    for (let offset = 0; offset < bytes.length; offset += 32) {
      const fieldElement = bytes.subarray(offset, offset + 32)
      if (fieldElement.length === 0) continue
      if (fieldElement[0] !== 0) throw new Error(`Invalid blob field element at ${offset}`)
      const data = fieldElement.subarray(1)
      chunks.push(data)
      decodedLength += data.length
    }
  }
  return concatBytes(chunks, decodedLength).subarray(0, segment.payloadBytes)
}

function archiveUrl(template, segment) {
  return template
    .replaceAll('{streamId}', encodeURIComponent(segment.streamId))
    .replaceAll('{sequence}', encodeURIComponent(String(segment.sequence)))
    .replaceAll('{txHash}', encodeURIComponent(segment.txHash))
    .replaceAll('{payloadSha256}', encodeURIComponent(segment.payloadSha256))
}

async function payloadFromArchive(segment) {
  const failures = []
  for (const template of state.config.archiveTemplates) {
    const url = archiveUrl(template, segment)
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = new Uint8Array(await response.arrayBuffer())
      await verifyPayloadHash(segment, payload)
      return { payload, archiveUrl: url }
    } catch (error) {
      failures.push(`${url}: ${error.message}`)
    }
  }
  if (failures.length) throw new Error(`archive fallback failed: ${failures.join(' | ')}`)
  return null
}

async function payloadFromBeacon(segment) {
  const sidecars = await sidecarsForSegment(segment)
  const payload = await reconstructPayload(segment, sidecars)
  await verifyPayloadHash(segment, payload)
  return { payload, slot: sidecars.slot }
}

async function verifyPayloadHash(segment, payload) {
  const actual = strip0x(await sha256Hex(payload))
  if (actual !== segment.payloadSha256) throw new Error(`SHA-256 mismatch for #${segment.sequence}`)
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('segments')) db.createObjectStore('segments', { keyPath: 'cacheKey' })
      if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'cacheKey' })
      if (!db.objectStoreNames.contains('sidecars')) db.createObjectStore('sidecars', { keyPath: 'cacheKey' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function getRecord(storeName, cacheKey) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).get(cacheKey)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
  })
}

async function putRecord(storeName, record) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readwrite').objectStore(storeName).put(record)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

async function clearStore(storeName) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readwrite').objectStore(storeName).clear()
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

function metadataKey() {
  return `segments:${state.config.chainPreset}:${normalizeHex(state.config.stationAddress)}:${state.config.streamId}`
}

function slotSidecarsKey(slot) {
  return `slot:${state.config.chainPreset}:${slot}`
}

async function cacheSegmentMetadata(segments) {
  const record = {
    cacheKey: metadataKey(),
    chainPreset: state.config.chainPreset,
    stationAddress: state.config.stationAddress,
    streamId: state.config.streamId,
    segments,
    updatedAt: new Date().toISOString(),
  }
  await putRecord('metadata', record)
  state.metadataUpdatedAt = record.updatedAt
}

async function restoreSegmentMetadata() {
  const cached = await getRecord('metadata', metadataKey())
  if (!cached?.segments?.length) return false
  state.segments = cached.segments
  state.metadataUpdatedAt = cached.updatedAt || ''
  for (const segment of state.segments) {
    const record = await cachedSegment(segment.cacheKey)
    if (record) state.verified.set(segment.cacheKey, record)
  }
  render()
  return true
}

async function cachedSegment(cacheKey) {
  return getRecord('segments', cacheKey)
}

async function allCachedSegments() {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction('segments').objectStore('segments').getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
}

async function putCachedSegment(record) {
  await putRecord('segments', record)
  await enforceCacheLimit()
}

async function deleteCachedSegment(cacheKey) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction('segments', 'readwrite').objectStore('segments').delete(cacheKey)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
}

async function clearCache() {
  await clearStore('segments')
  await clearStore('metadata')
  await clearStore('sidecars')
  state.verified.clear()
  state.segments = []
  state.metadataUpdatedAt = ''
  state.blobspace = { mode: 'warming', rows: [], warning: '' }
  for (const url of state.objectUrls.values()) URL.revokeObjectURL(url)
  state.objectUrls.clear()
  await refreshCacheStats()
  render()
}

async function enforceCacheLimit() {
  const limitBytes = Number(state.config.cacheLimitMb || DEFAULTS.cacheLimitMb) * 1024 * 1024
  const records = await allCachedSegments()
  let total = records.reduce((sum, record) => sum + Number(record.bytes || record.payload?.byteLength || 0), 0)
  if (total <= limitBytes) return
  const oldest = records.sort((a, b) => String(a.verifiedAt).localeCompare(String(b.verifiedAt)))
  for (const record of oldest) {
    if (total <= limitBytes) break
    await deleteCachedSegment(record.cacheKey)
    state.verified.delete(record.cacheKey)
    total -= Number(record.bytes || record.payload?.byteLength || 0)
  }
}

async function refreshCacheStats() {
  const records = await allCachedSegments()
  const total = records.reduce((sum, record) => sum + Number(record.bytes || record.payload?.byteLength || 0), 0)
  els.cacheSize.textContent = fmtBytes(total)
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate()
    if (estimate.usage && estimate.quota) {
      els.cacheSize.textContent = `${fmtBytes(total)} / ${fmtBytes(estimate.quota)}`
    }
  }
}

async function verifySegment(segment) {
  const cached = await cachedSegment(segment.cacheKey)
  if (cached?.payload) {
    state.verified.set(segment.cacheKey, cached)
    return cached
  }

  let source = 'beacon'
  let result
  try {
    result = await payloadFromBeacon(segment)
  } catch (beaconError) {
    const archive = await payloadFromArchive(segment)
    if (!archive) throw beaconError
    result = archive
    source = 'archive'
  }

  const record = {
    cacheKey: segment.cacheKey,
    streamId: segment.streamId,
    sequence: segment.sequence,
    txHash: segment.txHash,
    payload: result.payload,
    payloadSha256: segment.payloadSha256,
    bytes: result.payload.byteLength,
    codec: segment.codec,
    slot: result.slot || null,
    source,
    archiveUrl: result.archiveUrl || null,
    verifiedAt: new Date().toISOString(),
  }
  await putCachedSegment(record)
  state.verified.set(segment.cacheKey, record)
  await refreshCacheStats()
  return record
}

function objectUrl(record) {
  if (state.objectUrls.has(record.cacheKey)) return state.objectUrls.get(record.cacheKey)
  const url = URL.createObjectURL(new Blob([record.payload], { type: 'video/webm' }))
  state.objectUrls.set(record.cacheKey, url)
  return url
}

function playRecord(record) {
  state.currentRecordKey = record.cacheKey
  els.player.src = objectUrl(record)
  els.empty.classList.add('hidden')
  els.stationState.textContent = 'LIVE'
  void els.player.play().catch(() => {})
}

function latestVerifiedRecord() {
  return [...state.verified.values()].sort((a, b) => a.sequence - b.sequence).at(-1)
}

function nextVerifiedRecord(currentRecord) {
  return [...state.verified.values()]
    .filter((record) => record.sequence > currentRecord.sequence)
    .sort((a, b) => a.sequence - b.sequence)[0] || null
}

function currentRecord() {
  return state.currentRecordKey ? state.verified.get(state.currentRecordKey) || null : null
}

async function prefetchSegment(segment) {
  if (!segment || state.verified.has(segment.cacheKey) || state.prefetching.has(segment.cacheKey)) return
  state.prefetching.add(segment.cacheKey)
  try {
    await verifySegment(segment)
    render()
    setStatus(`Loaded ${state.segments.length} Station events, ${state.verified.size} verified locally.`)
  } catch {
  } finally {
    state.prefetching.delete(segment.cacheKey)
  }
}

function prefetchWindow() {
  const recent = [...state.segments].slice(-5)
  for (const segment of recent) void prefetchSegment(segment)
}

function streamBlobMap() {
  const byHash = new Map()
  for (const segment of state.segments) {
    for (const hash of segment.blobVersionedHashes || []) {
      byHash.set(normalizeHex(hash), {
        streamId: segment.streamId,
        sequence: segment.sequence,
        txHash: segment.txHash,
      })
    }
  }
  return byHash
}

async function refreshBlobspace() {
  const known = streamBlobMap()
  if (!known.size) {
    state.blobspace = { mode: 'warming', rows: [], warning: 'Waiting for Station metadata.' }
    return
  }

  try {
    const [headSlot, genesisTime] = await Promise.all([latestBeaconSlot(), beaconGenesisTime()])
    els.headSlot.textContent = String(headSlot)
    const slots = Array.from({ length: SLOT_WINDOW }, (_, index) => headSlot - index).filter((slot) => slot >= 0)
    const rows = await Promise.all(slots.map(async (slot) => {
      try {
        const record = await sidecarsForSlot(slot)
        const blobs = (record.sidecars || []).map((sidecar) => {
          const stream = known.get(normalizeHex(sidecar.versionedHash)) || null
          return {
            index: Number(sidecar.index),
            versionedHash: sidecar.versionedHash,
            isStreamBlob: Boolean(stream),
            stream,
          }
        })
        return {
          slot,
          timestampMs: slotTimestampMs(slot, genesisTime),
          blobCount: blobs.length,
          maxBlobs: MAX_BLOBS_PER_BLOCK,
          streamBlobCount: blobs.filter((blob) => blob.isStreamBlob).length,
          blobs,
          error: '',
        }
      } catch (error) {
        return {
          slot,
          timestampMs: slotTimestampMs(slot, genesisTime),
          blobCount: 0,
          maxBlobs: MAX_BLOBS_PER_BLOCK,
          streamBlobCount: 0,
          blobs: [],
          error: error.message,
        }
      }
    }))
    state.blobspace = { mode: 'live', rows, warning: '' }
  } catch (error) {
    state.blobspace = {
      mode: 'cached',
      rows: cachedBlobspaceRows(known),
      warning: error.message,
    }
  }
}

function cachedBlobspaceRows(known) {
  const rows = new Map()
  for (const record of state.verified.values()) {
    if (record.slot == null) continue
    const row = rows.get(record.slot) || {
      slot: Number(record.slot),
      timestampMs: null,
      blobCount: 0,
      maxBlobs: MAX_BLOBS_PER_BLOCK,
      streamBlobCount: 0,
      blobs: [],
      error: '',
    }
    const segment = state.segments.find((candidate) => candidate.cacheKey === record.cacheKey)
    for (const hash of segment?.blobVersionedHashes || []) {
      const stream = known.get(normalizeHex(hash)) || null
      row.blobs.push({
        index: row.blobs.length,
        versionedHash: normalizeHex(hash),
        isStreamBlob: Boolean(stream),
        stream,
      })
    }
    row.blobCount = row.blobs.length
    row.streamBlobCount = row.blobs.filter((blob) => blob.isStreamBlob).length
    rows.set(record.slot, row)
  }
  return [...rows.values()].sort((a, b) => b.slot - a.slot)
}

function renderBlobspace() {
  const blobspace = state.blobspace || { rows: [], mode: 'warming' }
  els.railMode.textContent = blobspace.mode === 'live'
    ? 'Live beacon sidecars from /eth/v1/beacon/blob_sidecars/{slot}.'
    : blobspace.warning || blobspace.mode || 'warming'
  const rows = [...(blobspace.rows || [])].sort((a, b) => Number(b.slot) - Number(a.slot))
  els.slots.innerHTML = rows.map((row) => {
    const blobs = row.blobs || []
    const byIndex = new Map(blobs.map((blob) => [Number(blob.index), blob]))
    const max = row.maxBlobs || MAX_BLOBS_PER_BLOCK
    const cells = Array.from({ length: max }, (_, index) => {
      const blob = byIndex.get(index)
      const kind = blob?.isStreamBlob ? 'stream' : blob ? 'other' : ''
      const label = blob?.isStreamBlob
        ? `segment #${blob.stream.sequence} ${shortHash(blob.stream.txHash)}`
        : blob?.versionedHash || 'empty'
      return `<span class="blob-cell ${kind}" title="${escapeHtml(label)}"></span>`
    }).join('')
    const streamCount = Number(row.streamBlobCount || 0)
    return `
      <section class="slot">
        <div class="slot-top">
          <strong>Slot ${escapeHtml(row.slot)}</strong>
          <span>${Number(row.blobCount || blobs.length)} / ${max} blobs${streamCount ? ` - ${streamCount} stream` : ''}</span>
        </div>
        <div class="slot-meta"><span><strong>Local</strong> ${escapeHtml(fmtLocalTime(row.timestampMs))}</span><span>${row.error ? 'endpoint miss' : ''}</span></div>
        <div class="blob-grid">${cells}</div>
        ${row.error ? `<div class="slot-error">${escapeHtml(row.error)}</div>` : ''}
      </section>
    `
  }).join('') || '<p class="muted">No blob sidecar rows available yet.</p>'
}

function renderHealth() {
  els.executionHealth.textContent = state.activeExecutionRpc ? 'ok' : '-'
  els.beaconHealth.textContent = state.activeBeaconApi ? 'ok' : '-'
  els.executionHealth.title = state.activeExecutionRpc
  els.beaconHealth.title = state.activeBeaconApi
}

function render() {
  const activeRecord = currentRecord()
  const latestSegment = [...state.segments].sort((a, b) => a.sequence - b.sequence).at(-1) || null
  els.knownCount.textContent = String(state.segments.length)
  els.verifiedCount.textContent = String(state.verified.size)
  els.metadataAge.textContent = fmtAge(state.metadataUpdatedAt)
  els.streamToggle.textContent = state.streaming ? 'LIVE' : 'LIVE'
  els.streamToggle.classList.toggle('active', state.streaming)
  els.loopToggle?.classList.toggle('active', state.loopReplay)
  const stationOnline = Boolean(activeRecord)
  els.stationState.textContent = stationOnline ? 'LIVE' : 'OFFLINE'
  document.querySelector('.status-badge')?.classList.toggle('online', stationOnline)
  els.networkLabel.textContent = CHAIN_PRESETS[state.config.chainPreset]?.label || state.config.chainPreset
  els.nowTitle.textContent = activeRecord ? `Playing segment #${activeRecord.sequence}` : 'Waiting for stream segments'
  els.nowDetail.textContent = 'Execution RPC announces segments; beacon sidecars carry the bytes.'
  els.metricSegment.textContent = activeRecord ? `#${activeRecord.sequence}` : latestSegment ? `#${latestSegment.sequence}` : '-'
  els.metricPayload.textContent = activeRecord ? fmtBytes(activeRecord.bytes) : latestSegment ? fmtBytes(latestSegment.payloadBytes) : '-'
  els.metricBlobs.textContent = latestSegment ? String(latestSegment.blobCount || '-') : '-'
  els.metricLatency.textContent = latestSegment ? fmtLatency(latestSegment) : '-'
  els.metricFetch.textContent = latestSegment && state.activeBeaconApi ? 'ok / ok' : '- / -'
  renderHealth()
  renderBlobspace()
  els.segments.innerHTML = state.segments.map((segment) => {
    const record = state.verified.get(segment.cacheKey)
    const queued = state.prefetching.has(segment.cacheKey)
    return `
      <section class="segment-row ${record ? 'verified' : ''}">
        <strong>#${escapeHtml(segment.sequence)}</strong>
        <span>${escapeHtml(segmentArrived(segment))}</span>
        <span title="${escapeHtml(segment.txHash)}">${escapeHtml(shortHash(segment.txHash))}</span>
        <span>${escapeHtml(segment.blobCount)}</span>
        <button type="button" data-key="${escapeHtml(segment.cacheKey)}">${record ? 'PLAY' : queued ? '...' : 'GET'}</button>
      </section>
    `
  }).join('') || '<div class="empty-row">No stream segments yet</div>'
}

async function refresh() {
  if (state.busy) return
  state.busy = true
  els.refresh.disabled = true
  setStatus('Reading Station events from execution RPC...')
  try {
    state.segments = await fetchLogs()
    await cacheSegmentMetadata(state.segments)
    if (!state.activeBeaconApi) {
      await beacon('/eth/v1/beacon/genesis').catch(() => null)
    }
    for (const segment of state.segments) {
      const cached = await cachedSegment(segment.cacheKey)
      if (cached) state.verified.set(segment.cacheKey, cached)
    }
    await refreshCacheStats()
    await refreshBlobspace()
    render()
    prefetchWindow()
    setStatus(`Loaded ${state.segments.length} Station events, ${state.verified.size} verified locally.`)
  } catch (error) {
    setStatus(error.message)
  } finally {
    state.busy = false
    els.refresh.disabled = false
  }
}

function startStreaming() {
  state.streaming = true
  render()
  void refresh().then(() => {
    const record = latestVerifiedRecord()
    if (record && !els.player.currentSrc) playRecord(record)
  })
  clearInterval(state.refreshTimer)
  state.refreshTimer = setInterval(() => void refresh(), 15000)
}

function stopStreaming() {
  state.streaming = false
  clearInterval(state.refreshTimer)
  state.refreshTimer = null
  render()
}

function fillForm() {
  els.chainPreset.innerHTML = Object.entries(CHAIN_PRESETS)
    .map(([key, preset]) => `<option value="${key}">${preset.label}</option>`)
    .join('')
  els.chainPreset.value = state.config.chainPreset
  els.streamId.value = state.config.streamId
  els.stationAddress.value = state.config.stationAddress
  els.fromBlock.value = state.config.fromBlock
  els.executionRpcs.value = state.config.executionRpcs.join('\n')
  els.beaconApis.value = state.config.beaconApis.join('\n')
  els.archiveTemplates.value = state.config.archiveTemplates.join('\n')
  els.cacheLimit.value = String(state.config.cacheLimitMb)
}

function exportIndex() {
  allCachedSegments().then((records) => {
    const index = {
      app: 'eth-radio',
      exportedAt: new Date().toISOString(),
      streamId: state.config.streamId,
      records: records.map(({ payload, ...record }) => record),
    }
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(index, null, 2)}\n`], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `rfe-cache-index-${state.config.streamId}.json`
    link.click()
    URL.revokeObjectURL(url)
  })
}

on(els.form, 'submit', (event) => {
  event.preventDefault()
  state.config = {
    ...state.config,
    chainPreset: els.chainPreset.value,
    streamId: els.streamId.value.trim() || DEFAULTS.streamId,
    stationAddress: els.stationAddress.value.trim() || DEFAULTS.stationAddress,
    fromBlock: els.fromBlock.value.trim() || DEFAULTS.fromBlock,
    executionRpcs: unique(parseLines(els.executionRpcs.value)).length ? unique(parseLines(els.executionRpcs.value)) : DEFAULTS.executionRpcs,
    beaconApis: unique(parseLines(els.beaconApis.value)).length ? unique(parseLines(els.beaconApis.value)) : DEFAULTS.beaconApis,
    archiveTemplates: unique(parseLines(els.archiveTemplates.value)),
    cacheLimitMb: Number(els.cacheLimit.value || DEFAULTS.cacheLimitMb),
  }
  saveConfig(state.config)
  state.segments = []
  state.verified.clear()
  state.activeExecutionRpc = ''
  state.activeBeaconApi = ''
  state.metadataUpdatedAt = ''
  state.blobspace = { mode: 'warming', rows: [], warning: '' }
  els.headBlock.textContent = '-'
  els.headSlot.textContent = '-'
  render()
  void refresh()
})

on(els.chainPreset, 'change', () => {
  const preset = CHAIN_PRESETS[els.chainPreset.value] || CHAIN_PRESETS[DEFAULTS.chainPreset]
  els.streamId.value = preset.streamId
  els.stationAddress.value = preset.stationAddress
  els.fromBlock.value = preset.fromBlock
  els.executionRpcs.value = preset.executionRpcs.join('\n')
  els.beaconApis.value = preset.beaconApis.join('\n')
})

on(els.refresh, 'click', () => void refresh())
on(els.streamToggle, 'click', () => {
  if (state.streaming) stopStreaming()
  else startStreaming()
})
on(els.loopToggle, 'click', () => {
  state.loopReplay = !state.loopReplay
  els.player.loop = state.loopReplay
  render()
})
on(els.muteToggle, 'click', () => {
  els.player.muted = !els.player.muted
  els.muteToggle.innerHTML = els.player.muted ? '&#128263;' : '&#128266;'
})
on(els.volume, 'input', () => {
  els.player.volume = Number(els.volume.value)
})
on(els.playLatest, 'click', () => {
  const record = latestVerifiedRecord()
  if (record) playRecord(record)
})
on(els.watchSegment, 'click', () => {
  const query = normalizeHex(els.segmentLookup.value.trim())
  if (!query) return
  const segment = state.segments.find((candidate) => {
    return normalizeHex(candidate.txHash).includes(query.replace(/^0x/, ''))
      || String(candidate.sequence) === query
      || candidate.blobVersionedHashes.some((hash) => normalizeHex(hash).includes(query.replace(/^0x/, '')))
  })
  if (!segment) {
    setStatus('No matching stream segment found in the current window.')
    return
  }
  const record = state.verified.get(segment.cacheKey)
  if (record) playRecord(record)
  else void verifySegment(segment).then(playRecord).catch((error) => setStatus(error.message)).finally(render)
})
on(els.exportIndex, 'click', exportIndex)
on(els.clearCache, 'click', () => void clearCache().then(() => setStatus('Browser cache cleared.')))
on(els.player, 'ended', () => {
  if (!state.streaming) return
  const current = currentRecord()
  const next = current ? nextVerifiedRecord(current) : null
  if (next) {
    playRecord(next)
    return
  }
  void refresh().then(() => {
    const refreshedCurrent = currentRecord()
    const refreshedNext = refreshedCurrent ? nextVerifiedRecord(refreshedCurrent) : latestVerifiedRecord()
    if (refreshedNext) playRecord(refreshedNext)
  })
})
on(els.segments, 'click', async (event) => {
  const button = event.target.closest('button[data-key]')
  if (!button) return
  const segment = state.segments.find((candidate) => candidate.cacheKey === button.dataset.key)
  if (!segment) return
  button.disabled = true
  setStatus(`Verifying segment #${segment.sequence}...`)
  try {
    const record = await verifySegment(segment)
    render()
    playRecord(record)
    setStatus(`Playing verified segment #${segment.sequence}.`)
  } catch (error) {
    setStatus(error.message)
  } finally {
    button.disabled = false
  }
})

setInterval(() => {
  els.utcClock.textContent = fmtUtcClock()
}, 1000)
els.utcClock.textContent = fmtUtcClock()
fillForm()
render()
void refreshCacheStats()
void restoreSegmentMetadata().finally(() => void refresh())
if (els.player && els.volume) els.player.volume = Number(els.volume.value)
