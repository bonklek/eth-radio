const CHAIN_PRESETS = {
  sepolia: {
    label: 'Sepolia',
    explorerTxBase: 'https://sepolia.etherscan.io/tx/',
    explorerAddressBase: 'https://sepolia.etherscan.io/address/',
    beaconSlotBase: 'https://sepolia.beaconcha.in/slot/',
    streamId: 'rfe-baked-clock-pipe-v6',
    stationAddress: '0x060c51d481808b506dfae72f054f39e11e4f4017',
    fromBlock: '11226386',
    executionRpcs: ['https://sepolia.drpc.org', 'https://ethereum-sepolia-rpc.publicnode.com'],
    beaconApis: ['https://ethereum-sepolia-beacon-api.publicnode.com'],
  },
  mainnet: {
    label: 'Mainnet',
    explorerTxBase: 'https://etherscan.io/tx/',
    explorerAddressBase: 'https://etherscan.io/address/',
    beaconSlotBase: 'https://beaconscan.com/slot/',
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
  logWindowBlocks: 96,
  cacheLimitMb: 512,
  executionRpcs: ['https://sepolia.drpc.org', 'https://ethereum-sepolia-rpc.publicnode.com'],
  beaconApis: ['https://ethereum-sepolia-beacon-api.publicnode.com'],
  archiveTemplates: [],
}

const EVENT_TOPIC = '0xfd61253da387da4d87d036a0276340bc4f04ff7c1173999c8392b158030f04c3'
const DB_NAME = 'radio-free-ethereum-static-v3'
const DB_VERSION = 3
const MAX_BLOBS_PER_BLOCK = 21
const SLOT_WINDOW = 10
const DEFAULT_BLOBSPACE_ROWS = []
const INITIAL_URL_STATE = readUrlState()
const els = {
  form: document.querySelector('#settings'),
  themeToggle: document.querySelector('#theme-toggle'),
  chainButtons: document.querySelectorAll('[data-chain-preset]'),
  chainPreset: document.querySelector('#chain-preset'),
  endpointPresets: document.querySelector('#endpoint-presets'),
  endpointSummary: document.querySelector('#endpoint-summary'),
  endpointApplyStatus: document.querySelector('#endpoint-apply-status'),
  resetPresetEndpoints: document.querySelector('#reset-preset-endpoints'),
  streamId: document.querySelector('#stream-id'),
  stationAddress: document.querySelector('#station-address'),
  stationLookup: document.querySelector('#station-lookup'),
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
  stationExplorer: document.querySelector('#station-explorer'),
  nowTitle: document.querySelector('#now-title'),
  nowDetail: document.querySelector('#now-detail'),
  segmentLookup: document.querySelector('#segment-lookup'),
  lookupMessage: document.querySelector('#lookup-message'),
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
  streamHealth: document.querySelector('#stream-health'),
  executionHealth: document.querySelector('#execution-health'),
  beaconHealth: document.querySelector('#beacon-health'),
  railMode: document.querySelector('#rail-mode'),
  blobspaceStatus: document.querySelector('#blobspace-status'),
  slots: document.querySelector('#slots'),
  segmentRailResizer: document.querySelector('#segment-rail-resizer'),
  segments: document.querySelector('#segments'),
}

const sunIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>'
const moonIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>'
const refreshIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>'
const volumeOnIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"></path><path d="M15 9.5a4 4 0 0 1 0 5"></path><path d="M18 6.5a8 8 0 0 1 0 11"></path></svg>'
const volumeOffIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"></path><path d="m16 10 5 5"></path><path d="m21 10-5 5"></path></svg>'

let state = {
  config: loadConfig(INITIAL_URL_STATE.config),
  segments: [],
  verified: new Map(),
  objectUrls: new Map(),
  sidecarMemoryCache: new Map(),
  activeExecutionRpc: '',
  activeBeaconApi: '',
  endpointHealth: {
    execution: { state: 'idle', message: '' },
    beacon: { state: 'idle', message: '' },
  },
  blobspace: { mode: 'sample', rows: defaultBlobspaceRows(), warning: '' },
  metadataUpdatedAt: '',
  currentRecordKey: '',
  playbackState: 'waiting',
  selectedSegmentQuery: INITIAL_URL_STATE.segment,
  blockTimes: new Map(),
  muteTouched: false,
  streaming: false,
  loopReplay: false,
  busy: false,
  refreshSerial: 0,
  refreshSpinToken: 0,
  anchor: null,
  refreshTimer: null,
  blobspaceTimer: null,
  prefetching: new Set(),
  prefetchPromises: new Map(),
}

function parseLines(value) {
  return String(value || '').split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean)
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function sameList(left, right) {
  const a = unique(left || [])
  const b = unique(right || [])
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function isHttpEndpoint(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function validateEndpointList(label, values) {
  if (!values.length) return [`${label} requires at least one endpoint.`]
  return values
    .filter((value) => !isHttpEndpoint(value))
    .map((value) => `${label} endpoint is not a valid HTTP(S) URL: ${value}`)
}

function normalizeStationAddressInput(value) {
  const address = extractAddress(value)
  if (address) return address
  const trimmed = String(value || '').trim()
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed.toLowerCase() : ''
}

function readUrlState() {
  const params = new URLSearchParams(window.location.search)
  const config = {}
  const chainPreset = params.get('network') || params.get('chainPreset')
  if (CHAIN_PRESETS[chainPreset]) config.chainPreset = chainPreset
  if (params.has('stream')) config.streamId = params.get('stream')
  if (params.has('streamId')) config.streamId = params.get('streamId')
  if (params.has('station')) config.stationAddress = params.get('station')
  if (params.has('stationAddress')) config.stationAddress = params.get('stationAddress')
  if (params.has('fromBlock')) config.fromBlock = params.get('fromBlock')
  if (params.has('executionRpcs')) config.executionRpcs = parseLines(params.get('executionRpcs'))
  if (params.has('executionRpc')) config.executionRpcs = parseLines(params.get('executionRpc'))
  if (params.has('beaconApis')) config.beaconApis = parseLines(params.get('beaconApis'))
  if (params.has('beaconApi')) config.beaconApis = parseLines(params.get('beaconApi'))
  if (params.has('archiveTemplates')) config.archiveTemplates = parseLines(params.get('archiveTemplates'))
  if (params.has('cacheLimitMb')) config.cacheLimitMb = Number(params.get('cacheLimitMb'))
  return { config, segment: params.get('segment') || params.get('tx') || '' }
}

function syncUrlState({ segment = state?.selectedSegmentQuery || '' } = {}) {
  const params = new URLSearchParams(window.location.search)
  params.set('network', state.config.chainPreset)
  params.set('stream', state.config.streamId || '')
  params.set('station', state.config.stationAddress || '')
  params.set('fromBlock', state.config.fromBlock || '')
  params.delete('executionRpcs')
  params.delete('executionRpc')
  params.delete('beaconApis')
  params.delete('beaconApi')
  params.delete('archiveTemplates')
  params.set('cacheLimitMb', String(state.config.cacheLimitMb || DEFAULTS.cacheLimitMb))
  if (segment) params.set('segment', segment)
  else params.delete('segment')
  const query = params.toString()
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
  window.history.replaceState(null, '', nextUrl)
}

function loadConfig(urlConfig = {}) {
  const saved = safeJsonObject(localStorage.getItem('rfe-static-config'))
  const preset = CHAIN_PRESETS[urlConfig.chainPreset] ? urlConfig.chainPreset : CHAIN_PRESETS[saved.chainPreset] ? saved.chainPreset : DEFAULTS.chainPreset
  const presetDefaults = CHAIN_PRESETS[preset]
  const merged = { ...saved, ...urlConfig, chainPreset: preset }
  const stationAddress = normalizeStationAddressInput(merged.stationAddress) || presetDefaults.stationAddress
  return {
    ...DEFAULTS,
    ...presetDefaults,
    ...merged,
    chainPreset: preset,
    stationAddress,
    executionRpcs: Object.hasOwn(merged, 'executionRpcs') || Object.hasOwn(merged, 'executionRpc') ? unique(parseLines(merged.executionRpcs || merged.executionRpc)) : presetDefaults.executionRpcs,
    beaconApis: Object.hasOwn(merged, 'beaconApis') || Object.hasOwn(merged, 'beaconApi') ? unique(parseLines(merged.beaconApis || merged.beaconApi)) : presetDefaults.beaconApis,
    archiveTemplates: Object.hasOwn(merged, 'archiveTemplates') ? unique(parseLines(merged.archiveTemplates)) : DEFAULTS.archiveTemplates,
    logWindowBlocks: positiveNumber(merged.logWindowBlocks, DEFAULTS.logWindowBlocks),
    cacheLimitMb: positiveNumber(merged.cacheLimitMb, DEFAULTS.cacheLimitMb),
  }
}

function saveConfig(config) {
  localStorage.setItem('rfe-static-config', JSON.stringify(config))
  syncUrlState()
}

function setTheme(theme) {
  const light = theme === 'light'
  document.body.classList.toggle('light', light)
  els.themeToggle.innerHTML = light ? moonIcon : sunIcon
  els.themeToggle.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode')
  els.themeToggle.title = light ? 'Dark mode' : 'Light mode'
  try {
    localStorage.setItem('rfe-theme', light ? 'light' : 'dark')
  } catch {
  }
}

function initTheme() {
  let saved = ''
  try {
    saved = localStorage.getItem('rfe-theme') || ''
  } catch {
  }
  setTheme(saved === 'light' ? 'light' : 'dark')
}

function applySegmentRailHeight(height) {
  const next = Math.max(180, Math.min(560, Number(height) || 280))
  document.documentElement.style.setProperty('--segment-rail-height', `${next}px`)
  try {
    localStorage.setItem('rfe-segment-rail-height', String(next))
  } catch {
  }
  return next
}

function initSegmentRailResize() {
  let saved = 280
  try {
    saved = Number(localStorage.getItem('rfe-segment-rail-height') || saved)
  } catch {
  }
  applySegmentRailHeight(saved)
  on(els.segmentRailResizer, 'pointerdown', (event) => {
    event.preventDefault()
    const panel = document.querySelector('.segments-panel')
    const startY = event.clientY
    const startHeight = panel?.getBoundingClientRect().height || saved
    els.segmentRailResizer.setPointerCapture(event.pointerId)
    const move = (moveEvent) => {
      applySegmentRailHeight(startHeight + startY - moveEvent.clientY)
    }
    const up = (upEvent) => {
      els.segmentRailResizer.releasePointerCapture(upEvent.pointerId)
      els.segmentRailResizer.removeEventListener('pointermove', move)
      els.segmentRailResizer.removeEventListener('pointerup', up)
      els.segmentRailResizer.removeEventListener('pointercancel', up)
    }
    els.segmentRailResizer.addEventListener('pointermove', move)
    els.segmentRailResizer.addEventListener('pointerup', up)
    els.segmentRailResizer.addEventListener('pointercancel', up)
  })
  on(els.segmentRailResizer, 'keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const current = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--segment-rail-height'), 10) || saved
    applySegmentRailHeight(current + (event.key === 'ArrowUp' ? 24 : -24))
  })
}

