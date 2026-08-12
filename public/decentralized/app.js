import {
  annotateStreamContinuity,
  assertPlayableContinuity,
  calculateSegmentRailBounds,
  canonicalStreamIdHash,
  channelIdentity,
  classifyPlaybackMode,
  archiveStreamAccessibleName,
  archiveStreamKey,
  appendArchiveSegments,
  clampCacheLimitMb,
  createArchiveAccumulator,
  endpointRequiresSessionStorage,
  favoriteAccessibleName,
  groupOldStreamsFromSegmentPublishedLogs,
  isBytes32Hex,
  matchingCachedMetadata,
  metadataScopeForConfig,
  normalizeArchiveTemplateList,
  normalizeHex,
  normalizeHttpEndpointList,
  normalizeFavoriteItem,
  normalizeFavorites,
  normalizeStationAddressInput,
  playbackModeLabel,
  incrementalStationRange,
  reconcileIncrementalStationSegments,
  retainedVerifiedRecordKeys,
  scopedSegmentIdentityKey,
  segmentContinuityPresentation,
  segmentActionAccessibleName,
  segmentIdentityKey,
  segmentIsQuarantined,
  selectPublisherScopedChannel,
  selectRecentSegmentsWithinByteBudget,
  slotJumpAccessibleName,
  withChannelIdentity,
  v1ScopedChannelIdentity,
} from './static-client-core.js'
import {
  executionTimestampSlot,
  slotStartTimestamp,
} from '../../packages/protocol/browser-kernel.js'
import {
  abiWordNumber,
  bytesToHex,
  fetchWithTimeout,
  hexToBytes,
  isAbortError,
  isBlobHex,
  isByteHex,
  isBytes48Hex,
  readBoundedJsonResponse,
  readBoundedResponseBytes,
  readBytes32,
  readBytes32Array,
  readString,
  requestAbortError,
  rpcQuantity,
  rpcQuantityNumber,
  runEndpointFallback,
  singleFlight,
  strip0x,
} from './static-client-io.js'
import { viewerAbiStringByteLimit } from './static-client-limits.js'
import {
  archiveUrl,
  normalizeSidecarRecord,
  reconstructPayload,
  segmentBlobHashes,
  segmentPayloadLength,
  sidecarIndex,
} from './static-client-media.js'
const IO_MAX_ABI_STRING_BYTES = viewerAbiStringByteLimit()
const CHAIN_PRESETS = {
  sepolia: {
    chainId: '11155111',
    label: 'Sepolia',
    explorerTxBase: 'https://sepolia.etherscan.io/tx/',
    explorerAddressBase: 'https://sepolia.etherscan.io/address/',
    beaconSlotBase: 'https://sepolia.beaconcha.in/slot/',
    streamId: 'rfe-baked-clock-pipe-v6',
    publisher: '',
    stationAddress: '0x060c51d481808b506dfae72f054f39e11e4f4017',
    fromBlock: '11226386',
    executionRpcs: ['https://sepolia.drpc.org', 'https://ethereum-sepolia-rpc.publicnode.com'],
    beaconApis: ['https://ethereum-sepolia-beacon-api.publicnode.com'],
  },
  mainnet: {
    chainId: '1',
    label: 'Mainnet',
    explorerTxBase: 'https://etherscan.io/tx/',
    explorerAddressBase: 'https://etherscan.io/address/',
    beaconSlotBase: 'https://beaconscan.com/slot/',
    streamId: 'rfe-mainnet-live',
    publisher: '',
    stationAddress: '',
    fromBlock: '0',
    executionRpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth-mainnet.g.alchemy.com/public'],
    beaconApis: ['https://ethereum-beacon-api.publicnode.com'],
  },
}

const DEFAULTS = {
  chainPreset: 'sepolia',
  chainId: '11155111',
  streamId: 'rfe-baked-clock-pipe-v6',
  publisher: '',
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
const DB_VERSION = 7
const MAX_BLOBS_PER_BLOCK = 21
const MAX_SEGMENT_BLOBS = 6
const BLOB_BYTES = 131_072
const BLOB_DATA_BYTES = BLOB_BYTES / 32 * 31
const MAX_SEGMENT_PAYLOAD_BYTES = MAX_SEGMENT_BLOBS * BLOB_DATA_BYTES
const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_BEACON_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_STATION_LOG_DATA_BYTES = 16 * 1024
const MAX_LOOKUP_INPUT_CODE_UNITS = 2048
const MAX_LOOKUP_DECIMAL_DIGITS = 78
const MAX_RPC_LOGS = 10_000
const ARCHIVE_MAX_SEGMENTS = 20_000
const ARCHIVE_MAX_STREAMS = 1_000
const LIVE_REFRESH_REORG_BLOCKS = 12
const LIVE_REFRESH_MAX_BLOCKS = 2_000
const LIVE_RETAINED_SEGMENTS = 2_048
const MAX_BLOCK_TIME_CACHE_ENTRIES = 4_096
const MAX_BLOCK_TIME_REQUEST_CONCURRENCY = 8
// Exact-anchor playback re-reads the last 12 blocks on every bounded cursor
// advance. History older than that documented reorg window is trusted as the
// continuity boundary, while only the latest 2,048 segments remain in memory.
const CACHE_LIMIT_MIN_MB = 16
const CACHE_LIMIT_MAX_MB = 2_048
const MEMORY_CACHE_MAX_MB = 64
const VERIFIED_MEMORY_MAX_BYTES = MEMORY_CACHE_MAX_MB * 1024 * 1024
const TARGET_BLOBS_PER_BLOCK = 14
const SLOT_WINDOW = 10
const MAX_SIDECAR_MEMORY_SLOTS = SLOT_WINDOW + 2
const DEFAULT_BLOBSPACE_ROWS = []
const LAYOUT_KEY = 'rfe-static-layout-preset'
const LAYOUT_SETTINGS_KEY = 'rfe-static-layout-settings-v1'
const FAVORITES_KEY = 'rfe-static-favorites-v2'
const CLOCK_KEY = 'rfe-static-clock-v1'
const BLOB_FEE_SAMPLES_KEY = 'rfe-static-blob-fee-samples-v1'
const BLOB_FEE_MAX_LOADED_SAMPLES = 2_800
const BLOB_FEE_PREFS_KEY = 'rfe-static-blob-fee-prefs-v1'
const CONFIG_KEY = 'rfe-static-config-v2'
const SESSION_ENDPOINT_CONFIG_KEY = 'rfe-static-session-endpoints-v1'
const LEGACY_CONFIG_KEY = 'rfe-static-config'
const CACHE_TOTAL_KEY = '__segment-cache-total-v1'
const BLOB_GAS_PER_BLOB = 131_072n
const BLOB_FEE_UNITS = {
  eth: 'ETH',
  gwei: 'Gwei',
  wei: 'Wei',
}
const WEI_PER_GWEI = 1_000_000_000n
const WEI_PER_ETH = 1_000_000_000_000_000_000n
const BLOB_FEE_HISTORY_CHUNK_BLOCKS = 1024
const BLOB_FEE_REFRESH_MS = 45_000
const BLOB_FEE_HIDDEN_REFRESH_MS = 5 * 60_000
const BLOB_FEE_HISTORY_WINDOWS = {
  tenMinute: { label: '10m avg', blocks: 50, cacheMs: 90_000 },
  hour: { label: '1h avg', blocks: 300, cacheMs: 3 * 60_000 },
  day: { label: '1d avg', blocks: 7200, cacheMs: 20 * 60_000 },
  week: { label: '1w avg', blocks: 50400, cacheMs: 60 * 60_000 },
}
const ARCHIVE_DEFAULT_WINDOW_BLOCKS = 50_000
const ARCHIVE_SCAN_CHUNK_BLOCKS = 2_000
const ARCHIVE_MAX_BLOCKS = 250_000
const SENSITIVE_URL_PARAMS = ['executionRpcs', 'executionRpc', 'beaconApis', 'beaconApi', 'archiveTemplates']
const PANEL_POSITIONS = {
  left: 'Left rail',
  main: 'Main',
  right: 'Right rail',
  bottom: 'Bottom',
}
const PANEL_LABELS = {
  player: 'Player',
  feeds: 'Blobspace feed',
  archive: 'Archive/favorites',
  blobFees: 'Blob fee tracker',
}
const storageStatus = {
  localStorage: 'available',
  indexedDb: 'unknown',
  localStorageError: '',
  indexedDbError: '',
}
const memoryStores = {
  segments: new Map(),
  metadata: new Map(),
}
let dbPromise = null
let cacheAccountingPromise = null
const INITIAL_URL_STATE = readUrlState()
const els = {
  startupShell: document.querySelector('#startup-shell'),
  shell: document.querySelector('#app-shell'),
  form: document.querySelector('#settings'),
  settingsToggle: document.querySelector('#settings-toggle'),
  settingsRecoveryToggle: document.querySelector('#settings-recovery-toggle'),
  settingsModal: document.querySelector('#settings-modal'),
  settingsClose: document.querySelector('#settings-close'),
  settingsTabs: document.querySelectorAll('[data-settings-tab]'),
  settingsPanels: document.querySelectorAll('[data-settings-panel]'),
  layoutPresets: document.querySelector('#layout-presets'),
  panelZones: {
    player: document.querySelector('.panel-player'),
    feeds: document.querySelector('.panel-feeds'),
    archive: document.querySelector('.panel-archive'),
    blobFees: document.querySelector('.panel-blob-fees'),
  },
  panelShow: document.querySelectorAll('[data-panel-show]'),
  panelPosition: document.querySelectorAll('[data-panel-position]'),
  panelOrder: document.querySelectorAll('[data-panel-order]'),
  layoutBottomSpan: document.querySelector('#layout-bottom-span'),
  clockMode: document.querySelector('#clock-mode'),
  clockTimeZone: document.querySelector('#clock-time-zone'),
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
  favoriteStream: document.querySelector('#favorite-stream'),
  favoriteStation: document.querySelector('#favorite-station'),
  favoriteChannel: document.querySelector('#favorite-channel'),
  loopToggle: document.querySelector('#loop-toggle'),
  muteToggle: document.querySelector('#mute-toggle'),
  volume: document.querySelector('#volume'),
  playLatest: document.querySelector('#play-latest'),
  layoutRecovery: document.querySelector('#layout-recovery'),
  recoveryStatus: document.querySelector('#status-recovery'),
  statusAnnouncer: document.querySelector('#status-announcer'),
  alertAnnouncer: document.querySelector('#alert-announcer'),
  stationState: document.querySelector('#station-state'),
  utcClock: document.querySelector('#utc-clock'),
  networkLabel: document.querySelector('#network-label'),
  stationExplorer: document.querySelector('#station-explorer'),
  nowTitle: document.querySelector('#now-title'),
  nowDetail: document.querySelector('#now-detail'),
  segmentLookup: document.querySelector('#segment-lookup'),
  lookupMessage: document.querySelector('#lookup-message'),
  watchSegment: document.querySelector('#watch-segment'),
  segmentsTitle: document.querySelector('#segments-title'),
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
  emptyRecovery: document.querySelector('#empty-recovery'),
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
  blobspaceWarning: document.querySelector('#blobspace-warning'),
  blobspaceDetails: document.querySelector('#blobspace-details'),
  slots: document.querySelector('#slots'),
  segmentRailResizer: document.querySelector('#segment-rail-resizer'),
  segments: document.querySelector('#segments'),
  archiveDetails: document.querySelector('#archive-details'),
  archiveModeButtons: document.querySelectorAll('[data-archive-mode]'),
  archiveModeFields: document.querySelectorAll('[data-archive-field]'),
  archiveScanForm: document.querySelector('#archive-scan-form'),
  archiveStation: document.querySelector('#archive-station'),
  archiveInbox: document.querySelector('#archive-inbox'),
  archivePublisher: document.querySelector('#archive-publisher'),
  archiveStreamFilter: document.querySelector('#archive-stream-filter'),
  archiveRangeMode: document.querySelector('#archive-range-mode'),
  archiveFromBlock: document.querySelector('#archive-from-block'),
  archiveFromDate: document.querySelector('#archive-from-date'),
  archiveToDate: document.querySelector('#archive-to-date'),
  archiveScan: document.querySelector('#archive-scan'),
  archiveStop: document.querySelector('#archive-stop'),
  archiveProgress: document.querySelector('#archive-progress'),
  archiveProgressBar: document.querySelector('#archive-progress-bar'),
  archiveResults: document.querySelector('#archive-results'),
  favoritesList: document.querySelector('#favorites-list'),
  blobFeeStatus: document.querySelector('#blob-fee-status'),
  blobFeeUnit: document.querySelector('#blob-fee-unit'),
  blobFeeWindow: document.querySelector('#blob-fee-window'),
  blobFeeBase: document.querySelector('#blob-fee-base'),
  blobFeePerBlob: document.querySelector('#blob-fee-per-blob'),
  blobFeeAverageLabel: document.querySelector('#blob-fee-average-label'),
  blobFeeAverage: document.querySelector('#blob-fee-average'),
  blobFeeUtilization: document.querySelector('#blob-fee-utilization'),
  blobFeeUpdated: document.querySelector('#blob-fee-updated'),
  blobFeeMessage: document.querySelector('#blob-fee-message'),
  blobFeeSparkline: document.querySelector('#blob-fee-sparkline'),
}

const sunIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="m4.93 4.93 1.41 1.41"></path><path d="m17.66 17.66 1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="m6.34 17.66-1.41 1.41"></path><path d="m19.07 4.93-1.41 1.41"></path></svg>'
const moonIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>'
const refreshIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"></path><path d="M21 3v6h-6"></path></svg>'
const volumeOnIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"></path><path d="M15 9.5a4 4 0 0 1 0 5"></path><path d="M18 6.5a8 8 0 0 1 0 11"></path></svg>'
const volumeOffIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"></path><path d="m16 10 5 5"></path><path d="m21 10-5 5"></path></svg>'
const SETTINGS_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')
let settingsFocusReturn = null
const lastStatusAnnouncement = { polite: '', assertive: '' }

let state = {
  runtimeGeneration: 0,
  runtimeController: new AbortController(),
  config: loadConfig(INITIAL_URL_STATE.config, { useSavedNetworkConfig: INITIAL_URL_STATE.localConfig }),
  segments: [],
  verified: new Map(),
  objectUrls: new Map(),
  deferredObjectUrlKeys: new Set(),
  sidecarMemoryCache: new Map(),
  sidecarFetchPromises: new Map(),
  sidecarCacheEpoch: 0,
  activeExecutionRpc: '',
  activeBeaconApi: '',
  endpointHealth: {
    execution: { state: 'idle', message: '' },
    beacon: { state: 'idle', message: '' },
  },
  blobspace: { mode: 'sample', rows: defaultBlobspaceRows(), warning: '' },
  metadataUpdatedAt: '',
  metadataState: 'none',
  currentRecordKey: '',
  playbackMode: 'idle',
  playbackIntent: 'replay',
  liveEdgeKey: '',
  playbackAdvanceToken: 0,
  playbackContextGeneration: 0,
  segmentNotice: '',
  selectedSegmentQuery: INITIAL_URL_STATE.segment,
  blockTimes: new Map(),
  blockTimeHashes: new Map(),
  muteTouched: false,
  followIntent: false,
  loopReplay: false,
  busy: false,
  refreshSerial: 0,
  refreshSpinToken: 0,
  anchor: null,
  refreshTimer: null,
  blobspaceTimer: null,
  blobspaceRefreshPromise: null,
  blobFeeTimer: null,
  prefetching: new Set(),
  prefetchPromises: new Map(),
  layoutPreset: loadLayoutPreset(),
  layoutSettings: loadLayoutSettings(),
  clock: loadClockPrefs(),
  favorites: loadFavorites(),
  archive: {
    scanning: false,
    cancel: false,
    activeController: null,
    mode: 'station',
    progress: defaultArchiveProgress('station'),
    inboxDiagnostics: { failedCandidates: 0, incompatibleCandidates: 0, failures: [] },
    tuneSerial: 0,
    tunedKey: '',
    streams: [],
    segmentsByKey: new Map(),
  },
  blobFees: loadBlobFeeSamples(),
  blobFeePrefs: loadBlobFeePrefs(),
}

function parseLines(value) {
  return String(value || '').split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean)
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function boundedStreamId(value, label = 'Stream ID') {
  const text = String(value ?? '')
  if (!text) throw new Error(`${label} must not be empty`)
  if (new TextEncoder().encode(text).byteLength > IO_MAX_ABI_STRING_BYTES) {
    throw new Error(`${label} exceeds the viewer ABI string limit of ${IO_MAX_ABI_STRING_BYTES.toLocaleString()} UTF-8 bytes`)
  }
  return text
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

function storageErrorText(error) {
  return String(error?.message || error || 'Browser storage is unavailable.').slice(0, 240)
}

function safeStorageGet(key, fallback = '') {
  try {
    const value = localStorage.getItem(key)
    return value == null ? fallback : value
  } catch (error) {
    storageStatus.localStorage = 'unavailable'
    storageStatus.localStorageError = storageErrorText(error)
    return fallback
  }
}

function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, value)
    return true
  } catch (error) {
    storageStatus.localStorage = 'unavailable'
    storageStatus.localStorageError = storageErrorText(error)
    return false
  }
}

function loadLayoutPreset() {
  const saved = safeStorageGet(LAYOUT_KEY)
  return ['default', 'player-side', 'player-top', 'player-bottom', 'horizontal-rails', 'archive-side', 'archive-bottom', 'custom'].includes(saved) ? saved : 'default'
}

function saveLayoutPreset(preset) {
  state.layoutPreset = loadLayoutPresetFromValue(preset)
  safeStorageSet(LAYOUT_KEY, state.layoutPreset)
  state.layoutSettings = layoutSettingsForPreset(state.layoutPreset)
  saveLayoutSettings()
  applyLayoutPreset()
}

function loadLayoutPresetFromValue(value) {
  return ['default', 'player-side', 'player-top', 'player-bottom', 'horizontal-rails', 'archive-side', 'archive-bottom', 'custom'].includes(value) ? value : 'default'
}

function defaultLayoutSettings() {
  return {
    bottomSpan: 'between',
    player: { visible: true, position: 'main', order: 1 },
    feeds: { visible: true, position: 'right', order: 1 },
    archive: { visible: true, position: 'bottom', order: 1 },
    blobFees: { visible: false, position: 'bottom', order: 2 },
  }
}

function layoutSettingsForPreset(preset) {
  const base = defaultLayoutSettings()
  if (preset === 'custom') return base
  const presets = {
    default: base,
    'player-side': {
      player: { visible: true, position: 'main', order: 1 },
      feeds: { visible: true, position: 'right', order: 1 },
      archive: { visible: true, position: 'right', order: 2 },
    },
    'player-top': {
      player: { visible: true, position: 'main', order: 1 },
      feeds: { visible: true, position: 'bottom', order: 1 },
      archive: { visible: true, position: 'bottom', order: 2 },
    },
    'player-bottom': {
      feeds: { visible: true, position: 'main', order: 1 },
      archive: { visible: true, position: 'right', order: 1 },
      player: { visible: true, position: 'bottom', order: 1 },
    },
    'horizontal-rails': {
      player: { visible: true, position: 'main', order: 1 },
      feeds: { visible: true, position: 'bottom', order: 1 },
      archive: { visible: true, position: 'bottom', order: 2 },
    },
    'archive-side': {
      player: { visible: true, position: 'main', order: 1 },
      feeds: { visible: true, position: 'right', order: 1 },
      archive: { visible: true, position: 'left', order: 1 },
    },
    'archive-bottom': base,
  }
  return normalizeLayoutSettings(presets[preset] || base)
}

function normalizeLayoutSettings(value) {
  const fallback = defaultLayoutSettings()
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const next = {
    bottomSpan: input.bottomSpan === 'full' ? 'full' : 'between',
  }
  for (const panel of Object.keys(PANEL_LABELS)) {
    const config = input[panel] && typeof input[panel] === 'object' ? input[panel] : fallback[panel]
    const position = Object.hasOwn(PANEL_POSITIONS, config.position) ? config.position : fallback[panel].position
    const order = Number(config.order)
    next[panel] = {
      visible: config.visible !== false,
      position,
      order: Number.isSafeInteger(order) && order > 0 && order <= 4 ? order : fallback[panel].order,
    }
  }
  if (!Object.values(next).some((panel) => panel.visible)) next.player.visible = true
  return next
}

function loadLayoutSettings() {
  const saved = safeJsonObject(safeStorageGet(LAYOUT_SETTINGS_KEY))
  if (Object.keys(saved).length) return normalizeLayoutSettings(saved)
  return layoutSettingsForPreset(loadLayoutPreset())
}

function saveLayoutSettings() {
  state.layoutSettings = normalizeLayoutSettings(state.layoutSettings)
  safeStorageSet(LAYOUT_SETTINGS_KEY, JSON.stringify(state.layoutSettings))
}

function loadClockPrefs() {
  const saved = safeJsonObject(safeStorageGet(CLOCK_KEY))
  return normalizeClockPrefs(saved)
}

function normalizeClockPrefs(value) {
  const mode = ['utc', 'local', 'timezone'].includes(value?.mode) ? value.mode : 'utc'
  const timeZone = String(value?.timeZone || '').trim().slice(0, 80)
  return { mode, timeZone }
}

function saveClockPrefs() {
  state.clock = normalizeClockPrefs(state.clock)
  safeStorageSet(CLOCK_KEY, JSON.stringify(state.clock))
}

function loadFavorites() {
  try {
    return normalizeFavorites(JSON.parse(safeStorageGet(FAVORITES_KEY, '[]')))
  } catch {
    return []
  }
}

function saveFavorites() {
  state.favorites = normalizeFavorites(state.favorites)
  safeStorageSet(FAVORITES_KEY, JSON.stringify(state.favorites))
}

function normalizeBlobFeeSample(sample) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return null
  const timestamp = Number(sample.timestamp)
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null
  const value = String(sample.baseFeePerBlobGasWei || '')
  if (value.length > 78 || !/^\d+$/.test(value)) return null
  const quantity = BigInt(value)
  if (quantity >= 1n << 256n) return null
  return { timestamp, baseFeePerBlobGasWei: quantity.toString() }
}

function loadBlobFeeSamples() {
  let samples
  try {
    const saved = JSON.parse(safeStorageGet(BLOB_FEE_SAMPLES_KEY, '[]'))
    samples = Array.isArray(saved) ? saved.slice(-BLOB_FEE_MAX_LOADED_SAMPLES).map(normalizeBlobFeeSample).filter(Boolean) : []
  } catch {
    samples = []
  }
  return {
    status: 'Unavailable',
    message: 'Blob fee tracker is off.',
    currentBaseFeeWei: null,
    currentBlobFeeWei: null,
    averages: {},
    utilization: null,
    history: {},
    samples: pruneBlobFeeSamples(samples),
    updatedAt: 0,
    loading: false,
  }
}

function pruneBlobFeeSamples(samples) {
  const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000
  return samples
    .map(normalizeBlobFeeSample)
    .filter((sample) => sample && sample.timestamp >= cutoff)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-1400)
}

function saveBlobFeeSamples() {
  state.blobFees.samples = pruneBlobFeeSamples(state.blobFees.samples)
  safeStorageSet(BLOB_FEE_SAMPLES_KEY, JSON.stringify(state.blobFees.samples))
}

function normalizeBlobFeePrefs(value) {
  const unit = Object.hasOwn(BLOB_FEE_UNITS, value?.unit) ? value.unit : 'eth'
  const historyWindow = Object.hasOwn(BLOB_FEE_HISTORY_WINDOWS, value?.historyWindow) ? value.historyWindow : 'hour'
  return { unit, historyWindow }
}

function loadBlobFeePrefs() {
  return normalizeBlobFeePrefs(safeJsonObject(safeStorageGet(BLOB_FEE_PREFS_KEY)))
}

function saveBlobFeePrefs() {
  state.blobFeePrefs = normalizeBlobFeePrefs(state.blobFeePrefs)
  safeStorageSet(BLOB_FEE_PREFS_KEY, JSON.stringify(state.blobFeePrefs))
}

function validateEndpointList(label, values) {
  try {
    normalizeHttpEndpointList(values, label)
    return []
  } catch (error) {
    return [publicErrorMessage(error)]
  }
}

function validateArchiveTemplateList(values) {
  if (!values.length) return []
  try {
    normalizeArchiveTemplateList(values)
    return []
  } catch (error) {
    return [publicErrorMessage(error)]
  }
}

function normalizedEndpointListOrEmpty(values, label) {
  try { return [...normalizeHttpEndpointList(unique(parseLines(values)), label)] } catch { return [] }
}

function normalizedArchiveTemplatesOrEmpty(values) {
  if (!parseLines(values).length) return []
  try { return [...normalizeArchiveTemplateList(unique(parseLines(values)))] } catch { return [] }
}

function configuredChannelKey(config = state.config) {
  if (!config?.publisher || !config?.streamId) return ''
  try {
    return config.chainId && config.stationAddress
      ? v1ScopedChannelIdentity(config).key
      : channelIdentity(config).key
  } catch {
    return ''
  }
}

function currentLoadedSegment(record) {
  if (!record?.cacheKey) return null
  const channelKey = configuredChannelKey()
  if (!channelKey) return null
  const segment = state.segments.find((candidate) => candidate.cacheKey === record.cacheKey) || null
  if (!segment || segment.channelKey !== channelKey || segmentIsQuarantined(segment)) return null
  try {
    const scoped = Boolean(record.chainId && record.stationAddress && record.syntheticChannelId)
    return (scoped ? v1ScopedChannelIdentity(record).key : channelIdentity(record).key) === channelKey
      && (scoped ? scopedSegmentIdentityKey(record) : segmentIdentityKey(record)) === record.cacheKey
      && record.sequence === segment.sequence
      && normalizeHex(record.txHash) === normalizeHex(segment.txHash)
      ? segment
      : null
  } catch {
    return null
  }
}

function assertCurrentLoadedSegment(record) {
  const segment = currentLoadedSegment(record)
  if (!segment) throw new Error('Segment does not belong to the currently loaded publisher-scoped channel.')
  assertPlayableContinuity(segment)
  return segment
}

function promoteVerifiedRecord(segment, record) {
  const loaded = assertCurrentLoadedSegment(segment)
  const promoted = {
    ...record,
    publisher: loaded.publisher,
    streamIdHash: loaded.streamIdHash,
    streamId: loaded.streamId,
    channelKey: loaded.channelKey,
    sequence: loaded.sequence,
    txHash: loaded.txHash,
    payloadSha256: loaded.payloadSha256,
    codec: loaded.codec,
    continuity: loaded.continuity,
    quarantined: false,
    payloadValidity: 'valid',
  }
  state.verified.set(loaded.cacheKey, promoted)
  enforceVerifiedMemoryLimit([loaded.cacheKey, state.currentRecordKey])
  loaded.payloadValidity = 'valid'
  return promoted
}

function enforceVerifiedMemoryLimit(protectedKeys = []) {
  const retainedKeys = retainedVerifiedRecordKeys([...state.verified.values()], {
    maxBytes: VERIFIED_MEMORY_MAX_BYTES,
    protectedKeys,
  })
  for (const cacheKey of state.verified.keys()) {
    if (retainedKeys.has(cacheKey)) continue
    state.verified.delete(cacheKey)
    releaseObjectUrl(cacheKey, { preserveActive: true })
  }
}

