import fs from 'node:fs'
import path from 'node:path'
import { isAddress } from 'viem'
import { parseExactEth, parseExactGwei } from '../../../scripts/lib/exact-units.mjs'
import { MAX_EXECUTION_ENDPOINTS } from './endpoint-operation.mjs'

export const DEFAULT_CONFIG = Object.freeze({
  sourcePath: '',
  sourceMode: 'file',
  liveInputUrl: '',
  captureAudioDevice: '',
  captureTarget: 'desktop',
  captureX: 0,
  captureY: 0,
  captureWidth: 1280,
  captureHeight: 720,
  streamId: '',
  chain: 'sepolia',
  stationAddress: '',
  executionRpcUrl: '',
  beaconRpcUrl: '',
  sendRpcUrls: '',
  profile: '360p',
  segmentMs: 12000,
  videoBitrateKbps: 220,
  audioBitrateKbps: 32,
  maxBlobs: 3,
  maxPending: 2,
  startupBufferSegments: 2,
  maxAheadSegments: 6,
  maxStreamCostEth: '0.05',
  maxSegmentCostEth: '0.005',
  maxFeePerBlobGasGwei: '',
  maxFeePerGasGwei: '',
  maxPriorityFeePerGasGwei: '',
  replaceAfterSeconds: 36,
  feeBumpPercent: 15,
  maxReplacements: 3,
  confirmationDepth: 2,
  sendRetries: 8,
  retryMs: 5000,
  cleanupConfirmedSegments: true,
  confirmMainnet: false,
  overlay: {
    enabled: true,
    title: 'RADIO FREE ETHEREUM',
    subtitle: 'PUBLIC SIGNAL',
    layout: 'terminal',
    accent: '#ff9ed1',
    opacity: 82,
    showUtc: true,
    showNetwork: true,
    showBlockNumber: true,
    showBlockHash: true,
    showSegment: true,
    showStreamId: true,
  },
})

const profiles = new Set(['360p', '480p', '720p'])
const layouts = new Set(['terminal', 'lower-third', 'minimal'])
const sourceModes = new Set(['file', 'screen', 'live-url'])
const captureTargets = new Set(['desktop', 'region'])
const color = /^#[0-9a-fA-F]{6}$/
const allowedConfigFields = new Set([...Object.keys(DEFAULT_CONFIG), 'preflightTicket'])
const allowedOverlayFields = new Set(Object.keys(DEFAULT_CONFIG.overlay))

function rejectUnknownFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be an object')
  const unknown = Object.keys(input).filter((key) => !allowedConfigFields.has(key))
  if (unknown.length) throw new Error(`Configuration contains unknown field: ${unknown.sort()[0]}`)
  if (input.overlay !== undefined) {
    if (!input.overlay || typeof input.overlay !== 'object' || Array.isArray(input.overlay)) {
      throw new Error('Overlay configuration must be an object')
    }
    const unknownOverlay = Object.keys(input.overlay).filter((key) => !allowedOverlayFields.has(key))
    if (unknownOverlay.length) throw new Error(`Overlay configuration contains unknown field: ${unknownOverlay.sort()[0]}`)
  }
}

function text(value, max, label, { required = false } = {}) {
  const result = String(value ?? '').trim()
  if (required && !result) throw new Error(`${label} is required`)
  if (result.length > max) throw new Error(`${label} must be ${max} characters or fewer`)
  return result
}

function integer(value, min, max, label) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  }
  return result
}

function boolean(value) {
  return value === true
}

function optionalUrl(value, label) {
  const result = text(value, 2048, label)
  if (!result) return ''
  let parsed
  try {
    parsed = new URL(result)
  } catch {
    throw new Error(`${label} must be a valid HTTP or HTTPS URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS`)
  }
  return result
}

function optionalGwei(value, label) {
  const result = text(value, 32, label)
  if (!result) return ''
  return parseExactGwei(result, { label, positive: true, maxInputLength: 32 }).canonical
}

function resolveEndpoint(configValue, envValue, label) {
  return optionalUrl(configValue || envValue || '', label)
}

export function environmentDefaults(env = process.env) {
  return {
    sepolia: {
      executionConfigured: Boolean(env.SEPOLIA_ETH_RPC_URL || env.ETH_RPC_URL),
      beaconConfigured: Boolean(env.SEPOLIA_BEACON_RPC_URL || env.BEACON_RPC_URL),
      stationConfigured: Boolean(env.SEPOLIA_STATION_ADDRESS || env.STATION_ADDRESS),
    },
    mainnet: {
      executionConfigured: Boolean(env.MAINNET_ETH_RPC_URL),
      beaconConfigured: Boolean(env.MAINNET_BEACON_RPC_URL),
      stationConfigured: Boolean(env.MAINNET_STATION_ADDRESS),
    },
    walletConfigured: Boolean(env.PRIVATE_KEY),
  }
}