function setStatus(value) {
  els.status.textContent = value
}

function defaultBlobspaceRows() {
  return DEFAULT_BLOBSPACE_ROWS.map((row) => ({
    ...row,
    timestampMs: null,
    maxBlobs: MAX_BLOBS_PER_BLOCK,
    streamBlobCount: 0,
    blobs: Array.from({ length: row.blobCount }, (_, index) => ({
      index,
      versionedHash: '',
      isStreamBlob: false,
      stream: null,
    })),
    error: '',
  }))
}

function on(element, eventName, handler) {
  if (element) element.addEventListener(eventName, handler)
}

function updateVolumeFill() {
  if (!els.volume) return
  const min = Number(els.volume.min || 0)
  const max = Number(els.volume.max || 1)
  const value = Number(els.volume.value || 0)
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100
  els.volume.style.setProperty('--volume-fill', `${Math.max(0, Math.min(100, percent))}%`)
}

function renderMuteIcon() {
  if (!els.muteToggle || !els.player) return
  els.muteToggle.innerHTML = els.player.muted ? volumeOffIcon : volumeOnIcon
  els.muteToggle.setAttribute('aria-pressed', els.player.muted ? 'true' : 'false')
  els.muteToggle.setAttribute('aria-label', els.player.muted ? 'Unmute' : 'Mute')
  els.muteToggle.title = els.player.muted ? 'Unmute' : 'Mute'
}

function normalizeHex(value) {
  return String(value || '').toLowerCase()
}

function extractTxHash(value) {
  return String(value || '').match(/0x[a-fA-F0-9]{64}/)?.[0]?.toLowerCase() || ''
}

function extractAddress(value) {
  return String(value || '').match(/0x[a-fA-F0-9]{40}/)?.[0]?.toLowerCase() || ''
}

function isExplorerUrl(value) {
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol)
  } catch {
    return false
  }
}

function parseLookupInput(value) {
  const raw = String(value || '').trim()
  if (!raw) return { kind: 'empty', valid: false, query: '', message: 'Paste a transaction URL, transaction hash, blob hash, block number, or sequence.' }
  const txHash = extractTxHash(raw)
  if (isExplorerUrl(raw)) {
    const url = new URL(raw)
    const pathParts = url.pathname.split('/').filter(Boolean)
    if (pathParts[0] === 'tx' && txHash) return { kind: 'tx-url', valid: true, query: txHash, message: `Explorer transaction URL recognized: ${shortHash(txHash)}.` }
    if (pathParts[0] === 'block' && /^\d+$/.test(pathParts[1] || '')) return { kind: 'block-url', valid: true, query: pathParts[1], message: `Explorer block URL recognized: block ${pathParts[1]}.` }
    if (txHash) return { kind: 'hash-url', valid: true, query: txHash, message: `Explorer URL contains hash ${shortHash(txHash)}.` }
    return { kind: 'invalid', valid: false, query: raw, message: 'Explorer URL did not contain a supported transaction hash or block number.' }
  }
  if (/^0x[a-fA-F0-9]{64}$/.test(raw)) {
    const normalized = normalizeHex(raw)
    return normalized.startsWith('0x01')
      ? { kind: 'blob-hash', valid: true, query: normalized, message: `Blob versioned hash recognized: ${shortHash(normalized)}.` }
      : { kind: 'tx-hash', valid: true, query: normalized, message: `Transaction hash recognized: ${shortHash(normalized)}.` }
  }
  if (/^\d+$/.test(raw)) {
    return { kind: 'number', valid: true, query: raw, message: `Number recognized: segment sequence or block ${raw}.` }
  }
  if (txHash) return { kind: 'tx-hash', valid: true, query: txHash, message: `Transaction hash recognized: ${shortHash(txHash)}.` }
  return { kind: 'invalid', valid: false, query: raw, message: 'Invalid lookup. Use an explorer URL, 0x-prefixed 32-byte hash, block number, or segment sequence.' }
}

function updateLookupMessage(parsed = parseLookupInput(els.segmentLookup?.value || '')) {
  if (!els.lookupMessage) return parsed
  els.lookupMessage.textContent = parsed.message
  els.lookupMessage.dataset.state = parsed.valid || parsed.kind === 'empty' ? 'ok' : 'error'
  return parsed
}

function strip0x(value) {
  return String(value || '').replace(/^0x/i, '')
}

function isBytes32Hex(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || ''))
}

function isBytes48Hex(value) {
  return /^0x[0-9a-fA-F]{96}$/.test(String(value || ''))
}

function isBlobHex(value) {
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(String(value || ''))
}

function isByteHex(value) {
  return /^(?:0x)?(?:[0-9a-fA-F]{2})*$/.test(String(value || ''))
}

function hexToBytes(value) {
  if (!isByteHex(value)) throw new Error('Invalid byte hex')
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

async function sidecarVersionedHash(sidecar) {
  const commitment = sidecar?.kzg_commitment || sidecar?.kzgCommitment
  if (!isBytes48Hex(commitment)) throw new Error('blob sidecar commitment must be 48-byte hex')
  return normalizeHex(await versionedHashFromCommitment(commitment))
}

function shortHash(value) {
  const text = String(value || '')
  return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-6)}` : text
}

function middleEllipsis(value, head = 8, tail = 6) {
  const text = String(value || '')
  return text.length > head + tail + 3 ? `${text.slice(0, head)}...${text.slice(-tail)}` : text
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

function fmtUtcMinute(timestampMs) {
  if (!timestampMs) return '-'
  return new Intl.DateTimeFormat([], {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(timestampMs))
}

function segmentTimeBlock(segment) {
  const timestampMs = segment?.createdAt ? Date.parse(segment.createdAt) : state.blockTimes.get(Number(segment?.blockNumber))
  return {
    time: fmtUtcMinute(timestampMs),
    block: segment?.blockNumber ? String(segment.blockNumber) : '-',
  }
}

function explorerTxUrl(txHash) {
  const base = CHAIN_PRESETS[state.config.chainPreset]?.explorerTxBase || CHAIN_PRESETS.sepolia.explorerTxBase
  return `${base}${encodeURIComponent(txHash)}`
}

function explorerSlotUrl(slot) {
  const base = CHAIN_PRESETS[state.config.chainPreset]?.beaconSlotBase || CHAIN_PRESETS.sepolia.beaconSlotBase
  return `${base}${encodeURIComponent(String(slot))}`
}

function stationExplorerUrl() {
  const address = normalizeHex(state.config.stationAddress)
  if (!address) return ''
  const base = CHAIN_PRESETS[state.config.chainPreset]?.explorerAddressBase || CHAIN_PRESETS.sepolia.explorerAddressBase
  return `${base}${encodeURIComponent(address)}`
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

function publicUrlLabel(value) {
  if (!value) return ''
  try {
    const url = new URL(String(value || ''))
    return `${url.protocol}//${url.host}`
  } catch {
    return 'custom endpoint'
  }
}