function parseArchiveStationInput(value) {
  const raw = String(value || '').trim()
  const txHash = extractTxHash(raw)
  if (txHash && !/\/address\//i.test(raw)) return { kind: 'tx', address: '', txHash }
  const address = normalizeStationAddressInput(raw)
  if (address) return { kind: 'address', address, txHash: '' }
  return { kind: 'invalid', address: '', txHash: '' }
}

function normalizeBlobVersionedHashes(value) {
  if (!Array.isArray(value)) return []
  if (value.length > MAX_SEGMENT_BLOBS) throw new Error(`blobVersionedHashes exceeds ${MAX_SEGMENT_BLOBS} entries`)
  if (value.some((hash) => !isBytes32Hex(hash))) throw new Error('blobVersionedHashes must contain unique bytes32 hex values')
  const hashes = value.map(normalizeHex)
  if (new Set(hashes).size !== hashes.length) {
    throw new Error('blobVersionedHashes must contain unique bytes32 hex values')
  }
  return hashes
}

function txBlobVersionedHashes(tx) {
  return normalizeBlobVersionedHashes(tx?.blobVersionedHashes || tx?.blob_versioned_hashes || [])
}

function sanitizedUrlParams(search) {
  const params = new URLSearchParams(search)
  let removedSensitive = false
  for (const name of SENSITIVE_URL_PARAMS) {
    if (!params.has(name)) continue
    params.delete(name)
    removedSensitive = true
  }
  return { params, removedSensitive }
}

function shareableUrlConfig(value) {
  const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    ...(config.chainPreset ? { chainPreset: config.chainPreset } : {}),
    ...(config.streamId != null ? { streamId: config.streamId } : {}),
    ...(config.streamIdHash != null ? { streamIdHash: config.streamIdHash } : {}),
    ...(config.publisher != null ? { publisher: config.publisher } : {}),
    ...(config.stationAddress != null ? { stationAddress: config.stationAddress } : {}),
    ...(config.fromBlock != null ? { fromBlock: config.fromBlock } : {}),
    ...(config.cacheLimitMb != null ? { cacheLimitMb: config.cacheLimitMb } : {}),
  }
}

function sameCanonicalSegment(left, right) {
  if (!left || !right) return false
  return left.cacheKey === right.cacheKey
    && normalizeHex(left.blockHash) === normalizeHex(right.blockHash)
    && left.blockNumber === right.blockNumber
    && left.transactionIndex === right.transactionIndex
    && left.logIndex === right.logIndex
    && normalizeHex(left.txHash) === normalizeHex(right.txHash)
    && left.sequence === right.sequence
    && left.payloadSha256 === right.payloadSha256
    && JSON.stringify((left.blobVersionedHashes || []).map(normalizeHex)) === JSON.stringify((right.blobVersionedHashes || []).map(normalizeHex))
}

function playbackContextSnapshot() {
  return state.playbackContextGeneration
}

function requireCurrentPlaybackContext(generation) {
  if (generation !== state.playbackContextGeneration) {
    throw requestAbortError('Canonical playback context changed.')
  }
}

function invalidateOrphanedActivePlayback(nextSegments) {
  if (!state.currentRecordKey) return false
  const previous = state.segments.find((segment) => segment.cacheKey === state.currentRecordKey) || null
  const replacement = nextSegments.find((segment) => segment.cacheKey === state.currentRecordKey) || null
  if (sameCanonicalSegment(previous, replacement) && !segmentIsQuarantined(replacement)) return false

  const orphanedKey = state.currentRecordKey
  state.playbackContextGeneration += 1
  state.playbackAdvanceToken += 1
  state.prefetching.clear()
  state.prefetchPromises.clear()
  if (els.player) {
    els.player.pause()
    els.player.removeAttribute('src')
    els.player.load()
  }
  state.currentRecordKey = ''
  state.liveEdgeKey = ''
  state.playbackMode = 'interrupted'
  releaseObjectUrl(orphanedKey)
  return true
}

function safeSessionJsonObject() {
  try {
    return safeJsonObject(sessionStorage.getItem(SESSION_ENDPOINT_CONFIG_KEY))
  } catch {
    return {}
  }
}

function endpointPersistenceSplit(config) {
  const persistent = { ...config }
  const session = {}
  let hasSessionOnly = false
  for (const field of ['executionRpcs', 'beaconApis', 'archiveTemplates']) {
    const values = Array.isArray(config?.[field]) ? [...config[field]] : []
    if (!values.some(endpointRequiresSessionStorage)) continue
    hasSessionOnly = true
    session[field] = values
    persistent[field] = values.filter((value) => !endpointRequiresSessionStorage(value))
  }
  return { persistent, session, hasSessionOnly }
}

function sessionEndpointConfig(preset) {
  const store = safeSessionJsonObject()
  const config = store.networks?.[preset]
  return config && typeof config === 'object' && !Array.isArray(config) ? config : {}
}

function saveSessionEndpointConfig(preset, config) {
  try {
    const store = safeSessionJsonObject()
    const networks = store.networks && typeof store.networks === 'object' && !Array.isArray(store.networks)
      ? { ...store.networks }
      : {}
    if (Object.keys(config).length) networks[preset] = config
    else delete networks[preset]
    sessionStorage.setItem(SESSION_ENDPOINT_CONFIG_KEY, JSON.stringify({ networks }))
    return true
  } catch {
    return false
  }
}

function configPersistenceNotice(result) {
  if (!result.persistent) return ' Browser settings are unavailable, so this choice lasts only for this tab.'
  if (result.hasSessionOnly && result.session) return ' URLs with user information or query parameters are session-only and were not written to persistent storage.'
  if (result.hasSessionOnly) return ' Sensitive URL persistence is unavailable, so those URLs last only until this page reloads.'
  return ''
}

function readUrlState() {
  const localConfig = window.history.state?.rfeLocalConfig === true
  const { params, removedSensitive } = sanitizedUrlParams(window.location.search)
  if (removedSensitive) {
    const query = params.toString()
    const cleanUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
    window.history.replaceState(localConfig ? { rfeLocalConfig: true } : null, '', cleanUrl)
  }
  const config = {}
  const chainPreset = params.get('network') || params.get('chainPreset')
  if (CHAIN_PRESETS[chainPreset]) config.chainPreset = chainPreset
  if (params.has('stream')) config.streamId = params.get('stream')
  if (params.has('streamId')) config.streamId = params.get('streamId')
  if (params.has('streamIdHash')) config.streamIdHash = params.get('streamIdHash')
  if (params.has('publisher')) config.publisher = params.get('publisher')
  if (params.has('station')) config.stationAddress = params.get('station')
  if (params.has('stationAddress')) config.stationAddress = params.get('stationAddress')
  if (params.has('fromBlock')) config.fromBlock = params.get('fromBlock')
  if (params.has('cacheLimitMb')) config.cacheLimitMb = clampCacheLimitMb(params.get('cacheLimitMb'), DEFAULTS.cacheLimitMb, { min: CACHE_LIMIT_MIN_MB, max: CACHE_LIMIT_MAX_MB })
  return { config, segment: params.get('segment') || params.get('tx') || '', localConfig }
}

function syncUrlState({ segment = state?.selectedSegmentQuery || '' } = {}) {
  const params = new URLSearchParams(window.location.search)
  params.set('network', state.config.chainPreset)
  params.set('stream', state.config.streamId || '')
  const streamIdHash = state.config.streamId
    ? state.config.streamIdHash || canonicalStreamIdHash(state.config.streamId)
    : ''
  if (streamIdHash) params.set('streamIdHash', streamIdHash)
  else params.delete('streamIdHash')
  if (state.config.publisher) params.set('publisher', state.config.publisher)
  else params.delete('publisher')
  params.set('station', state.config.stationAddress || '')
  params.set('fromBlock', state.config.fromBlock || '')
  for (const name of SENSITIVE_URL_PARAMS) params.delete(name)
  params.set('cacheLimitMb', String(state.config.cacheLimitMb || DEFAULTS.cacheLimitMb))
  if (segment) params.set('segment', segment)
  else params.delete('segment')
  const query = params.toString()
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
  window.history.replaceState({ rfeLocalConfig: true }, '', nextUrl)
}

function loadConfigStore() {
  const stored = safeJsonObject(safeStorageGet(CONFIG_KEY))
  const networks = {}
  if (stored.networks && typeof stored.networks === 'object' && !Array.isArray(stored.networks)) {
    for (const preset of Object.keys(CHAIN_PRESETS)) {
      const config = stored.networks[preset]
      if (config && typeof config === 'object' && !Array.isArray(config)) networks[preset] = config
    }
  }
  if (Object.keys(networks).length) {
    return {
      activePreset: CHAIN_PRESETS[stored.activePreset] ? stored.activePreset : DEFAULTS.chainPreset,
      networks,
    }
  }
  const legacy = safeJsonObject(safeStorageGet(LEGACY_CONFIG_KEY))
  const legacyPreset = CHAIN_PRESETS[legacy.chainPreset] ? legacy.chainPreset : ''
  return legacyPreset
    ? { activePreset: legacyPreset, networks: { [legacyPreset]: legacy } }
    : { activePreset: DEFAULTS.chainPreset, networks: {} }
}

function loadConfig(urlConfig = {}, { useSavedNetworkConfig = false } = {}) {
  const store = loadConfigStore()
  const shared = shareableUrlConfig(urlConfig)
  const explicitPreset = CHAIN_PRESETS[shared.chainPreset] ? shared.chainPreset : ''
  const preset = explicitPreset || (CHAIN_PRESETS[store.activePreset] ? store.activePreset : DEFAULTS.chainPreset)
  const presetDefaults = CHAIN_PRESETS[preset]
  const saved = !explicitPreset || useSavedNetworkConfig
    ? { ...(store.networks[preset] || {}), ...sessionEndpointConfig(preset) }
    : {}
  const merged = { ...saved, ...shared, chainPreset: preset }
  const sharedStationExplicit = Object.hasOwn(shared, 'stationAddress')
  const normalizedStationAddress = normalizeStationAddressInput(merged.stationAddress)
  const stationAddress = sharedStationExplicit ? normalizedStationAddress : normalizedStationAddress || presetDefaults.stationAddress
  const sharedStreamExplicit = Object.hasOwn(shared, 'streamId')
  let streamId
  try {
    streamId = boundedStreamId(merged.streamId || presetDefaults.streamId || DEFAULTS.streamId)
  } catch {
    streamId = sharedStreamExplicit ? '' : boundedStreamId(presetDefaults.streamId || DEFAULTS.streamId)
  }
  const streamIdHash = streamId ? canonicalStreamIdHash(streamId) : ''
  const previousStreamId = String(saved.streamId || presetDefaults.streamId || DEFAULTS.streamId)
  const previousStationAddress = normalizeStationAddressInput(saved.stationAddress) || presetDefaults.stationAddress
  const sharedStreamChanged = Object.hasOwn(shared, 'streamId') && String(shared.streamId) !== previousStreamId
  const sharedStationChanged = sharedStationExplicit && stationAddress !== previousStationAddress
  const sharedPublisherExplicit = Object.hasOwn(shared, 'publisher')
  const publisher = normalizeStationAddressInput(!streamId || ((sharedStreamChanged || sharedStationChanged) && !sharedPublisherExplicit) ? '' : merged.publisher || '')
  return {
    ...DEFAULTS,
    ...presetDefaults,
    ...merged,
    chainPreset: preset,
    chainId: presetDefaults.chainId,
    stationAddress,
    streamId,
    streamIdHash,
    publisher,
    executionRpcs: normalizedEndpointListOrEmpty(Object.hasOwn(merged, 'executionRpcs') || Object.hasOwn(merged, 'executionRpc') ? merged.executionRpcs || merged.executionRpc : presetDefaults.executionRpcs, 'Execution RPC'),
    beaconApis: normalizedEndpointListOrEmpty(Object.hasOwn(merged, 'beaconApis') || Object.hasOwn(merged, 'beaconApi') ? merged.beaconApis || merged.beaconApi : presetDefaults.beaconApis, 'Beacon API'),
    archiveTemplates: normalizedArchiveTemplatesOrEmpty(Object.hasOwn(merged, 'archiveTemplates') ? merged.archiveTemplates : DEFAULTS.archiveTemplates),
    logWindowBlocks: positiveNumber(merged.logWindowBlocks, DEFAULTS.logWindowBlocks),
    cacheLimitMb: clampCacheLimitMb(merged.cacheLimitMb, DEFAULTS.cacheLimitMb, { min: CACHE_LIMIT_MIN_MB, max: CACHE_LIMIT_MAX_MB }),
  }
}

function saveConfig(config) {
  const preset = CHAIN_PRESETS[config?.chainPreset] ? config.chainPreset : DEFAULTS.chainPreset
  const split = endpointPersistenceSplit(config)
  const store = loadConfigStore()
  const networks = { ...store.networks, [preset]: { ...split.persistent, chainPreset: preset } }
  const persisted = safeStorageSet(CONFIG_KEY, JSON.stringify({ activePreset: preset, networks }))
  const sessionPersisted = saveSessionEndpointConfig(preset, split.session)
  syncUrlState()
  return Object.freeze({ persistent: persisted, session: sessionPersisted, hasSessionOnly: split.hasSessionOnly })
}

function setTheme(theme) {
  const light = theme === 'light'
  document.body.classList.toggle('light', light)
  els.themeToggle.innerHTML = light ? moonIcon : sunIcon
  els.themeToggle.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode')
  els.themeToggle.title = light ? 'Dark mode' : 'Light mode'
  safeStorageSet('rfe-theme', light ? 'light' : 'dark')
}

function initTheme() {
  const saved = safeStorageGet('rfe-theme')
  setTheme(saved === 'light' ? 'light' : 'dark')
}

function segmentRailBounds() {
  const defaultMin = 180
  const feedPanes = document.querySelector('.feed-panes')
  const blobspacePanel = document.querySelector('.blobspace-panel')
  const segmentsPanel = document.querySelector('.segments-panel')
  if (!feedPanes || !blobspacePanel || !segmentsPanel || feedPanes.hidden) {
    return calculateSegmentRailBounds({ viewportHeight: window.innerHeight, feedPanesHidden: true, segmentMin: defaultMin })
  }
  const min = Number.parseFloat(getComputedStyle(segmentsPanel).minHeight) || defaultMin
  const style = getComputedStyle(feedPanes)
  const paneHeight = feedPanes.getBoundingClientRect().height
  const rowGap = Number.parseFloat(style.rowGap || style.gap || '0') || 0
  const verticalPadding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
  const blobspaceMin = Number.parseFloat(getComputedStyle(blobspacePanel).minHeight) || 112
  return calculateSegmentRailBounds({ viewportHeight: window.innerHeight, segmentMin: min, paneHeight, rowGap, verticalPadding, blobspaceMin })
}

function applySegmentRailHeight(height) {
  const bounds = segmentRailBounds()
  const next = Math.max(bounds.min, Math.min(bounds.max, Number(height) || 280))
  document.documentElement.style.setProperty('--segment-rail-height', `${next}px`)
  if (els.segmentRailResizer) {
    els.segmentRailResizer.setAttribute('aria-valuemin', String(bounds.min))
    els.segmentRailResizer.setAttribute('aria-valuemax', String(bounds.max))
    els.segmentRailResizer.setAttribute('aria-valuenow', String(next))
    const scannerHeight = Math.max(bounds.scannerMin || 112, (bounds.paneHeight || 0) - (bounds.gap || 0) - next)
    els.segmentRailResizer.setAttribute('aria-valuetext', `Stream segments ${next} pixels; blobspace scanner ${Math.round(scannerHeight)} pixels`)
  }
  safeStorageSet('rfe-segment-rail-height', String(next))
  return next
}

