import crypto from 'node:crypto'

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
  return `{${entries.join(',')}}`
}

function endpointDigest(value) {
  if (!value) return null
  return sha256Text(new URL(value).href)
}

/** Build the explicit semantic payload authorized by a local arm ticket. */
export function publisherArmConsent(config) {
  return {
    schema: 'rfe/publisher-arm-consent@1',
    destination: {
      chain: config.chain,
      stationAddress: config.stationAddress.toLowerCase(),
      streamId: config.streamId,
    },
    source: {
      mode: config.sourceMode,
      sourcePathDigest: config.sourcePath ? sha256Text(config.sourcePath) : null,
      liveInputUrlDigest: config.liveInputUrl ? endpointDigest(config.liveInputUrl) : null,
      captureAudioDeviceDigest: config.captureAudioDevice ? sha256Text(config.captureAudioDevice) : null,
      captureTarget: config.captureTarget,
      captureRegion: [config.captureX, config.captureY, config.captureWidth, config.captureHeight],
    },
    endpoints: {
      executionRpcDigest: endpointDigest(config.executionRpcUrl),
      beaconRpcDigest: endpointDigest(config.beaconRpcUrl),
      sendRpcDigests: config.sendRpcUrls.map(endpointDigest),
    },
    media: {
      profile: config.profile,
      segmentMs: config.segmentMs,
      videoBitrateKbps: config.videoBitrateKbps,
      audioBitrateKbps: config.audioBitrateKbps,
      maxBlobs: config.maxBlobs,
      maxPending: config.maxPending,
      startupBufferSegments: config.startupBufferSegments,
      maxAheadSegments: config.maxAheadSegments,
      overlay: { ...config.overlay },
    },
    economics: {
      maxStreamCostEth: config.maxStreamCostEth,
      maxSegmentCostEth: config.maxSegmentCostEth,
      maxFeePerBlobGasGwei: config.maxFeePerBlobGasGwei || null,
      maxFeePerGasGwei: config.maxFeePerGasGwei || null,
      maxPriorityFeePerGasGwei: config.maxPriorityFeePerGasGwei || null,
      replaceAfterSeconds: config.replaceAfterSeconds,
      feeBumpPercent: config.feeBumpPercent,
      maxReplacements: config.maxReplacements,
      confirmationDepth: config.confirmationDepth,
      sendRetries: config.sendRetries,
      retryMs: config.retryMs,
    },
    lifecycle: {
      cleanupConfirmedSegments: config.cleanupConfirmedSegments,
      confirmMainnet: config.confirmMainnet,
    },
  }
}

export function publisherArmConsentDigest(config) {
  return sha256Text(canonicalJson(publisherArmConsent(config)))
}

export { canonicalJson }