function publicErrorMessage(error) {
  return String(error?.message || error || 'request failed')
    .replace(/https?:\/\/[^\s"'<>)}\]]+/g, '[redacted endpoint]')
}

function abiWord(data, wordIndex, label) {
  if (!Number.isSafeInteger(wordIndex) || wordIndex < 0) throw new Error(`Invalid ${label}: word index must be non-negative`)
  const word = data.slice(wordIndex * 64, wordIndex * 64 + 64)
  if (!/^[0-9a-fA-F]{64}$/.test(word)) throw new Error(`Invalid ${label}: missing ABI word ${wordIndex}`)
  return word
}

function readWord(data, wordIndex, label = 'ABI data') {
  return BigInt(`0x${abiWord(data, wordIndex, label)}`)
}

function abiWordNumber(data, wordIndex, label = 'ABI data') {
  const value = readWord(data, wordIndex, label)
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${label}: value exceeds safe integer range`)
  return number
}

function readBytes32(data, wordIndex, label = 'ABI data') {
  return `0x${abiWord(data, wordIndex, label)}`
}

function abiOffsetWord(data, wordIndex, label) {
  const offset = abiWordNumber(data, wordIndex, label)
  if (offset < 0 || offset % 32 !== 0) {
    throw new Error(`Invalid ${label}: dynamic offset must be a 32-byte boundary`)
  }
  return offset
}

function readString(data, wordIndex, label = 'ABI string') {
  const offset = abiOffsetWord(data, wordIndex, label)
  const length = abiWordNumber(data, offset / 32, label)
  if (length < 0) throw new Error(`Invalid ${label}: string length is unsafe`)
  const start = offset * 2 + 64
  if (start + length * 2 > data.length) throw new Error(`Invalid ${label}: string extends past ABI data`)
  return new TextDecoder().decode(hexToBytes(data.slice(start, start + length * 2)))
}

function readBytes32Array(data, wordIndex, label = 'ABI bytes32 array') {
  const offset = abiOffsetWord(data, wordIndex, label)
  const length = abiWordNumber(data, offset / 32, label)
  if (length < 0) throw new Error(`Invalid ${label}: array length is unsafe`)
  const startWord = offset / 32 + 1
  return Array.from({ length }, (_, index) => readBytes32(data, startWord + index, label))
}

function rpcQuantity(value, label) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
    throw new Error(`${label} must be a JSON-RPC quantity`)
  }
  return BigInt(value)
}

function rpcQuantityNumber(value, label) {
  const quantity = rpcQuantity(value, label)
  const number = Number(quantity)
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe integer range`)
  return number
}

function bigintSafeInteger(value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe integer range`)
  return number
}

function timestampMsFromSeconds(value, label) {
  const seconds = typeof value === 'bigint' ? value : rpcQuantity(value, label)
  const milliseconds = seconds * 1000n
  const number = Number(milliseconds)
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe millisecond range`)
  return number
}

function topicAddress(topic) {
  if (!isBytes32Hex(topic)) throw new Error('Invalid Station log publisher topic')
  return `0x${strip0x(topic).slice(24)}`
}

function topicUintNumber(topic, label) {
  if (!isBytes32Hex(topic)) throw new Error(`Invalid ${label}: topic must be bytes32`)
  const value = BigInt(topic)
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${label}: value exceeds safe integer range`)
  return number
}

function assertSegmentLogShape(log) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) throw new Error('Invalid Station log: expected object')
  if (!Array.isArray(log.topics) || log.topics.length < 4) throw new Error('Invalid Station log: expected four topics')
  if (normalizeHex(log.topics[0]) !== EVENT_TOPIC) throw new Error('Invalid Station log: unexpected event topic')
  for (const [index, topic] of log.topics.slice(1, 4).entries()) {
    if (!isBytes32Hex(topic)) throw new Error(`Invalid Station log: topic ${index + 1} must be bytes32`)
  }
  if (typeof log.data !== 'string' || !isByteHex(log.data)) throw new Error('Invalid Station log: data must be byte hex')
  if (!isBytes32Hex(log.transactionHash)) throw new Error('Invalid Station log: transactionHash must be bytes32')
  if (!isBytes32Hex(log.blockHash)) throw new Error('Invalid Station log: blockHash must be bytes32')
}

function decodeSegmentLog(log) {
  assertSegmentLogShape(log)
  const data = strip0x(log.data)
  const segment = {
    app: 'eth-radio',
    version: 1,
    source: 'station',
    publisher: topicAddress(log.topics[1]),
    streamIdHash: log.topics[2],
    sequence: topicUintNumber(log.topics[3], 'Station log sequence'),
    streamId: readString(data, 0, 'Station log streamId'),
    durationMs: abiWordNumber(data, 1, 'Station log durationMs'),
    payloadBytes: abiWordNumber(data, 2, 'Station log payloadBytes'),
    payloadSha256Hex: readBytes32(data, 3, 'Station log payloadSha256'),
    payloadSha256: strip0x(readBytes32(data, 3, 'Station log payloadSha256')),
    codec: readString(data, 4, 'Station log codec'),
    previousSegmentHash: readBytes32(data, 5, 'Station log previousSegmentHash'),
    blobVersionedHashes: readBytes32Array(data, 6, 'Station log blobVersionedHashes').map(normalizeHex),
    txHash: log.transactionHash,
    transactionHash: log.transactionHash,
    blockNumber: rpcQuantityNumber(log.blockNumber, 'segment blockNumber'),
    blockHash: log.blockHash,
    transactionIndex: rpcQuantityNumber(log.transactionIndex, 'segment transactionIndex'),
    logIndex: rpcQuantityNumber(log.logIndex, 'segment logIndex'),
  }
  segment.blobCount = segment.blobVersionedHashes.length
  segment.cacheKey = `${segment.streamId}:${segment.sequence}:${segment.txHash}`
  return segment
}

async function withEndpointFallback(kind, endpoints, request) {
  if (!endpoints.length) {
    if (kind === 'execution') state.activeExecutionRpc = ''
    if (kind === 'beacon') state.activeBeaconApi = ''
    state.endpointHealth[kind] = { state: 'missing', message: `No ${kind} endpoints configured.` }
    renderHealth()
    throw new Error(`No ${kind} endpoints configured. Open Connection settings and apply a preset or custom HTTP(S) endpoint.`)
  }
  state.endpointHealth[kind] = { state: 'checking', message: `Checking ${endpoints.length} ${kind} endpoint${endpoints.length === 1 ? '' : 's'}...` }
  renderHealth()
  const failures = []
  for (const endpoint of endpoints) {
    try {
      const result = await request(endpoint.replace(/\/$/, ''))
      if (kind === 'execution') state.activeExecutionRpc = endpoint
      if (kind === 'beacon') state.activeBeaconApi = endpoint
      state.endpointHealth[kind] = { state: 'ok', message: publicUrlLabel(endpoint) }
      renderHealth()
      return result
    } catch (error) {
      failures.push(`${publicUrlLabel(endpoint)}: ${publicErrorMessage(error)}`)
    }
  }
  if (kind === 'execution') state.activeExecutionRpc = ''
  if (kind === 'beacon') state.activeBeaconApi = ''
  state.endpointHealth[kind] = { state: 'failed', message: failures.join(' | ') }
  renderHealth()
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
    return beaconData(body, pathname)
  })
}

function beaconData(response, label) {
  if (!response || typeof response !== 'object' || !('data' in response)) {
    throw new Error(`${label} response missing data`)
  }
  return response.data
}

function beaconDataArray(data, label) {
  if (!Array.isArray(data)) throw new Error(`${label} data must be an array`)
  return data
}

function decimalSafeInteger(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`${label} must be a decimal string`)
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe integer range`)
  return number
}

async function beaconGenesisTime() {
  const genesis = await beacon('/eth/v1/beacon/genesis')
  const genesisTime = genesis?.genesis_time
  if (typeof genesisTime !== 'string' || !/^\d+$/.test(genesisTime)) {
    throw new Error('beacon genesis time must be a decimal string')
  }
  return BigInt(genesisTime)
}

function slotTimestampMs(slot, genesisTime) {
  if (genesisTime == null) return null
  return timestampMsFromSeconds(genesisTime + BigInt(slot) * 12n, 'beacon slot timestamp')
}

async function latestBeaconSlot() {
  const head = await beacon('/eth/v1/beacon/headers/head')
  return beaconHeadSlot(head)
}

function beaconHeadSlot(head) {
  const slot = head?.header?.message?.slot
  return decimalSafeInteger(slot, 'beacon head slot')
}

function toBlockHex(block) {
  return `0x${BigInt(block).toString(16)}`
}

async function fetchLogs() {
  if (!state.config.stationAddress) throw new Error(`Set a Station address for ${state.config.chainPreset}.`)
  const headHex = await rpc('eth_blockNumber')
  const head = BigInt(headHex)
  els.headBlock.textContent = head.toString()
  if (state.anchor) {
    return fetchSegmentLogs(BigInt(state.anchor.blockNumber), head)
      .then((segments) => segments.filter((segment) => segmentOrder(segment) >= state.anchor.order))
  }
  const windowBlocks = BigInt(Math.max(1, Number(state.config.logWindowBlocks || DEFAULTS.logWindowBlocks)))
  const fromBlock = head > windowBlocks ? head - windowBlocks : 0n
  if (state.streaming) {
    const recent = await fetchSegmentLogs(fromBlock, head, { streamId: '' })
    const latest = recent.reduce((best, segment) => !best || segmentOrder(segment) > segmentOrder(best) ? segment : best, null)
    if (latest?.streamId && latest.streamId !== state.config.streamId) {
      tuneToStream({ streamId: latest.streamId, sequence: latest.sequence, txHash: latest.txHash }, { reset: false })
    }
    return recent.filter((segment) => segment.streamId === state.config.streamId)
  }
  return fetchSegmentLogs(fromBlock, head)
}

async function fetchSegmentLogs(fromBlock, toBlock, { streamId = state.config.streamId } = {}) {
  const logs = await rpc('eth_getLogs', [{
    address: state.config.stationAddress,
    fromBlock: toBlockHex(fromBlock),
    toBlock: toBlockHex(toBlock),
    topics: [EVENT_TOPIC],
  }])
  const segments = logs
    .map(decodeSegmentLog)
    .filter((segment) => !streamId || segment.streamId === streamId)
    .sort((a, b) =>
      a.sequence - b.sequence ||
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.logIndex - b.logIndex)
  await hydrateSegmentTimes(segments)
  return segments
}