function initSegmentRailResize() {
  let saved = Number(safeStorageGet('rfe-segment-rail-height', '280'))
  applySegmentRailHeight(saved)
  on(els.segmentRailResizer, 'pointerdown', (event) => {
    event.preventDefault()
    const panel = document.querySelector('.segments-panel')
    const startY = event.clientY
    const startHeight = panel?.getBoundingClientRect().height || saved
    els.segmentRailResizer.setPointerCapture(event.pointerId)
    const move = (moveEvent) => {
      saved = applySegmentRailHeight(startHeight + startY - moveEvent.clientY)
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
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--segment-rail-height'), 10) || saved
    const bounds = segmentRailBounds()
    const next = event.key === 'Home' ? bounds.min
      : event.key === 'End' ? bounds.max
        : current + (event.key === 'ArrowUp' ? 24 : -24)
    saved = applySegmentRailHeight(next)
  })
  on(window, 'resize', () => { saved = applySegmentRailHeight(saved) })
}

function announceStatus(value, { assertive = false, key = '' } = {}) {
  const lane = assertive ? 'assertive' : 'polite'
  const token = `${key}:${value}`
  if (lastStatusAnnouncement[lane] === token) return false
  lastStatusAnnouncement[lane] = token
  const target = assertive ? els.alertAnnouncer : els.statusAnnouncer
  if (!target) return false
  target.textContent = value
  return true
}

function setStatus(value, { announce = true, assertive = false, announcementKey = '' } = {}) {
  els.status.textContent = value
  if (els.recoveryStatus) els.recoveryStatus.textContent = value
  if (announce) announceStatus(value, { assertive, key: announcementKey })
}

function markStartupReady() {
  els.shell?.removeAttribute('inert')
  els.shell?.removeAttribute('aria-hidden')
  if (els.startupShell) els.startupShell.hidden = true
  document.body.dataset.startup = 'ready'
}

function runtimeSnapshot() {
  return { generation: state.runtimeGeneration, signal: state.runtimeController.signal }
}

function runtimeIsCurrent(runtime) {
  return Boolean(runtime)
    && runtime.generation === state.runtimeGeneration
    && runtime.signal === state.runtimeController.signal
    && !runtime.signal.aborted
}

function requireCurrentRuntime(runtime) {
  if (!runtimeIsCurrent(runtime)) throw requestAbortError('Runtime configuration changed.')
}

function setRuntimeStatus(runtime, value, options = {}) {
  if (!runtimeIsCurrent(runtime)) return false
  setStatus(value, options)
  return true
}

function runtimeAllowsMutation(runtime) {
  return !runtime || runtimeIsCurrent(runtime)
}

function archiveDefaultMessage(mode = 'station') {
  return mode === 'inbox'
    ? 'Scan recent blob transactions sent to an inbox and detect compatible RFE1 streams.'
    : 'Scan a bounded block range to discover prior Station streams.'
}

function archiveProgressState(message, { current = 0n, total = 0n, active = false, status = active ? 'scanning' : 'idle' } = {}) {
  const totalValue = typeof total === 'bigint' ? total : BigInt(Math.max(0, Number(total) || 0))
  const currentValue = typeof current === 'bigint' ? current : BigInt(Math.max(0, Number(current) || 0))
  return {
    message: String(message || ''),
    current: currentValue < 0n ? 0n : currentValue,
    total: totalValue < 0n ? 0n : totalValue,
    active: Boolean(active),
    status,
  }
}

function defaultArchiveProgress(mode = 'station') {
  return archiveProgressState(archiveDefaultMessage(mode))
}

function renderArchiveProgress() {
  const progress = state.archive.progress || defaultArchiveProgress(state.archive.mode)
  if (els.archiveProgress) {
    els.archiveProgress.textContent = progress.message
    els.archiveProgress.dataset.state = progress.status
  }
  if (!els.archiveProgressBar) return
  const percent = progress.total > 0n
    ? Number((progress.current > progress.total ? progress.total : progress.current) * 100n / progress.total)
    : 0
  els.archiveProgressBar.value = Math.max(0, Math.min(100, percent))
  els.archiveProgressBar.classList.toggle('active', progress.active)
  els.archiveProgressBar.setAttribute('aria-valuetext', progress.active ? `${percent}%` : progress.message)
}

function setArchiveProgress(message, options = {}) {
  const previousStatus = state.archive.progress?.status || 'idle'
  state.archive.progress = archiveProgressState(message, options)
  renderArchiveProgress()
  const terminalStatus = state.archive.progress.status
  if (terminalStatus !== previousStatus && ['success', 'cancelled', 'error'].includes(terminalStatus)) {
    announceStatus(state.archive.progress.message, {
      assertive: terminalStatus === 'error',
      key: `archive-${terminalStatus}`,
    })
  }
}

function resetArchiveProgress(message = archiveDefaultMessage(state.archive.mode)) {
  setArchiveProgress(message, { current: 0n, total: 0n, active: false, status: 'idle' })
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

function extractTxHash(value) {
  const text = String(value || '')
  if (text.length > MAX_LOOKUP_INPUT_CODE_UNITS) return ''
  return text.match(/0x[a-fA-F0-9]{64}/)?.[0]?.toLowerCase() || ''
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
  if (raw.length > MAX_LOOKUP_INPUT_CODE_UNITS) return { kind: 'invalid', valid: false, query: '', message: `Lookup input exceeds ${MAX_LOOKUP_INPUT_CODE_UNITS.toLocaleString()} characters.` }
  const txHash = extractTxHash(raw)
  if (isExplorerUrl(raw)) {
    const url = new URL(raw)
    const pathParts = url.pathname.split('/').filter(Boolean)
    if (pathParts[0] === 'tx' && txHash) return { kind: 'tx-url', valid: true, query: txHash, message: `Explorer transaction URL recognized: ${shortHash(txHash)}.` }
    if (pathParts[0] === 'block' && (pathParts[1] || '').length <= MAX_LOOKUP_DECIMAL_DIGITS && /^\d+$/.test(pathParts[1] || '')) return { kind: 'block-url', valid: true, query: pathParts[1], message: `Explorer block URL recognized: block ${pathParts[1]}.` }
    if (txHash) return { kind: 'hash-url', valid: true, query: txHash, message: `Explorer URL contains hash ${shortHash(txHash)}.` }
    return { kind: 'invalid', valid: false, query: raw, message: 'Explorer URL did not contain a supported transaction hash or block number.' }
  }
  if (/^0x[a-fA-F0-9]{64}$/.test(raw)) {
    const normalized = normalizeHex(raw)
    return normalized.startsWith('0x01')
      ? { kind: 'blob-hash', valid: true, query: normalized, message: `Blob versioned hash recognized: ${shortHash(normalized)}.` }
      : { kind: 'tx-hash', valid: true, query: normalized, message: `Transaction hash recognized: ${shortHash(normalized)}.` }
  }
  if (raw.length <= MAX_LOOKUP_DECIMAL_DIGITS && /^\d+$/.test(raw)) {
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

function fmtClock(date = new Date()) {
  if (state.clock.mode === 'local') {
    return `${new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)} local`
  }
  if (state.clock.mode === 'timezone' && state.clock.timeZone) {
    try {
      return `${new Intl.DateTimeFormat([], {
        timeZone: state.clock.timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date)} ${state.clock.timeZone}`
    } catch {
      return fmtUtcClock(date)
    }
  }
  return fmtUtcClock(date)
}

function fmtLatency(segment) {
  if (!segment?.createdAt) return '-'
  return fmtAge(segment.createdAt)
}

function formatWeiCompact(value) {
  if (value == null) return '-'
  const wei = typeof value === 'bigint' ? value : BigInt(value)
  if (wei === 0n) return '0 Wei'
  if (wei < WEI_PER_GWEI) return `${wei.toString()} Wei`
  const whole = wei / WEI_PER_GWEI
  const fraction = (wei % WEI_PER_GWEI).toString().padStart(9, '0').slice(0, 3).replace(/0+$/, '')
  return `${whole.toString()}${fraction ? `.${fraction}` : ''} Gwei`
}

function formatEthFromWei(value) {
  if (value == null) return '-'
  const wei = typeof value === 'bigint' ? value : BigInt(value)
  const whole = wei / WEI_PER_ETH
  const fraction = (wei % WEI_PER_ETH).toString().padStart(18, '0').slice(0, 8).replace(/0+$/, '')
  return `${whole.toString()}${fraction ? `.${fraction}` : ''} ETH`
}

function formatGweiFromWei(value) {
  if (value == null) return '-'
  const wei = typeof value === 'bigint' ? value : BigInt(value)
  const whole = wei / WEI_PER_GWEI
  const fraction = (wei % WEI_PER_GWEI).toString().padStart(9, '0').slice(0, 4).replace(/0+$/, '')
  return `${whole.toString()}${fraction ? `.${fraction}` : ''} Gwei`
}

function formatBlobFeeAmount(value, unit = state.blobFeePrefs.unit) {
  if (value == null) return '-'
  const wei = typeof value === 'bigint' ? value : BigInt(value)
  if (unit === 'wei') return `${wei.toString()} Wei`
  if (unit === 'gwei') return formatGweiFromWei(wei)
  return formatEthFromWei(wei)
}

function blobFeeWei(baseFeePerBlobGasWei) {
  return BigInt(baseFeePerBlobGasWei) * BLOB_GAS_PER_BLOB
}

function averageBigInts(values) {
  const usable = values.filter((value) => typeof value === 'bigint' && value > 0n)
  if (!usable.length) return null
  return usable.reduce((sum, value) => sum + value, 0n) / BigInt(usable.length)
}

function percentileBigInt(values, percentile) {
  const usable = values.filter((value) => typeof value === 'bigint' && value > 0n).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
  if (!usable.length) return null
  const index = Math.min(usable.length - 1, Math.max(0, Math.ceil((percentile / 100) * usable.length) - 1))
  return usable[index]
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
  const blockHash = isBytes32Hex(segment?.blockHash) ? normalizeHex(segment.blockHash) : ''
  const timestampMs = segment?.createdAt ? Date.parse(segment.createdAt) : blockHash ? state.blockTimes.get(blockHash) : null
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
  const message = String(error?.message || error || 'request failed')
    .replace(/https?:\/\/[^\s"'<>)}\]]+/g, '[redacted endpoint]')
  return message.length > 500 ? `${message.slice(0, 499)}…` : message
}

function isAddressHex(value) {
  return typeof value === 'string' && value.length === 42 && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function parseBlockInput(value, label) {
  const text = String(value || '').trim()
  if (text.length > 16) throw new Error(`${label} exceeds safe integer range`)
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a non-negative block number`)
  const number = Number(text)
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe integer range`)
  return BigInt(number)
}

function datetimeLocalValue(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function parseDatetimeLocal(value, label) {
  const text = String(value || '').trim()
  if (!text) return null
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) throw new Error(`${label} must be a valid date and time`)
  return ms
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
  if (!isBytes32Hex(log.topics[0]) || normalizeHex(log.topics[0]) !== EVENT_TOPIC) throw new Error('Invalid Station log: unexpected event topic')
  for (const [index, topic] of log.topics.slice(1, 4).entries()) {
    if (!isBytes32Hex(topic)) throw new Error(`Invalid Station log: topic ${index + 1} must be bytes32`)
  }
  if (typeof log.data !== 'string') throw new Error('Invalid Station log: data must be byte hex')
  const dataHexLength = log.data.startsWith('0x') ? log.data.length - 2 : log.data.length
  if (dataHexLength > MAX_STATION_LOG_DATA_BYTES * 2) throw new Error(`Invalid Station log: ABI data exceeds ${MAX_STATION_LOG_DATA_BYTES} bytes`)
  if (!isByteHex(log.data)) throw new Error('Invalid Station log: data must be byte hex')
  if (!isBytes32Hex(log.transactionHash)) throw new Error('Invalid Station log: transactionHash must be bytes32')
  if (!isBytes32Hex(log.blockHash)) throw new Error('Invalid Station log: blockHash must be bytes32')
}

function decodeSegmentLog(log, { chainId, stationAddress } = {}) {
  assertSegmentLogShape(log)
  const data = strip0x(log.data)
  const segment = withChannelIdentity({
    app: 'eth-radio',
    version: 1,
    source: 'station',
    publisher: topicAddress(log.topics[1]),
    streamIdHash: log.topics[2],
    sequence: topicUintNumber(log.topics[3], 'Station log sequence'),
    streamId: readString(data, 0, 'Station log streamId'),
    durationMs: abiWordNumber(data, 1, 'Station log durationMs'),
    payloadBytes: abiWordNumber(data, 2, 'Station log payloadBytes'),
    payloadSha256Hex: normalizeHex(readBytes32(data, 3, 'Station log payloadSha256')),
    payloadSha256: strip0x(normalizeHex(readBytes32(data, 3, 'Station log payloadSha256'))),
    codec: readString(data, 4, 'Station log codec'),
    previousSegmentHash: readBytes32(data, 5, 'Station log previousSegmentHash'),
    blobVersionedHashes: readBytes32Array(data, 6, 'Station log blobVersionedHashes').map(normalizeHex),
    txHash: log.transactionHash,
    transactionHash: log.transactionHash,
    blockNumber: rpcQuantityNumber(log.blockNumber, 'segment blockNumber'),
    blockHash: log.blockHash,
    transactionIndex: rpcQuantityNumber(log.transactionIndex, 'segment transactionIndex'),
    logIndex: rpcQuantityNumber(log.logIndex, 'segment logIndex'),
    chainId,
    stationAddress,
  })
  const scopedIdentity = v1ScopedChannelIdentity(segment)
  segment.channelKey = scopedIdentity.key
  segment.syntheticChannelId = scopedIdentity.syntheticChannelId
  segment.blobCount = segment.blobVersionedHashes.length
  segment.cacheKey = scopedSegmentIdentityKey(segment)
  segment.payloadValidity = 'unknown'
  return segment
}

async function withEndpointFallback(kind, endpoints, request) {
  return runEndpointFallback(kind, endpoints, request, {
    onActive(endpoint) {
      if (kind === 'execution') state.activeExecutionRpc = endpoint
      if (kind === 'beacon') state.activeBeaconApi = endpoint
    },
    onHealth(health) {
      state.endpointHealth[kind] = health
      renderHealth()
    },
    publicEndpointLabel: publicUrlLabel,
    publicError: publicErrorMessage,
  })
}

async function rpc(method, params = [], { signal } = {}) {
  return withEndpointFallback('execution', state.config.executionRpcs, async (endpoint) => {
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    }, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await readBoundedJsonResponse(response, MAX_RPC_RESPONSE_BYTES, `JSON-RPC ${method}`, { signal })
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0') {
      throw new Error(`JSON-RPC ${method} returned an invalid response envelope`)
    }
    if (body.error) throw new Error(typeof body.error?.message === 'string' ? body.error.message.slice(0, 500) : 'RPC error')
    if (!Object.hasOwn(body, 'result')) throw new Error(`JSON-RPC ${method} response is missing result`)
    return body.result
  })
}

async function executionBlock(blockNumber, fullTransactions = false, { signal } = {}) {
  const block = await rpc('eth_getBlockByNumber', [toBlockHex(blockNumber), fullTransactions], { signal })
  if (!block || typeof block !== 'object') throw new Error(`Execution block ${blockNumber} was not found`)
  return block
}

async function blockTimestampMs(blockNumber, { signal } = {}) {
  const block = await executionBlock(blockNumber, false, { signal })
  return timestampMsFromSeconds(block.timestamp, 'block timestamp')
}

async function blockAtOrBeforeTimestamp(targetMs, head, { signal } = {}) {
  const headMs = await blockTimestampMs(head, { signal })
  if (targetMs >= headMs) return head
  const genesisBlock = 0n
  let low = genesisBlock
  let high = head
  while (low < high) {
    const mid = (low + high + 1n) / 2n
    const midMs = await blockTimestampMs(mid, { signal })
    if (midMs <= targetMs) low = mid
    else high = mid - 1n
  }
  return low
}

function archiveRangeSelection({ rangeMode = 'date', fromBlock = '', fromDate = '', toDate = '' } = {}) {
  const mode = String(rangeMode || '').trim()
  const blockValue = String(fromBlock || '').trim()
  const fromDateValue = String(fromDate || '').trim()
  const toDateValue = String(toDate || '').trim()
  if (mode !== 'block' && mode !== 'date') throw new Error('Choose either From block or Date range before scanning.')
  if (mode === 'block') {
    if (fromDateValue || toDateValue) throw new Error('From block cannot be combined with archive date fields. Choose one range mode.')
    if (!blockValue) throw new Error('Enter a From block for block-range scanning.')
  } else {
    if (blockValue) throw new Error('From block cannot be combined with archive date fields. Choose one range mode.')
    if (!fromDateValue && !toDateValue) throw new Error('Enter at least one archive date for date-range scanning.')
  }
  return { mode, fromBlock: blockValue, fromDate: fromDateValue, toDate: toDateValue }
}

async function archiveDateBlockRange(head, { signal, fromDate = '', toDate = '' } = {}) {
  const fromMs = parseDatetimeLocal(fromDate, 'Archive from-date')
  const toMs = parseDatetimeLocal(toDate, 'Archive to-date')
  if (fromMs != null && toMs != null && fromMs > toMs) throw new Error('Archive from-date must be before to-date')
  const from = fromMs == null ? 0n : await blockAtOrBeforeTimestamp(fromMs, head, { signal })
  const to = toMs == null ? head : await blockAtOrBeforeTimestamp(toMs, head, { signal })
  return { from, to: to > head ? head : to }
}

function rpcQuantityBigInt(value, label) {
  return rpcQuantity(value, label)
}

function blobFeeHistoryValues(response) {
  const fees = Array.isArray(response?.baseFeePerBlobGas) ? response.baseFeePerBlobGas : null
  if (!fees) throw new Error('eth_feeHistory response missing baseFeePerBlobGas')
  const ratios = Array.isArray(response?.blobGasUsedRatio) ? response.blobGasUsedRatio : []
  if (fees.length > BLOB_FEE_HISTORY_CHUNK_BLOCKS + 1) throw new Error('eth_feeHistory baseFeePerBlobGas exceeds the requested chunk bound')
  if (ratios.length > BLOB_FEE_HISTORY_CHUNK_BLOCKS) throw new Error('eth_feeHistory blobGasUsedRatio exceeds the requested chunk bound')
  return {
    baseFees: fees.map((value) => rpcQuantityBigInt(value, 'baseFeePerBlobGas')).filter((value) => value > 0n),
    utilization: ratios
      .filter((value) => typeof value === 'number')
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1),
    oldestBlock: response.oldestBlock ? rpcQuantityBigInt(response.oldestBlock, 'feeHistory oldestBlock') : null,
  }
}

async function fetchCurrentBlobBaseFee() {
  const value = await rpc('eth_blobBaseFee')
  return rpcQuantityBigInt(value, 'eth_blobBaseFee')
}

async function fetchBlobFeeHistory(blocks) {
  const baseFees = []
  const utilization = []
  let newestBlock = 'latest'
  let remaining = blocks
  while (remaining > 0) {
    const chunk = Math.min(remaining, BLOB_FEE_HISTORY_CHUNK_BLOCKS)
    const response = await rpc('eth_feeHistory', [toBlockHex(chunk), newestBlock, []])
    const parsed = blobFeeHistoryValues(response)
    baseFees.push(...parsed.baseFees)
    utilization.push(...parsed.utilization)
    if (!parsed.oldestBlock || parsed.oldestBlock === 0n) break
    newestBlock = `0x${(parsed.oldestBlock - 1n).toString(16)}`
    remaining -= chunk
  }
  return { baseFees, utilization }
}

function cachedBlobFeeWindow(key, now = Date.now()) {
  const cached = state.blobFees.history[key]
  const windowConfig = BLOB_FEE_HISTORY_WINDOWS[key]
  if (!cached || !windowConfig || now - cached.updatedAt > windowConfig.cacheMs) return null
  return cached
}

async function refreshBlobFeeWindow(key) {
  const windowConfig = BLOB_FEE_HISTORY_WINDOWS[key]
  const cached = cachedBlobFeeWindow(key)
  if (cached) return cached
  try {
    const history = await fetchBlobFeeHistory(windowConfig.blocks)
    const average = averageBigInts(history.baseFees)
    if (average == null) throw new Error('No blob fee samples returned')
    const next = {
      status: 'ok',
      updatedAt: Date.now(),
      averageWei: average.toString(),
      percentile75Wei: percentileBigInt(history.baseFees, 75)?.toString() || '',
      percentile90Wei: percentileBigInt(history.baseFees, 90)?.toString() || '',
      percentile97Wei: percentileBigInt(history.baseFees, 97)?.toString() || '',
      sampleBlocks: history.utilization.length,
      blobCount: Math.round(history.utilization.reduce((sum, value) => sum + value * MAX_BLOBS_PER_BLOCK, 0)),
      utilization: history.utilization.length
        ? history.utilization.reduce((sum, value) => sum + value, 0) / history.utilization.length
        : null,
    }
    state.blobFees.history[key] = next
    return next
  } catch (error) {
    const next = { status: 'limited', updatedAt: Date.now(), message: key === 'day' || key === 'week' ? 'provider limited' : publicErrorMessage(error) }
    state.blobFees.history[key] = next
    return next
  }
}

function classifyBlobFee(current, hourWindow) {
  if (current == null) return 'Unavailable'
  if (!hourWindow || hourWindow.status !== 'ok' || !hourWindow.averageWei) return 'Normal'
  const average = BigInt(hourWindow.averageWei)
  const p75 = hourWindow.percentile75Wei ? BigInt(hourWindow.percentile75Wei) : null
  const p90 = hourWindow.percentile90Wei ? BigInt(hourWindow.percentile90Wei) : null
  const p97 = hourWindow.percentile97Wei ? BigInt(hourWindow.percentile97Wei) : null
  if ((average > 0n && current > average * 4n) || (p97 != null && current > p97)) return 'Extreme'
  if ((average > 0n && current > average * 2n) || (p90 != null && current > p90)) return 'High'
  if ((average > 0n && current * 100n > average * 125n) || (p75 != null && current > p75)) return 'Elevated'
  return 'Normal'
}

async function refreshBlobFees() {
  if (!state.layoutSettings.blobFees?.visible || state.blobFees.loading) return
  state.blobFees.loading = true
  renderBlobFees()
  try {
    const current = await fetchCurrentBlobBaseFee()
    state.blobFees.currentBaseFeeWei = current.toString()
    state.blobFees.currentBlobFeeWei = blobFeeWei(current).toString()
    state.blobFees.samples.push({ timestamp: Date.now(), baseFeePerBlobGasWei: current.toString() })
    saveBlobFeeSamples()
    const entries = await Promise.all(Object.keys(BLOB_FEE_HISTORY_WINDOWS).map(async (key) => [key, await refreshBlobFeeWindow(key)]))
    state.blobFees.averages = Object.fromEntries(entries)
    const hourWindow = state.blobFees.averages.hour
    state.blobFees.status = classifyBlobFee(current, hourWindow)
    state.blobFees.utilization = hourWindow?.utilization ?? state.blobFees.averages.tenMinute?.utilization ?? null
    state.blobFees.message = ''
    state.blobFees.updatedAt = Date.now()
  } catch {
    state.blobFees.status = 'Unavailable'
    state.blobFees.message = 'Blob fee data unavailable from this RPC.'
    state.blobFees.updatedAt = Date.now()
  } finally {
    state.blobFees.loading = false
    renderBlobFees()
  }
}

function startBlobFeeTracker() {
  clearInterval(state.blobFeeTimer)
  state.blobFeeTimer = null
  if (!state.layoutSettings.blobFees?.visible) return
  void refreshBlobFees()
  const interval = document.hidden ? BLOB_FEE_HIDDEN_REFRESH_MS : BLOB_FEE_REFRESH_MS
  state.blobFeeTimer = setInterval(() => void refreshBlobFees(), interval)
}

async function beacon(pathname, { signal } = {}) {
  return withEndpointFallback('beacon', state.config.beaconApis, async (endpoint) => {
    const response = await fetchWithTimeout(`${endpoint}${pathname}`, { headers: { accept: 'application/json' } }, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await readBoundedJsonResponse(response, MAX_BEACON_RESPONSE_BYTES, `Beacon ${pathname}`, { signal })
    return beaconData(body, pathname)
  })
}

function beaconData(response, label) {
  if (!response || typeof response !== 'object' || !('data' in response)) {
    throw new Error(`${label} response missing data`)
  }
  return response.data
}

function beaconDataArray(data, label, maxLength = MAX_BLOBS_PER_BLOCK) {
  if (!Array.isArray(data)) throw new Error(`${label} data must be an array`)
  if (data.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries`)
  return data
}

function decimalSafeInteger(value, label) {
  if (typeof value !== 'string' || value.length > 16 || !/^\d+$/.test(value)) throw new Error(`${label} must be a bounded decimal string`)
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe integer range`)
  return number
}

async function beaconGenesisTime({ signal } = {}) {
  const genesis = await beacon('/eth/v1/beacon/genesis', { signal })
  return BigInt(decimalSafeInteger(genesis?.genesis_time, 'beacon genesis time'))
}

function slotTimestampMs(slot, genesisTime) {
  if (genesisTime == null) return null
  return timestampMsFromSeconds(slotStartTimestamp(BigInt(slot), genesisTime), 'beacon slot timestamp')
}

async function latestBeaconSlot({ signal } = {}) {
  const head = await beacon('/eth/v1/beacon/headers/head', { signal })
  return beaconHeadSlot(head)
}

function beaconHeadSlot(head) {
  const slot = head?.header?.message?.slot
  return decimalSafeInteger(slot, 'beacon head slot')
}

function toBlockHex(block) {
  return `0x${BigInt(block).toString(16)}`
}

async function fetchLogs({ signal, runtime } = {}) {
  if (!state.config.stationAddress) throw new Error(`Set a Station address for ${state.config.chainPreset}.`)
  const headHex = await rpc('eth_blockNumber', [], { signal })
  if (runtime) requireCurrentRuntime(runtime)
  const head = rpcQuantity(headHex, 'eth_blockNumber')
  els.headBlock.textContent = head.toString()
  if (state.anchor) {
    const range = incrementalStationRange({
      anchorBlock: state.anchor.blockNumber,
      cursorBlock: state.anchor.cursorBlock ?? state.anchor.blockNumber,
      headBlock: head,
      overlapBlocks: LIVE_REFRESH_REORG_BLOCKS,
      maxBlocks: LIVE_REFRESH_MAX_BLOCKS,
    })
    if (!range) return { segments: state.segments, cursorBlock: state.anchor.cursorBlock ?? BigInt(state.anchor.blockNumber) }
    const fresh = await fetchSegmentLogs(range.fromBlock, range.toBlock, { signal })
    if (runtime) requireCurrentRuntime(runtime)
    return {
      segments: reconcileIncrementalStationSegments(state.segments, fresh, {
        replaceFromBlock: range.fromBlock,
        anchorOrder: state.anchor.order,
        maxSegments: LIVE_RETAINED_SEGMENTS,
      }),
      cursorBlock: range.nextCursorBlock,
      caughtUp: range.caughtUp,
    }
  }
  const windowBlocks = BigInt(Math.max(1, Number(state.config.logWindowBlocks || DEFAULTS.logWindowBlocks)))
  const fromBlock = head > windowBlocks ? head - windowBlocks : 0n
  return { segments: await fetchSegmentLogs(fromBlock, head, { signal }), cursorBlock: null, caughtUp: true }
}

async function fetchSegmentLogs(fromBlock, toBlock, { streamId = state.config.streamId, publisher = state.config.publisher, signal } = {}) {
  const segments = await fetchSegmentLogsForStation(state.config.stationAddress, fromBlock, toBlock, { streamId, publisher, signal })
  if (!streamId) return segments
  const selection = selectPublisherScopedChannel(segments, { streamId, publisher })
  if (selection.status === 'ambiguous') {
    throw new Error(`Publisher is required for stream "${streamId}" because ${selection.publishers.length} publishers use that stream ID. Choose a publisher-specific favorite or URL.`)
  }
  if (selection.status === 'selected' && !publisher) {
    throw new Error(`Publisher selection is required before loading stream "${streamId}". Discovery found ${shortHash(selection.publisher)}, but the browser will not trust it automatically. Open an exact Station transaction, choose a publisher-specific archive/favorite, or add an explicit publisher to the URL.`)
  }
  return selection.segments
}

async function fetchSegmentLogsForStation(stationAddress, fromBlock, toBlock, { streamId = '', publisher = '', signal } = {}) {
  const station = normalizeStationAddressInput(stationAddress)
  if (!station) throw new Error('Station must be a 20-byte address before reading logs.')
  const publisherAddress = normalizeStationAddressInput(publisher || '')
  const logs = await rpc('eth_getLogs', [{
    address: station,
    fromBlock: toBlockHex(fromBlock),
    toBlock: toBlockHex(toBlock),
    topics: [EVENT_TOPIC],
  }], { signal })
  if (!Array.isArray(logs)) throw new Error('eth_getLogs result must be an array')
  if (logs.length > MAX_RPC_LOGS) throw new Error(`eth_getLogs result exceeds ${MAX_RPC_LOGS} entries`)
  const segments = logs
    .map((log) => decodeSegmentLog(log, {
      chainId: CHAIN_PRESETS[state.config.chainPreset]?.chainId,
      stationAddress: station,
    }))
    .filter((segment) => !streamId || segment.streamId === streamId)
    .filter((segment) => !publisherAddress || normalizeHex(segment.publisher) === publisherAddress)
    .sort((a, b) =>
      a.sequence - b.sequence ||
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.logIndex - b.logIndex)
  await hydrateSegmentTimes(segments, { signal })
  return annotateStreamContinuity(segments)
}

async function resolveArchiveStationTarget(value, { signal } = {}) {
  const parsed = parseArchiveStationInput(value)
  if (parsed.kind === 'address') return { station: parsed.address, deploymentBlock: null, txHash: '' }
  if (parsed.kind !== 'tx') {
    throw new Error('Station input must be a 20-byte address, deployment transaction hash, or explorer URL.')
  }
  const receipt = await rpc('eth_getTransactionReceipt', [parsed.txHash], { signal })
  if (!receipt) throw new Error(`Deployment transaction ${shortHash(parsed.txHash)} was not found on ${CHAIN_PRESETS[state.config.chainPreset]?.label || state.config.chainPreset}.`)
  const contractAddress = normalizeStationAddressInput(receipt.contractAddress || '')
  if (!contractAddress) {
    throw new Error(`Transaction ${shortHash(parsed.txHash)} did not create a contract. Paste the Station contract address or its deployment transaction.`)
  }
  const deploymentBlock = rpcQuantityNumber(receipt.blockNumber, 'deployment receipt blockNumber')
  return { station: contractAddress, deploymentBlock, txHash: parsed.txHash }
}

function archiveScanErrorMessage(error) {
  const message = publicErrorMessage(error)
  if (/execution endpoints failed/i.test(message) || /HTTP 4\d\d/i.test(message)) {
    return `${message}. The execution RPC refused this archive log request. Try a deployment transaction so the scan starts at the Station creation block, use a later from-block, or apply a browser-accessible custom RPC in Settings.`
  }
  return message
}

async function scanOldStreams({ stationAddress, publisher = '', rangeMode = 'date', fromBlock = '', fromDate = '', toDate = '', signal } = {}) {
  const target = await resolveArchiveStationTarget(stationAddress, { signal })
  const station = target.station
  if (els.archiveStation) els.archiveStation.value = station
  const publisherAddress = publisher ? normalizeStationAddressInput(publisher) : ''
  if (publisher && !publisherAddress) throw new Error('Publisher/channel must be a 20-byte address or explorer address URL.')
  const head = rpcQuantity(await rpc('eth_blockNumber', [], { signal }), 'eth_blockNumber')
  els.headBlock.textContent = head.toString()
  const range = archiveRangeSelection({ rangeMode, fromBlock, fromDate, toDate })
  const dateRange = range.mode === 'date'
    ? await archiveDateBlockRange(head, { signal, fromDate: range.fromDate, toDate: range.toDate })
    : null
  const deploymentBlock = target.deploymentBlock == null ? null : BigInt(target.deploymentBlock)
  let from = range.mode === 'block'
    ? parseBlockInput(range.fromBlock, 'Archive from-block')
    : (dateRange?.from ?? deploymentBlock ?? (head > BigInt(ARCHIVE_DEFAULT_WINDOW_BLOCKS) ? head - BigInt(ARCHIVE_DEFAULT_WINDOW_BLOCKS) : 0n))
  let to = dateRange?.to ?? head
  if (deploymentBlock != null && from < deploymentBlock) from = deploymentBlock
  if (els.archiveFromBlock && range.mode === 'block') els.archiveFromBlock.value = from.toString()
  if (from < 0n || from > head) throw new Error(`From block must be between 0 and current head ${head}.`)
  if (to < from || to > head) throw new Error(`Archive date range must resolve between block ${from} and current head ${head}.`)
  if (to - from > BigInt(ARCHIVE_MAX_BLOCKS)) {
    throw new Error(`Archive scans are capped at ${ARCHIVE_MAX_BLOCKS.toLocaleString()} blocks in the browser. Choose a newer from-block${target.txHash ? '' : ' or paste the Station deployment transaction so the creation block can be used'}.`)
  }
  state.archive.scanning = true
  state.archive.cancel = false
  state.archive.streams = []
  state.archive.segmentsByKey = new Map()
  if (els.archiveScan) els.archiveScan.disabled = true
  renderArchive()
  const archiveAccumulator = createArchiveAccumulator({ maxSegments: ARCHIVE_MAX_SEGMENTS, maxStreams: ARCHIVE_MAX_STREAMS })
  const totalBlocks = to - from + 1n
  let scannedBlocks = 0n
  setArchiveProgress(`Scanning blocks ${from.toString()}-${to.toString()}...`, { current: 0n, total: totalBlocks, active: true })
  for (let start = from; start <= to; start += BigInt(ARCHIVE_SCAN_CHUNK_BLOCKS + 1)) {
    if (state.archive.cancel) break
    const end = start + BigInt(ARCHIVE_SCAN_CHUNK_BLOCKS) > to ? to : start + BigInt(ARCHIVE_SCAN_CHUNK_BLOCKS)
    setArchiveProgress(`Scanning blocks ${start.toString()}-${end.toString()} of ${to.toString()}...`, {
      current: start - from,
      total: totalBlocks,
      active: true,
    })
    let chunk
    try {
      chunk = await fetchSegmentLogsForStation(station, start, end, { publisher: publisherAddress, signal })
    } catch (error) {
      if (isAbortError(error)) throw error
      throw new Error(`Archive scan failed for blocks ${start.toString()}-${end.toString()}: ${archiveScanErrorMessage(error)}`, { cause: error })
    }
    appendArchiveSegments(archiveAccumulator, chunk, {
      narrowingHint: 'Choose a later from-block or add a publisher filter before scanning again.',
    })
    scannedBlocks = end - from + 1n
    setArchiveProgress(`Scanning blocks ${start.toString()}-${end.toString()} of ${to.toString()}...`, {
      current: scannedBlocks,
      total: totalBlocks,
      active: true,
    })
  }
  const allSegments = archiveAccumulator.segments
  state.archive.streams = groupOldStreamsFromSegmentPublishedLogs(allSegments)
  state.archive.segmentsByKey = groupedArchiveSegments(allSegments)
  renderArchive()
  state.archive.scanning = false
  if (els.archiveScan) els.archiveScan.disabled = false
  const stopped = state.archive.cancel
  state.archive.cancel = false
  if (els.archiveProgress) {
    const message = stopped
      ? `Stopped after discovering ${state.archive.streams.length} stream${state.archive.streams.length === 1 ? '' : 's'}.`
      : `Discovered ${state.archive.streams.length} stream${state.archive.streams.length === 1 ? '' : 's'} from ${allSegments.length} segment log${allSegments.length === 1 ? '' : 's'}.`
    setArchiveProgress(message, {
      current: stopped ? scannedBlocks : totalBlocks,
      total: totalBlocks,
      active: false,
      status: stopped ? 'cancelled' : 'success',
    })
  }
}

function groupedArchiveSegments(segments) {
  const byKey = new Map()
  for (const segment of segments) {
    const key = archiveStreamKey(segment)
    const list = byKey.get(key) || []
    list.push(segment)
    byKey.set(key, list)
  }
  for (const [key, list] of byKey) {
    const ordered = list.sort((a, b) =>
      a.sequence - b.sequence ||
      a.blockNumber - b.blockNumber ||
      a.transactionIndex - b.transactionIndex ||
      a.logIndex - b.logIndex)
    byKey.set(key, annotateStreamContinuity(ordered))
  }
  return byKey
}

async function archiveSegmentsForWatch(key, summary) {
  const existing = state.archive.segmentsByKey.get(key) || []
  if (existing.length) return existing
  if (state.archive.mode !== 'station') {
    throw new Error('This inbox stream is no longer loaded in browser memory. Scan the inbox again, then choose Watch.')
  }
  const station = normalizeStationAddressInput(els.archiveStation?.value || state.config.stationAddress)
  if (!station) throw new Error('Set the Station contract before watching this archived stream.')
  const fromBlock = BigInt(summary.firstBlock)
  const toBlock = BigInt(summary.latestBlock)
  if (fromBlock > toBlock) throw new Error('Archived stream block range is invalid. Scan again and choose a stream.')
  if (els.archiveProgress) {
    setArchiveProgress(`Reloading "${summary.title}" segments from blocks ${fromBlock.toString()}-${toBlock.toString()}...`, {
      current: 0n,
      total: toBlock - fromBlock + 1n,
      active: true,
    })
  }
  const segments = await fetchSegmentLogsForStation(station, fromBlock, toBlock, {
    streamId: summary.streamId,
    publisher: summary.publisher,
  })
  const matching = segments.filter((segment) => archiveStreamKey(segment) === key)
  if (!matching.length) {
    throw new Error(`No segment logs for "${summary.title}" were found in blocks ${summary.firstBlock}-${summary.latestBlock}. Scan again with a wider range.`)
  }
  const nextGroups = groupedArchiveSegments([...state.archive.segmentsByKey.values()].flat().concat(matching))
  state.archive.segmentsByKey = nextGroups
  return nextGroups.get(key) || matching
}

function parseRfe1Envelope(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return null
  if (bytes[0] !== 0x52 || bytes[1] !== 0x46 || bytes[2] !== 0x45 || bytes[3] !== 0x31) return null
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0, false)
  const headerStart = 8
  const headerEnd = headerStart + headerLength
  if (!Number.isSafeInteger(headerLength) || headerLength <= 0 || headerEnd > bytes.length) return null
  let header
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerStart, headerEnd)))
  } catch {
    return null
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return null
  const payload = bytes.subarray(headerEnd)
  const publisher = normalizeStationAddressInput(header.publisher)
  const streamId = String(header.streamId ?? '')
  if (!streamId || new TextEncoder().encode(streamId).byteLength > IO_MAX_ABI_STRING_BYTES) return null
  const canonicalHash = canonicalStreamIdHash(streamId)
  if (header.streamIdHash != null && (!isBytes32Hex(header.streamIdHash) || normalizeHex(header.streamIdHash) !== canonicalHash)) return null
  const sequence = Number(header.sequence)
  if (!isBytes32Hex(header.payloadSha256)) return null
  const payloadSha256Hex = normalizeHex(header.payloadSha256)
  if (!publisher || !Number.isSafeInteger(sequence) || sequence < 0) return null
  const durationMs = Number(header.durationMs ?? 0)
  const payloadBytes = Number(header.payloadBytes ?? payload.byteLength)
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) return null
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0 || payloadBytes > payload.byteLength) return null
  const previousSegmentHash = isBytes32Hex(header.previousSegmentHash) ? normalizeHex(header.previousSegmentHash) : ''
  return {
    header,
    payload: payload.subarray(0, payloadBytes),
    publisher,
    streamId,
    streamIdHash: canonicalHash,
    sequence,
    durationMs,
    payloadBytes,
    payloadSha256Hex,
    payloadSha256: strip0x(payloadSha256Hex),
    codec: String(header.codec || 'video/webm').slice(0, 120),
    previousSegmentHash,
  }
}

