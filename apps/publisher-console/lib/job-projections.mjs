const MEDIA_FIELDS = Object.freeze([
  'sourcePath', 'sourceMode', 'liveInputUrl', 'captureAudioDevice', 'captureTarget',
  'captureX', 'captureY', 'captureWidth', 'captureHeight', 'streamId', 'chain',
  'stationAddress', 'executionRpcUrl', 'profile', 'segmentMs', 'videoBitrateKbps',
  'audioBitrateKbps', 'maxBlobs', 'maxAheadSegments', 'overlay',
])
const PUBLISHER_FIELDS = Object.freeze([
  'streamId', 'chain', 'stationAddress', 'executionRpcUrl', 'sendRpcUrls',
  'segmentMs', 'maxBlobs', 'maxPending', 'maxStreamCostEth',
  'maxSegmentCostEth', 'maxFeePerBlobGasGwei', 'maxFeePerGasGwei',
  'maxPriorityFeePerGasGwei', 'replaceAfterSeconds', 'feeBumpPercent',
  'maxReplacements', 'confirmationDepth', 'retryMs', 'confirmMainnet',
])

function select(config, fields) {
  return Object.fromEntries(fields.map((field) => [field, config[field]]))
}

export function mediaJobProjection(config, paths) {
  return {
    configSchema: 'rfe/publisher-media-job@1',
    ...select(config, MEDIA_FIELDS),
    segmentDir: paths.segmentDir,
    publisherProgressPath: paths.publisherProgressPath,
    startSequence: 0,
  }
}

export function transactionJobProjection(config, paths) {
  return {
    configSchema: 'rfe/publisher-transaction-job@1',
    ...select(config, PUBLISHER_FIELDS),
    segmentDir: paths.segmentDir,
    publisherStatePath: paths.publisherStatePath,
    publisherProgressPath: paths.publisherProgressPath,
    startSequence: 0,
  }
}

export { MEDIA_FIELDS, PUBLISHER_FIELDS }