function tuneToStream(stream, { reset = true } = {}) {
  if (!stream?.streamId || stream.streamId === state.config.streamId) return false
  state.config = { ...state.config, streamId: stream.streamId }
  saveConfig(state.config)
  fillForm()
  if (reset) {
    resetRuntimeState()
    render()
  }
  setStatus(`Tuned watcher to stream ${stream.streamId}${stream.sequence != null ? ` from segment #${stream.sequence}` : ''}.`)
  return true
}

async function hydrateSegmentTimes(segments) {
  const blocks = unique(segments.map((segment) => String(segment.blockNumber)))
    .filter((blockNumber) => !state.blockTimes.has(Number(blockNumber)))
  await Promise.all(blocks.map(async (blockNumber) => {
    try {
      const block = await rpc('eth_getBlockByNumber', [toBlockHex(blockNumber), false])
      const timestampMs = timestampMsFromSeconds(block.timestamp, 'block timestamp')
      state.blockTimes.set(Number(blockNumber), timestampMs)
      for (const segment of segments) {
        if (String(segment.blockNumber) === blockNumber) segment.createdAt = new Date(timestampMs).toISOString()
      }
    } catch {
    }
  }))
  for (const segment of segments) {
    const timestampMs = state.blockTimes.get(Number(segment.blockNumber))
    if (timestampMs && !segment.createdAt) segment.createdAt = new Date(timestampMs).toISOString()
  }
}

function receiptStationSegments(receipt) {
  if (!receipt || typeof receipt !== 'object' || !Array.isArray(receipt.logs)) {
    throw new Error('Transaction receipt logs must be an array')
  }
  const station = normalizeHex(state.config.stationAddress)
  return receipt.logs
    .filter((log) => normalizeHex(log.address) === station && normalizeHex(log.topics?.[0]) === EVENT_TOPIC)
    .map(decodeSegmentLog)
}

function segmentOrder(segment) {
  return BigInt(segment.blockNumber) * 1_000_000n
    + BigInt(segment.transactionIndex) * 1_000n
    + BigInt(segment.logIndex)
}

async function loadForwardWindowFromTx(txHash) {
  if (!state.config.stationAddress) throw new Error(`Set a Station address for ${state.config.chainPreset}.`)
  state.refreshSerial += 1
  state.segments = []
  state.verified.clear()
  state.metadataUpdatedAt = ''
  state.anchor = null
  render()
  setStatus(`Looking up transaction ${shortHash(txHash)}...`)
  const receipt = await rpc('eth_getTransactionReceipt', [txHash])
  if (!receipt) throw new Error(`Transaction ${shortHash(txHash)} was not found on ${CHAIN_PRESETS[state.config.chainPreset]?.label || state.config.chainPreset}.`)
  const anchorSegments = receiptStationSegments(receipt)
  const anchorBlock = rpcQuantityNumber(receipt.blockNumber, 'receipt blockNumber')
  const receiptTransactionIndex = rpcQuantityNumber(receipt.transactionIndex, 'receipt transactionIndex')
  const txOrder = BigInt(anchorBlock) * 1_000_000n + BigInt(receiptTransactionIndex) * 1_000n
  if (anchorSegments[0]?.streamId && anchorSegments[0].streamId !== state.config.streamId) {
    state.config = { ...state.config, streamId: anchorSegments[0].streamId }
    saveConfig(state.config)
    fillForm()
  }
  const headHex = await rpc('eth_blockNumber')
  const head = BigInt(headHex)
  els.headBlock.textContent = head.toString()
  setStatus(`Building segment window from block ${anchorBlock} forward...`)
  const forward = await fetchSegmentLogs(BigInt(anchorBlock), head)
  const anchor = anchorSegments[0] || forward.find((segment) => segmentOrder(segment) >= txOrder)
  if (!anchor) {
    throw new Error(`No Station segments for ${state.config.streamId} were found at or after ${shortHash(txHash)}.`)
  }
  const anchorOrder = anchorSegments.length ? segmentOrder(anchor) : txOrder
  state.anchor = { blockNumber: anchorBlock, order: anchorOrder, txHash }
  state.segments = forward.filter((segment) => segmentOrder(segment) >= anchorOrder)
  if (!state.segments.some((segment) => segment.cacheKey === anchor.cacheKey)) {
    state.segments.unshift(anchor)
  }
  state.segments.sort((a, b) =>
    a.sequence - b.sequence ||
    a.blockNumber - b.blockNumber ||
    a.transactionIndex - b.transactionIndex ||
    a.logIndex - b.logIndex)
  await cacheSegmentMetadata(state.segments)
  state.verified.clear()
  for (const segment of state.segments) {
    const cached = await cachedSegment(segment.cacheKey)
    if (cached) state.verified.set(segment.cacheKey, cached)
  }
  await refreshCacheStats()
  await refreshBlobspace()
  render()
  return anchor
}

async function loadForwardWindowFromBlock(blockNumber) {
  if (!state.config.stationAddress) throw new Error(`Set a Station address for ${state.config.chainPreset}.`)
  const anchorBlock = Number(blockNumber)
  if (!Number.isSafeInteger(anchorBlock) || anchorBlock < 0) throw new Error(`Invalid block number: ${blockNumber}`)
  state.refreshSerial += 1
  state.segments = []
  state.verified.clear()
  state.metadataUpdatedAt = ''
  state.anchor = null
  render()
  const headHex = await rpc('eth_blockNumber')
  const head = BigInt(headHex)
  els.headBlock.textContent = head.toString()
  if (BigInt(anchorBlock) > head) {
    throw new Error(`Block ${anchorBlock} is ahead of current ${CHAIN_PRESETS[state.config.chainPreset]?.label || state.config.chainPreset} head ${head}.`)
  }
  setStatus(`Building segment window from block ${anchorBlock} forward...`)
  const anchorOrder = BigInt(anchorBlock) * 1_000_000n
  state.anchor = { blockNumber: anchorBlock, order: anchorOrder, txHash: '' }
  state.segments = await fetchSegmentLogs(BigInt(anchorBlock), head)
  if (!state.segments.length) {
    throw new Error(`No Station segments for ${state.config.streamId} were found at or after block ${anchorBlock}.`)
  }
  await cacheSegmentMetadata(state.segments)
  state.verified.clear()
  for (const segment of state.segments) {
    const cached = await cachedSegment(segment.cacheKey)
    if (cached) state.verified.set(segment.cacheKey, cached)
  }
  await refreshCacheStats()
  await refreshBlobspace()
  render()
  return state.segments[0]
}

async function segmentSlot(segment) {
  if (segment.slot) return segment.slot
  const tx = await rpc('eth_getTransactionByHash', [segment.txHash])
  const block = await rpc('eth_getBlockByHash', [tx.blockHash, false])
  const genesis = await beaconGenesisTime()
  const timestamp = rpcQuantity(block.timestamp, 'block timestamp')
  if (timestamp < genesis) throw new Error('block timestamp is before beacon genesis')
  return bigintSafeInteger((timestamp - genesis) / 12n, 'segment slot')
}

function normalizeSidecarRecord(record, expectedSlot) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  let slot
  let expected
  try {
    slot = sidecarIndex(record.slot, 'cached sidecar slot')
    expected = sidecarIndex(expectedSlot, 'expected sidecar slot')
  } catch {
    return null
  }
  if (slot !== expected) return null
  if (!Array.isArray(record.sidecars)) return null
  const sidecars = []
  for (const sidecar of record.sidecars) {
    if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) continue
    let index
    try {
      index = sidecarIndex(sidecar.index, 'cached sidecar index')
    } catch {
      continue
    }
    const versionedHash = sidecar.versionedHash ? normalizeHex(sidecar.versionedHash) : null
    if (versionedHash !== null && !isBytes32Hex(versionedHash)) continue
    sidecars.push({
      index,
      versionedHash,
      commitment: typeof sidecar.commitment === 'string' ? sidecar.commitment : null,
      blob: typeof sidecar.blob === 'string' ? sidecar.blob : null,
    })
  }
  return { ...record, slot, sidecars }
}

function sidecarIndex(value, label) {
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return index
}