async function blockBlobTransactions(blockNumber, inboxAddress, { signal } = {}) {
  const block = await rpc('eth_getBlockByNumber', [toBlockHex(blockNumber), true], { signal })
  if (!block || typeof block !== 'object' || !Array.isArray(block.transactions)) {
    throw new Error(`block ${blockNumber} response did not include transactions`)
  }
  if (block.transactions.length > MAX_RPC_LOGS) throw new Error(`block ${blockNumber} exceeds ${MAX_RPC_LOGS} transactions`)
  const inbox = normalizeHex(inboxAddress)
  const blockNumberValue = rpcQuantityNumber(block.number, 'inbox blockNumber')
  if (blockNumberValue !== nonNegativeSafeInteger(blockNumber, 'requested inbox blockNumber')) throw new Error(`block ${blockNumber} response returned a different block number`)
  if (!isBytes32Hex(block.hash)) throw new Error(`block ${blockNumber} response returned an invalid block hash`)
  const blockHash = normalizeHex(block.hash)
  const createdAt = new Date(timestampMsFromSeconds(block.timestamp, 'inbox block timestamp')).toISOString()
  const candidates = []
  const seenHashes = new Set()
  const seenIndices = new Set()
  for (const tx of block.transactions) {
    if (!isAddressHex(tx?.to) || normalizeHex(tx.to) !== inbox) continue
    const blobVersionedHashes = txBlobVersionedHashes(tx)
    if (!blobVersionedHashes.length) continue
    if (!isBytes32Hex(tx.hash)) throw new Error(`block ${blockNumber} blob transaction returned an invalid hash`)
    const txHash = normalizeHex(tx.hash)
    const transactionIndex = rpcQuantityNumber(tx.transactionIndex, 'inbox transactionIndex')
    if (seenHashes.has(txHash) || seenIndices.has(transactionIndex)) throw new Error(`block ${blockNumber} returned duplicate blob transaction identity`)
    seenHashes.add(txHash)
    seenIndices.add(transactionIndex)
    candidates.push({ tx, blockNumber: blockNumberValue, blockHash, createdAt, txHash, transactionIndex, blobVersionedHashes })
  }
  return candidates
}

function classifyInboxDiscoveryFailure(error, { stage = 'candidate' } = {}) {
  if (isAbortError(error)) return { kind: 'abort', message: 'Inbox discovery cancelled.' }
  return {
    kind: stage === 'endpoint' ? 'endpoint' : 'candidate',
    message: archiveScanErrorMessage(error),
  }
}

function inboxScanCompletion({ streamCount = 0, segmentCount = 0, failedCandidates = 0, incompatibleCandidates = 0, failures = [] } = {}) {
  const discovered = `Discovered ${streamCount} inbox stream${streamCount === 1 ? '' : 's'} from ${segmentCount} compatible RFE1 segment${segmentCount === 1 ? '' : 's'}.`
  if (failedCandidates > 0) {
    const example = failures[0]?.message ? ` First candidate error: ${failures[0].message}` : ''
    return {
      status: 'warning',
      message: `Partial scan: ${discovered} Skipped ${failedCandidates} candidate${failedCandidates === 1 ? '' : 's'} after parsing or reconstruction failures.${example}`,
    }
  }
  const ignored = incompatibleCandidates > 0
    ? ` Ignored ${incompatibleCandidates} incompatible candidate${incompatibleCandidates === 1 ? '' : 's'} normally.`
    : ''
  return { status: 'success', message: `${discovered}${ignored}` }
}

async function inboxSegmentFromSidecar({ inboxAddress, txRecord, sidecar, logIndex }) {
  if (!isBytes32Hex(sidecar?.versionedHash)) return null
  const versionedHash = normalizeHex(sidecar.versionedHash)
  if (!isBlobHex(sidecar.blob)) return null
  const envelopeBytes = await reconstructPayload({ blobVersionedHashes: [versionedHash], payloadBytes: 131072 }, { matches: [sidecar] })
  const envelope = parseRfe1Envelope(envelopeBytes)
  if (!envelope) return null
  const actual = strip0x(await sha256Hex(envelope.payload))
  if (actual !== envelope.payloadSha256) return null
  const segment = withChannelIdentity({
    app: 'eth-radio',
    version: 1,
    source: 'blob-inbox',
    inboxAddress,
    publisher: envelope.publisher,
    streamIdHash: envelope.streamIdHash || canonicalStreamIdHash(envelope.streamId),
    sequence: envelope.sequence,
    streamId: envelope.streamId,
    durationMs: envelope.durationMs,
    payloadBytes: envelope.payloadBytes,
    payloadSha256Hex: envelope.payloadSha256Hex,
    payloadSha256: envelope.payloadSha256,
    codec: envelope.codec,
    previousSegmentHash: envelope.previousSegmentHash,
    blobVersionedHashes: [versionedHash],
    txHash: txRecord.txHash,
    transactionHash: txRecord.txHash,
    blockNumber: txRecord.blockNumber,
    blockHash: txRecord.blockHash,
    transactionIndex: txRecord.transactionIndex,
    logIndex,
    slot: nonNegativeSafeInteger(sidecar.slot ?? sidecar.index, 'inbox sidecar slot'),
    createdAt: txRecord.createdAt,
    embeddedPayload: envelope.payload,
  })
  if (segment.payloadBytes > MAX_SEGMENT_PAYLOAD_BYTES) {
    throw new Error(`Invalid Station log payloadBytes: exceeds ${MAX_SEGMENT_PAYLOAD_BYTES} bytes`)
  }
  segment.blobCount = segment.blobVersionedHashes.length
  segment.cacheKey = JSON.stringify(['inbox', normalizeHex(inboxAddress), segment.publisher, segment.streamIdHash, segment.streamId, String(segment.sequence), segment.txHash, versionedHash])
  segment.payloadValidity = 'valid'
  return segment
}

async function scanBlobInboxStreams({ inboxAddress, publisher = '', streamId = '', rangeMode = 'date', fromBlock = '', fromDate = '', toDate = '', signal } = {}) {
  const inbox = normalizeStationAddressInput(inboxAddress)
  if (!inbox) throw new Error('Blob inbox must be a 20-byte destination address or explorer address URL.')
  if (els.archiveInbox) els.archiveInbox.value = inbox
  const publisherAddress = publisher ? normalizeStationAddressInput(publisher) : ''
  if (publisher && !publisherAddress) throw new Error('Publisher/channel must be a 20-byte address or explorer address URL.')
  const head = rpcQuantity(await rpc('eth_blockNumber', [], { signal }), 'eth_blockNumber')
  els.headBlock.textContent = head.toString()
  const range = archiveRangeSelection({ rangeMode, fromBlock, fromDate, toDate })
  const dateRange = range.mode === 'date'
    ? await archiveDateBlockRange(head, { signal, fromDate: range.fromDate, toDate: range.toDate })
    : null
  const recentWindow = Math.min(ARCHIVE_DEFAULT_WINDOW_BLOCKS, 2_000)
  const from = range.mode === 'block'
    ? parseBlockInput(range.fromBlock, 'Inbox from-block')
    : (dateRange?.from ?? (head > BigInt(recentWindow) ? head - BigInt(recentWindow) : 0n))
  const to = dateRange?.to ?? head
  if (els.archiveFromBlock && range.mode === 'block') els.archiveFromBlock.value = from.toString()
  if (from < 0n || from > head) throw new Error(`From block must be between 0 and current head ${head}.`)
  if (to < from || to > head) throw new Error(`Inbox date range must resolve between block ${from} and current head ${head}.`)
  if (to - from > BigInt(ARCHIVE_MAX_BLOCKS)) throw new Error(`Blob inbox scans are capped at ${ARCHIVE_MAX_BLOCKS.toLocaleString()} blocks in the browser. Choose a newer from-block.`)
  state.archive.scanning = true
  state.archive.cancel = false
  state.archive.streams = []
  state.archive.segmentsByKey = new Map()
  state.archive.inboxDiagnostics = { failedCandidates: 0, incompatibleCandidates: 0, failures: [] }
  if (els.archiveScan) els.archiveScan.disabled = true
  renderArchive()
  const archiveAccumulator = createArchiveAccumulator({ maxSegments: ARCHIVE_MAX_SEGMENTS, maxStreams: ARCHIVE_MAX_STREAMS })
  const totalBlocks = to - from + 1n
  let scannedBlocks = 0n
  setArchiveProgress(`Scanning inbox blocks ${from.toString()}-${to.toString()}...`, { current: 0n, total: totalBlocks, active: true })
  for (let start = from; start <= to; start += BigInt(ARCHIVE_SCAN_CHUNK_BLOCKS + 1)) {
    if (state.archive.cancel) break
    const end = start + BigInt(ARCHIVE_SCAN_CHUNK_BLOCKS) > to ? to : start + BigInt(ARCHIVE_SCAN_CHUNK_BLOCKS)
    setArchiveProgress(`Scanning inbox blocks ${start.toString()}-${end.toString()} of ${to.toString()}...`, {
      current: start - from,
      total: totalBlocks,
      active: true,
    })
    for (let blockNumber = Number(start); blockNumber <= Number(end); blockNumber += 1) {
      if (state.archive.cancel) break
      let txRecords
      try {
        txRecords = await blockBlobTransactions(blockNumber, inbox, { signal })
      } catch (error) {
        if (isAbortError(error)) throw error
        throw new Error(`Inbox scan failed at block ${blockNumber}: ${archiveScanErrorMessage(error)}`, { cause: error })
      }
      for (const txRecord of txRecords) {
        let slot
        let sidecarRecord
        try {
          slot = await segmentSlot({ txHash: txRecord.txHash }, { signal })
          sidecarRecord = await sidecarsForSlot(slot, { signal })
        } catch (error) {
          const failure = classifyInboxDiscoveryFailure(error, { stage: 'endpoint' })
          if (failure.kind === 'abort') throw error
          throw new Error(`Inbox discovery endpoint failure for ${shortHash(txRecord.txHash)}: ${failure.message}`, { cause: error })
        }
        const wanted = new Set(txRecord.blobVersionedHashes.map(normalizeHex))
        let index = 0
        for (const sidecar of sidecarRecord.sidecars.filter((candidate) => wanted.has(normalizeHex(candidate.versionedHash)))) {
          let segment
          try {
            segment = await inboxSegmentFromSidecar({ inboxAddress: inbox, txRecord: { ...txRecord, slot }, sidecar: { ...sidecar, slot }, logIndex: index })
            index += 1
          } catch (error) {
            index += 1
            const failure = classifyInboxDiscoveryFailure(error)
            if (failure.kind === 'abort') throw error
            state.archive.inboxDiagnostics.failedCandidates += 1
            if (state.archive.inboxDiagnostics.failures.length < 3) {
              state.archive.inboxDiagnostics.failures.push({
                txHash: txRecord.txHash,
                versionedHash: normalizeHex(sidecar.versionedHash),
                message: failure.message,
              })
            }
            continue
          }
          if (!segment) {
            state.archive.inboxDiagnostics.incompatibleCandidates += 1
            continue
          }
          if (publisherAddress && normalizeHex(segment.publisher) !== publisherAddress) continue
          if (streamId && segment.streamId !== streamId) continue
          appendArchiveSegments(archiveAccumulator, [segment], {
            narrowingHint: 'Choose a later from-block or add both publisher and stream filters before scanning again.',
          })
        }
      }
      scannedBlocks = BigInt(blockNumber) - from + 1n
      setArchiveProgress(`Scanning inbox block ${blockNumber} of ${to.toString()}...`, {
        current: scannedBlocks,
        total: totalBlocks,
        active: true,
      })
    }
  }
  const allSegments = archiveAccumulator.segments
  state.archive.streams = groupOldStreamsFromSegmentPublishedLogs(allSegments)
  state.archive.segmentsByKey = groupedArchiveSegments(allSegments)
  renderArchive()
  state.archive.scanning = false
  if (els.archiveScan) els.archiveScan.disabled = false
  const stopped = state.archive.cancel
  state.archive.cancel = false
  if (els.archiveProgress) {
    const completion = inboxScanCompletion({
      streamCount: state.archive.streams.length,
      segmentCount: allSegments.length,
      ...state.archive.inboxDiagnostics,
    })
    const message = stopped
      ? `Stopped after discovering ${state.archive.streams.length} inbox stream${state.archive.streams.length === 1 ? '' : 's'}.`
      : completion.message
    setArchiveProgress(message, {
      current: stopped ? scannedBlocks : totalBlocks,
      total: totalBlocks,
      active: false,
      status: stopped ? 'cancelled' : completion.status,
    })
  }
}

function archiveTuneIsCurrent(tuneSerial, runtime = null) {
  return tuneSerial === state.archive.tuneSerial && (!runtime || runtimeIsCurrent(runtime))
}

function beginArchiveTuneRequest() {
  state.playbackContextGeneration += 1
  return ++state.archive.tuneSerial
}

async function tuneArchiveStream(key, { tuneSerial = beginArchiveTuneRequest() } = {}) {
  const summary = state.archive.streams.find((stream) => stream.key === key)
  if (!summary) throw new Error('Archive stream is no longer available. Scan again and choose a stream.')
  let segments
  try {
    segments = await archiveSegmentsForWatch(key, summary)
  } catch (error) {
    if (!archiveTuneIsCurrent(tuneSerial)) return false
    throw error
  }
  if (!archiveTuneIsCurrent(tuneSerial)) return false
  if (!segments.length) throw new Error('Archive stream is no longer available. Scan again and choose a stream.')
  setStatus(`Watching ${state.archive.mode === 'inbox' ? 'blob inbox' : 'Station'} stream "${summary.title}"...`)
  stopStreaming()
  state.config = {
    ...state.config,
    stationAddress: normalizeStationAddressInput(els.archiveStation?.value) || state.config.stationAddress,
    streamId: summary.streamId || state.config.streamId,
    streamIdHash: summary.streamIdHash || canonicalStreamIdHash(summary.streamId || state.config.streamId),
    publisher: summary.publisher,
    fromBlock: String(summary.firstBlock),
  }
  saveConfig(state.config)
  resetRuntimeState()
  const runtime = runtimeSnapshot()
  state.anchor = { blockNumber: summary.firstBlock, order: segmentOrder(segments[0]), txHash: segments[0].txHash }
  state.segments = segments
  state.archive.tunedKey = key
  state.selectedSegmentQuery = segments[0]?.txHash || ''
  state.metadataUpdatedAt = new Date().toISOString()
  state.playbackMode = 'idle'
  state.segmentNotice = `Loaded ${segments.length} segment${segments.length === 1 ? '' : 's'} for "${summary.title}". Choose GET or a segment number to verify and play.`
  fillForm()
  syncUrlState()
  render()
  revealTunedStream()
  setStatus(`Loaded "${summary.title}" with ${summary.segmentCount} segment${summary.segmentCount === 1 ? '' : 's'}. Choose GET or a segment number to verify and play.`)
  await cacheSegmentMetadata(state.segments, runtime)
  if (!archiveTuneIsCurrent(tuneSerial, runtime)) return false
  for (const segment of state.segments) {
    if (!archiveTuneIsCurrent(tuneSerial, runtime)) return false
    try {
      if (segment.source === 'blob-inbox' && segment.embeddedPayload instanceof Uint8Array) {
        await verifySegment(segment, runtime)
      } else {
        const cached = await validatedCachedSegment(segment, runtime)
        if (!archiveTuneIsCurrent(tuneSerial, runtime)) return false
        if (cached) promoteVerifiedRecord(segment, cached)
      }
    } catch (error) {
      if (!archiveTuneIsCurrent(tuneSerial, runtime) || isAbortError(error)) return false
      setStatus(`Loaded "${summary.title}", but segment #${segment.sequence} still needs manual verification: ${publicErrorMessage(error)}`)
    }
  }
  await refreshCacheStats(runtime)
  if (!archiveTuneIsCurrent(tuneSerial, runtime)) return false
  await refreshBlobspace(runtime)
  if (!archiveTuneIsCurrent(tuneSerial, runtime)) return false
  render()
  const ready = firstVerifiedRecord()
  if (ready) {
    state.segmentNotice = ''
    playRecord(ready, { userRequested: true })
    render()
    setStatus(`Now watching "${summary.title}" from verified segment #${ready.sequence}.`)
  } else {
    prefetchWindow()
    state.segmentNotice = `Loaded ${summary.segmentCount} segment${summary.segmentCount === 1 ? '' : 's'} for "${summary.title}". Choose GET/PLAY in Stream Segments to verify and replay.`
    render()
    setStatus(`Loaded "${summary.title}" with ${summary.segmentCount} segment${summary.segmentCount === 1 ? '' : 's'}. Choose GET/PLAY in Stream Segments to verify and replay.`)
  }
  return true
}

function tuneToStream(stream, { reset = true } = {}) {
  const identity = channelIdentity(stream)
  const currentKey = JSON.stringify([state.config.publisher || '', state.config.streamIdHash || canonicalStreamIdHash(state.config.streamId), state.config.streamId])
  if (identity.key === currentKey) return false
  state.config = {
    ...state.config,
    publisher: identity.publisher,
    streamIdHash: identity.streamIdHash,
    streamId: identity.streamId,
  }
  saveConfig(state.config)
  fillForm()
  if (reset) {
    resetRuntimeState()
    render()
  }
  setStatus(`Watching stream ${identity.streamId} from publisher ${shortHash(identity.publisher)}${stream.sequence != null ? ` at segment #${stream.sequence}` : ''}.`)
  return true
}

async function runBoundedTasks(items, concurrency, task) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Task concurrency must be a positive safe integer')
  for (let offset = 0; offset < items.length; offset += concurrency) {
    const outcomes = await Promise.allSettled(items.slice(offset, offset + concurrency).map(task))
    const failure = outcomes.find((outcome) => outcome.status === 'rejected')
    if (failure) throw failure.reason
  }
}

function cacheBlockTimestamp(blockNumber, blockHash, timestampMs) {
  const normalizedHash = normalizeHex(blockHash)
  const previousHash = state.blockTimeHashes.get(blockNumber)
  if (previousHash && previousHash !== normalizedHash) state.blockTimes.delete(previousHash)
  state.blockTimes.delete(normalizedHash)
  state.blockTimes.set(normalizedHash, timestampMs)
  state.blockTimeHashes.set(blockNumber, normalizedHash)
  while (state.blockTimes.size > MAX_BLOCK_TIME_CACHE_ENTRIES) {
    const oldestHash = state.blockTimes.keys().next().value
    state.blockTimes.delete(oldestHash)
    for (const [number, hash] of state.blockTimeHashes) {
      if (hash === oldestHash) state.blockTimeHashes.delete(number)
    }
  }
  return timestampMs
}

async function hydrateSegmentTimes(segments, { signal } = {}) {
  const blocks = unique(segments
    .filter((segment) => isBytes32Hex(segment.blockHash) && Number.isSafeInteger(segment.blockNumber))
    .map((segment) => `${segment.blockNumber}:${normalizeHex(segment.blockHash)}`))
  await runBoundedTasks(blocks, MAX_BLOCK_TIME_REQUEST_CONCURRENCY, async (identity) => {
    const separator = identity.indexOf(':')
    const blockNumber = Number(identity.slice(0, separator))
    const blockHash = identity.slice(separator + 1)
    const cachedTimestamp = state.blockTimes.get(blockHash)
    if (cachedTimestamp) {
      cacheBlockTimestamp(blockNumber, blockHash, cachedTimestamp)
      for (const segment of segments) {
        if (segment.blockNumber === blockNumber && normalizeHex(segment.blockHash) === blockHash) {
          segment.createdAt = new Date(cachedTimestamp).toISOString()
        }
      }
      return
    }
    try {
      const block = await rpc('eth_getBlockByHash', [blockHash, false], { signal })
      if (!block || normalizeHex(block.hash) !== blockHash) throw new Error('Execution block hash did not match the Station event')
      if (rpcQuantityNumber(block.number, 'block number') !== blockNumber) throw new Error('Execution block number did not match the Station event')
      const timestampMs = timestampMsFromSeconds(block.timestamp, 'block timestamp')
      cacheBlockTimestamp(blockNumber, blockHash, timestampMs)
      for (const segment of segments) {
        if (segment.blockNumber === blockNumber && normalizeHex(segment.blockHash) === blockHash) {
          segment.createdAt = new Date(timestampMs).toISOString()
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error
    }
  })
  for (const segment of segments) {
    const blockHash = isBytes32Hex(segment.blockHash) ? normalizeHex(segment.blockHash) : ''
    const timestampMs = blockHash ? state.blockTimes.get(blockHash) : null
    if (timestampMs && !segment.createdAt) segment.createdAt = new Date(timestampMs).toISOString()
  }
}

function receiptStationSegments(receipt) {
  if (!receipt || typeof receipt !== 'object' || !Array.isArray(receipt.logs)) {
    throw new Error('Transaction receipt logs must be an array')
  }
  if (receipt.logs.length > MAX_RPC_LOGS) throw new Error(`Transaction receipt logs exceed ${MAX_RPC_LOGS} entries`)
  const station = normalizeHex(state.config.stationAddress)
  return receipt.logs
    .filter((log) => isAddressHex(log?.address) && isBytes32Hex(log?.topics?.[0]))
    .filter((log) => normalizeHex(log.address) === station && normalizeHex(log.topics[0]) === EVENT_TOPIC)
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
  state.metadataState = 'none'
  state.anchor = null
  render()
  setStatus(`Looking up transaction ${shortHash(txHash)}...`)
  const receipt = await rpc('eth_getTransactionReceipt', [txHash])
  if (!receipt) throw new Error(`Transaction ${shortHash(txHash)} was not found on ${CHAIN_PRESETS[state.config.chainPreset]?.label || state.config.chainPreset}.`)
  const anchorSegments = receiptStationSegments(receipt)
  const anchorBlock = rpcQuantityNumber(receipt.blockNumber, 'receipt blockNumber')
  const receiptTransactionIndex = rpcQuantityNumber(receipt.transactionIndex, 'receipt transactionIndex')
  const txOrder = BigInt(anchorBlock) * 1_000_000n + BigInt(receiptTransactionIndex) * 1_000n
  if (anchorSegments[0]) tuneToStream(anchorSegments[0], { reset: false })
  const headHex = await rpc('eth_blockNumber')
  const head = rpcQuantity(headHex, 'eth_blockNumber')
  els.headBlock.textContent = head.toString()
  setStatus(`Building segment window from block ${anchorBlock} forward...`)
  const initialRange = incrementalStationRange({
    anchorBlock,
    cursorBlock: anchorBlock,
    headBlock: head,
    overlapBlocks: LIVE_REFRESH_REORG_BLOCKS,
    maxBlocks: LIVE_REFRESH_MAX_BLOCKS,
  })
  const forward = initialRange ? await fetchSegmentLogs(initialRange.fromBlock, initialRange.toBlock) : []
  const anchor = anchorSegments[0] || forward.find((segment) => segmentOrder(segment) >= txOrder)
  if (!anchor) {
    throw new Error(`No Station segments for ${state.config.streamId} were found at or after ${shortHash(txHash)}.`)
  }
  const anchorOrder = anchorSegments.length ? segmentOrder(anchor) : txOrder
  state.anchor = { blockNumber: anchorBlock, order: anchorOrder, txHash, cursorBlock: initialRange?.nextCursorBlock ?? BigInt(anchorBlock) }
  state.segments = forward.filter((segment) => segmentOrder(segment) >= anchorOrder)
  if (!state.segments.some((segment) => segment.cacheKey === anchor.cacheKey)) {
    state.segments.unshift(anchor)
  }
  state.segments.sort((a, b) =>
    a.sequence - b.sequence ||
    a.blockNumber - b.blockNumber ||
    a.transactionIndex - b.transactionIndex ||
    a.logIndex - b.logIndex)
  state.segments = annotateStreamContinuity(state.segments)
  await cacheSegmentMetadata(state.segments)
  state.verified.clear()
  await hydrateValidatedCachedSegments(state.segments)
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
  state.metadataState = 'none'
  state.anchor = null
  render()
  const headHex = await rpc('eth_blockNumber')
  const head = rpcQuantity(headHex, 'eth_blockNumber')
  els.headBlock.textContent = head.toString()
  if (BigInt(anchorBlock) > head) {
    throw new Error(`Block ${anchorBlock} is ahead of current ${CHAIN_PRESETS[state.config.chainPreset]?.label || state.config.chainPreset} head ${head}.`)
  }
  setStatus(`Building segment window from block ${anchorBlock} forward...`)
  const anchorOrder = BigInt(anchorBlock) * 1_000_000n
  const initialRange = incrementalStationRange({
    anchorBlock,
    cursorBlock: anchorBlock,
    headBlock: head,
    overlapBlocks: LIVE_REFRESH_REORG_BLOCKS,
    maxBlocks: LIVE_REFRESH_MAX_BLOCKS,
  })
  state.anchor = { blockNumber: anchorBlock, order: anchorOrder, txHash: '', cursorBlock: initialRange?.nextCursorBlock ?? BigInt(anchorBlock) }
  state.segments = initialRange ? await fetchSegmentLogs(initialRange.fromBlock, initialRange.toBlock) : []
  if (!state.segments.length) {
    throw new Error(`No Station segments for ${state.config.streamId} were found at or after block ${anchorBlock}.`)
  }
  await cacheSegmentMetadata(state.segments)
  state.verified.clear()
  await hydrateValidatedCachedSegments(state.segments)
  await refreshCacheStats()
  await refreshBlobspace()
  render()
  return state.segments[0]
}

async function segmentSlot(segment, { signal } = {}) {
  if (segment.slot) return segment.slot
  const tx = await rpc('eth_getTransactionByHash', [segment.txHash], { signal })
  const block = await rpc('eth_getBlockByHash', [tx.blockHash, false], { signal })
  const genesis = await beaconGenesisTime({ signal })
  const timestamp = rpcQuantity(block.timestamp, 'block timestamp')
  if (timestamp < genesis) throw new Error('block timestamp is before beacon genesis')
  return bigintSafeInteger(executionTimestampSlot(timestamp, genesis), 'segment slot')
}

function nonNegativeSafeInteger(value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return number
}

async function sidecarsForSlot(slot, { signal } = {}) {
  const cacheKey = slotSidecarsKey(slot)
  const cached = state.sidecarMemoryCache.get(cacheKey)
  if (cached) {
    state.sidecarMemoryCache.delete(cacheKey)
    state.sidecarMemoryCache.set(cacheKey, cached)
    return cached
  }
  const pending = state.sidecarFetchPromises.get(cacheKey)
  if (pending) return pending

  const generation = state.runtimeGeneration
  const cacheEpoch = state.sidecarCacheEpoch
  const fetchPromise = (async () => {
    const started = performance.now()
    const rows = beaconDataArray(await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`, { signal }), 'blob sidecars', MAX_BLOBS_PER_BLOCK)
    if (signal?.aborted || generation !== state.runtimeGeneration || cacheEpoch !== state.sidecarCacheEpoch) {
      throw requestAbortError('Runtime configuration changed.')
    }
    const seenIndices = new Set()
    const sidecars = await Promise.all(rows.map(async (sidecar) => {
      const commitment = sidecar.kzg_commitment || sidecar.kzgCommitment
      const index = sidecarIndex(sidecar.index, 'beacon sidecar index')
      if (seenIndices.has(index)) throw new Error(`beacon sidecars contain duplicate index ${index}`)
      seenIndices.add(index)
      if (!isBlobHex(sidecar.blob)) throw new Error(`beacon sidecar ${index} blob must be exactly ${BLOB_BYTES} bytes`)
      const versionedHash = await sidecarVersionedHash(sidecar)
      return {
        index,
        versionedHash,
        commitment,
        blob: sidecar.blob,
      }
    }))
    if (signal?.aborted || generation !== state.runtimeGeneration || cacheEpoch !== state.sidecarCacheEpoch) {
      throw requestAbortError('Runtime configuration changed.')
    }
    const record = {
      cacheKey,
      chainPreset: state.config.chainPreset,
      slot: nonNegativeSafeInteger(slot, 'beacon slot'),
      sidecars,
      fetchMs: Math.round(performance.now() - started),
      fetchedAt: new Date().toISOString(),
    }
    const normalizedRecord = normalizeSidecarRecord(record, slot)
    if (!normalizedRecord) throw new Error('Invalid sidecar record from beacon response')
    state.sidecarMemoryCache.set(cacheKey, normalizedRecord)
    while (state.sidecarMemoryCache.size > MAX_SIDECAR_MEMORY_SLOTS) {
      const oldestKey = state.sidecarMemoryCache.keys().next().value
      state.sidecarMemoryCache.delete(oldestKey)
    }
    return normalizedRecord
  })()
  state.sidecarFetchPromises.set(cacheKey, fetchPromise)
  try {
    return await fetchPromise
  } finally {
    if (state.sidecarFetchPromises.get(cacheKey) === fetchPromise) state.sidecarFetchPromises.delete(cacheKey)
  }
}

async function sidecarsForSegment(segment, { signal } = {}) {
  const slot = await segmentSlot(segment, { signal })
  const wanted = new Set(segmentBlobHashes(segment))
  const matches = []
  const record = await sidecarsForSlot(slot, { signal })
  if (!Array.isArray(record.sidecars)) throw new Error('Invalid sidecar cache record: sidecars must be an array')
  for (const sidecar of record.sidecars) {
    if (wanted.has(normalizeHex(sidecar.versionedHash))) matches.push(sidecar)
  }
  return { slot, matches }
}

async function payloadFromArchive(segment, { signal } = {}) {
  const payloadBytes = segmentPayloadLength(segment)
  const failures = []
  for (const template of state.config.archiveTemplates) {
    const url = archiveUrl(template, segment)
    try {
      const response = await fetchWithTimeout(url, {}, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await readBoundedResponseBytes(response, payloadBytes, 'Archive payload', { signal })
      if (payload.byteLength !== payloadBytes) {
        throw new Error(`Archive payload length mismatch: expected ${payloadBytes} bytes, received ${payload.byteLength}`)
      }
      await verifyPayloadHash(segment, payload)
      return { payload, archiveUrl: url }
    } catch (error) {
      if (isAbortError(error)) throw error
      failures.push(`${publicUrlLabel(url)}: ${publicErrorMessage(error)}`)
    }
  }
  if (failures.length) throw new Error(`archive fallback failed: ${failures.join(' | ')}`)
  return null
}

async function payloadFromBeacon(segment, { signal } = {}) {
  const sidecars = await sidecarsForSegment(segment, { signal })
  const payload = await reconstructPayload(segment, sidecars)
  await verifyPayloadHash(segment, payload)
  return { payload, slot: sidecars.slot }
}

async function verifyPayloadHash(segment, payload) {
  const actual = strip0x(await sha256Hex(payload))
  if (actual !== segment.payloadSha256) {
    segment.payloadValidity = 'invalid'
    throw new Error(`SHA-256 mismatch for #${segment.sequence}`)
  }
  segment.payloadValidity = 'valid'
}

function storageMemoryStore(storeName) {
  const store = memoryStores[storeName]
  if (!store) throw new Error(`Unknown browser cache store: ${storeName}`)
  return store
}

function memorySegmentLimitBytes() {
  const configuredMb = clampCacheLimitMb(state.config.cacheLimitMb, DEFAULTS.cacheLimitMb, { min: CACHE_LIMIT_MIN_MB, max: CACHE_LIMIT_MAX_MB })
  return Math.min(configuredMb, MEMORY_CACHE_MAX_MB) * 1024 * 1024
}

function putMemoryRecord(storeName, record) {
  const memory = storageMemoryStore(storeName)
  memory.set(record.cacheKey, record)
  if (storeName !== 'segments') return true
  let total = [...memory.values()].reduce((sum, item) => sum + cachedSegmentByteLength(item), 0)
  const limit = memorySegmentLimitBytes()
  const oldest = [...memory.values()].sort((a, b) => String(a.verifiedAt || '').localeCompare(String(b.verifiedAt || '')))
  for (const item of oldest) {
    if (total <= limit) break
    memory.delete(item.cacheKey)
    total -= cachedSegmentByteLength(item)
  }
  return memory.has(record.cacheKey)
}

function markIndexedDbUnavailable(error) {
  storageStatus.indexedDb = 'unavailable'
  storageStatus.indexedDbError = storageErrorText(error)
  return null
}

function openDb() {
  if (storageStatus.indexedDb === 'unavailable' || typeof indexedDB === 'undefined') {
    if (typeof indexedDB === 'undefined') markIndexedDbUnavailable('IndexedDB is not available in this browser.')
    return Promise.resolve(null)
  }
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    let request
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (error) {
      resolve(markIndexedDbUnavailable(error))
      return
    }
    request.onupgradeneeded = (event) => {
      try {
        const db = request.result
        const segmentStore = db.objectStoreNames.contains('segments')
          ? request.transaction.objectStore('segments')
          : db.createObjectStore('segments', { keyPath: 'cacheKey' })
        if (!segmentStore.indexNames.contains('verifiedAt')) segmentStore.createIndex('verifiedAt', 'verifiedAt')
        if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'cacheKey' })
        if (event.oldVersion > 0 && event.oldVersion < 7) {
          segmentStore.clear()
          request.transaction.objectStore('metadata').clear()
        }
        if (db.objectStoreNames.contains('sidecars')) db.deleteObjectStore('sidecars')
      } catch (error) {
        markIndexedDbUnavailable(error)
        try {
          request.transaction?.abort()
        } catch {
          // The request error handler completes the memory-only fallback.
        }
      }
    }
    request.onsuccess = () => {
      if (storageStatus.indexedDb === 'unavailable') {
        request.result.close()
        resolve(null)
        return
      }
      storageStatus.indexedDb = 'available'
      resolve(request.result)
    }
    request.onerror = () => resolve(markIndexedDbUnavailable(request.error))
    request.onblocked = () => resolve(markIndexedDbUnavailable('IndexedDB upgrade was blocked.'))
  })
  return dbPromise
}