export function normalizeConfig(input, {
  env = process.env,
  requireSource = true,
  requireSigner = true,
  requireMainnetConfirmation = true,
} = {}) {
  rejectUnknownFields(input || {})
  const raw = { ...DEFAULT_CONFIG, ...(input || {}) }
  raw.overlay = { ...DEFAULT_CONFIG.overlay, ...(input?.overlay || {}) }
  const chain = text(raw.chain, 16, 'Network', { required: true }).toLowerCase()
  if (!['sepolia', 'mainnet'].includes(chain)) throw new Error('Network must be Sepolia or Mainnet')

  const sourceMode = text(raw.sourceMode, 24, 'Source mode', { required: true }).toLowerCase()
  if (!sourceModes.has(sourceMode)) throw new Error('Source mode must be file, screen, or live-url')
  const sourcePath = text(raw.sourcePath, 4096, 'Source file', { required: requireSource && sourceMode === 'file' })
  const resolvedSource = sourcePath ? path.resolve(sourcePath) : ''
  if (requireSource && sourceMode === 'file') {
    if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isFile()) {
      throw new Error(`Source file was not found: ${resolvedSource}`)
    }
  }
  const liveInputUrl = text(raw.liveInputUrl, 4096, 'Live input URL', { required: requireSource && sourceMode === 'live-url' })
  if (liveInputUrl) {
    let parsed
    try { parsed = new URL(liveInputUrl) } catch { throw new Error('Live input URL is invalid') }
    if (!['http:', 'https:', 'rtmp:', 'rtmps:', 'srt:', 'udp:'].includes(parsed.protocol)) {
      throw new Error('Live input URL must use HTTP, HTTPS, RTMP, RTMPS, SRT, or UDP')
    }
  }
  const captureTarget = text(raw.captureTarget, 16, 'Capture target', { required: true }).toLowerCase()
  if (!captureTargets.has(captureTarget)) throw new Error('Capture target must be desktop or region')

  const streamId = text(raw.streamId, 160, 'Stream ID', { required: true })
  const envPrefix = chain.toUpperCase()
  const stationAddress = text(
    raw.stationAddress || env[`${envPrefix}_STATION_ADDRESS`] || (chain === 'sepolia' ? env.STATION_ADDRESS : ''),
    64,
    'Station address',
    { required: true },
  )
  if (!isAddress(stationAddress)) throw new Error('Station address is not a valid Ethereum address')

  const executionRpcUrl = resolveEndpoint(
    raw.executionRpcUrl,
    env[`${envPrefix}_ETH_RPC_URL`] || (chain === 'sepolia' ? env.ETH_RPC_URL : ''),
    'Execution RPC URL',
  )
  if (!executionRpcUrl) throw new Error(`An execution RPC URL is required for ${chain}`)
  const beaconRpcUrl = resolveEndpoint(
    raw.beaconRpcUrl,
    env[`${envPrefix}_BEACON_RPC_URL`] || (chain === 'sepolia' ? env.BEACON_RPC_URL : ''),
    'Beacon RPC URL',
  )

  const sendRpcUrls = text(raw.sendRpcUrls, 8192, 'Fallback RPC URLs')
    .split(/[\r\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value, index) => optionalUrl(value, `Fallback RPC URL ${index + 1}`))
  const uniqueExecutionEndpoints = new Set([executionRpcUrl, ...sendRpcUrls])
  if (uniqueExecutionEndpoints.size > MAX_EXECUTION_ENDPOINTS) {
    throw new Error(`At most ${MAX_EXECUTION_ENDPOINTS} unique execution RPC endpoints are allowed`)
  }

  if (!profiles.has(raw.profile)) throw new Error('Profile must be 360p, 480p, or 720p')
  if (!layouts.has(raw.overlay.layout)) throw new Error('Overlay layout is invalid')
  if (!color.test(String(raw.overlay.accent || ''))) throw new Error('Overlay accent must be a six-digit hex color')

  const streamCost = parseExactEth(
    text(raw.maxStreamCostEth, 32, 'Maximum stream cost', { required: true }),
    { label: 'Maximum stream cost', positive: true, maxInputLength: 32 },
  )
  const segmentCost = parseExactEth(
    text(raw.maxSegmentCostEth, 32, 'Maximum segment exposure', { required: true }),
    { label: 'Maximum segment exposure', positive: true, maxInputLength: 32 },
  )
  if (segmentCost.units > streamCost.units) {
    throw new Error('Maximum segment exposure cannot exceed the total stream budget')
  }
  if (requireMainnetConfirmation && chain === 'mainnet' && !boolean(raw.confirmMainnet)) {
    throw new Error('Mainnet publishing requires the explicit real-ETH confirmation')
  }
  if (requireSigner && !env.PRIVATE_KEY) throw new Error('PRIVATE_KEY is not configured in the local .env file')

  return {
    ...raw,
    sourcePath: resolvedSource,
    sourceMode,
    liveInputUrl,
    captureAudioDevice: text(raw.captureAudioDevice, 256, 'Capture audio device'),
    captureTarget,
    captureX: integer(raw.captureX, 0, 32768, 'Capture X offset'),
    captureY: integer(raw.captureY, 0, 32768, 'Capture Y offset'),
    captureWidth: integer(raw.captureWidth, 160, 16384, 'Capture width'),
    captureHeight: integer(raw.captureHeight, 90, 16384, 'Capture height'),
    streamId,
    chain,
    stationAddress,
    executionRpcUrl,
    beaconRpcUrl,
    sendRpcUrls,
    profile: raw.profile,
    segmentMs: integer(raw.segmentMs, 4000, 60000, 'Segment duration'),
    videoBitrateKbps: integer(raw.videoBitrateKbps, 48, 4000, 'Video bitrate'),
    audioBitrateKbps: integer(raw.audioBitrateKbps, 8, 320, 'Audio bitrate'),
    maxBlobs: integer(raw.maxBlobs, 1, 6, 'Maximum blobs per segment'),
    maxPending: integer(raw.maxPending, 1, 6, 'Maximum pending transactions'),
    startupBufferSegments: integer(raw.startupBufferSegments, 1, 12, 'Startup buffer'),
    maxAheadSegments: integer(raw.maxAheadSegments, 2, 60, 'Maximum ahead buffer'),
    maxStreamCostEth: streamCost.canonical,
    maxSegmentCostEth: segmentCost.canonical,
    maxFeePerBlobGasGwei: optionalGwei(raw.maxFeePerBlobGasGwei, 'Maximum blob fee'),
    maxFeePerGasGwei: optionalGwei(raw.maxFeePerGasGwei, 'Maximum execution fee'),
    maxPriorityFeePerGasGwei: optionalGwei(raw.maxPriorityFeePerGasGwei, 'Maximum priority fee'),
    replaceAfterSeconds: integer(raw.replaceAfterSeconds, 12, 600, 'Replacement timer'),
    feeBumpPercent: integer(raw.feeBumpPercent, 10, 200, 'Fee bump percentage'),
    maxReplacements: integer(raw.maxReplacements, 0, 10, 'Maximum replacements'),
    confirmationDepth: integer(raw.confirmationDepth, 1, 12, 'Confirmation depth'),
    sendRetries: integer(raw.sendRetries, 1, 50, 'Send retries'),
    retryMs: integer(raw.retryMs, 250, 120000, 'Retry delay'),
    cleanupConfirmedSegments: boolean(raw.cleanupConfirmedSegments),
    confirmMainnet: boolean(raw.confirmMainnet),
    overlay: {
      enabled: boolean(raw.overlay.enabled),
      title: text(raw.overlay.title, 64, 'Overlay title'),
      subtitle: text(raw.overlay.subtitle, 96, 'Overlay subtitle'),
      layout: raw.overlay.layout,
      accent: raw.overlay.accent.toLowerCase(),
      opacity: integer(raw.overlay.opacity, 10, 100, 'Overlay opacity'),
      showUtc: boolean(raw.overlay.showUtc),
      showNetwork: boolean(raw.overlay.showNetwork),
      showBlockNumber: boolean(raw.overlay.showBlockNumber),
      showBlockHash: boolean(raw.overlay.showBlockHash),
      showSegment: boolean(raw.overlay.showSegment),
      showStreamId: boolean(raw.overlay.showStreamId),
    },
  }
}

export function publicConfig(config) {
  if (!config) return null
  return {
    ...config,
    executionRpcUrl: config.executionRpcUrl ? '(configured)' : '',
    beaconRpcUrl: config.beaconRpcUrl ? '(configured)' : '',
    sendRpcUrls: config.sendRpcUrls?.length ? `${config.sendRpcUrls.length} fallback endpoint(s)` : '',
  }
}