async function sidecarsForSlot(slot) {
  const cacheKey = slotSidecarsKey(slot)
  if (state.sidecarMemoryCache.has(cacheKey)) return state.sidecarMemoryCache.get(cacheKey)
  const cached = await getRecord('sidecars', cacheKey)
  const cachedRecord = normalizeSidecarRecord(cached, slot)
  const cachedAtMs = cachedRecord?.fetchedAt ? Date.parse(cachedRecord.fetchedAt) : Number.NaN
  const cacheAgeMs = Number.isFinite(cachedAtMs) ? Date.now() - cachedAtMs : Number.POSITIVE_INFINITY
  if (cachedRecord && (cachedRecord.sidecars.length || cacheAgeMs < 30_000)) {
    state.sidecarMemoryCache.set(cacheKey, cachedRecord)
    return cachedRecord
  }

  const started = performance.now()
  const rows = beaconDataArray(await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`), 'blob sidecars')
  const sidecars = await Promise.all(rows.map(async (sidecar) => {
    const commitment = sidecar.kzg_commitment || sidecar.kzgCommitment
    const versionedHash = await sidecarVersionedHash(sidecar)
    return {
      index: sidecarIndex(sidecar.index, 'beacon sidecar index'),
      versionedHash,
      commitment,
      blob: sidecar.blob || null,
    }
  }))
  const record = {
    cacheKey,
    chainPreset: state.config.chainPreset,
    slot: sidecarIndex(slot, 'beacon slot'),
    sidecars,
    fetchMs: Math.round(performance.now() - started),
    fetchedAt: new Date().toISOString(),
  }
  const normalizedRecord = normalizeSidecarRecord(record, slot)
  if (!normalizedRecord) throw new Error('Invalid sidecar cache record from beacon response')
  await putRecord('sidecars', normalizedRecord)
  state.sidecarMemoryCache.set(cacheKey, normalizedRecord)
  return normalizedRecord
}

async function sidecarsForSegment(segment) {
  const slot = await segmentSlot(segment)
  const wanted = new Set(segment.blobVersionedHashes.map(normalizeHex))
  const matches = []
  const record = await sidecarsForSlot(slot)
  if (!Array.isArray(record.sidecars)) throw new Error('Invalid sidecar cache record: sidecars must be an array')
  for (const sidecar of record.sidecars) {
    if (wanted.has(normalizeHex(sidecar.versionedHash))) matches.push(sidecar)
  }
  return { slot, matches }
}

function validSidecarMatch(match) {
  return match
    && typeof match === 'object'
    && !Array.isArray(match)
    && isBytes32Hex(match.versionedHash)
    && isBlobHex(match.blob)
}

async function reconstructPayload(segment, sidecars) {
  if (!Array.isArray(sidecars?.matches)) throw new Error('Invalid sidecar response: matches must be an array')
  const byHash = new Map()
  for (const [index, match] of sidecars.matches.entries()) {
    if (!validSidecarMatch(match)) throw new Error(`Invalid sidecar match at index ${index}`)
    byHash.set(normalizeHex(match.versionedHash), match.blob)
  }
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
      failures.push(`${publicUrlLabel(url)}: ${publicErrorMessage(error)}`)
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
    request.onsuccess = () => {
      if (!Array.isArray(request.result)) {
        reject(new Error('Invalid segment cache response: expected an array'))
        return
      }
      resolve(request.result)
    }
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
  state.blobspace = { mode: 'sample', rows: defaultBlobspaceRows(), warning: '' }
  state.sidecarMemoryCache.clear()
  for (const url of state.objectUrls.values()) URL.revokeObjectURL(url)
  state.objectUrls.clear()
  await refreshCacheStats()
  render()
}

function cachedSegmentByteLength(record) {
  const payload = record?.payload
  if (payload instanceof Blob && Number.isSafeInteger(payload.size) && payload.size >= 0) return payload.size
  if (payload instanceof ArrayBuffer && Number.isSafeInteger(payload.byteLength)) return payload.byteLength
  if (ArrayBuffer.isView(payload) && Number.isSafeInteger(payload.byteLength)) return payload.byteLength
  if (Number.isSafeInteger(record?.bytes) && record.bytes >= 0) return record.bytes
  throw new Error(`Invalid cached segment byte length for ${record?.cacheKey || 'unknown segment'}`)
}

async function enforceCacheLimit() {
  const limitBytes = Number(state.config.cacheLimitMb || DEFAULTS.cacheLimitMb) * 1024 * 1024
  const records = await allCachedSegments()
  let total = records.reduce((sum, record) => sum + cachedSegmentByteLength(record), 0)
  if (total <= limitBytes) return
  const oldest = records.sort((a, b) => String(a.verifiedAt).localeCompare(String(b.verifiedAt)))
  for (const record of oldest) {
    if (total <= limitBytes) break
    await deleteCachedSegment(record.cacheKey)
    state.verified.delete(record.cacheKey)
    total -= cachedSegmentByteLength(record)
  }
}

async function refreshCacheStats() {
  const records = await allCachedSegments()
  const total = records.reduce((sum, record) => sum + cachedSegmentByteLength(record), 0)
  els.cacheSize.textContent = fmtBytes(total)
  if (navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate()
    if (estimate.usage && estimate.quota) {
      els.cacheSize.textContent = `${fmtBytes(total)} / ${fmtBytes(estimate.quota)}`
    }
  }
}

async function cachedPayloadBytes(payload) {
  if (payload instanceof Uint8Array) return payload
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  if (payload instanceof Blob) return new Uint8Array(await payload.arrayBuffer())
  throw new Error('Cached payload is not byte data')
}

async function verifySegment(segment) {
  state.playbackState = 'buffering'
  const cached = await cachedSegment(segment.cacheKey)
  if (cached?.payload) {
    try {
      const payload = await cachedPayloadBytes(cached.payload)
      await verifyPayloadHash(segment, payload)
      const verified = {
        ...cached,
        payload,
        bytes: payload.byteLength,
        cacheHit: true,
      }
      state.verified.set(segment.cacheKey, verified)
      return verified
    } catch (error) {
      await deleteCachedSegment(segment.cacheKey).catch(() => {})
      state.verified.delete(segment.cacheKey)
      setStatus(`Discarded cached segment #${segment.sequence}: ${publicErrorMessage(error)}`)
    }
  }

  let source = 'beacon'
  let result
  try {
    result = await payloadFromBeacon(segment)
  } catch (beaconError) {
    if (state.config.archiveTemplates.length) {
      setStatus(`Blob sidecars are unavailable for segment #${segment.sequence}; trying verified archive fallback.`)
    } else {
      setStatus(`Blob sidecars are unavailable for segment #${segment.sequence}. A verified browser cache entry can still play if available.`)
    }
    const archive = await payloadFromArchive(segment)
    if (!archive) {
      throw new Error(`Blob sidecars are unavailable for segment #${segment.sequence}, and no archive fallback returned a payload that can be verified: ${publicErrorMessage(beaconError)}`)
    }
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

function prepareAudioForPlayback({ userRequested = false } = {}) {
  if (!els.player) return
  if (userRequested && !state.muteTouched) {
    els.player.muted = false
    if (!Number(els.player.volume)) {
      els.player.volume = Number(els.volume?.value || 0.85) || 0.85
    }
  }
  renderMuteIcon()
}

function playRecord(record, options = {}) {
  state.currentRecordKey = record.cacheKey
  state.playbackState = 'playing'
  state.selectedSegmentQuery = record.txHash || String(record.sequence)
  syncUrlState()
  els.player.src = objectUrl(record)
  prepareAudioForPlayback(options)
  els.empty.classList.add('hidden')
  els.stationState.textContent = 'LIVE'
  void els.player.play().catch((error) => {
    state.playbackState = 'interrupted'
    if (options.userRequested) setStatus(`Playback blocked: ${publicErrorMessage(error)}`)
    render()
  })
  warmNextSegment(record)
}

function latestVerifiedRecord() {
  return [...state.verified.values()].sort((a, b) => a.sequence - b.sequence).at(-1)
}

function nextVerifiedRecord(currentRecord) {
  return [...state.verified.values()]
    .filter((record) => record.sequence > currentRecord.sequence)
    .sort((a, b) => a.sequence - b.sequence)[0] || null
}

function nextSegmentAfter(record) {
  const index = state.segments.findIndex((segment) => segment.cacheKey === record?.cacheKey)
  return index >= 0 ? state.segments[index + 1] || null : null
}

function currentRecord() {
  return state.currentRecordKey ? state.verified.get(state.currentRecordKey) || null : null
}

async function prefetchSegment(segment) {
  if (!segment) return null
  if (state.verified.has(segment.cacheKey)) return state.verified.get(segment.cacheKey)
  if (state.prefetchPromises.has(segment.cacheKey)) return state.prefetchPromises.get(segment.cacheKey)
  state.prefetching.add(segment.cacheKey)
  const promise = verifySegment(segment)
    .then((record) => {
      objectUrl(record)
      render()
      return record
    })
    .catch(() => null)
    .finally(() => {
      state.prefetching.delete(segment.cacheKey)
      state.prefetchPromises.delete(segment.cacheKey)
    })
  state.prefetchPromises.set(segment.cacheKey, promise)
  return promise
}

function prefetchWindow() {
  const recent = [...state.segments].slice(-5)
  for (const segment of recent) void prefetchSegment(segment)
}

function warmNextSegment(record) {
  const nextSegment = nextSegmentAfter(record)
  if (nextSegment) void prefetchSegment(nextSegment)
}

function streamBlobMap() {
  const byHash = new Map()
  for (const segment of state.segments) {
    for (const hash of segment.blobVersionedHashes) {
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
  try {
    const [headSlot, genesisTime] = await Promise.all([latestBeaconSlot(), beaconGenesisTime()])
    els.headSlot.textContent = String(headSlot)
    const slots = Array.from({ length: SLOT_WINDOW }, (_, index) => headSlot - index).filter((slot) => slot >= 0)
    const rows = await Promise.all(slots.map(async (slot) => {
      try {
        const record = await sidecarsForSlot(slot)
        const blobs = record.sidecars.map((sidecar) => {
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
          error: publicErrorMessage(error),
        }
      }
    }))
    state.blobspace = { mode: 'live', rows, warning: '' }
  } catch (error) {
    state.blobspace = {
      mode: 'cached',
      rows: cachedBlobspaceRows(known),
      warning: publicErrorMessage(error),
    }
  }
}

async function refreshBlobspaceRail() {
  try {
    await refreshBlobspace()
  } finally {
    render()
  }
}

function cachedBlobspaceRows(known) {
  const rows = new Map()
  for (const record of state.verified.values()) {
    if (record.slot == null) continue
    let slot
    try {
      slot = sidecarIndex(record.slot, 'cached segment slot')
    } catch {
      continue
    }
    const row = rows.get(slot) || {
      slot,
      timestampMs: null,
      blobCount: 0,
      maxBlobs: MAX_BLOBS_PER_BLOCK,
      streamBlobCount: 0,
      blobs: [],
      error: '',
    }
    const segment = state.segments.find((candidate) => candidate.cacheKey === record.cacheKey)
    if (!segment) continue
    for (const hash of segment.blobVersionedHashes) {
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
    rows.set(slot, row)
  }
  return [...rows.values()].sort((a, b) => b.slot - a.slot)
}

function renderBlobspace() {
  const blobspace = state.blobspace || { rows: [], mode: 'warming' }
  els.railMode.textContent = 'Live beacon sidecars from /eth/v1/beacon/blob_sidecars/{slot}.'
  const preset = CHAIN_PRESETS[state.config.chainPreset] || CHAIN_PRESETS[DEFAULTS.chainPreset]
  const latestSlot = els.headSlot.textContent || '-'
  const warning = blobspace.warning || 'none'
  const explorerBase = preset.explorerTxBase.replace(/\/tx\/$/, '')
  els.blobspaceStatus.innerHTML = [
    ['Latest slot', latestSlot],
    ['Warning', warning],
    ['Preset', preset.label],
    ['Explorer', explorerBase],
    ['Station metadata', state.metadataUpdatedAt ? `${fmtAge(state.metadataUpdatedAt)} old` : 'none'],
  ].map(([label, value]) => `<span><strong>${escapeHtml(label)}</strong> ${escapeHtml(value)}</span>`).join('')
  const rows = [...(blobspace.rows || [])].sort((a, b) => Number(b.slot) - Number(a.slot))
  els.slots.innerHTML = rows.map((row) => {
    const blobs = row.blobs || []
    const byIndex = new Map(blobs.map((blob) => [Number(blob.index), blob]))
    const max = row.maxBlobs || MAX_BLOBS_PER_BLOCK
    const slotUrl = explorerSlotUrl(row.slot)
    const cells = Array.from({ length: max }, (_, index) => {
      const blob = byIndex.get(index)
      const kind = blob?.isStreamBlob ? 'stream' : blob ? 'other' : ''
      const label = blob?.isStreamBlob
        ? `segment #${blob.stream.sequence} ${shortHash(blob.stream.txHash)}`
        : blob?.versionedHash || 'empty'
      if (!blob) return `<span class="blob-cell" title="${escapeHtml(label)}"></span>`
      const href = blob.isStreamBlob ? explorerTxUrl(blob.stream.txHash) : slotUrl
      return `<a class="blob-cell ${kind}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></a>`
    }).join('')
    const streamCount = Number(row.streamBlobCount || 0)
    const firstStreamBlob = blobs.find((blob) => blob.isStreamBlob)
    return `
      <section class="slot">
        <div class="slot-top">
          <a class="slot-link" href="${escapeHtml(slotUrl)}" target="_blank" rel="noopener noreferrer">Slot ${escapeHtml(row.slot)}</a>
          <span>${Number(row.blobCount || blobs.length)} / ${max} blobs${streamCount ? ` - ${streamCount} stream` : ''}</span>
          ${firstStreamBlob ? `<button class="slot-jump" type="button" data-slot-jump-tx="${escapeHtml(firstStreamBlob.stream.txHash)}" data-slot-jump-sequence="${escapeHtml(firstStreamBlob.stream.sequence)}">JUMP</button>` : ''}
        </div>
        <div class="slot-meta"><span><strong>Local</strong> ${escapeHtml(row.localTime || fmtLocalTime(row.timestampMs))}</span><span>${row.error ? 'endpoint miss' : ''}</span></div>
        <div class="blob-grid">${cells}</div>
        ${row.error ? `<div class="slot-error">${escapeHtml(row.error)}</div>` : ''}
      </section>
    `
  }).join('') || '<p class="muted">No blob sidecar rows available yet.</p>'
}

function renderHealth() {
  const execution = state.config.executionRpcs.length ? state.endpointHealth.execution : { state: 'missing', message: 'No execution RPC endpoints configured.' }
  const beacon = state.config.beaconApis.length ? state.endpointHealth.beacon : { state: 'missing', message: 'No beacon API endpoints configured.' }
  els.executionHealth.textContent = execution.state === 'idle' ? '-' : execution.state
  els.beaconHealth.textContent = beacon.state === 'idle' ? '-' : beacon.state
  els.executionHealth.title = execution.message || publicUrlLabel(state.activeExecutionRpc)
  els.beaconHealth.title = beacon.message || publicUrlLabel(state.activeBeaconApi)
}

function endpointMode() {
  const preset = CHAIN_PRESETS[state.config.chainPreset] || CHAIN_PRESETS[DEFAULTS.chainPreset]
  return sameList(state.config.executionRpcs, preset.executionRpcs)
    && sameList(state.config.beaconApis, preset.beaconApis)
    ? 'preset'
    : 'custom'
}

function renderEndpointSetup() {
  const mode = endpointMode()
  const activePreset = CHAIN_PRESETS[state.config.chainPreset] || CHAIN_PRESETS[DEFAULTS.chainPreset]
  if (els.endpointSummary) {
    els.endpointSummary.textContent = `${activePreset.label} ${mode === 'preset' ? 'preset' : 'custom'} - ${state.config.executionRpcs.length} execution / ${state.config.beaconApis.length} beacon`
    els.endpointSummary.title = [
      ...state.config.executionRpcs.map((endpoint) => `Execution: ${publicUrlLabel(endpoint)}`),
      ...state.config.beaconApis.map((endpoint) => `Beacon: ${publicUrlLabel(endpoint)}`),
    ].join('\n')
  }
  if (els.endpointApplyStatus && (!state.config.executionRpcs.length || !state.config.beaconApis.length)) {
    els.endpointApplyStatus.textContent = 'Endpoint configuration is incomplete. Add at least one execution RPC and one beacon API, or apply a preset.'
  }
  if (!els.endpointPresets) return
  els.endpointPresets.innerHTML = Object.entries(CHAIN_PRESETS).map(([key, preset]) => {
    const selected = key === state.config.chainPreset && mode === 'preset'
    return `
      <button class="endpoint-preset ${selected ? 'active' : ''}" type="button" data-endpoint-preset="${escapeHtml(key)}" aria-pressed="${selected ? 'true' : 'false'}">
        <strong>${escapeHtml(preset.label)}</strong>
        <span>${escapeHtml(preset.executionRpcs.length)} execution / ${escapeHtml(preset.beaconApis.length)} beacon</span>
      </button>
    `
  }).join('')
}

function playbackStateLabel() {
  const labels = {
    waiting: 'waiting for next slot',
    buffering: 'buffering',
    playing: 'playing',
    lagging: 'lagging',
    interrupted: 'interrupted',
    replayEnded: 'replay ended',
  }
  return labels[state.playbackState] || 'waiting for next slot'
}

function streamHealthSummary(latestSegment) {
  const activeRecord = currentRecord()
  if (!state.config.executionRpcs.length || !state.config.beaconApis.length) return 'endpoint-blocked'
  if (state.endpointHealth.execution.state === 'failed') return 'endpoint-blocked'
  if (!state.config.stationAddress) return 'station-missing'
  if (activeRecord?.cacheHit) return 'replaying from cache'
  if (activeRecord?.source === 'archive') return 'archive-backed'
  if (state.endpointHealth.beacon.state === 'failed' && state.segments.length && !state.verified.size) return 'sidecar-blocked'
  if (state.endpointHealth.beacon.state === 'failed') return 'endpoint-blocked'
  if (!state.segments.length) return state.streaming ? 'waiting for next slot' : 'no metadata'
  if (!state.verified.size) return 'metadata only'
  const latestAgeSeconds = latestSegment?.createdAt ? Math.round((Date.now() - Date.parse(latestSegment.createdAt)) / 1000) : 0
  if (latestAgeSeconds > 120) return 'stale'
  if (state.playbackState === 'buffering') return 'buffering'
  if (state.streaming && latestSegment && !state.verified.has(latestSegment.cacheKey)) return 'lagging'
  return state.streaming ? 'live' : 'replay/cache'
}

function playbackSourceLabel(record) {
  if (!record) return '- / -'
  if (record.cacheHit) return 'cache / verified'
  if (record.source === 'archive') return 'archive / verified'
  if (record.source === 'beacon') return 'beacon / verified'
  return 'cache / verified'
}

function render() {
  const activeRecord = currentRecord()
  const latestSegment = [...state.segments].sort((a, b) => a.sequence - b.sequence).at(-1) || null
  els.knownCount.textContent = String(state.segments.length)
  els.verifiedCount.textContent = String(state.verified.size)
  els.metadataAge.textContent = fmtAge(state.metadataUpdatedAt)
  const health = streamHealthSummary(latestSegment)
  els.streamHealth.textContent = health
  els.streamHealth.title = `Playback: ${playbackStateLabel()}`
  els.streamToggle.textContent = state.streaming ? 'LIVE' : 'LIVE'
  els.streamToggle.classList.toggle('active', state.streaming)
  els.loopToggle?.classList.toggle('active', state.loopReplay)
  const stationOnline = Boolean(activeRecord)
  els.stationState.textContent = stationOnline ? 'LIVE' : 'OFFLINE'
  document.querySelector('.status-badge')?.classList.toggle('online', stationOnline)
  els.networkLabel.textContent = CHAIN_PRESETS[state.config.chainPreset]?.label || state.config.chainPreset
  const stationUrl = stationExplorerUrl()
  if (stationUrl) {
    els.stationExplorer.href = stationUrl
    els.stationExplorer.textContent = 'Station'
    els.stationExplorer.removeAttribute('aria-disabled')
    els.stationExplorer.title = state.config.stationAddress
  } else {
    els.stationExplorer.href = '#'
    els.stationExplorer.textContent = 'No Station'
    els.stationExplorer.setAttribute('aria-disabled', 'true')
    els.stationExplorer.title = 'Set a Station address to open it in the block explorer.'
  }
  for (const button of els.chainButtons) {
    const active = button.dataset.chainPreset === state.config.chainPreset
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', active ? 'true' : 'false')
  }
  els.nowTitle.textContent = activeRecord ? `${playbackStateLabel()} segment #${activeRecord.sequence}` : playbackStateLabel()
  els.nowDetail.textContent = activeRecord
    ? `Stream health: ${health}. Payload source: ${playbackSourceLabel(activeRecord)}.`
    : `Stream health: ${health}. Execution RPC announces segments; beacon sidecars carry the bytes.`
  els.metricSegment.textContent = activeRecord ? `#${activeRecord.sequence}` : latestSegment ? `#${latestSegment.sequence}` : '-'
  els.metricPayload.textContent = activeRecord ? fmtBytes(activeRecord.bytes) : latestSegment ? fmtBytes(latestSegment.payloadBytes) : '-'
  els.metricBlobs.textContent = latestSegment ? String(latestSegment.blobCount || '-') : '-'
  els.metricLatency.textContent = latestSegment ? fmtLatency(latestSegment) : '-'
  els.metricFetch.textContent = activeRecord ? playbackSourceLabel(activeRecord) : latestSegment && state.activeBeaconApi ? 'ok / pending' : '- / -'
  renderHealth()
  renderEndpointSetup()
  renderBlobspace()
  els.segments.innerHTML = state.segments.map((segment) => {
    const record = state.verified.get(segment.cacheKey)
    const queued = state.prefetching.has(segment.cacheKey)
    const timeBlock = segmentTimeBlock(segment)
    const txLabel = middleEllipsis(segment.txHash, 8, 6)
    return `
      <section class="segment-row ${record ? 'verified' : ''}">
        <button class="segment-jump" type="button" data-jump-key="${escapeHtml(segment.cacheKey)}">#${escapeHtml(segment.sequence)}</button>
        <span class="segment-time"><time>${escapeHtml(timeBlock.time)}</time><small>${escapeHtml(timeBlock.block)}</small></span>
        <a class="tx-link" href="${escapeHtml(explorerTxUrl(segment.txHash))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(segment.txHash)}">${escapeHtml(txLabel)}</a>
        <span>${escapeHtml(segment.blobCount)}</span>
        <button type="button" data-key="${escapeHtml(segment.cacheKey)}">${record ? 'PLAY' : queued ? '...' : 'GET'}</button>
      </section>
    `
  }).join('') || '<div class="empty-row">No stream segments yet</div>'
}

async function refresh() {
  if (state.busy) return
  state.busy = true
  const serial = ++state.refreshSerial
  const spinToken = ++state.refreshSpinToken
  const spinStartedAt = performance.now()
  els.refresh.disabled = true
  els.refresh.classList.add('is-spinning')
  if (!state.anchor) {
    state.segments = []
    state.verified.clear()
    state.metadataUpdatedAt = ''
    state.blobspace = { mode: 'sample', rows: defaultBlobspaceRows(), warning: '' }
    render()
  }
  setStatus('Reading Station events from execution RPC...')
  try {
    const segments = await fetchLogs()
    if (serial !== state.refreshSerial) return
    state.segments = segments
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
    if (state.segments.length && !state.verified.size) {
      setStatus(`Station metadata is available for ${state.segments.length} segment${state.segments.length === 1 ? '' : 's'}; payload verification is pending sidecars, archive fallback, or browser cache.`)
    } else {
      setStatus(`Loaded ${state.segments.length} Station events, ${state.verified.size} verified locally.`)
    }
  } catch (error) {
    setStatus(publicErrorMessage(error))
  } finally {
    state.busy = false
    els.refresh.disabled = false
    const remainingSpinMs = Math.max(0, 550 - (performance.now() - spinStartedAt))
    setTimeout(() => {
      if (state.refreshSpinToken === spinToken) els.refresh.classList.remove('is-spinning')
    }, remainingSpinMs)
  }
}

function startStreaming() {
  state.streaming = true
  state.playbackState = 'waiting'
  render()
  void refresh().then(() => {
    const record = latestVerifiedRecord()
    if (record && !els.player.currentSrc) playRecord(record, { userRequested: true })
  })
  clearInterval(state.refreshTimer)
  state.refreshTimer = setInterval(() => void refresh(), 15000)
}

function stopStreaming() {
  state.streaming = false
  if (!state.currentRecordKey) state.playbackState = 'waiting'
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

function startBlobspaceRail() {
  clearInterval(state.blobspaceTimer)
  void refreshBlobspaceRail()
  state.blobspaceTimer = setInterval(() => void refreshBlobspaceRail(), 15000)
}

function presetConfig(presetKey) {
  const preset = CHAIN_PRESETS[presetKey] || CHAIN_PRESETS[DEFAULTS.chainPreset]
  return {
    ...state.config,
    ...preset,
    chainPreset: presetKey,
    executionRpcs: [...preset.executionRpcs],
    beaconApis: [...preset.beaconApis],
  }
}

function resetRuntimeState() {
  state.refreshSerial += 1
  state.refreshSpinToken += 1
  state.busy = false
  state.anchor = null
  state.segments = []
  state.verified.clear()
  state.sidecarMemoryCache.clear()
  state.activeExecutionRpc = ''
  state.activeBeaconApi = ''
  state.endpointHealth = {
    execution: { state: state.config.executionRpcs.length ? 'idle' : 'missing', message: '' },
    beacon: { state: state.config.beaconApis.length ? 'idle' : 'missing', message: '' },
  }
  state.metadataUpdatedAt = ''
  state.blobspace = { mode: 'sample', rows: defaultBlobspaceRows(), warning: '' }
  els.refresh.disabled = false
  els.refresh.classList.remove('is-spinning')
  els.headBlock.textContent = '-'
  els.headSlot.textContent = '-'
}

function applyPreset(presetKey, { refreshAfter = false } = {}) {
  if (!CHAIN_PRESETS[presetKey]) return
  state.config = presetConfig(presetKey)
  saveConfig(state.config)
  resetRuntimeState()
  fillForm()
  render()
  if (els.endpointApplyStatus) els.endpointApplyStatus.textContent = `${CHAIN_PRESETS[presetKey].label} preset endpoints applied.`
  if (refreshAfter) void refresh()
}

function formConfig() {
  const selectedPreset = CHAIN_PRESETS[els.chainPreset.value] || CHAIN_PRESETS[DEFAULTS.chainPreset]
  const executionRpcs = unique(parseLines(els.executionRpcs.value))
  const beaconApis = unique(parseLines(els.beaconApis.value))
  const endpointErrors = [
    ...validateEndpointList('Execution RPC', executionRpcs),
    ...validateEndpointList('Beacon API', beaconApis),
  ]
  if (endpointErrors.length) throw new Error(endpointErrors[0])
  const stationAddress = normalizeStationAddressInput(els.stationAddress.value)
  if (els.stationAddress.value.trim() && !stationAddress) {
    throw new Error('Station must be a 20-byte address or a block explorer address URL.')
  }
  return {
    ...state.config,
    chainPreset: els.chainPreset.value,
    streamId: els.streamId.value.trim() || selectedPreset.streamId,
    stationAddress: stationAddress || selectedPreset.stationAddress,
    fromBlock: els.fromBlock.value.trim() || selectedPreset.fromBlock,
    executionRpcs,
    beaconApis,
    archiveTemplates: unique(parseLines(els.archiveTemplates.value)),
    cacheLimitMb: positiveNumber(els.cacheLimit.value, DEFAULTS.cacheLimitMb),
  }
}

function applyCustomConfig() {
  state.config = formConfig()
  saveConfig(state.config)
  resetRuntimeState()
  fillForm()
  render()
  const mode = endpointMode()
  if (els.endpointApplyStatus) {
    els.endpointApplyStatus.textContent = mode === 'preset'
      ? 'Preset endpoint values applied from the custom form.'
      : 'Custom browser endpoint configuration applied.'
  }
  void refresh()
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
  try {
    applyCustomConfig()
  } catch (error) {
    if (els.endpointApplyStatus) els.endpointApplyStatus.textContent = publicErrorMessage(error)
    setStatus(publicErrorMessage(error))
  }
})

on(els.stationLookup, 'click', () => {
  try {
    const next = formConfig()
    state.config = next
    saveConfig(state.config)
    resetRuntimeState()
    fillForm()
    render()
    setStatus(`Looking up Station logs for ${shortHash(state.config.stationAddress)} via browser RPC...`)
    void refresh()
  } catch (error) {
    setStatus(publicErrorMessage(error))
  }
})

on(els.chainPreset, 'change', () => {
  applyPreset(els.chainPreset.value)
})

on(els.endpointPresets, 'click', (event) => {
  const button = event.target.closest('[data-endpoint-preset]')
  if (!button) return
  applyPreset(button.dataset.endpointPreset, { refreshAfter: true })
})

on(els.resetPresetEndpoints, 'click', () => {
  applyPreset(els.chainPreset.value, { refreshAfter: true })
})

for (const button of els.chainButtons) {
  on(button, 'click', () => applyPreset(button.dataset.chainPreset, { refreshAfter: true }))
}

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
  state.muteTouched = true
  els.player.muted = !els.player.muted
  renderMuteIcon()
})
on(els.volume, 'input', () => {
  els.player.volume = Number(els.volume.value)
  updateVolumeFill()
})
on(els.playLatest, 'click', () => {
  const record = latestVerifiedRecord()
  if (record) playRecord(record, { userRequested: true })
})
on(els.segmentLookup, 'input', () => {
  updateLookupMessage()
})
on(els.segmentLookup, 'paste', () => {
  setTimeout(() => {
    const parsed = updateLookupMessage()
    if (parsed.valid && parsed.query && parsed.kind !== 'number') els.segmentLookup.value = parsed.query
  }, 0)
})
on(els.segmentLookup, 'keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    els.watchSegment.click()
  }
})
on(els.watchSegment, 'click', async () => {
  const parsed = updateLookupMessage()
  if (!parsed.query) return
  if (!parsed.valid) {
    setStatus(parsed.message)
    return
  }
  const rawQuery = parsed.query
  const txHash = parsed.kind === 'tx-url' || parsed.kind === 'tx-hash' || parsed.kind === 'hash-url' ? extractTxHash(rawQuery) : ''
  const query = normalizeHex(rawQuery)
  state.selectedSegmentQuery = rawQuery
  syncUrlState()
  els.watchSegment.disabled = true
  try {
    let segment
    if (txHash) {
      segment = await loadForwardWindowFromTx(txHash)
      const record = state.verified.get(segment.cacheKey)
      if (record) {
        playRecord(record, { userRequested: true })
        setStatus(`Playing cached segment #${segment.sequence} from ${shortHash(txHash)}.`)
      } else {
        setStatus(`Loaded ${state.segments.length} segments from ${shortHash(txHash)} forward. Verifying segment #${segment.sequence}...`)
        void verifySegment(segment)
          .then((verified) => {
            playRecord(verified, { userRequested: true })
            setStatus(`Playing verified segment #${segment.sequence}.`)
          })
          .catch((error) => setStatus(publicErrorMessage(error)))
          .finally(render)
      }
      return
    } else if (parsed.kind === 'block-url') {
      segment = await loadForwardWindowFromBlock(rawQuery)
      setStatus(`Loaded ${state.segments.length} segments from block ${rawQuery} forward. Verifying segment #${segment.sequence}...`)
    } else {
      segment = state.segments.find((candidate) => {
        return String(candidate.sequence) === query
          || candidate.blobVersionedHashes.some((hash) => normalizeHex(hash).includes(query.replace(/^0x/, '')))
      })
      if (!segment) {
        if (parsed.kind === 'number') {
          segment = await loadForwardWindowFromBlock(rawQuery)
          setStatus(`Loaded ${state.segments.length} segments from block ${rawQuery} forward. Verifying segment #${segment.sequence}...`)
        } else {
          setStatus('No matching stream segment found. Paste a transaction hash, block number, or load a wider segment window.')
          return
        }
      }
    }
    const record = state.verified.get(segment.cacheKey)
    if (record) playRecord(record, { userRequested: true })
    else await verifySegment(segment).then((verified) => playRecord(verified, { userRequested: true }))
    setStatus(`Playing verified segment #${segment.sequence}.`)
  } catch (error) {
    setStatus(publicErrorMessage(error))
  } finally {
    els.watchSegment.disabled = false
    render()
  }
})
on(els.slots, 'click', async (event) => {
  const cell = event.target.closest('[data-slot-jump-tx]')
  if (!cell) return
  const txHash = normalizeHex(cell.dataset.blobTx || cell.dataset.slotJumpTx)
  const sequence = cell.dataset.blobSequence || cell.dataset.slotJumpSequence
  const segment = state.segments.find((candidate) => normalizeHex(candidate.txHash) === txHash && String(candidate.sequence) === String(sequence))
  if (!segment) {
    setStatus(`Blob metadata points to ${shortHash(txHash)}, but the segment is not loaded.`)
    return
  }
  tuneToStream({ streamId: segment.streamId, sequence: segment.sequence, txHash: segment.txHash }, { reset: false })
  state.selectedSegmentQuery = txHash
  if (els.segmentLookup) els.segmentLookup.value = txHash
  updateLookupMessage()
  syncUrlState()
  setStatus(`Verifying segment #${segment.sequence} from ${cell.dataset.slotJumpTx ? 'slot jump' : 'clicked blob'}...`)
  try {
    const record = state.verified.get(segment.cacheKey) || await verifySegment(segment)
    render()
    playRecord(record, { userRequested: true })
    setStatus(`Playing verified segment #${segment.sequence}.`)
  } catch (error) {
    setStatus(publicErrorMessage(error))
  }
})
on(els.exportIndex, 'click', exportIndex)
on(els.clearCache, 'click', () => void clearCache().then(() => setStatus('Browser cache cleared.')))
on(els.themeToggle, 'click', () => {
  setTheme(document.body.classList.contains('light') ? 'dark' : 'light')
})
on(els.player, 'ended', () => {
  const current = currentRecord()
  if (!state.streaming) {
    const nextSegment = nextSegmentAfter(current)
    if (nextSegment) {
      const ready = state.verified.get(nextSegment.cacheKey)
      if (ready) {
        playRecord(ready)
        render()
        setStatus(`Playing verified segment #${nextSegment.sequence}.`)
        return
      }
      setStatus(`Buffering next segment #${nextSegment.sequence}...`)
      void prefetchSegment(nextSegment)
        .then((record) => {
          if (!record) throw new Error(`Unable to buffer segment #${nextSegment.sequence}.`)
          playRecord(record)
          render()
          setStatus(`Playing verified segment #${nextSegment.sequence}.`)
        })
        .catch((error) => setStatus(publicErrorMessage(error)))
      return
    }
    if (state.loopReplay && state.segments.length) {
      const first = state.segments[0]
      const ready = state.verified.get(first.cacheKey)
      if (ready) {
        playRecord(ready)
        render()
        setStatus(`Playing verified segment #${first.sequence}.`)
        return
      }
      setStatus(`Looping back to segment #${first.sequence}...`)
      void prefetchSegment(first)
        .then((record) => {
          if (!record) throw new Error(`Unable to buffer segment #${first.sequence}.`)
          playRecord(record)
          render()
          setStatus(`Playing verified segment #${first.sequence}.`)
        })
        .catch((error) => setStatus(publicErrorMessage(error)))
      return
    }
    state.playbackState = 'replayEnded'
    render()
    setStatus('Replay reached the end of the loaded segment window.')
    return
  }
  if (!state.streaming) return
  const next = current ? nextVerifiedRecord(current) : null
  if (next) {
    playRecord(next)
    return
  }
  state.playbackState = 'waiting'
  render()
  void refresh().then(() => {
    const refreshedCurrent = currentRecord()
    const refreshedNext = refreshedCurrent ? nextVerifiedRecord(refreshedCurrent) : latestVerifiedRecord()
    if (refreshedNext) {
      playRecord(refreshedNext)
      return
    }
    const newestSegment = state.segments.at(-1)
    if (newestSegment && !state.verified.has(newestSegment.cacheKey)) {
      state.playbackState = 'buffering'
      render()
      setStatus(`Waiting at live edge. Verifying newest segment #${newestSegment.sequence}...`)
      void prefetchSegment(newestSegment).then((record) => {
        if (record) playRecord(record)
        else {
          state.playbackState = 'waiting'
          render()
          setStatus('Waiting for the next verified live segment.')
        }
      })
      return
    }
    state.playbackState = 'waiting'
    render()
    setStatus('Waiting for the next Station slot at the live edge.')
  })
})
on(els.segments, 'click', async (event) => {
  const jumpButton = event.target.closest('button[data-jump-key]')
  if (jumpButton) {
    const segment = state.segments.find((candidate) => candidate.cacheKey === jumpButton.dataset.jumpKey)
    if (!segment) return
    state.selectedSegmentQuery = segment.txHash
    if (els.segmentLookup) els.segmentLookup.value = segment.txHash
    updateLookupMessage()
    syncUrlState()
    jumpButton.disabled = true
    setStatus(`Jumping to segment #${segment.sequence}...`)
    try {
      const record = state.verified.get(segment.cacheKey) || await verifySegment(segment)
      render()
      playRecord(record, { userRequested: true })
      setStatus(`Playing verified segment #${segment.sequence}.`)
    } catch (error) {
      setStatus(publicErrorMessage(error))
    } finally {
      jumpButton.disabled = false
    }
    return
  }
  const button = event.target.closest('button[data-key]')
  if (!button) return
  const segment = state.segments.find((candidate) => candidate.cacheKey === button.dataset.key)
  if (!segment) return
  button.disabled = true
  setStatus(`Verifying segment #${segment.sequence}...`)
  try {
    const record = await verifySegment(segment)
    render()
    playRecord(record, { userRequested: true })
    setStatus(`Playing verified segment #${segment.sequence}.`)
  } catch (error) {
    setStatus(publicErrorMessage(error))
  } finally {
    button.disabled = false
  }
})

setInterval(() => {
  els.utcClock.textContent = fmtUtcClock()
}, 1000)
els.utcClock.textContent = fmtUtcClock()
initTheme()
initSegmentRailResize()
fillForm()
if (els.segmentLookup && state.selectedSegmentQuery) els.segmentLookup.value = state.selectedSegmentQuery
updateLookupMessage()
if (els.refresh) els.refresh.innerHTML = refreshIcon
renderMuteIcon()
updateVolumeFill()
render()
void refreshCacheStats()
startBlobspaceRail()
if (els.player && els.volume) {
  els.player.volume = Number(els.volume.value)
  renderMuteIcon()
  updateVolumeFill()
}