async function getRecord(storeName, cacheKey) {
  const memory = storageMemoryStore(storeName)
  const fallback = memory.get(cacheKey) || null
  const db = await openDb()
  if (!db) return fallback
  return new Promise((resolve) => {
    let request
    try {
      request = db.transaction(storeName).objectStore(storeName).get(cacheKey)
    } catch (error) {
      markIndexedDbUnavailable(error)
      resolve(fallback)
      return
    }
    request.onsuccess = () => {
      const record = request.result || fallback
      if (record && storeName !== 'segments') memory.set(cacheKey, record)
      resolve(record || null)
    }
    request.onerror = () => {
      markIndexedDbUnavailable(request.error)
      resolve(fallback)
    }
  })
}

async function putRecord(storeName, record) {
  const memory = storageMemoryStore(storeName)
  const db = await openDb()
  if (!db) {
    putMemoryRecord(storeName, record)
    return false
  }
  return new Promise((resolve) => {
    let request
    try {
      request = db.transaction(storeName, 'readwrite').objectStore(storeName).put(record)
    } catch (error) {
      markIndexedDbUnavailable(error)
      resolve(false)
      return
    }
    request.onsuccess = () => {
      if (storeName !== 'segments') memory.set(record.cacheKey, record)
      resolve(true)
    }
    request.onerror = () => {
      markIndexedDbUnavailable(request.error)
      putMemoryRecord(storeName, record)
      resolve(false)
    }
  })
}

async function clearStore(storeName) {
  storageMemoryStore(storeName).clear()
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    let request
    try {
      request = db.transaction(storeName, 'readwrite').objectStore(storeName).clear()
    } catch (error) {
      markIndexedDbUnavailable(error)
      resolve(false)
      return
    }
    request.onsuccess = () => resolve(true)
    request.onerror = () => {
      markIndexedDbUnavailable(request.error)
      resolve(false)
    }
  })
}

function metadataScope(config = state.config) {
  return metadataScopeForConfig(config)
}

function slotSidecarsKey(slot) {
  return `slot:${state.config.chainPreset}:${slot}`
}

async function cacheSegmentMetadata(segments, runtime = runtimeSnapshot()) {
  requireCurrentRuntime(runtime)
  const scope = metadataScope()
  const record = {
    ...scope,
    segments: segments.map(({ embeddedPayload: _embeddedPayload, ...segment }) => segment),
    updatedAt: new Date().toISOString(),
  }
  await putRecord('metadata', record)
  requireCurrentRuntime(runtime)
  state.metadataUpdatedAt = record.updatedAt
  state.metadataState = 'fresh'
}

async function restoreSegmentMetadata(runtime = runtimeSnapshot()) {
  requireCurrentRuntime(runtime)
  const restoreSerial = state.refreshSerial
  const scope = metadataScope()
  const cached = matchingCachedMetadata(await getRecord('metadata', scope.cacheKey), scope)
  requireCurrentRuntime(runtime)
  if (!cached) return false
  state.segments = cached.segments
  const verified = new Map()
  for (const segment of selectRecentSegmentsWithinByteBudget(cached.segments, VERIFIED_MEMORY_MAX_BYTES)) {
    try {
      const record = await validatedCachedSegment(segment, runtime)
      if (record) verified.set(segment.cacheKey, record)
    } catch (error) {
      if (!runtimeIsCurrent(runtime)) throw error
    }
  }
  if (!runtimeIsCurrent(runtime)) return false
  if (restoreSerial !== state.refreshSerial || metadataScope().cacheKey !== scope.cacheKey) return false
  state.verified = verified
  state.metadataUpdatedAt = cached.updatedAt || ''
  state.metadataState = 'cached'
  state.segmentNotice = `Restored ${state.segments.length} cached segment${state.segments.length === 1 ? '' : 's'} from ${fmtAge(state.metadataUpdatedAt)} ago. Network confirmation is pending.`
  render()
  return true
}

async function restoreInitialCachedMetadata(runtime = runtimeSnapshot()) {
  if (!normalizeStationAddressInput(state.config.publisher)
    || !normalizeStationAddressInput(state.config.stationAddress)
    || !state.config.streamId) return false
  try {
    const restored = await restoreSegmentMetadata(runtime)
    if (restored) {
      setRuntimeStatus(runtime, `Restored ${state.segments.length} cached segment${state.segments.length === 1 ? '' : 's'}; refresh to check for newer Station events.`)
    }
    return restored
  } catch (error) {
    setRuntimeStatus(runtime, `Cached metadata could not be restored: ${publicErrorMessage(error)}`)
    return false
  }
}

async function cachedSegment(cacheKey) {
  return getRecord('segments', cacheKey)
}

async function validatedCachedSegment(segment, runtime = runtimeSnapshot()) {
  requireCurrentRuntime(runtime)
  const loaded = assertCurrentLoadedSegment(segment)
  const record = await cachedSegment(loaded.cacheKey)
  requireCurrentRuntime(runtime)
  if (!record?.payload) return null
  try {
    const payloadBytes = segmentPayloadLength(loaded)
    const payload = await cachedPayloadBytes(record.payload, payloadBytes)
    if (payload.byteLength !== payloadBytes) throw new Error(`Cached payload length mismatch for #${loaded.sequence}`)
    await verifyPayloadHash(loaded, payload)
    requireCurrentRuntime(runtime)
    return {
      ...record,
      cacheKey: loaded.cacheKey,
      publisher: loaded.publisher,
      streamIdHash: loaded.streamIdHash,
      streamId: loaded.streamId,
      channelKey: loaded.channelKey,
      sequence: loaded.sequence,
      txHash: loaded.txHash,
      payloadSha256: loaded.payloadSha256,
      codec: loaded.codec,
      continuity: loaded.continuity,
      quarantined: false,
      payloadValidity: 'valid',
      payload,
      bytes: payload.byteLength,
      cacheHit: true,
    }
  } catch (error) {
    requireCurrentRuntime(runtime)
    await deleteCachedSegment(loaded.cacheKey).catch(() => {})
    requireCurrentRuntime(runtime)
    throw error
  }
}

async function hydrateValidatedCachedSegments(segments, runtime = runtimeSnapshot()) {
  requireCurrentRuntime(runtime)
  for (const segment of selectRecentSegmentsWithinByteBudget(segments, VERIFIED_MEMORY_MAX_BYTES)) {
    try {
      const record = await validatedCachedSegment(segment, runtime)
      if (record) promoteVerifiedRecord(segment, record)
    } catch (error) {
      if (!runtimeIsCurrent(runtime)) throw error
      state.verified.delete(segment.cacheKey)
    }
  }
}

async function ensureCacheAccounting(db) {
  if (!db) {
    return [...storageMemoryStore('segments').values()].reduce((sum, record) => sum + cachedSegmentByteLength(record), 0)
  }
  if (cacheAccountingPromise) return cacheAccountingPromise
  cacheAccountingPromise = new Promise((resolve) => {
    let request
    try {
      request = db.transaction('metadata').objectStore('metadata').get(CACHE_TOTAL_KEY)
    } catch (error) {
      markIndexedDbUnavailable(error)
      resolve(0)
      return
    }
    request.onsuccess = () => {
      if (Number.isSafeInteger(request.result?.bytes) && request.result.bytes >= 0) {
        resolve(request.result.bytes)
        return
      }
      let total = 0
      let cursorRequest
      try {
        cursorRequest = db.transaction('segments').objectStore('segments').openCursor()
      } catch (error) {
        markIndexedDbUnavailable(error)
        resolve(0)
        return
      }
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (cursor) {
          try {
            total += cachedSegmentByteLength(cursor.value)
          } catch (error) {
            markIndexedDbUnavailable(error)
            resolve(0)
            return
          }
          cursor.continue()
          return
        }
        putRecord('metadata', { cacheKey: CACHE_TOTAL_KEY, bytes: total, updatedAt: new Date().toISOString() })
          .finally(() => resolve(total))
      }
      cursorRequest.onerror = () => {
        markIndexedDbUnavailable(cursorRequest.error)
        resolve(0)
      }
    }
    request.onerror = () => {
      markIndexedDbUnavailable(request.error)
      resolve(0)
    }
  }).finally(() => {
    cacheAccountingPromise = null
  })
  return cacheAccountingPromise
}

async function cacheTotalBytes() {
  const db = await openDb()
  return ensureCacheAccounting(db)
}

async function allCachedSegments() {
  const memory = storageMemoryStore('segments')
  const db = await openDb()
  if (!db) return [...memory.values()]
  return new Promise((resolve) => {
    const records = []
    let request
    try {
      request = db.transaction('segments').objectStore('segments').openCursor()
    } catch (error) {
      markIndexedDbUnavailable(error)
      resolve([...memory.values()])
      return
    }
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        const { payload: _payload, ...metadata } = cursor.value
        records.push(metadata)
        cursor.continue()
        return
      }
      resolve(records)
    }
    request.onerror = () => {
      markIndexedDbUnavailable(request.error)
      resolve([...memory.values()])
    }
  })
}

async function putPersistentSegment(record) {
  const db = await openDb()
  if (!db) {
    putMemoryRecord('segments', record)
    return false
  }
  await ensureCacheAccounting(db)
  return new Promise((resolve) => {
    let transaction
    let oldRequest
    let totalRequest
    let oldReady = false
    let totalReady = false
    const write = () => {
      if (!oldReady || !totalReady) return
      try {
        const oldBytes = oldRequest.result ? cachedSegmentByteLength(oldRequest.result) : 0
        const currentTotal = Number.isSafeInteger(totalRequest.result?.bytes) ? totalRequest.result.bytes : 0
        const nextTotal = currentTotal - oldBytes + cachedSegmentByteLength(record)
        transaction.objectStore('segments').put(record)
        transaction.objectStore('metadata').put({ cacheKey: CACHE_TOTAL_KEY, bytes: nextTotal, updatedAt: new Date().toISOString() })
      } catch (error) {
        markIndexedDbUnavailable(error)
        try { transaction.abort() } catch { /* already complete */ }
      }
    }
    try {
      transaction = db.transaction(['segments', 'metadata'], 'readwrite')
      oldRequest = transaction.objectStore('segments').get(record.cacheKey)
      totalRequest = transaction.objectStore('metadata').get(CACHE_TOTAL_KEY)
    } catch (error) {
      markIndexedDbUnavailable(error)
      putMemoryRecord('segments', record)
      resolve(false)
      return
    }
    oldRequest.onsuccess = () => { oldReady = true; write() }
    totalRequest.onsuccess = () => { totalReady = true; write() }
    transaction.oncomplete = () => resolve(true)
    transaction.onabort = transaction.onerror = () => {
      markIndexedDbUnavailable(transaction.error || 'IndexedDB segment write failed')
      putMemoryRecord('segments', record)
      resolve(false)
    }
  })
}

async function putCachedSegment(record, runtime = null) {
  if (runtime) requireCurrentRuntime(runtime)
  const storedRecord = {
    ...record,
    runtimeGeneration: runtime?.generation ?? state.runtimeGeneration,
    runtimeWriteToken: crypto.randomUUID(),
  }
  await putPersistentSegment(storedRecord)
  if (runtime && !runtimeIsCurrent(runtime)) {
    await deleteCachedSegmentIfCurrent(storedRecord)
    requireCurrentRuntime(runtime)
  }
  try {
    await enforceCacheLimit(runtime)
  } catch (error) {
    if (runtime && !runtimeIsCurrent(runtime)) await deleteCachedSegmentIfCurrent(storedRecord)
    throw error
  }
  if (runtime) requireCurrentRuntime(runtime)
  return storedRecord
}

async function deleteCachedSegment(cacheKey) {
  const deleted = await deletePersistentSegment(cacheKey)
  if (deleted) releaseObjectUrl(cacheKey, { preserveActive: true })
  return deleted
}

async function deletePersistentSegment(cacheKey, expected = null, { signal } = {}) {
  if (signal?.aborted) return false
  const memory = storageMemoryStore('segments')
  const db = await openDb()
  if (!db) {
    const existing = memory.get(cacheKey)
    if (!existing || (expected && !sameCachedSegmentWrite(existing, expected))) return false
    memory.delete(cacheKey)
    return true
  }
  await ensureCacheAccounting(db)
  if (signal?.aborted) return false
  return new Promise((resolve) => {
    let transaction
    let recordRequest
    let totalRequest
    let recordReady = false
    let totalReady = false
    let deleted = false
    const abortTransaction = () => {
      try { transaction?.abort() } catch { /* already complete */ }
    }
    const remove = () => {
      if (!recordReady || !totalReady || signal?.aborted) return
      const current = recordRequest.result
      if (!current || (expected && !sameCachedSegmentWrite(current, expected))) return
      const currentTotal = Number.isSafeInteger(totalRequest.result?.bytes) ? totalRequest.result.bytes : 0
      const nextTotal = Math.max(0, currentTotal - cachedSegmentByteLength(current))
      transaction.objectStore('segments').delete(cacheKey)
      transaction.objectStore('metadata').put({ cacheKey: CACHE_TOTAL_KEY, bytes: nextTotal, updatedAt: new Date().toISOString() })
      deleted = true
    }
    try {
      transaction = db.transaction(['segments', 'metadata'], 'readwrite')
      recordRequest = transaction.objectStore('segments').get(cacheKey)
      totalRequest = transaction.objectStore('metadata').get(CACHE_TOTAL_KEY)
      signal?.addEventListener('abort', abortTransaction, { once: true })
    } catch (error) {
      markIndexedDbUnavailable(error)
      resolve(false)
      return
    }
    recordRequest.onsuccess = () => { recordReady = true; remove() }
    totalRequest.onsuccess = () => { totalReady = true; remove() }
    transaction.oncomplete = () => {
      signal?.removeEventListener('abort', abortTransaction)
      if (deleted && (!expected || sameCachedSegmentWrite(memory.get(cacheKey), expected))) memory.delete(cacheKey)
      resolve(deleted)
    }
    transaction.onabort = () => { signal?.removeEventListener('abort', abortTransaction); resolve(false) }
    transaction.onerror = () => markIndexedDbUnavailable(transaction.error)
  })
}

function sameCachedSegmentWrite(left, right) {
  if (!left || !right || left.cacheKey !== right.cacheKey) return false
  if (left.runtimeWriteToken || right.runtimeWriteToken) return left.runtimeWriteToken === right.runtimeWriteToken
  return left.verifiedAt === right.verifiedAt
    && left.payloadSha256 === right.payloadSha256
    && cachedSegmentByteLength(left) === cachedSegmentByteLength(right)
}

async function deleteCachedSegmentIfCurrent(record, { signal } = {}) {
  const deleted = await deletePersistentSegment(record.cacheKey, record, { signal })
  if (deleted) releaseObjectUrl(record.cacheKey, { preserveActive: true })
  return deleted
}

async function clearCache() {
  await clearStore('segments')
  await clearStore('metadata')
  state.verified.clear()
  state.segments = []
  state.segmentNotice = ''
  state.blockTimes.clear()
  state.blockTimeHashes.clear()
  state.metadataUpdatedAt = ''
  state.metadataState = 'none'
  state.blobspace = { mode: 'sample', rows: defaultBlobspaceRows(), warning: '' }
  state.sidecarMemoryCache.clear()
  state.sidecarFetchPromises.clear()
  state.sidecarCacheEpoch += 1
  for (const cacheKey of [...state.objectUrls.keys()]) releaseObjectUrl(cacheKey, { preserveActive: true })
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

async function enforceCacheLimit(runtime = null) {
  if (runtime) requireCurrentRuntime(runtime)
  const configuredMb = clampCacheLimitMb(state.config.cacheLimitMb, DEFAULTS.cacheLimitMb, { min: CACHE_LIMIT_MIN_MB, max: CACHE_LIMIT_MAX_MB })
  const limitBytes = configuredMb * 1024 * 1024
  const db = await openDb()
  if (runtime) requireCurrentRuntime(runtime)
  if (!db) {
    const memory = storageMemoryStore('segments')
    let total = [...memory.values()].reduce((sum, record) => sum + cachedSegmentByteLength(record), 0)
    for (const record of [...memory.values()].sort((a, b) => String(a.verifiedAt || '').localeCompare(String(b.verifiedAt || '')))) {
      if (total <= Math.min(limitBytes, memorySegmentLimitBytes())) break
      if (record.cacheKey === state.currentRecordKey) continue
      memory.delete(record.cacheKey)
      state.verified.delete(record.cacheKey)
      releaseObjectUrl(record.cacheKey, { preserveActive: true })
      total -= cachedSegmentByteLength(record)
    }
    return
  }
  const total = await ensureCacheAccounting(db)
  if (runtime) requireCurrentRuntime(runtime)
  if (total <= limitBytes) return
  const evictedKeys = await new Promise((resolve) => {
    let transaction
    let totalRequest
    const keys = []
    const abortTransaction = () => {
      try { transaction?.abort() } catch { /* already complete */ }
    }
    try {
      transaction = db.transaction(['segments', 'metadata'], 'readwrite')
      totalRequest = transaction.objectStore('metadata').get(CACHE_TOTAL_KEY)
      runtime?.signal?.addEventListener('abort', abortTransaction, { once: true })
    } catch (error) {
      markIndexedDbUnavailable(error)
      resolve([])
      return
    }
    totalRequest.onsuccess = () => {
      let currentTotal = Number.isSafeInteger(totalRequest.result?.bytes) ? totalRequest.result.bytes : total
      const request = transaction.objectStore('segments').index('verifiedAt').openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor || currentTotal <= limitBytes) {
          transaction.objectStore('metadata').put({ cacheKey: CACHE_TOTAL_KEY, bytes: Math.max(0, currentTotal), updatedAt: new Date().toISOString() })
          return
        }
        const record = cursor.value
        if (record.cacheKey === state.currentRecordKey) {
          cursor.continue()
          return
        }
        try {
          currentTotal -= cachedSegmentByteLength(record)
        } catch (error) {
          markIndexedDbUnavailable(error)
          abortTransaction()
          return
        }
        keys.push(record.cacheKey)
        cursor.delete()
        cursor.continue()
      }
      request.onerror = () => abortTransaction()
    }
    transaction.oncomplete = () => { runtime?.signal?.removeEventListener('abort', abortTransaction); resolve(keys) }
    transaction.onabort = () => { runtime?.signal?.removeEventListener('abort', abortTransaction); resolve([]) }
    transaction.onerror = () => markIndexedDbUnavailable(transaction.error)
  })
  if (runtime) requireCurrentRuntime(runtime)
  for (const cacheKey of evictedKeys) {
    state.verified.delete(cacheKey)
    storageMemoryStore('segments').delete(cacheKey)
    releaseObjectUrl(cacheKey, { preserveActive: true })
  }
}

async function refreshCacheStats(runtime = null) {
  try {
    const total = await cacheTotalBytes()
    if (!runtimeAllowsMutation(runtime)) return false
    const memoryOnly = storageStatus.indexedDb === 'unavailable'
    els.cacheSize.textContent = `${fmtBytes(total)}${memoryOnly ? ' · memory only' : ''}`
    els.cacheSize.title = memoryOnly
      ? 'Persistent media cache is unavailable. Verified payloads remain usable only until this tab closes.'
      : 'Verified payloads are stored in this browser.'
    if (!memoryOnly && navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate()
        if (!runtimeAllowsMutation(runtime)) return false
        if (estimate.usage && estimate.quota) {
          els.cacheSize.textContent = `${fmtBytes(total)} / ${fmtBytes(estimate.quota)}`
        }
      } catch (error) {
        if (!runtimeAllowsMutation(runtime)) return false
        els.cacheSize.title = `Storage quota could not be read: ${storageErrorText(error)}`
      }
    }
    return true
  } catch (error) {
    if (!runtimeAllowsMutation(runtime)) return false
    markIndexedDbUnavailable(error)
    els.cacheSize.textContent = 'memory only'
    els.cacheSize.title = 'Persistent media cache is unavailable. Network viewing remains available.'
    return false
  }
}

function storageLimitationMessage(status = storageStatus) {
  const settingsUnavailable = status.localStorage === 'unavailable'
  const cacheUnavailable = status.indexedDb === 'unavailable'
  if (settingsUnavailable && cacheUnavailable) {
    return 'Browser storage is unavailable. Settings and verified media will last only for this tab; network viewing remains available.'
  }
  if (settingsUnavailable) return 'Saved settings are unavailable. Current settings work for this tab, and network viewing remains available.'
  if (cacheUnavailable) return 'Persistent media cache is unavailable. Verified media will last only for this tab; network viewing remains available.'
  return ''
}

async function initializeCachedState() {
  const runtime = runtimeSnapshot()
  try {
    await restoreInitialCachedMetadata(runtime)
    requireCurrentRuntime(runtime)
    await refreshCacheStats(runtime)
    requireCurrentRuntime(runtime)
  } catch (error) {
    if (!runtimeIsCurrent(runtime)) return
    markIndexedDbUnavailable(error)
    await refreshCacheStats(runtime)
  }
  const limitation = storageLimitationMessage()
  if (limitation) setRuntimeStatus(runtime, limitation)
}

async function cachedPayloadBytes(payload, maxBytes = MAX_SEGMENT_PAYLOAD_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_SEGMENT_PAYLOAD_BYTES) {
    throw new Error('Invalid cached payload byte limit')
  }
  if (payload instanceof Uint8Array) {
    if (payload.byteLength > maxBytes) throw new Error(`Cached payload exceeds ${maxBytes} bytes`)
    return payload
  }
  if (payload instanceof ArrayBuffer) {
    if (payload.byteLength > maxBytes) throw new Error(`Cached payload exceeds ${maxBytes} bytes`)
    return new Uint8Array(payload)
  }
  if (ArrayBuffer.isView(payload)) {
    if (payload.byteLength > maxBytes) throw new Error(`Cached payload exceeds ${maxBytes} bytes`)
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
  }
  if (payload instanceof Blob) {
    if (payload.size > maxBytes) throw new Error(`Cached payload exceeds ${maxBytes} bytes`)
    return new Uint8Array(await payload.arrayBuffer())
  }
  throw new Error('Cached payload is not byte data')
}

async function verifySegment(segment, runtime = runtimeSnapshot(), playbackContext = playbackContextSnapshot()) {
  requireCurrentRuntime(runtime)
  requireCurrentPlaybackContext(playbackContext)
  assertPlayableContinuity(segment)
  assertCurrentLoadedSegment(segment)
  try {
    const cached = await validatedCachedSegment(segment, runtime)
    requireCurrentRuntime(runtime)
    requireCurrentPlaybackContext(playbackContext)
    if (cached) return promoteVerifiedRecord(segment, cached)
  } catch (error) {
    requireCurrentRuntime(runtime)
    requireCurrentPlaybackContext(playbackContext)
    state.verified.delete(segment.cacheKey)
    setRuntimeStatus(runtime, `Discarded cached segment #${segment.sequence}: ${publicErrorMessage(error)}`)
  }

  if (segment.source === 'blob-inbox' && segment.embeddedPayload instanceof Uint8Array) {
    await verifyPayloadHash(segment, segment.embeddedPayload)
    requireCurrentRuntime(runtime)
    requireCurrentPlaybackContext(playbackContext)
    const record = {
      cacheKey: segment.cacheKey,
      publisher: segment.publisher,
      streamIdHash: segment.streamIdHash,
      streamId: segment.streamId,
      channelKey: segment.channelKey,
      continuity: segment.continuity,
      quarantined: false,
      payloadValidity: 'valid',
      sequence: segment.sequence,
      txHash: segment.txHash,
      payload: segment.embeddedPayload,
      payloadSha256: segment.payloadSha256,
      bytes: segment.embeddedPayload.byteLength,
      codec: segment.codec,
      slot: segment.slot || null,
      source: 'blob-inbox',
      verifiedAt: new Date().toISOString(),
    }
    const storedRecord = await putCachedSegment(record, runtime)
    requireCurrentRuntime(runtime)
    requireCurrentPlaybackContext(playbackContext)
    const promotedRecord = promoteVerifiedRecord(segment, storedRecord)
    await refreshCacheStats(runtime)
    requireCurrentRuntime(runtime)
    requireCurrentPlaybackContext(playbackContext)
    return promotedRecord
  }

  let source = 'beacon'
  let result
  try {
    result = await payloadFromBeacon(segment, { signal: runtime.signal })
    requireCurrentPlaybackContext(playbackContext)
  } catch (beaconError) {
    requireCurrentRuntime(runtime)
    if (state.config.archiveTemplates.length) {
      setRuntimeStatus(runtime, `Blob sidecars are unavailable for segment #${segment.sequence}; trying verified archive fallback.`)
    } else {
      setRuntimeStatus(runtime, `Blob sidecars are unavailable for segment #${segment.sequence}. A verified browser cache entry can still play if available.`)
    }
    const archive = await payloadFromArchive(segment, { signal: runtime.signal })
    requireCurrentRuntime(runtime)
    requireCurrentPlaybackContext(playbackContext)
    if (!archive) {
      throw new Error(`Blob sidecars are unavailable for segment #${segment.sequence}, and no archive fallback returned a payload that can be verified: ${publicErrorMessage(beaconError)}`, { cause: beaconError })
    }
    result = archive
    source = 'archive'
  }

  const record = {
    cacheKey: segment.cacheKey,
    publisher: segment.publisher,
    streamIdHash: segment.streamIdHash,
    streamId: segment.streamId,
    channelKey: segment.channelKey,
    continuity: segment.continuity,
    quarantined: false,
    payloadValidity: 'valid',
    sequence: segment.sequence,
    txHash: segment.txHash,
    payload: result.payload,
    payloadSha256: segment.payloadSha256,
    bytes: result.payload.byteLength,
    codec: segment.codec,
    slot: result.slot || null,
    source,
    archiveSourceOrigin: result.archiveUrl ? publicUrlLabel(result.archiveUrl) : null,
    verifiedAt: new Date().toISOString(),
  }
  const storedRecord = await putCachedSegment(record, runtime)
  requireCurrentRuntime(runtime)
  requireCurrentPlaybackContext(playbackContext)
  const promotedRecord = promoteVerifiedRecord(segment, storedRecord)
  await refreshCacheStats(runtime)
  requireCurrentRuntime(runtime)
  requireCurrentPlaybackContext(playbackContext)
  return promotedRecord
}

function objectUrl(record) {
  if (state.objectUrls.has(record.cacheKey)) return state.objectUrls.get(record.cacheKey)
  const url = URL.createObjectURL(new Blob([record.payload], { type: 'video/webm' }))
  state.objectUrls.set(record.cacheKey, url)
  return url
}

function releaseObjectUrl(cacheKey, { preserveActive = false } = {}) {
  const url = state.objectUrls.get(cacheKey)
  if (!url) return false
  if (preserveActive && cacheKey === state.currentRecordKey && els.player?.currentSrc) {
    state.deferredObjectUrlKeys.add(cacheKey)
    return false
  }
  URL.revokeObjectURL(url)
  state.objectUrls.delete(cacheKey)
  state.deferredObjectUrlKeys.delete(cacheKey)
  return true
}

function revokeDeferredObjectUrls(nextActiveKey = '') {
  for (const cacheKey of [...state.deferredObjectUrlKeys]) {
    if (cacheKey !== nextActiveKey) releaseObjectUrl(cacheKey)
  }
}

function revokeAllObjectUrls() {
  for (const url of state.objectUrls.values()) URL.revokeObjectURL(url)
  state.objectUrls.clear()
  state.deferredObjectUrlKeys.clear()
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

function mediaErrorPresentation(error) {
  const code = Number(error?.code)
  const reasons = {
    1: 'playback was aborted locally',
    2: 'the browser reported a media network error',
    3: 'the browser could not decode the verified media',
    4: 'the browser does not support this media profile',
  }
  return {
    code: Number.isInteger(code) && Object.hasOwn(reasons, code) ? `MEDIA_${code}` : 'MEDIA_UNKNOWN',
    message: `Local playback failed: ${reasons[code] || 'the browser reported an unknown media error'}. Station programming has not been reclassified as fallback.`,
  }
}

function playRecord(record, options = {}, runtime = runtimeSnapshot()) {
  if (!runtimeIsCurrent(runtime)) return false
  assertCurrentLoadedSegment(record)
  revokeDeferredObjectUrls(record.cacheKey)
  const playbackToken = ++state.playbackAdvanceToken
  state.currentRecordKey = record.cacheKey
  const playbackIntent = options.playbackIntent === 'follow' && state.followIntent ? 'follow' : 'replay'
  state.playbackIntent = playbackIntent
  state.playbackMode = classifyPlaybackMode({ playbackIntent, followIntent: state.followIntent, liveEdgeKey: state.liveEdgeKey, currentRecordKey: record.cacheKey })
  state.selectedSegmentQuery = record.txHash || String(record.sequence)
  syncUrlState()
  els.player.src = objectUrl(record)
  prepareAudioForPlayback(options)
  els.empty.classList.add('hidden')
  void els.player.play().catch((error) => {
    if (!runtimeIsCurrent(runtime) || playbackToken !== state.playbackAdvanceToken) return
    state.playbackMode = 'interrupted'
    const prefix = options.userRequested ? 'Playback blocked' : 'Automatic playback did not start'
    setStatus(`${prefix}: ${publicErrorMessage(error)}. Use the segment play control to retry.`, { assertive: true, announcementKey: options.userRequested ? 'playback-blocked' : 'autoplay-blocked' })
    render()
  })
  warmNextSegment(record)
  return true
}

function latestVerifiedRecord() {
  return [...state.verified.values()].filter(currentLoadedSegment).sort((a, b) => a.sequence - b.sequence).at(-1)
}

function firstVerifiedRecord() {
  return [...state.verified.values()].filter(currentLoadedSegment).sort((a, b) => a.sequence - b.sequence)[0] || null
}

function nextVerifiedRecord(currentRecord) {
  return [...state.verified.values()]
    .filter((record) => currentLoadedSegment(record) && record.sequence > currentRecord.sequence)
    .sort((a, b) => a.sequence - b.sequence)[0] || null
}

function orderedLoadedSegments(segments = state.segments) {
  const channelKey = configuredChannelKey()
  return [...segments].filter((segment) => segment.channelKey === channelKey && !segmentIsQuarantined(segment)).sort((a, b) =>
    a.sequence - b.sequence
    || a.blockNumber - b.blockNumber
    || a.transactionIndex - b.transactionIndex
    || a.logIndex - b.logIndex)
}

function nextSegmentAfter(record) {
  const segments = orderedLoadedSegments()
  const index = segments.findIndex((segment) => segment.cacheKey === record?.cacheKey)
  return index >= 0 ? segments[index + 1] || null : null
}

function playbackAdvanceIsCurrent(advanceToken, currentKey, { requireLoop = false, replayOnly = false } = {}) {
  return advanceToken === state.playbackAdvanceToken
    && currentKey === state.currentRecordKey
    && (!requireLoop || state.loopReplay)
    && (!replayOnly || !state.followIntent)
}

function beginUserPlaybackRequest() {
  return ++state.playbackAdvanceToken
}

function userPlaybackRequestIsCurrent(requestToken) {
  return requestToken === state.playbackAdvanceToken
}

async function advanceLoadedPlayback(segment, { advanceToken, currentKey, requireLoop = false } = {}) {
  const record = state.verified.get(segment.cacheKey) || await prefetchSegment(segment)
  if (!playbackAdvanceIsCurrent(advanceToken, currentKey, { requireLoop, replayOnly: true })) return null
  if (!record) throw new Error(`Unable to buffer segment #${segment.sequence}.`)
  playRecord(record)
  render()
  return record
}

function currentRecord() {
  const record = state.currentRecordKey ? state.verified.get(state.currentRecordKey) || null : null
  return record && currentLoadedSegment(record) ? record : null
}

async function prefetchSegment(segment, runtime = runtimeSnapshot()) {
  if (!segment || !runtimeIsCurrent(runtime)) return null
  if (!currentLoadedSegment(segment)) return null
  const verified = state.verified.get(segment.cacheKey)
  if (verified && currentLoadedSegment(verified)) return verified
  if (verified) state.verified.delete(segment.cacheKey)
  if (state.prefetchPromises.has(segment.cacheKey)) return state.prefetchPromises.get(segment.cacheKey)
  state.prefetching.add(segment.cacheKey)
  const playbackContext = playbackContextSnapshot()
  const promise = verifySegment(segment, runtime, playbackContext)
    .then((record) => {
      requireCurrentRuntime(runtime)
      requireCurrentPlaybackContext(playbackContext)
      objectUrl(record)
      render()
      return record
    })
    .catch(() => null)
    .finally(() => {
      if (runtimeIsCurrent(runtime) && state.prefetchPromises.get(segment.cacheKey) === promise) {
        state.prefetching.delete(segment.cacheKey)
        state.prefetchPromises.delete(segment.cacheKey)
      }
    })
  state.prefetchPromises.set(segment.cacheKey, promise)
  return promise
}

function prefetchWindow() {
  const recent = state.segments.filter((segment) => !segmentIsQuarantined(segment)).slice(-5)
  for (const segment of recent) void prefetchSegment(segment)
}

function warmNextSegment(record) {
  const nextSegment = nextSegmentAfter(record)
  if (nextSegment) void prefetchSegment(nextSegment)
}

function revealTunedStream() {
  requestAnimationFrame(() => {
    const target = document.querySelector('.segments-panel') || document.querySelector('.viewer-frame')
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

function streamBlobMap() {
  const byHash = new Map()
  for (const segment of state.segments) {
    for (const hash of segment.blobVersionedHashes) {
      byHash.set(normalizeHex(hash), {
        publisher: segment.publisher,
        streamIdHash: segment.streamIdHash,
        streamId: segment.streamId,
        sequence: segment.sequence,
        txHash: segment.txHash,
      })
    }
  }
  return byHash
}

async function refreshBlobspaceOnce(runtime = runtimeSnapshot()) {
  requireCurrentRuntime(runtime)
  const known = streamBlobMap()
  try {
    const [headSlot, genesisTime] = await Promise.all([latestBeaconSlot({ signal: runtime.signal }), beaconGenesisTime({ signal: runtime.signal })])
    requireCurrentRuntime(runtime)
    els.headSlot.textContent = String(headSlot)
    const slots = Array.from({ length: SLOT_WINDOW }, (_, index) => headSlot - index).filter((slot) => slot >= 0)
    const rows = await Promise.all(slots.map(async (slot) => {
      try {
        const record = await sidecarsForSlot(slot, { signal: runtime.signal })
        requireCurrentRuntime(runtime)
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
        if (isAbortError(error) || !runtimeIsCurrent(runtime)) throw error
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
    requireCurrentRuntime(runtime)
    state.blobspace = { mode: 'live', rows, warning: '' }
  } catch (error) {
    if (!runtimeIsCurrent(runtime)) return
    state.blobspace = {
      mode: 'cached',
      rows: cachedBlobspaceRows(known),
      warning: publicErrorMessage(error),
    }
  }
}

function refreshBlobspace(runtime = runtimeSnapshot()) {
  return singleFlight(state, 'blobspaceRefreshPromise', () => refreshBlobspaceOnce(runtime))
}

async function refreshBlobspaceRail() {
  const runtime = runtimeSnapshot()
  try {
    await refreshBlobspace(runtime)
  } finally {
    if (runtimeIsCurrent(runtime)) renderBlobspace()
  }
}

function dynamicFocusKey(element = document.activeElement) {
  const control = element?.closest?.('[data-focus-key]')
  return control?.dataset?.focusKey || ''
}

function restoreDynamicFocus(focusKey) {
  if (!focusKey) return false
  const target = [...document.querySelectorAll('[data-focus-key]')]
    .find((element) => element.dataset.focusKey === focusKey)
  if (!target || target === document.activeElement) return Boolean(target)
  target.focus({ preventScroll: true })
  return true
}

function cachedBlobspaceRows(known) {
  const rows = new Map()
  for (const record of state.verified.values()) {
    if (record.slot == null) continue
    let slot
    try {
      slot = nonNegativeSafeInteger(record.slot, 'cached segment slot')
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
  const focusKey = dynamicFocusKey()
  const blobspace = state.blobspace || { rows: [], mode: 'warming' }
  els.railMode.textContent = 'Live beacon sidecars from /eth/v1/beacon/blob_sidecars/{slot}.'
  const preset = CHAIN_PRESETS[state.config.chainPreset] || CHAIN_PRESETS[DEFAULTS.chainPreset]
  const latestSlot = els.headSlot.textContent || '-'
  const warning = blobspace.warning || 'none'
  const explorerBase = preset.explorerTxBase.replace(/\/tx\/$/, '')
  const warningText = warning === 'none' ? 'No endpoint warnings.' : `Warning: ${warning}`
  if (els.blobspaceWarning.textContent !== warningText) els.blobspaceWarning.textContent = warningText
  els.blobspaceWarning.title = warningText
  els.blobspaceDetails.innerHTML = [
    ['Latest slot', latestSlot],
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
      return `<a class="blob-cell ${kind}" data-focus-key="blob:${escapeHtml(row.slot)}:${index}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"></a>`
    }).join('')
    const streamCount = Number(row.streamBlobCount || 0)
    const firstStreamBlob = blobs.find((blob) => blob.isStreamBlob)
    const slotJumpLabel = firstStreamBlob ? slotJumpAccessibleName(row.slot, firstStreamBlob.stream.sequence) : ''
    return `
      <section class="slot">
        <div class="slot-top">
          <a class="slot-link" data-focus-key="slot:${escapeHtml(row.slot)}" href="${escapeHtml(slotUrl)}" target="_blank" rel="noopener noreferrer">Slot ${escapeHtml(row.slot)}</a>
          <span>${Number(row.blobCount || blobs.length)} / ${max} blobs${streamCount ? ` - ${streamCount} stream` : ''}</span>
          ${firstStreamBlob ? `<button class="slot-jump" type="button" data-focus-key="slot-jump:${escapeHtml(row.slot)}" data-slot-jump-tx="${escapeHtml(firstStreamBlob.stream.txHash)}" data-slot-jump-sequence="${escapeHtml(firstStreamBlob.stream.sequence)}" aria-label="${escapeHtml(slotJumpLabel)}">JUMP</button>` : ''}
        </div>
        <div class="slot-meta"><span><strong>Local</strong> ${escapeHtml(row.localTime || fmtLocalTime(row.timestampMs))}</span><span>${row.error ? 'endpoint miss' : ''}</span></div>
        <div class="blob-grid">${cells}</div>
        ${row.error ? `<div class="slot-error">${escapeHtml(row.error)}</div>` : ''}
      </section>
    `
  }).join('') || '<p class="muted">No blob sidecar rows available yet.</p>'
  restoreDynamicFocus(focusKey)
}

function renderHealth() {
  const execution = state.config.executionRpcs.length ? state.endpointHealth.execution : { state: 'missing', message: 'No execution RPC endpoints configured.' }
  const beacon = state.config.beaconApis.length ? state.endpointHealth.beacon : { state: 'missing', message: 'No beacon API endpoints configured.' }
  els.executionHealth.textContent = execution.state === 'idle' ? '-' : execution.state
  els.beaconHealth.textContent = beacon.state === 'idle' ? '-' : beacon.state
  els.executionHealth.title = execution.message || publicUrlLabel(state.activeExecutionRpc)
  els.beaconHealth.title = beacon.message || publicUrlLabel(state.activeBeaconApi)
}

function blobFeeAverageText(key) {
  const entry = state.blobFees.averages[key] || state.blobFees.history[key]
  if (!entry) return { text: '-', title: '' }
  if (entry.status !== 'ok') {
    return { text: entry.message || 'provider limited', title: '' }
  }
  return {
    text: formatBlobFeeAmount(blobFeeWei(BigInt(entry.averageWei))),
    title: `${formatWeiCompact(BigInt(entry.averageWei))} blob base fee`,
  }
}

function formatBlobWindowUsage(entry) {
  const blocks = Number(entry?.sampleBlocks || 0)
  const blobs = Number(entry?.blobCount || 0)
  if (!Number.isSafeInteger(blocks) || blocks <= 0 || !Number.isFinite(blobs)) return { text: '-', title: '' }
  return {
    text: `${blocks} blocks - ~${Math.round(blobs)} blobs`,
    title: `Approximate total blobs observed in the selected window, derived from blobGasUsedRatio * ${MAX_BLOBS_PER_BLOCK} max blobs per block. Current mainnet target is ${TARGET_BLOBS_PER_BLOCK}; max is ${MAX_BLOBS_PER_BLOCK}.`,
  }
}

function renderBlobFeeSparkline() {
  if (!els.blobFeeSparkline) return
  const samples = pruneBlobFeeSamples(state.blobFees.samples).slice(-80)
  if (samples.length < 2) {
    els.blobFeeSparkline.innerHTML = ''
    return
  }
  const values = samples.map((sample) => BigInt(sample.baseFeePerBlobGasWei))
  const max = values.reduce((largest, value) => value > largest ? value : largest, 0n)
  if (max === 0n) {
    els.blobFeeSparkline.innerHTML = ''
    return
  }
  const points = values.map((value, index) => {
    const x = samples.length === 1 ? 0 : Math.round((index / (samples.length - 1)) * 1000) / 10
    const y = 32 - Number((value * 30n) / max)
    return `${x},${y}`
  }).join(' ')
  els.blobFeeSparkline.innerHTML = `<svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"></polyline></svg>`
}

function renderBlobFees() {
  if (!els.blobFeeStatus) return
  const current = state.blobFees.currentBaseFeeWei != null ? BigInt(state.blobFees.currentBaseFeeWei) : null
  const perBlob = state.blobFees.currentBlobFeeWei != null ? BigInt(state.blobFees.currentBlobFeeWei) : null
  const selectedWindow = state.blobFeePrefs.historyWindow
  const selectedAverage = blobFeeAverageText(selectedWindow)
  els.blobFeeStatus.textContent = state.blobFees.loading ? 'Updating' : state.blobFees.status
  els.blobFeeStatus.dataset.state = String(state.blobFees.status || 'Unavailable').toLowerCase()
  if (els.blobFeeUnit) {
    els.blobFeeUnit.innerHTML = Object.entries(BLOB_FEE_UNITS)
      .map(([key, label]) => `<option value="${key}">${escapeHtml(label)}</option>`)
      .join('')
    els.blobFeeUnit.value = state.blobFeePrefs.unit
  }
  if (els.blobFeeWindow) {
    els.blobFeeWindow.innerHTML = Object.entries(BLOB_FEE_HISTORY_WINDOWS)
      .map(([key, config]) => `<option value="${key}">${escapeHtml(config.label)}</option>`)
      .join('')
    els.blobFeeWindow.value = selectedWindow
  }
  if (els.blobFeeBase) els.blobFeeBase.textContent = formatWeiCompact(current)
  if (els.blobFeePerBlob) els.blobFeePerBlob.textContent = formatBlobFeeAmount(perBlob)
  if (els.blobFeeAverageLabel) {
    els.blobFeeAverageLabel.textContent = BLOB_FEE_HISTORY_WINDOWS[selectedWindow]?.label || 'Average'
  }
  if (els.blobFeeAverage) {
    els.blobFeeAverage.textContent = selectedAverage.text
    els.blobFeeAverage.title = selectedAverage.title
  }
  if (els.blobFeeUtilization) {
    const selectedEntry = state.blobFees.averages[selectedWindow] || state.blobFees.history[selectedWindow]
    const usageDisplay = formatBlobWindowUsage(selectedEntry)
    els.blobFeeUtilization.textContent = usageDisplay.text
    els.blobFeeUtilization.title = usageDisplay.title
  }
  if (els.blobFeeUpdated) {
    els.blobFeeUpdated.textContent = state.blobFees.updatedAt ? fmtClock(new Date(state.blobFees.updatedAt)) : '-'
  }
  if (els.blobFeeMessage) {
    els.blobFeeMessage.textContent = state.blobFees.message || (state.layoutSettings.blobFees?.visible ? 'Using configured execution RPC.' : 'Enable in Settings to start polling.')
  }
  renderBlobFeeSparkline()
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
      <button class="endpoint-preset ${selected ? 'active' : ''}" type="button" data-focus-key="endpoint-preset:${escapeHtml(key)}" data-endpoint-preset="${escapeHtml(key)}" aria-pressed="${selected ? 'true' : 'false'}">
        <strong>${escapeHtml(preset.label)}</strong>
        <span>${escapeHtml(preset.executionRpcs.length)} execution / ${escapeHtml(preset.beaconApis.length)} beacon</span>
      </button>
    `
  }).join('')
}

function renderEmptyState({ activeRecord, health, tunedSummary }) {
  if (!els.empty) return
  els.empty.classList.toggle('hidden', Boolean(activeRecord))
  if (activeRecord) return
  const title = els.empty.querySelector('strong')
  const detail = els.empty.querySelector('span')
  if (!title || !detail) return
  const recoveryStates = {
    'endpoint-blocked': {
      title: 'Connection setup needed',
      detail: 'The station cannot be checked with the current network endpoints. Review Connections, then refresh the signal.',
      action: 'Open connection settings',
    },
    'station-missing': {
      title: 'Choose a station',
      detail: 'No Station contract is configured for this network. Add one in Connections to tune a broadcast.',
      action: 'Choose a station',
    },
    'sidecar-blocked': {
      title: 'Media endpoint unavailable',
      detail: 'Segment announcements were found, but the beacon media endpoint is unavailable. Review Connections and try again.',
      action: 'Review media connection',
    },
  }
  const recovery = recoveryStates[health]
  if (els.emptyRecovery) {
    els.emptyRecovery.hidden = !recovery
    els.emptyRecovery.textContent = recovery?.action || 'Open connection settings'
  }
  if (recovery) {
    title.textContent = recovery.title
    detail.textContent = recovery.detail
    return
  }
  if (state.segments.length) {
    title.textContent = tunedSummary ? `Ready to watch ${tunedSummary.title}` : 'Stream segments loaded'
    detail.textContent = `${state.segments.length} segment${state.segments.length === 1 ? '' : 's'} loaded. Choose GET or a segment number in Stream Segments to verify and play.`
    return
  }
  title.textContent = 'No recent station signal'
  detail.textContent = 'No recent segment announcements are available. The viewer stays idle until Ethereum carries new blobs for this stream.'
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
  if (!state.segments.length) return state.followIntent ? 'waiting for next slot' : 'no metadata'
  if (!state.verified.size) return 'metadata only'
  const latestAgeSeconds = latestSegment?.createdAt ? Math.round((Date.now() - Date.parse(latestSegment.createdAt)) / 1000) : 0
  if (latestAgeSeconds > 120) return 'stale'
  if (state.playbackMode === 'buffering' || state.playbackMode === 'replay-buffering') return 'buffering'
  if (state.followIntent && latestSegment && !state.verified.has(latestSegment.cacheKey)) return 'lagging'
  if (state.playbackMode === 'live') return 'live'
  if (state.playbackMode === 'catching-up') return 'catching up'
  return activeRecord ? 'replay/cache' : state.followIntent ? 'waiting for next slot' : 'idle'
}

function playbackSourceLabel(record) {
  if (!record) return '- / -'
  if (record.cacheHit) return 'cache / verified'
  if (record.source === 'archive') return 'archive / verified'
  if (record.source === 'beacon') return 'beacon / verified'
  return 'cache / verified'
}

function applyLayoutPreset() {
  const preset = loadLayoutPresetFromValue(state.layoutPreset)
  const settings = normalizeLayoutSettings(state.layoutSettings)
  if (els.shell) els.shell.dataset.layout = preset
  if (els.shell) {
    const visiblePositions = Object.values(settings).filter((panel) => panel.visible).map((panel) => panel.position)
    els.shell.dataset.leftRail = visiblePositions.includes('left') ? 'true' : 'false'
    els.shell.dataset.rightRail = visiblePositions.includes('right') ? 'true' : 'false'
    els.shell.dataset.bottomSpan = settings.bottomSpan
  }
  const bottomSlots = Object.entries(settings)
    .filter(([, config]) => config && config.visible && config.position === 'bottom')
    .sort((a, b) => a[1].order - b[1].order)
    .map(([panel]) => panel)
  for (const [panel, element] of Object.entries(els.panelZones)) {
    const config = settings[panel]
    if (!element || !config) continue
    element.hidden = !config.visible
    const bottomIndex = bottomSlots.indexOf(panel)
    element.style.gridArea = bottomIndex >= 0 ? `bottom${bottomIndex + 1}` : config.position
    element.style.order = String(config.order)
    element.dataset.panelPosition = config.position
  }
  if (els.layoutRecovery) els.layoutRecovery.hidden = settings.player.visible
  renderLayoutControls()
  if ((preset === 'archive-side' || preset === 'archive-bottom') && els.archiveDetails) {
    els.archiveDetails.open = true
  }
  startBlobFeeTracker()
}

function renderLayoutControls() {
  const settings = normalizeLayoutSettings(state.layoutSettings)
  for (const select of els.panelPosition) {
    const panel = select.dataset.panelPosition
    select.innerHTML = Object.entries(PANEL_POSITIONS)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join('')
    select.value = settings[panel]?.position || 'main'
  }
  for (const select of els.panelOrder) {
    const panel = select.dataset.panelOrder
    select.innerHTML = [1, 2, 3, 4].map((value) => `<option value="${value}">${value}</option>`).join('')
    select.value = String(settings[panel]?.order || 1)
  }
  for (const input of els.panelShow) {
    const panel = input.dataset.panelShow
    input.checked = settings[panel]?.visible !== false
  }
  if (els.layoutPresets) {
    for (const button of els.layoutPresets.querySelectorAll('[data-layout-preset]')) {
      const active = button.dataset.layoutPreset === state.layoutPreset
      button.classList.toggle('active', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
  }
  if (els.layoutBottomSpan) els.layoutBottomSpan.value = settings.bottomSpan
}

function renderClockControls() {
  if (els.clockMode) els.clockMode.value = state.clock.mode
  if (els.clockTimeZone) {
    els.clockTimeZone.value = state.clock.timeZone
    els.clockTimeZone.disabled = state.clock.mode !== 'timezone'
  }
  if (els.utcClock) els.utcClock.textContent = fmtClock()
}

function openSettings(tab = 'appearance') {
  if (!els.settingsModal) return
  const wasClosed = els.settingsModal.hidden
  if (wasClosed) settingsFocusReturn = document.activeElement
  els.settingsModal.hidden = false
  document.body.classList.add('settings-open')
  showSettingsTab(tab)
  const selectedTab = [...els.settingsTabs].find((button) => button.dataset.settingsTab === tab)
  const dialog = els.settingsModal.querySelector('[role="dialog"]')
  const initialFocus = selectedTab || settingsFocusableElements()[0] || dialog
  initialFocus?.focus()
  els.shell?.setAttribute('aria-hidden', 'true')
  if (els.shell) els.shell.inert = true
}

function closeSettings() {
  if (!els.settingsModal || els.settingsModal.hidden) return
  els.settingsModal.hidden = true
  document.body.classList.remove('settings-open')
  els.shell?.removeAttribute('aria-hidden')
  if (els.shell) els.shell.inert = false
  const focusReturn = settingsFocusReturn
  settingsFocusReturn = null
  const focusTarget = focusReturn?.isConnected && !focusReturn.closest('[hidden]')
    ? focusReturn
    : (!els.panelZones.player?.hidden ? els.settingsToggle : els.settingsRecoveryToggle)
  if (focusTarget?.isConnected && typeof focusTarget.focus === 'function') focusTarget.focus()
}

function settingsFocusableElements() {
  if (!els.settingsModal || els.settingsModal.hidden) return []
  return [...els.settingsModal.querySelectorAll(SETTINGS_FOCUSABLE_SELECTOR)]
    .filter((element) => element.getClientRects().length > 0)
}

function trapSettingsFocus(event) {
  if (event.key !== 'Tab' || !els.settingsModal || els.settingsModal.hidden) return
  const focusable = settingsFocusableElements()
  const dialog = els.settingsModal.querySelector('[role="dialog"]')
  if (!focusable.length) {
    event.preventDefault()
    dialog?.focus()
    return
  }
  const first = focusable[0]
  const last = focusable.at(-1)
  const active = document.activeElement
  if (event.shiftKey && (active === first || !els.settingsModal.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !els.settingsModal.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}

function showSettingsTab(tab) {
  const tabs = [...els.settingsTabs]
  const selected = tabs.find((button) => button.dataset.settingsTab === tab) || tabs[0]
  if (!selected) return
  const selectedTab = selected.dataset.settingsTab
  for (const button of tabs) {
    const active = button === selected
    button.classList.toggle('active', active)
    button.setAttribute('aria-selected', active ? 'true' : 'false')
    button.tabIndex = active ? 0 : -1
  }
  for (const panel of els.settingsPanels) {
    panel.hidden = panel.dataset.settingsPanel !== selectedTab
  }
}

function moveSettingsTabFocus(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabs = [...els.settingsTabs]
  const currentIndex = tabs.indexOf(event.currentTarget)
  if (currentIndex < 0 || tabs.length === 0) return
  event.preventDefault()
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? tabs.length - 1
      : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  showSettingsTab(tabs[nextIndex].dataset.settingsTab)
  tabs[nextIndex].focus()
}

function currentStreamFavorite() {
  return normalizeFavoriteItem({
    type: 'stream',
    chainId: state.config.chainId,
    stationAddress: state.config.stationAddress,
    publisher: state.config.publisher || '',
    streamId: state.config.streamId,
    streamIdHash: state.config.streamIdHash || canonicalStreamIdHash(state.config.streamId),
    label: state.config.streamId,
  })
}

function currentChannelFavorite() {
  if (!state.config.publisher) return null
  return normalizeFavoriteItem({
    type: 'channel',
    chainId: state.config.chainId,
    stationAddress: state.config.stationAddress,
    publisher: state.config.publisher,
    label: shortHash(state.config.publisher),
  })
}

function upsertFavorite(item) {
  const favorite = normalizeFavoriteItem(item)
  if (!favorite) throw new Error('Nothing valid to save yet.')
  const existing = state.favorites.find((candidate) => candidate.id === favorite.id)
  if (existing) {
    existing.label = favorite.label || existing.label
    existing.firstBlock = favorite.firstBlock ?? existing.firstBlock ?? null
    existing.latestBlock = favorite.latestBlock ?? existing.latestBlock ?? null
  } else {
    state.favorites.unshift(favorite)
  }
  saveFavorites()
  renderFavorites()
  return favorite
}

function favoriteLabel(item) {
  if (item.label) return item.label
  if (item.type === 'station') return `Station ${shortHash(item.stationAddress)}`
  if (item.type === 'channel') return `Channel ${shortHash(item.publisher)}`
  if (item.type === 'inbox') return `Inbox ${shortHash(item.inboxAddress)}`
  if (item.type === 'inbox-channel') return `Inbox channel ${shortHash(item.publisher)}`
  return item.streamId || shortHash(item.streamIdHash)
}

function favoriteChainLabel(item) {
  return Object.values(CHAIN_PRESETS).find((preset) => preset.chainId === item.chainId)?.label || `Chain ${item.chainId}`
}

function renderFavorites() {
  if (!els.favoritesList) return
  if (!state.favorites.length) {
    els.favoritesList.innerHTML = '<div class="empty-row">No local favorites saved yet</div>'
    return
  }
  els.favoritesList.innerHTML = state.favorites.map((item) => {
    const label = favoriteLabel(item)
    const chainLabel = favoriteChainLabel(item)
    const accessibleName = favoriteAccessibleName(item, label)
    return `
    <section class="favorite-row" data-favorite-id="${escapeHtml(item.id)}" aria-label="Favorite: ${escapeHtml(accessibleName)}">
      <div>
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(chainLabel)} · ${escapeHtml(item.type)} · ${escapeHtml(shortHash(item.stationAddress || item.inboxAddress))}${item.publisher ? ` · ${escapeHtml(shortHash(item.publisher))}` : ''}</span>
      </div>
      <button type="button" data-focus-key="favorite:${escapeHtml(item.id)}:tune" data-favorite-action="tune" aria-label="Watch ${escapeHtml(accessibleName)}">Watch</button>
      <button type="button" data-focus-key="favorite:${escapeHtml(item.id)}:rename" data-favorite-action="rename" aria-label="Rename ${escapeHtml(accessibleName)}">Rename</button>
      <button type="button" data-focus-key="favorite:${escapeHtml(item.id)}:remove" data-favorite-action="remove" aria-label="Remove ${escapeHtml(accessibleName)}">Remove</button>
    </section>
  `}).join('')
}

function renderArchive() {
  if (!els.archiveResults) return
  renderArchiveMode()
  if (els.archiveStation && !els.archiveStation.value) els.archiveStation.value = state.config.stationAddress
  if (!state.archive.streams.length) {
    els.archiveResults.innerHTML = `<div class="empty-row">${state.archive.mode === 'inbox' ? 'No compatible inbox streams discovered in this scan' : 'No old streams discovered in this scan'}</div>`
    return
  }
  els.archiveResults.innerHTML = state.archive.streams.map((stream) => {
    const tuned = state.archive.tunedKey === stream.key
    const accessibleName = archiveStreamAccessibleName(stream)
    return `
    <section class="archive-stream ${tuned ? 'active' : ''}" data-archive-key="${escapeHtml(stream.key)}" aria-label="Archived stream: ${escapeHtml(accessibleName)}">
      <div>
        <strong>${escapeHtml(stream.title)}${tuned ? ' · watching' : ''}</strong>
        <span>${state.archive.mode === 'inbox' ? 'inbox stream' : 'station stream'} · publisher ${escapeHtml(shortHash(stream.publisher))}</span>
        <span>segments ${escapeHtml(stream.segmentCount)} · seq ${escapeHtml(stream.firstSequence)}-${escapeHtml(stream.latestSequence)} · blocks ${escapeHtml(stream.firstBlock)}-${escapeHtml(stream.latestBlock)}</span>
      </div>
      <button type="button" data-focus-key="archive:${escapeHtml(stream.key)}:tune" data-archive-action="tune" aria-label="${tuned ? 'View segments for' : 'Watch'} ${escapeHtml(accessibleName)}">${tuned ? 'View segments' : 'Watch'}</button>
      <button type="button" data-focus-key="archive:${escapeHtml(stream.key)}:save" data-archive-action="save" aria-label="Save ${escapeHtml(accessibleName)}">Save</button>
    </section>
  `}).join('')
}

function renderArchiveMode() {
  for (const button of els.archiveModeButtons) {
    const active = button.dataset.archiveMode === state.archive.mode
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', active ? 'true' : 'false')
    button.disabled = Boolean(state.archive.activeController)
  }
  for (const field of els.archiveModeFields) {
    field.hidden = field.dataset.archiveField !== state.archive.mode
  }
  const rangeMode = els.archiveRangeMode?.value === 'block' ? 'block' : 'date'
  if (els.archiveFromBlock) els.archiveFromBlock.disabled = rangeMode !== 'block'
  if (els.archiveFromDate) els.archiveFromDate.disabled = rangeMode !== 'date'
  if (els.archiveToDate) els.archiveToDate.disabled = rangeMode !== 'date'
  if (rangeMode === 'date' && els.archiveFromDate && els.archiveToDate && !els.archiveFromDate.value && !els.archiveToDate.value) {
    const now = new Date()
    const hours = state.archive.mode === 'inbox' ? 2 : 24
    els.archiveToDate.value = datetimeLocalValue(now)
    els.archiveFromDate.value = datetimeLocalValue(new Date(now.getTime() - hours * 60 * 60 * 1000))
  }
  renderArchiveProgress()
  if (els.archiveScan) els.archiveScan.disabled = state.archive.scanning || Boolean(state.archive.activeController)
  if (els.archiveStop) els.archiveStop.disabled = !state.archive.scanning && !state.archive.activeController
}

function tunedArchiveSummary() {
  return state.archive.tunedKey
    ? state.archive.streams.find((stream) => stream.key === state.archive.tunedKey) || null
    : null
}

async function watchStationFavorite(item, tuneSerial = beginArchiveTuneRequest()) {
  const summary = {
    key: archiveStreamKey({
      publisher: item.publisher,
      streamIdHash: item.streamIdHash,
      streamId: item.streamId,
    }),
    publisher: item.publisher,
    streamIdHash: item.streamIdHash,
    streamId: item.streamId,
    title: favoriteLabel(item),
    segmentCount: 0,
    firstSequence: 0,
    latestSequence: 0,
    firstBlock: item.firstBlock,
    latestBlock: item.latestBlock,
  }
  state.archive.mode = 'station'
  state.archive.tunedKey = summary.key
  if (!state.archive.streams.some((stream) => stream.key === summary.key)) {
    state.archive.streams.unshift(summary)
  }
  if (els.archiveStation) els.archiveStation.value = item.stationAddress
  if (els.archivePublisher) els.archivePublisher.value = item.publisher || ''
  let segments
  try {
    segments = await archiveSegmentsForWatch(summary.key, summary)
  } catch (error) {
    if (!archiveTuneIsCurrent(tuneSerial)) return false
    throw error
  }
  if (!archiveTuneIsCurrent(tuneSerial)) return false
  summary.segmentCount = segments.length
  summary.firstSequence = Math.min(...segments.map((segment) => segment.sequence))
  summary.latestSequence = Math.max(...segments.map((segment) => segment.sequence))
  summary.firstBlock = Math.min(...segments.map((segment) => segment.blockNumber))
  summary.latestBlock = Math.max(...segments.map((segment) => segment.blockNumber))
  return tuneArchiveStream(summary.key, { tuneSerial })
}

function resetFavoriteArchiveState(mode) {
  state.archive.mode = mode
  state.archive.streams = []
  state.archive.segmentsByKey = new Map()
  state.archive.tunedKey = ''
  resetArchiveProgress(archiveDefaultMessage(mode))
}

function tuneFavorite(item) {
  if (!item) return
  const presetKey = Object.keys(CHAIN_PRESETS).find((key) => CHAIN_PRESETS[key].chainId === item.chainId)
  if (!presetKey) {
    setStatus(`Favorite uses unsupported chain ID ${item.chainId}.`)
    return
  }
  const tuneSerial = beginArchiveTuneRequest()
  if (item.type.startsWith('inbox')) {
    if (state.config.chainPreset !== presetKey) {
      state.config = loadConfig({ chainPreset: presetKey }, { useSavedNetworkConfig: true })
      saveConfig(state.config)
      resetRuntimeState()
      fillForm()
    }
    resetFavoriteArchiveState('inbox')
    if (els.archiveInbox) els.archiveInbox.value = item.inboxAddress
    if (els.archivePublisher) els.archivePublisher.value = item.publisher || ''
    if (els.archiveStreamFilter) els.archiveStreamFilter.value = item.streamId || ''
    render()
    setStatus(`${favoriteLabel(item)} selected. Scan the saved blob inbox to find recent compatible segments.`)
    return
  }
  const favoriteConfig = loadConfig({ chainPreset: presetKey }, { useSavedNetworkConfig: true })
  state.config = {
    ...favoriteConfig,
    stationAddress: item.stationAddress,
    streamId: item.streamId || favoriteConfig.streamId,
    streamIdHash: item.streamId ? canonicalStreamIdHash(item.streamId) : favoriteConfig.streamIdHash,
    publisher: item.publisher || '',
  }
  saveConfig(state.config)
  resetRuntimeState()
  fillForm()
  resetFavoriteArchiveState('station')
  if (els.archiveStation) els.archiveStation.value = item.stationAddress
  if (els.archivePublisher) els.archivePublisher.value = item.publisher || ''
  render()
  if (item.type === 'stream') {
    if (item.firstBlock != null && item.latestBlock != null) {
      state.segmentNotice = `Loading saved stream "${favoriteLabel(item)}" from blocks ${item.firstBlock}-${item.latestBlock}...`
      render()
      void watchStationFavorite(item, tuneSerial).catch((error) => {
        if (!archiveTuneIsCurrent(tuneSerial) || isAbortError(error)) return
        const message = publicErrorMessage(error)
        state.segmentNotice = message
        setStatus(message)
        render()
      })
    } else {
      void refresh()
    }
  } else {
    setStatus(`${favoriteLabel(item)} selected. Use Watch old streams to scan this saved ${item.type}.`)
  }
}

function renderPlayLatest(latestPlayable = latestVerifiedRecord()) {
  if (!els.playLatest) return
  els.playLatest.disabled = !latestPlayable
  els.playLatest.title = latestPlayable ? `Play verified segment #${latestPlayable.sequence}` : 'No verified segment is ready to play'
}

function render() {
  const focusKey = dynamicFocusKey()
  const activeRecord = currentRecord()
  const latestSegment = [...state.segments].sort((a, b) => a.sequence - b.sequence).at(-1) || null
  const tunedSummary = tunedArchiveSummary()
  els.knownCount.textContent = String(state.segments.length)
  els.verifiedCount.textContent = String(state.verified.size)
  const metadataAge = fmtAge(state.metadataUpdatedAt)
  els.metadataAge.textContent = state.metadataState === 'cached'
    ? `cached · ${metadataAge}`
    : state.metadataState === 'stale'
      ? `stale · ${metadataAge}`
      : metadataAge
  els.metadataAge.title = state.metadataState === 'cached'
    ? 'Restored from matching browser cache; network confirmation is pending.'
    : state.metadataState === 'stale'
      ? 'Previously loaded metadata is retained because the latest network refresh failed.'
      : 'Age of the latest Station metadata.'
  const health = streamHealthSummary(latestSegment)
  els.streamHealth.textContent = health
  els.streamHealth.title = `Playback: ${playbackModeLabel(state.playbackMode)}`
  renderPlayLatest()
  els.streamToggle.textContent = state.playbackMode === 'live' ? 'LIVE' : state.followIntent ? 'FOLLOWING' : 'FOLLOW LIVE'
  els.streamToggle.classList.toggle('active', state.playbackMode === 'live')
  els.streamToggle.dataset.following = state.followIntent ? 'true' : 'false'
  els.streamToggle.setAttribute('aria-pressed', state.followIntent ? 'true' : 'false')
  els.streamToggle.setAttribute('aria-label', state.followIntent ? `Stop following live stream; ${playbackModeLabel(state.playbackMode)}` : 'Start following live stream')
  els.streamToggle.title = state.followIntent ? `Stop following live stream (${playbackModeLabel(state.playbackMode)})` : 'Start following live stream'
  const currentFavorite = currentStreamFavorite()
  const streamSaved = currentFavorite ? state.favorites.some((item) => item.id === currentFavorite.id) : false
  if (els.favoriteStream) {
    els.favoriteStream.textContent = streamSaved ? '★' : '☆'
    els.favoriteStream.setAttribute('aria-pressed', streamSaved ? 'true' : 'false')
    const favoriteLabel = streamSaved ? 'Remove current stream from favorites' : 'Save current stream'
    els.favoriteStream.setAttribute('aria-label', favoriteLabel)
    els.favoriteStream.title = favoriteLabel
  }
  if (els.loopToggle) {
    els.player.loop = false
    els.loopToggle.textContent = state.loopReplay ? 'LOOP ON' : 'LOOP OFF'
    els.loopToggle.classList.toggle('active', state.loopReplay)
    els.loopToggle.setAttribute('aria-pressed', state.loopReplay ? 'true' : 'false')
    els.loopToggle.setAttribute('aria-label', state.loopReplay ? 'Stop looping loaded segments' : 'Loop loaded segments')
    els.loopToggle.title = state.loopReplay ? 'Stop looping loaded segments' : 'Loop loaded segments'
  }
  const stationLive = state.playbackMode === 'live' && Boolean(activeRecord)
  const stationLoaded = Boolean(activeRecord || latestSegment)
  const stationLabels = {
    live: 'LIVE',
    replay: 'REPLAY',
    'replay-buffering': 'BUFFER',
    'catching-up': 'CATCH UP',
    buffering: 'BUFFER',
    waiting: 'WAITING',
    paused: 'PAUSED',
    interrupted: 'INTERRUPTED',
    ended: 'ENDED',
  }
  els.stationState.textContent = stationLabels[state.playbackMode] || (stationLoaded ? 'LOADED' : 'OFFLINE')
  document.querySelector('.status-badge')?.classList.toggle('online', stationLive)
  els.networkLabel.textContent = CHAIN_PRESETS[state.config.chainPreset]?.label || state.config.chainPreset
  const stationUrl = stationExplorerUrl()
  if (stationUrl) {
    els.stationExplorer.href = stationUrl
    els.stationExplorer.textContent = 'Station'
    els.stationExplorer.removeAttribute('aria-disabled')
    els.stationExplorer.removeAttribute('tabindex')
    els.stationExplorer.title = state.config.stationAddress
  } else {
    els.stationExplorer.removeAttribute('href')
    els.stationExplorer.textContent = 'No Station'
    els.stationExplorer.setAttribute('aria-disabled', 'true')
    els.stationExplorer.setAttribute('tabindex', '-1')
    els.stationExplorer.title = 'Set a Station address to open it in the block explorer.'
  }
  for (const button of els.chainButtons) {
    const active = button.dataset.chainPreset === state.config.chainPreset
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', active ? 'true' : 'false')
  }
  els.nowTitle.textContent = activeRecord ? `${playbackModeLabel(state.playbackMode)} segment #${activeRecord.sequence}` : playbackModeLabel(state.playbackMode)
  els.nowDetail.textContent = activeRecord
    ? `Stream health: ${health}. Payload source: ${playbackSourceLabel(activeRecord)}.`
    : latestSegment
      ? `Stream health: ${health}. Segment metadata is loaded; verify a segment to start playback.`
      : `Stream health: ${health}. Execution RPC announces segments; beacon sidecars carry the bytes.`
  renderEmptyState({ activeRecord, latestSegment, health, tunedSummary })
  els.metricSegment.textContent = activeRecord ? `#${activeRecord.sequence}` : latestSegment ? `#${latestSegment.sequence}` : '-'
  els.metricPayload.textContent = activeRecord ? fmtBytes(activeRecord.bytes) : latestSegment ? fmtBytes(latestSegment.payloadBytes) : '-'
  els.metricBlobs.textContent = latestSegment ? String(latestSegment.blobCount || '-') : '-'
  els.metricLatency.textContent = latestSegment ? fmtLatency(latestSegment) : '-'
  els.metricFetch.textContent = activeRecord ? playbackSourceLabel(activeRecord) : latestSegment && state.activeBeaconApi ? 'ok / pending' : '- / -'
  renderHealth()
  renderEndpointSetup()
  renderBlobspace()
  renderBlobFees()
  renderArchive()
  renderFavorites()
  if (els.segmentsTitle) {
    els.segmentsTitle.textContent = tunedSummary
      ? `Stream Segments · ${tunedSummary.title}`
      : `Stream Segments${state.config.streamId ? ` · ${state.config.streamId}` : ''}`
  }
  const segmentRows = state.segments.map((segment) => {
    const record = state.verified.get(segment.cacheKey)
    const queued = state.prefetching.has(segment.cacheKey)
    const timeBlock = segmentTimeBlock(segment)
    const txLabel = middleEllipsis(segment.txHash, 8, 6)
    const active = activeRecord?.cacheKey === segment.cacheKey
    const continuity = segmentContinuityPresentation(segment)
    const quarantined = continuity.quarantined
    const segmentAction = continuity.action || (active ? 'NOW' : record ? 'PLAY' : queued ? '...' : 'GET')
    const segmentActionLabel = segmentActionAccessibleName({
      sequence: segment.sequence,
      quarantined,
      active,
      cached: Boolean(record),
      queued,
    })
    return `
      <section class="segment-row ${record ? 'verified' : ''} ${active ? 'active' : ''} ${quarantined ? 'quarantined' : ''}" role="row" data-segment-key="${escapeHtml(segment.cacheKey)}" title="${escapeHtml(continuity.label)}">
        <span class="segment-cell" role="cell"><button class="segment-jump" type="button" data-focus-key="segment:${escapeHtml(segment.cacheKey)}:jump" data-jump-key="${escapeHtml(segment.cacheKey)}" aria-label="Jump to segment #${escapeHtml(segment.sequence)}" ${quarantined ? 'disabled aria-disabled="true"' : ''}>#${escapeHtml(segment.sequence)}</button></span>
        <span class="segment-cell segment-time" role="cell"><time>${escapeHtml(timeBlock.time)}</time><small>${escapeHtml(timeBlock.block)}</small></span>
        <span class="segment-cell" role="cell"><a class="tx-link" data-focus-key="segment:${escapeHtml(segment.cacheKey)}:transaction" href="${escapeHtml(explorerTxUrl(segment.txHash))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(segment.txHash)}">${escapeHtml(txLabel)}</a></span>
        <span class="segment-cell" role="cell">${escapeHtml(segment.blobCount)}${continuity.suffix}</span>
        <span class="segment-cell" role="cell"><button type="button" data-focus-key="segment:${escapeHtml(segment.cacheKey)}:play" data-key="${escapeHtml(segment.cacheKey)}" aria-label="${escapeHtml(segmentActionLabel)}" ${quarantined ? 'disabled aria-disabled="true"' : ''}>${segmentAction}</button></span>
      </section>
    `
  }).join('')
  const noticeRow = state.segmentNotice
    ? `<div role="row"><div class="segment-notice" role="cell" aria-colspan="5">${escapeHtml(state.segmentNotice)}</div></div>`
    : ''
  const emptyRow = '<div role="row"><div class="empty-row" role="cell" aria-colspan="5">No stream segments yet</div></div>'
  els.segments.innerHTML = noticeRow + (segmentRows || emptyRow)
  restoreDynamicFocus(focusKey)
}

async function refresh() {
  if (state.busy) return
  const runtime = runtimeSnapshot()
  state.busy = true
  const serial = ++state.refreshSerial
  const spinToken = ++state.refreshSpinToken
  const spinStartedAt = performance.now()
  els.refresh.disabled = true
  els.refresh.classList.add('is-spinning')
  if (!state.anchor && !state.segments.length) {
    state.blobspace = { mode: 'sample', rows: defaultBlobspaceRows(), warning: '' }
    render()
  } else if (state.segments.length) {
    state.segmentNotice = state.metadataState === 'cached'
      ? 'Showing cached metadata while checking the execution RPC for a fresh Station view.'
      : 'Keeping the current segment list visible while checking for fresh Station events.'
    render()
  }
  setRuntimeStatus(runtime, 'Reading Station events from execution RPC...', { announce: false })
  try {
    const refreshed = await fetchLogs({ signal: runtime.signal, runtime })
    if (!runtimeIsCurrent(runtime) || serial !== state.refreshSerial) return
    const activePlaybackInvalidated = invalidateOrphanedActivePlayback(refreshed.segments)
    state.segments = refreshed.segments
    if (state.anchor && refreshed.cursorBlock != null) state.anchor.cursorBlock = refreshed.cursorBlock
    state.verified.clear()
    await cacheSegmentMetadata(state.segments, runtime)
    requireCurrentRuntime(runtime)
    if (!state.activeBeaconApi) {
      await beacon('/eth/v1/beacon/genesis', { signal: runtime.signal }).catch((error) => {
        if (isAbortError(error)) throw error
        return null
      })
      requireCurrentRuntime(runtime)
    }
    await hydrateValidatedCachedSegments(state.segments, runtime)
    await refreshCacheStats(runtime)
    requireCurrentRuntime(runtime)
    await refreshBlobspace(runtime)
    requireCurrentRuntime(runtime)
    if (state.followIntent) {
      state.liveEdgeKey = orderedLoadedSegments().at(-1)?.cacheKey || ''
      if (state.playbackMode === 'live' && state.currentRecordKey !== state.liveEdgeKey) state.playbackMode = 'catching-up'
    }
    state.segmentNotice = activePlaybackInvalidated
      ? 'Canonical Station history changed while this segment was active. Orphaned playback was stopped; choose a current verified segment to resume.'
      : ''
    render()
    prefetchWindow()
    if (activePlaybackInvalidated) {
      setRuntimeStatus(runtime, 'Canonical Station history changed. Orphaned playback was stopped before current metadata was rendered.', { announcementKey: 'canonical-history-changed' })
    } else if (state.segments.length && !state.verified.size) {
      setRuntimeStatus(runtime, `Station metadata is available for ${state.segments.length} segment${state.segments.length === 1 ? '' : 's'}; payload verification is pending sidecars, archive fallback, or browser cache.`, { announce: false })
    } else {
      setRuntimeStatus(runtime, `Loaded ${state.segments.length} Station events, ${state.verified.size} verified locally.`, { announce: false })
    }
  } catch (error) {
    if (!runtimeIsCurrent(runtime)) return
    if (state.segments.length) {
      if (state.metadataState === 'fresh') state.metadataState = 'stale'
      state.segmentNotice = state.metadataState === 'cached'
        ? `Cached metadata remains available. Network refresh failed: ${publicErrorMessage(error)}`
        : `Previously loaded metadata remains available but may be stale: ${publicErrorMessage(error)}`
      render()
    }
    setRuntimeStatus(runtime, publicErrorMessage(error))
  } finally {
    if (runtimeIsCurrent(runtime)) {
      state.busy = false
      els.refresh.disabled = false
      const remainingSpinMs = Math.max(0, 550 - (performance.now() - spinStartedAt))
      setTimeout(() => {
        if (runtimeIsCurrent(runtime) && state.refreshSpinToken === spinToken) els.refresh.classList.remove('is-spinning')
      }, remainingSpinMs)
    }
  }
}

function startStreaming() {
  const runtime = runtimeSnapshot()
  state.playbackAdvanceToken += 1
  state.followIntent = true
  state.playbackMode = state.currentRecordKey ? (els.player?.paused ? 'paused' : 'replay') : 'waiting'
  render()
  void refresh().then(() => {
    if (!runtimeIsCurrent(runtime)) return
    const record = latestVerifiedRecord()
    const latest = orderedLoadedSegments().at(-1) || null
    state.liveEdgeKey = latest?.cacheKey || ''
    if (record && !els.player.currentSrc) playRecord(record, { userRequested: true, playbackIntent: 'follow' }, runtime)
    else render()
  })
  clearInterval(state.refreshTimer)
  state.refreshTimer = setInterval(() => void refresh(), 15000)
}

function stopStreaming() {
  state.playbackAdvanceToken += 1
  state.followIntent = false
  state.liveEdgeKey = ''
  if (!state.currentRecordKey) state.playbackMode = 'idle'
  else if (['live', 'catching-up', 'waiting', 'buffering'].includes(state.playbackMode)) state.playbackMode = els.player?.paused ? 'paused' : 'replay'
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
    streamIdHash: canonicalStreamIdHash(preset.streamId),
    executionRpcs: [...preset.executionRpcs],
    beaconApis: [...preset.beaconApis],
  }
}

function resetRuntimeState() {
  state.runtimeController.abort(requestAbortError('Runtime configuration changed.'))
  state.archive.activeController?.abort(requestAbortError('Runtime configuration changed.'))
  state.archive.activeController = null
  state.archive.scanning = false
  state.runtimeGeneration += 1
  state.runtimeController = new AbortController()
  state.refreshSerial += 1
  state.refreshSpinToken += 1
  state.playbackAdvanceToken += 1
  state.playbackContextGeneration += 1
  state.busy = false
  state.blobspaceRefreshPromise = null
  state.anchor = null
  state.segments = []
  state.verified.clear()
  state.prefetching.clear()
  state.prefetchPromises.clear()
  state.segmentNotice = ''
  state.blockTimes.clear()
  state.blockTimeHashes.clear()
  state.sidecarMemoryCache.clear()
  state.sidecarFetchPromises.clear()
  state.sidecarCacheEpoch += 1
  state.activeExecutionRpc = ''
  state.activeBeaconApi = ''
  state.endpointHealth = {
    execution: { state: state.config.executionRpcs.length ? 'idle' : 'missing', message: '' },
    beacon: { state: state.config.beaconApis.length ? 'idle' : 'missing', message: '' },
  }
  state.metadataUpdatedAt = ''
  state.metadataState = 'none'
  state.currentRecordKey = ''
  state.playbackMode = 'idle'
  state.playbackIntent = 'replay'
  state.liveEdgeKey = ''
  state.followIntent = false
  clearInterval(state.refreshTimer)
  state.refreshTimer = null
  state.selectedSegmentQuery = ''
  if (els.player) {
    els.player.pause()
    els.player.removeAttribute('src')
    els.player.load()
  }
  revokeAllObjectUrls()
  state.blobspace = { mode: 'sample', rows: defaultBlobspaceRows(), warning: '' }
  state.blobFees = { ...loadBlobFeeSamples(), samples: state.blobFees.samples }
  els.refresh.disabled = false
  els.refresh.classList.remove('is-spinning')
  els.headBlock.textContent = '-'
  els.headSlot.textContent = '-'
}

function applyPreset(presetKey, { refreshAfter = false } = {}) {
  if (!CHAIN_PRESETS[presetKey]) return
  state.config = presetConfig(presetKey)
  const persistence = saveConfig(state.config)
  resetRuntimeState()
  fillForm()
  render()
  if (els.endpointApplyStatus) {
    els.endpointApplyStatus.textContent = `${CHAIN_PRESETS[presetKey].label} preset endpoints applied.${configPersistenceNotice(persistence)}`
    announceStatus(els.endpointApplyStatus.textContent, { key: 'endpoint-preset-applied' })
  }
  if (refreshAfter) void refresh()
}

function formConfig() {
  const selectedPreset = CHAIN_PRESETS[els.chainPreset.value] || CHAIN_PRESETS[DEFAULTS.chainPreset]
  const executionRpcs = unique(parseLines(els.executionRpcs.value))
  const beaconApis = unique(parseLines(els.beaconApis.value))
  const archiveTemplates = unique(parseLines(els.archiveTemplates.value))
  const endpointErrors = [
    ...validateEndpointList('Execution RPC', executionRpcs),
    ...validateEndpointList('Beacon API', beaconApis),
    ...validateArchiveTemplateList(archiveTemplates),
  ]
  if (endpointErrors.length) throw new Error(endpointErrors[0])
  const stationAddress = normalizeStationAddressInput(els.stationAddress.value)
  if (els.stationAddress.value.trim() && !stationAddress) {
    throw new Error('Station must be a 20-byte address or a block explorer address URL.')
  }
  const enteredStreamId = els.streamId.value
  const streamId = boundedStreamId(enteredStreamId === state.config.streamId
    ? state.config.streamId
    : enteredStreamId.trim() || selectedPreset.streamId)
  const stationChanged = stationAddress !== normalizeStationAddressInput(state.config.stationAddress)
  return {
    ...state.config,
    chainPreset: els.chainPreset.value,
    streamId,
    streamIdHash: canonicalStreamIdHash(streamId),
    publisher: streamId === state.config.streamId && !stationChanged ? state.config.publisher : '',
    stationAddress: stationAddress || selectedPreset.stationAddress,
    fromBlock: els.fromBlock.value.trim() || selectedPreset.fromBlock,
    executionRpcs: [...normalizeHttpEndpointList(executionRpcs, 'Execution RPC')],
    beaconApis: [...normalizeHttpEndpointList(beaconApis, 'Beacon API')],
    archiveTemplates: archiveTemplates.length ? [...normalizeArchiveTemplateList(archiveTemplates)] : [],
    cacheLimitMb: clampCacheLimitMb(els.cacheLimit.value, DEFAULTS.cacheLimitMb, { min: CACHE_LIMIT_MIN_MB, max: CACHE_LIMIT_MAX_MB }),
  }
}

function applyCustomConfig() {
  state.config = formConfig()
  const persistence = saveConfig(state.config)
  resetRuntimeState()
  fillForm()
  render()
  const mode = endpointMode()
  if (els.endpointApplyStatus) {
    const applied = mode === 'preset'
      ? 'Preset endpoint values applied from the custom form.'
      : 'Custom browser endpoint configuration applied.'
    els.endpointApplyStatus.textContent = `${applied}${configPersistenceNotice(persistence)}`
    announceStatus(els.endpointApplyStatus.textContent, { key: 'endpoint-config-applied' })
  }
  void refresh()
}

function exportableCacheRecord(input) {
  const {
    payload: _payload,
    archiveUrl,
    runtimeWriteToken: _runtimeWriteToken,
    ...record
  } = input || {}
  return {
    ...record,
    ...(archiveUrl ? { archiveSourceOrigin: publicUrlLabel(archiveUrl) } : {}),
  }
}

function cacheIndexDocument(records, config, exportedAt = new Date().toISOString()) {
  const scope = metadataScopeForConfig(config)
  const scopedRecords = records.filter((record) =>
    String(record?.chainId || '') === scope.chainId
    && normalizeHex(record?.stationAddress) === scope.stationAddress
    && normalizeHex(record?.publisher) === scope.publisher
    && normalizeHex(record?.streamIdHash) === scope.streamIdHash
    && String(record?.streamId || '') === scope.streamId
    && normalizeHex(record?.syntheticChannelId) === scope.syntheticChannelId)
  return {
    schema: 'rfe-cache-index@2',
    app: 'eth-radio',
    exportedAt,
    chainPreset: scope.chainPreset,
    chainId: scope.chainId,
    stationAddress: scope.stationAddress,
    publisher: scope.publisher,
    streamIdHash: scope.streamIdHash,
    streamId: scope.streamId,
    syntheticChannelId: scope.syntheticChannelId,
    records: scopedRecords.map(exportableCacheRecord),
  }
}

function exportIndex() {
  allCachedSegments().then((records) => {
    const index = cacheIndexDocument(records, state.config)
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(index, null, 2)}\n`], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `rfe-cache-index-${state.config.streamId}.json`
    link.click()
    URL.revokeObjectURL(url)
    if (storageStatus.indexedDb === 'unavailable') setStatus('Exported the in-memory cache index. Persistent browser cache is unavailable.')
  }).catch((error) => setStatus(`Cache index could not be exported: ${publicErrorMessage(error)}`))
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
  if (state.followIntent) stopStreaming()
  else startStreaming()
})
on(els.loopToggle, 'click', () => {
  state.loopReplay = !state.loopReplay
  state.playbackAdvanceToken += 1
  els.player.loop = false
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
  const playbackRequestToken = beginUserPlaybackRequest()
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
        if (!userPlaybackRequestIsCurrent(playbackRequestToken)) return
        playRecord(record, { userRequested: true })
        setStatus(`Playing cached segment #${segment.sequence} from ${shortHash(txHash)}.`)
      } else {
        setStatus(`Loaded ${state.segments.length} segments from ${shortHash(txHash)} forward. Verifying segment #${segment.sequence}...`)
        void verifySegment(segment)
          .then((verified) => {
            if (!userPlaybackRequestIsCurrent(playbackRequestToken)) return
            playRecord(verified, { userRequested: true })
            setStatus(`Playing verified segment #${segment.sequence}.`)
          })
          .catch((error) => {
            if (userPlaybackRequestIsCurrent(playbackRequestToken)) setStatus(publicErrorMessage(error))
          })
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
    if (!record) {
      const verified = await verifySegment(segment)
      if (!userPlaybackRequestIsCurrent(playbackRequestToken)) return
      playRecord(verified, { userRequested: true })
    } else {
      if (!userPlaybackRequestIsCurrent(playbackRequestToken)) return
      playRecord(record, { userRequested: true })
    }
    setStatus(`Playing verified segment #${segment.sequence}.`)
  } catch (error) {
    if (userPlaybackRequestIsCurrent(playbackRequestToken)) setStatus(publicErrorMessage(error))
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
  const playbackRequestToken = beginUserPlaybackRequest()
  tuneToStream(segment, { reset: false })
  state.selectedSegmentQuery = txHash
  if (els.segmentLookup) els.segmentLookup.value = txHash
  updateLookupMessage()
  syncUrlState()
  setStatus(`Verifying segment #${segment.sequence} from ${cell.dataset.slotJumpTx ? 'slot jump' : 'clicked blob'}...`)
  try {
    const record = state.verified.get(segment.cacheKey) || await verifySegment(segment)
    if (!userPlaybackRequestIsCurrent(playbackRequestToken)) return
    render()
    playRecord(record, { userRequested: true })
    setStatus(`Playing verified segment #${segment.sequence}.`)
  } catch (error) {
    if (userPlaybackRequestIsCurrent(playbackRequestToken)) setStatus(publicErrorMessage(error))
  }
})
on(els.exportIndex, 'click', exportIndex)
on(els.clearCache, 'click', () => void clearCache()
  .then(() => setStatus(storageStatus.indexedDb === 'unavailable' ? 'In-memory cache cleared. Persistent browser cache is unavailable.' : 'Browser cache cleared.'))
  .catch((error) => setStatus(`Cache could not be cleared: ${publicErrorMessage(error)}`)))
on(els.themeToggle, 'click', () => {
  setTheme(document.body.classList.contains('light') ? 'dark' : 'light')
})
on(els.settingsToggle, 'click', () => openSettings('appearance'))
on(els.settingsRecoveryToggle, 'click', () => openSettings('layout'))
on(els.emptyRecovery, 'click', () => openSettings('connections'))
on(els.settingsClose, 'click', closeSettings)
on(els.settingsModal, 'click', (event) => {
  if (event.target.closest('[data-settings-close]')) closeSettings()
})
on(document, 'keydown', (event) => {
  if (els.settingsModal?.hidden) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeSettings()
    return
  }
  trapSettingsFocus(event)
})
on(document, 'visibilitychange', () => startBlobFeeTracker())
for (const button of els.settingsTabs) {
  on(button, 'click', () => {
    showSettingsTab(button.dataset.settingsTab)
    button.focus()
  })
  on(button, 'keydown', moveSettingsTabFocus)
}
on(els.layoutPresets, 'click', (event) => {
  const button = event.target.closest('[data-layout-preset]')
  if (!button) return
  saveLayoutPreset(button.dataset.layoutPreset)
  setStatus(`Layout preset applied: ${button.textContent.trim()}.`)
})
for (const input of els.panelShow) {
  on(input, 'change', () => {
    const panel = input.dataset.panelShow
    const nextConfig = { ...state.layoutSettings[panel], visible: input.checked }
    if (panel === 'blobFees' && input.checked && state.layoutSettings[panel]?.visible === false) {
      nextConfig.position = 'bottom'
      nextConfig.order = 2
    }
    state.layoutSettings[panel] = nextConfig
    saveLayoutSettings()
    applyLayoutPreset()
    setStatus(`${PANEL_LABELS[panel]} ${input.checked ? 'shown' : 'hidden'}.`)
  })
}
for (const select of els.panelPosition) {
  on(select, 'change', () => {
    const panel = select.dataset.panelPosition
    state.layoutSettings[panel] = { ...state.layoutSettings[panel], position: select.value }
    state.layoutPreset = 'custom'
    safeStorageSet(LAYOUT_KEY, state.layoutPreset)
    saveLayoutSettings()
    applyLayoutPreset()
    setStatus(`${PANEL_LABELS[panel]} moved to ${PANEL_POSITIONS[select.value]}.`)
  })
}
for (const select of els.panelOrder) {
  on(select, 'change', () => {
    const panel = select.dataset.panelOrder
    state.layoutSettings[panel] = { ...state.layoutSettings[panel], order: Number(select.value) }
    state.layoutPreset = 'custom'
    safeStorageSet(LAYOUT_KEY, state.layoutPreset)
    saveLayoutSettings()
    applyLayoutPreset()
    setStatus(`${PANEL_LABELS[panel]} order set to ${select.value}.`)
  })
}
on(els.layoutBottomSpan, 'change', () => {
  state.layoutSettings = { ...state.layoutSettings, bottomSpan: els.layoutBottomSpan.value }
  state.layoutPreset = 'custom'
  safeStorageSet(LAYOUT_KEY, state.layoutPreset)
  saveLayoutSettings()
  applyLayoutPreset()
  setStatus(els.layoutBottomSpan.value === 'full'
    ? 'Bottom panels now stretch to the page edges.'
    : 'Side rails now keep the lower corner space.')
})
on(els.clockMode, 'change', () => {
  state.clock = { ...state.clock, mode: els.clockMode.value }
  saveClockPrefs()
  renderClockControls()
  renderBlobFees()
})
on(els.clockTimeZone, 'input', () => {
  state.clock = { ...state.clock, timeZone: els.clockTimeZone.value.trim() }
  saveClockPrefs()
  renderClockControls()
  renderBlobFees()
})
on(els.blobFeeUnit, 'change', () => {
  state.blobFeePrefs = { ...state.blobFeePrefs, unit: els.blobFeeUnit.value }
  saveBlobFeePrefs()
  renderBlobFees()
})
on(els.blobFeeWindow, 'change', () => {
  state.blobFeePrefs = { ...state.blobFeePrefs, historyWindow: els.blobFeeWindow.value }
  saveBlobFeePrefs()
  renderBlobFees()
})
on(els.favoriteStream, 'click', () => {
  try {
    const current = currentStreamFavorite()
    if (!current) throw new Error('Nothing valid to save yet.')
    const existing = state.favorites.find((item) => item.id === current.id)
    if (existing) {
      state.favorites = state.favorites.filter((item) => item.id !== current.id)
      saveFavorites()
      render()
      setStatus(`Removed stream favorite: ${favoriteLabel(existing)}.`)
      return
    }
    const favorite = upsertFavorite(current)
    setStatus(`Saved stream favorite: ${favoriteLabel(favorite)}.`)
    render()
  } catch (error) {
    setStatus(publicErrorMessage(error))
  }
})
on(els.favoriteStation, 'click', () => {
  try {
    const favorite = upsertFavorite({
      type: 'station',
      chainId: state.config.chainId,
      stationAddress: state.config.stationAddress,
      label: `Station ${shortHash(state.config.stationAddress)}`,
    })
    setStatus(`Saved Station favorite: ${favoriteLabel(favorite)}.`)
  } catch {
    setStatus('Set a Station address before saving it.')
  }
})
on(els.favoriteChannel, 'click', () => {
  try {
    const favorite = upsertFavorite(currentChannelFavorite())
    setStatus(`Saved channel favorite: ${favoriteLabel(favorite)}.`)
  } catch {
    setStatus('Load stream metadata before saving a publisher/channel favorite.')
  }
})
for (const button of els.archiveModeButtons) {
  on(button, 'click', () => {
    state.archive.mode = button.dataset.archiveMode || 'station'
    state.archive.streams = []
    state.archive.segmentsByKey = new Map()
    resetArchiveProgress(archiveDefaultMessage(state.archive.mode))
    renderArchive()
  })
}
on(els.archiveRangeMode, 'change', () => {
  const rangeMode = els.archiveRangeMode.value === 'block' ? 'block' : 'date'
  if (rangeMode === 'block') {
    els.archiveFromDate.value = ''
    els.archiveToDate.value = ''
  } else {
    els.archiveFromBlock.value = ''
  }
  resetArchiveProgress(`Using ${rangeMode === 'block' ? 'an explicit From block' : 'an explicit date range'} for the next scan.`)
  renderArchiveMode()
})
on(els.archiveScanForm, 'input', () => {
  if (state.archive.progress?.status === 'error') resetArchiveProgress()
})
on(els.archiveScanForm, 'submit', (event) => {
  event.preventDefault()
  state.archive.activeController?.abort()
  const controller = new AbortController()
  state.archive.activeController = controller
  state.archive.cancel = false
  resetArchiveProgress()
  renderArchiveMode()
  const scan = state.archive.mode === 'inbox'
    ? scanBlobInboxStreams({
      inboxAddress: els.archiveInbox.value,
      publisher: els.archivePublisher.value,
      streamId: els.archiveStreamFilter.value.trim(),
      rangeMode: els.archiveRangeMode.value,
      fromBlock: els.archiveFromBlock.value.trim(),
      fromDate: els.archiveFromDate.value,
      toDate: els.archiveToDate.value,
      signal: controller.signal,
    })
    : scanOldStreams({
      stationAddress: els.archiveStation.value,
      publisher: els.archivePublisher.value,
      rangeMode: els.archiveRangeMode.value,
      fromBlock: els.archiveFromBlock.value.trim(),
      fromDate: els.archiveFromDate.value,
      toDate: els.archiveToDate.value,
      signal: controller.signal,
    })
  void scan.catch((error) => {
    const cancelled = state.archive.cancel || isAbortError(error)
    state.archive.scanning = false
    const progress = state.archive.progress || defaultArchiveProgress(state.archive.mode)
    if (cancelled) {
      setArchiveProgress('Archive scan stopped.', {
        current: progress.current,
        total: progress.total,
        active: false,
        status: 'cancelled',
      })
    } else {
      setArchiveProgress(archiveScanErrorMessage(error), {
        current: progress.current,
        total: progress.total,
        active: false,
        status: 'error',
      })
    }
    state.archive.cancel = false
    renderArchive()
  }).finally(() => {
    if (state.archive.activeController === controller) state.archive.activeController = null
    if (els.archiveScan) els.archiveScan.disabled = false
    renderArchiveMode()
  })
})
on(els.archiveStop, 'click', () => {
  if (!state.archive.activeController) return
  state.archive.cancel = true
  state.archive.activeController.abort()
  const progress = state.archive.progress || defaultArchiveProgress(state.archive.mode)
  setArchiveProgress('Stopping archive scan...', {
    current: progress.current,
    total: progress.total,
    active: true,
    status: 'stopping',
  })
})
on(els.archiveResults, 'click', (event) => {
  const row = event.target.closest('[data-archive-key]')
  const button = event.target.closest('[data-archive-action]')
  if (!row || !button) return
  const stream = state.archive.streams.find((candidate) => candidate.key === row.dataset.archiveKey)
  if (!stream) return
  if (button.dataset.archiveAction === 'save') {
    try {
      const favorite = upsertFavorite(state.archive.mode === 'inbox'
        ? {
          type: 'inbox-stream',
          chainId: state.config.chainId,
          inboxAddress: els.archiveInbox.value,
          publisher: stream.publisher,
          streamId: stream.streamId,
          streamIdHash: stream.streamIdHash,
          firstBlock: stream.firstBlock,
          latestBlock: stream.latestBlock,
          label: stream.title,
        }
        : {
          type: 'stream',
          chainId: state.config.chainId,
          stationAddress: els.archiveStation.value || state.config.stationAddress,
          publisher: stream.publisher,
          streamId: stream.streamId,
          streamIdHash: stream.streamIdHash,
          firstBlock: stream.firstBlock,
          latestBlock: stream.latestBlock,
          label: stream.title,
        })
      setStatus(`Saved stream favorite: ${favoriteLabel(favorite)}.`)
    } catch (error) {
      setStatus(publicErrorMessage(error))
    }
    return
  }
  if (state.archive.tunedKey === row.dataset.archiveKey && state.segments.length) {
    revealTunedStream()
    setStatus(`Showing watched stream "${stream.title}" in Stream Segments.`)
    return
  }
  button.disabled = true
  const previousText = button.textContent
  button.textContent = 'Watching...'
  setStatus(`Watching "${stream.title}"...`)
  void tuneArchiveStream(row.dataset.archiveKey)
    .catch((error) => {
      if (isAbortError(error)) return
      const message = publicErrorMessage(error)
      state.segmentNotice = message
      setStatus(message)
      render()
    })
    .finally(() => {
      button.disabled = false
      button.textContent = previousText
      renderArchive()
    })
})
on(els.favoritesList, 'click', (event) => {
  const row = event.target.closest('[data-favorite-id]')
  const button = event.target.closest('[data-favorite-action]')
  if (!row || !button) return
  const favorite = state.favorites.find((item) => item.id === row.dataset.favoriteId)
  if (!favorite) return
  if (button.dataset.favoriteAction === 'remove') {
    state.favorites = state.favorites.filter((item) => item.id !== favorite.id)
    saveFavorites()
    renderFavorites()
    setStatus(`Removed favorite: ${favoriteLabel(favorite)}.`)
    return
  }
  if (button.dataset.favoriteAction === 'rename') {
    const label = window.prompt('Local favorite label', favoriteLabel(favorite))
    if (label == null) return
    favorite.label = String(label).trim().slice(0, 80)
    saveFavorites()
    renderFavorites()
    setStatus(`Renamed favorite: ${favoriteLabel(favorite)}.`)
    return
  }
  tuneFavorite(favorite)
})
function mediaEventMatchesCurrentRecord() {
  if (!state.currentRecordKey || !els.player) return false
  const expectedUrl = state.objectUrls.get(state.currentRecordKey) || ''
  const activeUrl = els.player.currentSrc || els.player.src || ''
  return Boolean(expectedUrl && activeUrl === expectedUrl)
}

on(els.player, 'waiting', () => {
  if (!mediaEventMatchesCurrentRecord() || els.player.ended) return
  state.playbackMode = state.playbackIntent === 'follow' ? 'buffering' : 'replay-buffering'
  render()
})
on(els.player, 'playing', () => {
  if (!mediaEventMatchesCurrentRecord()) return
  state.playbackMode = classifyPlaybackMode(state)
  render()
})
on(els.player, 'pause', () => {
  if (!mediaEventMatchesCurrentRecord() || els.player.ended) return
  state.playbackMode = 'paused'
  render()
})
on(els.player, 'error', () => {
  if (!mediaEventMatchesCurrentRecord() || !els.player.error) return
  state.playbackMode = 'interrupted'
  render()
  const failure = mediaErrorPresentation(els.player.error)
  setStatus(failure.message, { assertive: true, announcementKey: failure.code })
})
on(els.player, 'ended', () => {
  if (!mediaEventMatchesCurrentRecord() || !els.player.ended) return
  const current = currentRecord()
  if (!state.followIntent) {
    const advanceToken = state.playbackAdvanceToken
    const currentKey = state.currentRecordKey
    const nextSegment = nextSegmentAfter(current)
    if (nextSegment) {
      setStatus(`Buffering next segment #${nextSegment.sequence}...`, { announce: false })
      void advanceLoadedPlayback(nextSegment, { advanceToken, currentKey })
        .then((record) => {
          if (record) setStatus(`Playing verified segment #${nextSegment.sequence}.`, { announce: false })
        })
        .catch((error) => {
          if (playbackAdvanceIsCurrent(advanceToken, currentKey, { replayOnly: true })) setStatus(publicErrorMessage(error))
        })
      return
    }
    if (state.loopReplay && state.segments.length) {
      const first = orderedLoadedSegments()[0]
      setStatus(`Looping back to segment #${first.sequence}...`, { announce: false })
      void advanceLoadedPlayback(first, { advanceToken, currentKey, requireLoop: true })
        .then((record) => {
          if (record) setStatus(`Playing verified segment #${first.sequence}.`, { announce: false })
        })
        .catch((error) => {
          if (playbackAdvanceIsCurrent(advanceToken, currentKey, { requireLoop: true, replayOnly: true })) setStatus(publicErrorMessage(error))
        })
      return
    }
    state.playbackMode = 'ended'
    render()
    setStatus('Replay reached the end of the loaded segment window.')
    return
  }
  if (!state.followIntent) return
  const next = current ? nextVerifiedRecord(current) : null
  if (next) {
    playRecord(next, { playbackIntent: 'follow' })
    return
  }
  state.playbackMode = 'waiting'
  render()
  const advanceToken = state.playbackAdvanceToken
  const currentKey = state.currentRecordKey
  void refresh().then(() => {
    if (!state.followIntent || !playbackAdvanceIsCurrent(advanceToken, currentKey)) return
    const refreshedCurrent = currentRecord()
    const refreshedNext = refreshedCurrent ? nextVerifiedRecord(refreshedCurrent) : latestVerifiedRecord()
    if (refreshedNext) {
      playRecord(refreshedNext, { playbackIntent: 'follow' })
      return
    }
    const newestSegment = state.segments.at(-1)
    if (newestSegment && !state.verified.has(newestSegment.cacheKey)) {
      state.playbackMode = 'buffering'
      render()
      setStatus(`Waiting at live edge. Verifying newest segment #${newestSegment.sequence}...`, { announce: false })
      void prefetchSegment(newestSegment).then((record) => {
        if (!state.followIntent || !playbackAdvanceIsCurrent(advanceToken, currentKey)) return
        if (record) playRecord(record, { playbackIntent: 'follow' })
        else {
          state.playbackMode = 'waiting'
          render()
          setStatus('Waiting for the next verified live segment.', { announce: false })
        }
      })
      return
    }
    state.playbackMode = 'waiting'
    render()
    setStatus('Waiting for the next Station slot at the live edge.', { announce: false })
  })
})
on(els.segments, 'click', async (event) => {
  const jumpButton = event.target.closest('button[data-jump-key]')
  if (jumpButton) {
    const segment = state.segments.find((candidate) => candidate.cacheKey === jumpButton.dataset.jumpKey)
    if (!segment) return
    const playbackRequestToken = beginUserPlaybackRequest()
    state.selectedSegmentQuery = segment.txHash
    if (els.segmentLookup) els.segmentLookup.value = segment.txHash
    updateLookupMessage()
    syncUrlState()
    jumpButton.disabled = true
    setStatus(`Jumping to segment #${segment.sequence}...`)
    try {
      const record = state.verified.get(segment.cacheKey) || await verifySegment(segment)
      if (!userPlaybackRequestIsCurrent(playbackRequestToken)) return
      render()
      playRecord(record, { userRequested: true })
      setStatus(`Playing verified segment #${segment.sequence}.`)
    } catch (error) {
      if (userPlaybackRequestIsCurrent(playbackRequestToken)) setStatus(publicErrorMessage(error))
    } finally {
      jumpButton.disabled = false
    }
    return
  }
  const button = event.target.closest('button[data-key]')
  if (!button) return
  const segment = state.segments.find((candidate) => candidate.cacheKey === button.dataset.key)
  if (!segment) return
  const playbackRequestToken = beginUserPlaybackRequest()
  button.disabled = true
  setStatus(`Verifying segment #${segment.sequence}...`)
  try {
    const record = await verifySegment(segment)
    if (!userPlaybackRequestIsCurrent(playbackRequestToken)) return
    render()
    playRecord(record, { userRequested: true })
    setStatus(`Playing verified segment #${segment.sequence}.`)
  } catch (error) {
    if (userPlaybackRequestIsCurrent(playbackRequestToken)) setStatus(publicErrorMessage(error))
  } finally {
    button.disabled = false
  }
})

setInterval(() => {
  if (els.utcClock) els.utcClock.textContent = fmtClock()
}, 1000)
if (els.utcClock) els.utcClock.textContent = fmtClock()
initTheme()
initSegmentRailResize()
fillForm()
applyLayoutPreset()
renderClockControls()
if (els.archiveStation) els.archiveStation.value = state.config.stationAddress
if (els.segmentLookup && state.selectedSegmentQuery) els.segmentLookup.value = state.selectedSegmentQuery
updateLookupMessage()
if (els.refresh) els.refresh.innerHTML = refreshIcon
renderMuteIcon()
updateVolumeFill()
render()
void initializeCachedState()
startBlobspaceRail()
if (els.player && els.volume) {
  els.player.volume = Number(els.volume.value)
  renderMuteIcon()
  updateVolumeFill()
}
markStartupReady()
