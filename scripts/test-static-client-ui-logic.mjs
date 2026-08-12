import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as identityRuntime from '../public/decentralized/static-client-core.js'
import * as ioRuntime from '../public/decentralized/static-client-io.js'
import * as mediaRuntime from '../public/decentralized/static-client-media.js'

const productionAppSource = fs.readFileSync(new URL('../public/decentralized/app.js', import.meta.url), 'utf8')
const productionHtmlSource = fs.readFileSync(new URL('../public/decentralized/index.html', import.meta.url), 'utf8')
const productionCssSource = fs.readFileSync(new URL('../public/decentralized/styles.css', import.meta.url), 'utf8')

function productionSlice(start, end) {
  const startIndex = productionAppSource.indexOf(start)
  const endIndex = productionAppSource.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `Missing production start marker: ${start}`)
  assert.notEqual(endIndex, -1, `Missing production end marker: ${end}`)
  return productionAppSource.slice(startIndex, endIndex)
}

function normalizeHex(value) {
  return String(value || '').toLowerCase()
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(left, right) {
  const a = relativeLuminance(left)
  const b = relativeLuminance(right)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const lightSelectedText = '#fffaff'
const lightSelectedBackground = '#8a2452'
const lightSelectedBoundary = '#17658f'
const lightControlBackground = '#f5f0f7'
assert.ok(contrastRatio(lightSelectedText, lightSelectedBackground) >= 4.5, 'light selected control text must meet WCAG AA contrast')
assert.ok(contrastRatio(lightSelectedBoundary, lightControlBackground) >= 3, 'light selected control boundary must meet non-text contrast')
assert.match(productionCssSource, /body\.light \.settings-tabs button\.active \{\s*border-color: #8a2452;\s*background: #8a2452;\s*color: #fffaff;/)
assert.match(productionCssSource, /body\.light \.chain-toggle button\.active \{\s*border-color: #8a2452;\s*background: #8a2452;\s*color: #fffaff;/)
assert.match(productionCssSource, /body\.light \.layout-presets button\.active,\s*body\.light \.endpoint-preset\.active \{\s*border-color: #17658f;/)
assert.match(productionCssSource, /\.empty-state strong,[\s\S]*?\.slot-error \{\s*min-width: 0;\s*overflow-wrap: anywhere;/)
assert.match(productionHtmlSource, /id="status-announcer"[^>]+role="status"[^>]+aria-live="polite"[^>]+aria-atomic="true"/)
assert.match(productionHtmlSource, /id="alert-announcer"[^>]+role="alert"[^>]+aria-live="assertive"[^>]+aria-atomic="true"/)
assert.doesNotMatch(productionHtmlSource, /id="status"[^>]+role="status"/)
assert.doesNotMatch(productionHtmlSource, /id="status-recovery"[^>]+role="status"/)

const statusWrites = { polite: [], assertive: [] }
const statusElements = {
  status: { textContent: '' },
  recoveryStatus: { textContent: '' },
  statusAnnouncer: { set textContent(value) { statusWrites.polite.push(value) } },
  alertAnnouncer: { set textContent(value) { statusWrites.assertive.push(value) } },
}
const statusRuntime = new Function('els', 'lastStatusAnnouncement', `${productionSlice('function announceStatus(', 'function runtimeSnapshot(')}; return { announceStatus, setStatus }`)(
  statusElements,
  { polite: '', assertive: '' },
)
statusRuntime.setStatus('Reading Station events...', { announce: false })
assert.equal(statusElements.status.textContent, 'Reading Station events...')
assert.equal(statusElements.recoveryStatus.textContent, 'Reading Station events...')
assert.deepEqual(statusWrites, { polite: [], assertive: [] })
statusRuntime.setStatus('Station retuned.', { announcementKey: 'retuned' })
statusRuntime.setStatus('Station retuned.', { announcementKey: 'retuned' })
assert.deepEqual(statusWrites.polite, ['Station retuned.'], 'identical semantic announcements must be deduplicated')
statusRuntime.setStatus('Playback blocked.', { assertive: true, announcementKey: 'playback-blocked' })
assert.deepEqual(statusWrites.assertive, ['Playback blocked.'])

const mediaErrorRuntime = new Function(`${productionSlice('function mediaErrorPresentation(', 'function playRecord(')}; return { mediaErrorPresentation }`)()
assert.deepEqual(mediaErrorRuntime.mediaErrorPresentation({ code: 3 }), {
  code: 'MEDIA_3',
  message: 'Local playback failed: the browser could not decode the verified media. Station programming has not been reclassified as fallback.',
})
assert.equal(mediaErrorRuntime.mediaErrorPresentation({ code: 4 }).code, 'MEDIA_4')
assert.equal(mediaErrorRuntime.mediaErrorPresentation({ code: 999 }).code, 'MEDIA_UNKNOWN')
const mediaEventSource = productionSlice("on(els.player, 'error'", "on(els.player, 'ended'")
assert.match(mediaEventSource, /state\.playbackMode = 'interrupted'/)
assert.match(mediaEventSource, /mediaErrorPresentation\(els\.player\.error\)/)
assert.match(mediaEventSource, /assertive: true/)
const staleMediaRuntime = new Function('state', 'els', `${productionSlice('function mediaEventMatchesCurrentRecord(', "on(els.player, 'waiting'")}; return { mediaEventMatchesCurrentRecord }`)(
  { currentRecordKey: 'new', objectUrls: new Map([['new', 'blob:new']]) },
  { player: { currentSrc: 'blob:old', src: 'blob:new' } },
)
assert.equal(staleMediaRuntime.mediaEventMatchesCurrentRecord(), false, 'a stale currentSrc event must not mutate the newly selected record')
const currentMediaRuntime = new Function('state', 'els', `${productionSlice('function mediaEventMatchesCurrentRecord(', "on(els.player, 'waiting'")}; return { mediaEventMatchesCurrentRecord }`)(
  { currentRecordKey: 'new', objectUrls: new Map([['new', 'blob:new']]) },
  { player: { currentSrc: 'blob:new', src: 'blob:new' } },
)
assert.equal(currentMediaRuntime.mediaEventMatchesCurrentRecord(), true)
assert.match(productionSlice('function playRecord(', 'function latestVerifiedRecord('), /Automatic playback did not start/)

const blobFeeSampleRuntime = new Function(`${productionSlice('function normalizeBlobFeeSample(', 'function loadBlobFeeSamples(')}; return { normalizeBlobFeeSample }`)()
const feeSampleTimestamp = Date.now()
assert.deepEqual(blobFeeSampleRuntime.normalizeBlobFeeSample({ timestamp: feeSampleTimestamp, baseFeePerBlobGasWei: '00042' }), {
  timestamp: feeSampleTimestamp,
  baseFeePerBlobGasWei: '42',
})
assert.equal(blobFeeSampleRuntime.normalizeBlobFeeSample({ timestamp: feeSampleTimestamp, baseFeePerBlobGasWei: (1n << 256n).toString() }), null)
assert.equal(blobFeeSampleRuntime.normalizeBlobFeeSample({ timestamp: feeSampleTimestamp, baseFeePerBlobGasWei: '9'.repeat(10_000) }), null)
const blobFeeLoadSource = productionSlice('function loadBlobFeeSamples(', 'function pruneBlobFeeSamples(')
assert.match(blobFeeLoadSource, /saved\.slice\(-BLOB_FEE_MAX_LOADED_SAMPLES\)/, 'persisted fee-sample hydration must cap input cardinality before normalization')
assert.doesNotMatch(productionAppSource, /const head = BigInt\((?:headHex|await rpc\('eth_blockNumber')/, 'provider head quantities must use the bounded JSON-RPC parser')

const cacheExportRuntime = new Function('publicUrlLabel', 'metadataScopeForConfig', 'normalizeHex', `${productionSlice('function exportableCacheRecord(', 'function exportIndex(')}; return { exportableCacheRecord, cacheIndexDocument }`)(
  (value) => {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  },
  identityRuntime.metadataScopeForConfig,
  normalizeHex,
)
const exportCredentialCanary = 'CACHE_EXPORT_SECRET_CANARY'
const exportPublisher = `0x${'ab'.repeat(20)}`
const exportStation = `0x${'cd'.repeat(20)}`
const exportConfig = {
  chainPreset: 'sepolia',
  chainId: '11155111',
  stationAddress: exportStation,
  publisher: exportPublisher,
  streamId: 'export-stream',
  streamIdHash: identityRuntime.canonicalStreamIdHash('export-stream'),
}
const exportScope = identityRuntime.metadataScopeForConfig(exportConfig)
const exportedCacheIndex = cacheExportRuntime.cacheIndexDocument([
  {
    ...exportScope,
    cacheKey: 'record-1',
    payload: new Uint8Array([1, 2, 3]),
    runtimeWriteToken: 'internal-write-token',
    archiveUrl: `https://user:${exportCredentialCanary}@archive.invalid/media?token=${exportCredentialCanary}`,
    source: 'archive',
  },
  {
    ...exportScope,
    stationAddress: `0x${'ef'.repeat(20)}`,
    cacheKey: 'cross-station-record',
  },
], exportConfig, '2026-07-11T00:00:00.000Z')
const exportedCacheJson = JSON.stringify(exportedCacheIndex)
assert.equal(exportedCacheIndex.schema, 'rfe-cache-index@2')
assert.equal(exportedCacheIndex.chainId, '11155111')
assert.equal(exportedCacheIndex.stationAddress, exportStation)
assert.equal(exportedCacheIndex.publisher, exportPublisher)
assert.equal(exportedCacheIndex.syntheticChannelId, exportScope.syntheticChannelId)
assert.equal(exportedCacheIndex.records.length, 1, 'current-channel export must exclude records from other Station deployments')
assert.equal(exportedCacheIndex.records[0].archiveSourceOrigin, 'https://archive.invalid')
assert.equal(Object.hasOwn(exportedCacheIndex.records[0], 'archiveUrl'), false)
assert.equal(Object.hasOwn(exportedCacheIndex.records[0], 'payload'), false)
assert.equal(Object.hasOwn(exportedCacheIndex.records[0], 'runtimeWriteToken'), false)
assert.doesNotMatch(exportedCacheJson, new RegExp(exportCredentialCanary))
assert.doesNotMatch(exportedCacheJson, /internal-write-token/)
const verifiedRecordSource = productionSlice('async function verifySegment(', 'function objectUrl(')
assert.match(verifiedRecordSource, /archiveSourceOrigin: result\.archiveUrl \? publicUrlLabel\(result\.archiveUrl\) : null/)
assert.doesNotMatch(verifiedRecordSource, /archiveUrl: result\.archiveUrl/)

function extractAddress(value) {
  return (
    String(value || '')
      .match(/0x[a-fA-F0-9]{40}/)?.[0]
      ?.toLowerCase() || ''
  )
}

function normalizeStationAddressInput(value) {
  const text = String(value || '')
  if (text.length > 2048) return ''
  const address = extractAddress(text)
  if (address) return address
  const trimmed = text.trim()
  return /^0x[a-fA-F0-9]{40}$/.test(trimmed) ? trimmed.toLowerCase() : ''
}

function extractTxHash(value) {
  return (
    String(value || '')
      .match(/0x[a-fA-F0-9]{64}/)?.[0]
      ?.toLowerCase() || ''
  )
}

function parseArchiveStationInput(value) {
  const raw = String(value || '').trim()
  const txHash = extractTxHash(raw)
  if (txHash && !/\/address\//i.test(raw)) return { kind: 'tx', address: '', txHash }
  const address = normalizeStationAddressInput(raw)
  if (address) return { kind: 'address', address, txHash: '' }
  return { kind: 'invalid', address: '', txHash: '' }
}

assert.throws(() => identityRuntime.canonicalStreamIdHash(''), /streamId is required/)
assert.equal(identityRuntime.canonicalStreamIdHash('hello'), '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8', 'browser identity must use Ethereum Keccak-256')

const publisherA = `0x${'11'.repeat(20)}`
const publisherB = `0x${'22'.repeat(20)}`
const collisionStreamId = 'publisher-collision'
const collisionStreamIdHash = identityRuntime.canonicalStreamIdHash(collisionStreamId)
const collisionBase = {
  publisher: publisherA,
  streamId: collisionStreamId,
  streamIdHash: collisionStreamIdHash,
  sequence: 0,
  txHash: `0x${'31'.repeat(32)}`,
  payloadSha256Hex: `0x${'41'.repeat(32)}`,
  payloadSha256: '41'.repeat(32),
  previousSegmentHash: `0x${'00'.repeat(32)}`,
}
const publisherCollision = {
  ...collisionBase,
  publisher: publisherB,
  txHash: `0x${'32'.repeat(32)}`,
}
assert.notEqual(identityRuntime.segmentIdentityKey(collisionBase), identityRuntime.segmentIdentityKey(publisherCollision))
const ambiguousChannel = identityRuntime.selectPublisherScopedChannel([collisionBase, publisherCollision], { streamId: collisionStreamId })
assert.equal(ambiguousChannel.status, 'ambiguous')
assert.equal(ambiguousChannel.segments.length, 0, 'ambiguous publisher selection must load nothing')
assert.deepEqual(ambiguousChannel.publishers, [publisherA, publisherB])
const selectedPublisher = identityRuntime.selectPublisherScopedChannel([collisionBase, publisherCollision], {
  streamId: collisionStreamId,
  publisher: publisherB,
})
assert.equal(selectedPublisher.status, 'selected')
assert.equal(selectedPublisher.publisher, publisherB)
assert.equal(selectedPublisher.segments.length, 1)
const singlePublisherBinding = identityRuntime.selectPublisherScopedChannel([collisionBase], { streamId: collisionStreamId })
assert.equal(singlePublisherBinding.status, 'selected')
assert.equal(singlePublisherBinding.publisher, publisherA, 'one discovered publisher may be bound explicitly')
assert.throws(
  () =>
    identityRuntime.channelIdentity({
      ...collisionBase,
      streamIdHash: `0x${'99'.repeat(32)}`,
    }),
  /does not match streamId/,
)

const bindingState = {
  config: {
    stationAddress: `0x${'60'.repeat(20)}`,
    publisher: '',
    streamId: collisionStreamId,
    streamIdHash: collisionStreamIdHash,
  },
}
let bindingSource = [collisionBase]
let publisherSyncs = 0
const bindingRuntime = new Function('state', 'fetchSegmentLogsForStation', 'selectPublisherScopedChannel', 'canonicalStreamIdHash', 'saveConfig', 'shortHash', `${productionSlice('async function fetchSegmentLogs(', 'async function fetchSegmentLogsForStation(')}; return { fetchSegmentLogs }`)(
  bindingState,
  async () => bindingSource,
  identityRuntime.selectPublisherScopedChannel,
  identityRuntime.canonicalStreamIdHash,
  () => {
    publisherSyncs += 1
  },
  (value) => value,
)
await assert.rejects(bindingRuntime.fetchSegmentLogs(1n, 2n), /will not trust it automatically/)
assert.equal(bindingState.config.publisher, '', 'a sole discovery window must remain untrusted')
assert.equal(publisherSyncs, 0)
bindingState.config.publisher = publisherA
assert.equal((await bindingRuntime.fetchSegmentLogs(1n, 2n)).length, 1, 'explicit publisher may load its channel')
bindingState.config.publisher = ''
bindingSource = [collisionBase, publisherCollision]
await assert.rejects(bindingRuntime.fetchSegmentLogs(1n, 2n), /Publisher is required/)
assert.equal(bindingState.config.publisher, '', 'ambiguous discovery must not bind a publisher')
assert.equal(publisherSyncs, 0)

const payloadA = `0x${'a1'.repeat(32)}`
const payloadB = `0x${'b2'.repeat(32)}`
const payloadC = `0x${'c3'.repeat(32)}`
const payloadD = `0x${'d4'.repeat(32)}`
const continuityBase = {
  publisher: publisherA,
  streamId: 'continuity-browser',
  streamIdHash: identityRuntime.canonicalStreamIdHash('continuity-browser'),
  txHash: `0x${'51'.repeat(32)}`,
}
const continuityRecords = identityRuntime.annotateStreamContinuity([
  {
    ...continuityBase,
    sequence: 0,
    payloadSha256Hex: payloadA,
    previousSegmentHash: `0x${'00'.repeat(32)}`,
    payloadValidity: 'invalid',
  },
  {
    ...continuityBase,
    sequence: 1,
    payloadSha256Hex: payloadB,
    previousSegmentHash: payloadA,
  },
  {
    ...continuityBase,
    sequence: 2,
    payloadSha256Hex: payloadC,
    previousSegmentHash: `0x${'ee'.repeat(32)}`,
  },
  {
    ...continuityBase,
    sequence: 3,
    payloadSha256Hex: payloadD,
    previousSegmentHash: payloadC,
  },
])
assert.deepEqual(
  continuityRecords.map((segment) => segment.continuity.status),
  ['valid', 'valid', 'invalid', 'invalid'],
)
assert.equal(continuityRecords[0].continuity.reason, 'root')
assert.equal(continuityRecords[0].payloadValidity, 'invalid', 'payload validity must remain independent from continuity')
assert.equal(continuityRecords[1].continuity.reason, 'matching-predecessor')
assert.equal(continuityRecords[2].continuity.reason, 'predecessor-mismatch')
assert.equal(continuityRecords[3].continuity.reason, 'invalid-ancestry')
const gapRecords = identityRuntime.annotateStreamContinuity([
  {
    ...continuityBase,
    publisher: publisherB,
    sequence: 5,
    payloadSha256Hex: payloadC,
    previousSegmentHash: payloadB,
  },
  {
    ...continuityBase,
    publisher: publisherB,
    sequence: 6,
    payloadSha256Hex: payloadD,
    previousSegmentHash: payloadC,
  },
])
assert.deepEqual(
  gapRecords.map((segment) => segment.continuity.status),
  ['unknown', 'unknown'],
)
assert.equal(gapRecords[0].continuity.reason, 'missing-predecessor')
assert.equal(gapRecords[1].continuity.reason, 'unknown-ancestry')
assert.equal(identityRuntime.segmentContinuityPresentation(gapRecords[0]).suffix, ' · ?')
const missingLinkRecords = identityRuntime.annotateStreamContinuity([
  {
    ...continuityBase,
    publisher: publisherB,
    streamId: 'legacy-browser',
    streamIdHash: identityRuntime.canonicalStreamIdHash('legacy-browser'),
    sequence: 0,
    payloadSha256Hex: payloadA,
  },
])
assert.equal(missingLinkRecords[0].continuity.status, 'unknown')
assert.equal(missingLinkRecords[0].continuity.reason, 'missing-link-metadata')
const quarantinePresentation = identityRuntime.segmentContinuityPresentation(continuityRecords[2])
assert.equal(quarantinePresentation.quarantined, true)
assert.equal(quarantinePresentation.action, 'QUARANTINED')
assert.throws(() => identityRuntime.assertPlayableContinuity(continuityRecords[2]), /quarantined/)
assert.equal(identityRuntime.assertPlayableContinuity(gapRecords[0]), true, 'partial windows must remain playable after payload verification')

const loadedValid = {
  ...identityRuntime.withChannelIdentity(collisionBase),
  cacheKey: identityRuntime.segmentIdentityKey(collisionBase),
  continuity: { status: 'valid', reason: 'root' },
  quarantined: false,
}
const loadedInvalid = {
  ...identityRuntime.withChannelIdentity({
    ...collisionBase,
    sequence: 1,
    txHash: `0x${'33'.repeat(32)}`,
  }),
  cacheKey: identityRuntime.segmentIdentityKey({
    ...collisionBase,
    sequence: 1,
    txHash: `0x${'33'.repeat(32)}`,
  }),
  continuity: { status: 'invalid', reason: 'predecessor-mismatch' },
  quarantined: true,
}
const foreignLoaded = {
  ...identityRuntime.withChannelIdentity(publisherCollision),
  cacheKey: identityRuntime.segmentIdentityKey(publisherCollision),
  continuity: { status: 'valid', reason: 'root' },
  quarantined: false,
  sequence: 99,
}
const membershipState = {
  config: {
    publisher: publisherA,
    streamIdHash: collisionStreamIdHash,
    streamId: collisionStreamId,
  },
  segments: [loadedValid, loadedInvalid],
  verified: new Map(),
}
const membershipRuntime = new Function(
  'state',
  'channelIdentity',
  'segmentIsQuarantined',
  'assertPlayableContinuity',
  'segmentIdentityKey',
  'normalizeHex',
  `${productionSlice('function configuredChannelKey(', 'function parseArchiveStationInput(')}
   ${productionSlice('function latestVerifiedRecord(', 'function orderedLoadedSegments(')}
   return { currentLoadedSegment, assertCurrentLoadedSegment, promoteVerifiedRecord, latestVerifiedRecord, firstVerifiedRecord, nextVerifiedRecord }`,
)(membershipState, identityRuntime.channelIdentity, identityRuntime.segmentIsQuarantined, identityRuntime.assertPlayableContinuity, identityRuntime.segmentIdentityKey, normalizeHex)
membershipState.verified.set(loadedValid.cacheKey, loadedValid)
membershipState.verified.set(loadedInvalid.cacheKey, loadedInvalid)
membershipState.verified.set(foreignLoaded.cacheKey, foreignLoaded)
assert.equal(membershipRuntime.latestVerifiedRecord().cacheKey, loadedValid.cacheKey, 'latest/autoplay must ignore invalid descendants and foreign channels')
assert.equal(membershipRuntime.firstVerifiedRecord().cacheKey, loadedValid.cacheKey)
assert.equal(membershipRuntime.currentLoadedSegment(foreignLoaded), null, 'archive/live contamination must not join the loaded channel')
assert.throws(() => membershipRuntime.assertCurrentLoadedSegment(loadedInvalid), /currently loaded|quarantined/)
const membershipPlaybackRuntime = new Function('state', 'runtimeSnapshot', 'runtimeIsCurrent', 'assertCurrentLoadedSegment', `${productionSlice('function playRecord(', 'function latestVerifiedRecord(')}; return { playRecord }`)(
  membershipState,
  () => ({}),
  () => true,
  membershipRuntime.assertCurrentLoadedSegment,
)
assert.throws(() => membershipPlaybackRuntime.playRecord(foreignLoaded, {}, {}), /currently loaded/, 'manual playback must reject a verified-map record from another publisher channel')

let cachedPayload = new Uint8Array([1, 2, 3])
let deletedTamperedPayloads = 0
let rejectCachedHash = false
const cacheValidationRuntime = new Function('runtimeSnapshot', 'requireCurrentRuntime', 'assertCurrentLoadedSegment', 'cachedSegment', 'segmentPayloadLength', 'cachedPayloadBytes', 'verifyPayloadHash', 'deleteCachedSegment', `${productionSlice('async function validatedCachedSegment(', 'async function hydrateValidatedCachedSegments(')}; return { validatedCachedSegment }`)(
  () => ({}),
  () => {},
  membershipRuntime.assertCurrentLoadedSegment,
  async () => ({ cacheKey: loadedValid.cacheKey, payload: cachedPayload }),
  () => 3,
  async (payload) => payload,
  async () => {
    if (rejectCachedHash) throw new Error('SHA-256 mismatch')
  },
  async () => {
    deletedTamperedPayloads += 1
  },
)
const boundCacheRecord = await cacheValidationRuntime.validatedCachedSegment(loadedValid, {})
assert.equal(boundCacheRecord.channelKey, loadedValid.channelKey)
assert.equal(boundCacheRecord.continuity.status, 'valid')
rejectCachedHash = true
await assert.rejects(cacheValidationRuntime.validatedCachedSegment(loadedValid, {}), /SHA-256 mismatch/)
assert.equal(deletedTamperedPayloads, 1, 'tampered cache payload must be deleted')
rejectCachedHash = false
cachedPayload = new Uint8Array([1, 2])
await assert.rejects(cacheValidationRuntime.validatedCachedSegment(loadedValid, {}), /length mismatch/)
assert.equal(deletedTamperedPayloads, 2)
cachedPayload = new Uint8Array([1, 2, 3])
membershipState.segments = [
  {
    ...loadedValid,
    continuity: { status: 'invalid', reason: 'invalid-ancestry' },
    quarantined: true,
  },
]
await assert.rejects(cacheValidationRuntime.validatedCachedSegment(loadedValid, {}), /currently loaded|quarantined/)
membershipState.segments = [loadedValid, loadedInvalid]
assert.doesNotMatch(productionSlice('async function scanBlobInboxStreams(', 'async function tuneArchiveStream('), /state\.verified\.set/, 'inbox discovery must remain archive-scoped until explicit tune')
for (const [start, end] of [
  ['async function tuneArchiveStream(', 'function tuneToStream('],
  ['async function loadForwardWindowFromTx(', 'async function segmentSlot('],
  ['async function refresh()', 'function startStreaming('],
  ['async function verifySegment(', 'function objectUrl('],
]) {
  const slice = productionSlice(start, end)
  assert.doesNotMatch(slice, /await cachedSegment\(/, `${start} must not hydrate cache without validation`)
}

const favoriteRuntime = identityRuntime
const { normalizeFavoriteItem, normalizeFavorites } = favoriteRuntime
const groupingRuntime = identityRuntime
assert.deepEqual(
  [
    identityRuntime.slotJumpAccessibleName(100, 7),
    identityRuntime.slotJumpAccessibleName(101, 8),
  ],
  ['Jump to stream segment #7 from slot 100', 'Jump to stream segment #8 from slot 101'],
)
assert.deepEqual(
  [
    identityRuntime.segmentActionAccessibleName({ sequence: 7, cached: true }),
    identityRuntime.segmentActionAccessibleName({ sequence: 8 }),
  ],
  ['Play segment #7', 'Fetch segment #8'],
  'repeated segment actions must expose distinct target-specific names',
)
const { groupOldStreamsFromSegmentPublishedLogs } = groupingRuntime
const productionFavorite = favoriteRuntime.normalizeFavoriteItem({
  type: 'stream',
  chainId: '11155111',
  stationAddress: `0x${'61'.repeat(20)}`,
  publisher: publisherB,
  streamId: collisionStreamId,
  streamIdHash: collisionStreamIdHash,
})
assert.equal(productionFavorite.publisher, publisherB)
assert.equal(productionFavorite.streamIdHash, collisionStreamIdHash)
assert.equal(
  favoriteRuntime.normalizeFavoriteItem({
    ...productionFavorite,
    streamIdHash: `0x${'ff'.repeat(32)}`,
  }),
  null,
  'favorite migration must reject a mismatched claimed stream hash',
)
const whitespaceStreamId = '  exact channel id  '
const whitespaceFavorite = normalizeFavoriteItem({
  type: 'stream',
  chainId: '11155111',
  stationAddress: `0x${'61'.repeat(20)}`,
  publisher: publisherA,
  streamId: whitespaceStreamId,
  streamIdHash: identityRuntime.canonicalStreamIdHash(whitespaceStreamId),
})
assert.equal(whitespaceFavorite.streamId, whitespaceStreamId)
assert.equal(normalizeFavorites(JSON.parse(JSON.stringify([whitespaceFavorite])))[0].streamId, whitespaceStreamId, 'favorites must round-trip exact raw stream IDs')

const sharedFavoriteLabel = 'Shared station'
const sameLabelFavoriteNames = [
  normalizeFavoriteItem({ type: 'station', chainId: '11155111', stationAddress: `0x${'11'.repeat(20)}`, label: sharedFavoriteLabel }),
  normalizeFavoriteItem({ type: 'station', chainId: '11155111', stationAddress: `0x${'22'.repeat(20)}`, label: sharedFavoriteLabel }),
].map((favorite) => identityRuntime.favoriteAccessibleName(favorite, sharedFavoriteLabel))
assert.equal(new Set(sameLabelFavoriteNames).size, 2, 'same-label favorites must have identity-scoped accessible names')
assert.ok(sameLabelFavoriteNames.every((name) => name.startsWith(`${sharedFavoriteLabel}; station 0x`)))

const sameTitleArchiveNames = [
  { title: 'Shared archive', publisher: `0x${'33'.repeat(20)}`, streamIdHash: `0x${'44'.repeat(32)}` },
  { title: 'Shared archive', publisher: `0x${'55'.repeat(20)}`, streamIdHash: `0x${'44'.repeat(32)}` },
].map(identityRuntime.archiveStreamAccessibleName)
assert.equal(new Set(sameTitleArchiveNames).size, 2, 'same-title archive streams from different publishers must have identity-scoped accessible names')
assert.ok(sameTitleArchiveNames.every((name) => name.startsWith('Shared archive; publisher 0x')))

const archiveResultsElement = { innerHTML: '' }
const archiveRenderState = {
  config: { stationAddress: `0x${'66'.repeat(20)}` },
  archive: {
    mode: 'station',
    tunedKey: '',
    streams: sameTitleArchiveNames.map((_, index) => ({
      key: `archive-${index}`,
      title: 'Shared archive',
      publisher: index ? `0x${'55'.repeat(20)}` : `0x${'33'.repeat(20)}`,
      streamIdHash: `0x${'44'.repeat(32)}`,
      segmentCount: 1,
      firstSequence: index,
      latestSequence: index,
      firstBlock: 100 + index,
      latestBlock: 100 + index,
    })),
  },
}
const renderArchive = new Function('state', 'els', 'renderArchiveMode', 'escapeHtml', 'shortHash', 'archiveStreamAccessibleName', `${productionSlice('function renderArchive()', 'function renderArchiveMode()')}; return renderArchive`)(
  archiveRenderState,
  { archiveResults: archiveResultsElement, archiveStation: { value: '' } },
  () => {},
  (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;'),
  (value) => value,
  identityRuntime.archiveStreamAccessibleName,
)
renderArchive()
for (const [surface, pattern] of [
  ['regions', /<section[^>]+aria-label="([^"]+)"/g],
  ['Watch actions', /data-archive-action="tune" aria-label="([^"]+)"/g],
  ['Save actions', /data-archive-action="save" aria-label="([^"]+)"/g],
]) {
  const names = [...archiveResultsElement.innerHTML.matchAll(pattern)].map((match) => match[1])
  assert.equal(names.length, 2, `archive ${surface} fixture should render both streams`)
  assert.equal(new Set(names).size, 2, `same-title archive ${surface} should identify the publisher-scoped stream`)
}

const tuneState = {
  config: {
    publisher: publisherA,
    streamId: collisionStreamId,
    streamIdHash: collisionStreamIdHash,
  },
}
let savedTuneConfig = null
const tuneRuntime = new Function('state', 'channelIdentity', 'canonicalStreamIdHash', 'saveConfig', 'fillForm', 'resetRuntimeState', 'render', 'setStatus', 'shortHash', `${productionSlice('function tuneToStream(', 'async function hydrateSegmentTimes(')}; return { tuneToStream }`)(
  tuneState,
  identityRuntime.channelIdentity,
  identityRuntime.canonicalStreamIdHash,
  (config) => {
    savedTuneConfig = { ...config }
  },
  () => {},
  () => {},
  () => {},
  () => {},
  (value) => value,
)
assert.equal(tuneRuntime.tuneToStream(publisherCollision, { reset: false }), true)
assert.equal(tuneState.config.publisher, publisherB, 'same raw stream ID must retune when publisher changes explicitly')
assert.equal(savedTuneConfig.publisher, publisherB)
assert.equal(tuneRuntime.tuneToStream(publisherCollision, { reset: false }), false, 'identical full channel identity should not retune')

const continuityRuntimeState = {
  verified: new Map(),
  prefetchPromises: new Map(),
  prefetching: new Set(),
}
const playbackContinuityRuntime = new Function('state', 'runtimeSnapshot', 'runtimeIsCurrent', 'assertCurrentLoadedSegment', `${productionSlice('function playRecord(', 'function latestVerifiedRecord(')}; return { playRecord }`)(
  continuityRuntimeState,
  () => ({}),
  () => true,
  identityRuntime.assertPlayableContinuity,
)
assert.throws(() => playbackContinuityRuntime.playRecord(continuityRecords[2], {}, {}), /quarantined/, 'production playback must reject invalid continuity before creating media state')
const prefetchContinuityRuntime = new Function('state', 'runtimeSnapshot', 'runtimeIsCurrent', 'currentLoadedSegment', `${productionSlice('async function prefetchSegment(', 'function prefetchWindow(')}; return { prefetchSegment }`)(
  continuityRuntimeState,
  () => ({}),
  () => true,
  () => null,
)
assert.equal(await prefetchContinuityRuntime.prefetchSegment(continuityRecords[2], {}), null)

const parseRfe1Envelope = new Function('normalizeStationAddressInput', 'IO_MAX_ABI_STRING_BYTES', 'canonicalStreamIdHash', 'isBytes32Hex', 'normalizeHex', 'strip0x', `${productionSlice('function parseRfe1Envelope(', 'async function blockBlobTransactions(')}; return { parseRfe1Envelope }`)(
  normalizeStationAddressInput,
  4_096,
  identityRuntime.canonicalStreamIdHash,
  identityRuntime.isBytes32Hex,
  normalizeHex,
  ioRuntime.strip0x,
).parseRfe1Envelope

const BLOB_GAS_PER_BLOB = 131_072n
const MAX_BLOBS_PER_BLOCK = 21
const TARGET_BLOBS_PER_BLOCK = 14
const WEI_PER_GWEI = 1_000_000_000n
const WEI_PER_ETH = 1_000_000_000_000_000_000n
const BLOB_FEE_HISTORY_CHUNK_BLOCKS = 1024
const BLOB_FEE_HISTORY_WINDOWS = {
  tenMinute: { blocks: 50, cacheMs: 90_000 },
  hour: { blocks: 300, cacheMs: 3 * 60_000 },
  day: { blocks: 7200, cacheMs: 20 * 60_000 },
  week: { blocks: 50400, cacheMs: 60 * 60_000 },
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

function normalizeLayoutSettings(value) {
  const fallback = defaultLayoutSettings()
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const next = { bottomSpan: input.bottomSpan === 'full' ? 'full' : 'between' }
  for (const panel of ['player', 'feeds', 'archive', 'blobFees']) {
    const config = input[panel] && typeof input[panel] === 'object' ? input[panel] : fallback[panel]
    const position = ['left', 'main', 'right', 'bottom'].includes(config.position) ? config.position : fallback[panel].position
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

function rpcQuantityBigInt(value, label) {
  return ioRuntime.rpcQuantity(value, label)
}

function blobFeeWei(baseFeePerBlobGasWei) {
  return BigInt(baseFeePerBlobGasWei) * BLOB_GAS_PER_BLOB
}

function formatGweiFromWei(value) {
  const wei = typeof value === 'bigint' ? value : BigInt(value)
  const whole = wei / WEI_PER_GWEI
  const fraction = (wei % WEI_PER_GWEI).toString().padStart(9, '0').slice(0, 4).replace(/0+$/, '')
  return `${whole.toString()}${fraction ? `.${fraction}` : ''} Gwei`
}

function formatEthFromWei(value) {
  const wei = typeof value === 'bigint' ? value : BigInt(value)
  const whole = wei / WEI_PER_ETH
  const fraction = (wei % WEI_PER_ETH).toString().padStart(18, '0').slice(0, 8).replace(/0+$/, '')
  return `${whole.toString()}${fraction ? `.${fraction}` : ''} ETH`
}

function fmtUtcClock(date = new Date()) {
  return `${date.toISOString().slice(11, 19)} UTC`
}

function fmtClockWithPrefs(date, clock) {
  if (clock.mode === 'local') {
    return `${new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)} local`
  }
  if (clock.mode === 'timezone' && clock.timeZone) {
    try {
      return `${new Intl.DateTimeFormat([], {
        timeZone: clock.timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date)} ${clock.timeZone}`
    } catch {
      return fmtUtcClock(date)
    }
  }
  return fmtUtcClock(date)
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

function averageBigInts(values) {
  const usable = values.filter((value) => typeof value === 'bigint' && value > 0n)
  if (!usable.length) return null
  return usable.reduce((sum, value) => sum + value, 0n) / BigInt(usable.length)
}

function percentileBigInt(values, percentile) {
  const usable = values.filter((value) => typeof value === 'bigint' && value > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (!usable.length) return null
  const index = Math.min(usable.length - 1, Math.max(0, Math.ceil((percentile / 100) * usable.length) - 1))
  return usable[index]
}

function blobFeeHistoryValues(response) {
  const fees = Array.isArray(response?.baseFeePerBlobGas) ? response.baseFeePerBlobGas : null
  if (!fees) throw new Error('eth_feeHistory response missing baseFeePerBlobGas')
  const ratios = Array.isArray(response?.blobGasUsedRatio) ? response.blobGasUsedRatio : []
  if (fees.length > BLOB_FEE_HISTORY_CHUNK_BLOCKS + 1) throw new Error('eth_feeHistory baseFeePerBlobGas exceeds the requested chunk bound')
  if (ratios.length > BLOB_FEE_HISTORY_CHUNK_BLOCKS) throw new Error('eth_feeHistory blobGasUsedRatio exceeds the requested chunk bound')
  return {
    baseFees: fees.map((value) => rpcQuantityBigInt(value, 'baseFeePerBlobGas')).filter((value) => value > 0n),
    utilization: ratios.filter((value) => typeof value === 'number').filter((value) => Number.isFinite(value) && value >= 0 && value <= 1),
    oldestBlock: response.oldestBlock ? rpcQuantityBigInt(response.oldestBlock, 'feeHistory oldestBlock') : null,
  }
}

async function fetchBlobFeeHistory(blocks, rpc) {
  const baseFees = []
  const utilization = []
  let newestBlock = 'latest'
  let remaining = blocks
  while (remaining > 0) {
    const chunk = Math.min(remaining, BLOB_FEE_HISTORY_CHUNK_BLOCKS)
    const response = await rpc('eth_feeHistory', [`0x${BigInt(chunk).toString(16)}`, newestBlock, []])
    const parsed = blobFeeHistoryValues(response)
    baseFees.push(...parsed.baseFees)
    utilization.push(...parsed.utilization)
    if (!parsed.oldestBlock || parsed.oldestBlock === 0n) break
    newestBlock = `0x${(parsed.oldestBlock - 1n).toString(16)}`
    remaining -= chunk
  }
  return { baseFees, utilization }
}

async function refreshBlobFeeWindow(key, state, rpc) {
  const windowConfig = BLOB_FEE_HISTORY_WINDOWS[key]
  try {
    const history = await fetchBlobFeeHistory(windowConfig.blocks, rpc)
    const average = averageBigInts(history.baseFees)
    if (average == null) throw new Error('No blob fee samples returned')
    const next = {
      status: 'ok',
      averageWei: average.toString(),
      percentile75Wei: percentileBigInt(history.baseFees, 75)?.toString() || '',
      sampleBlocks: history.utilization.length,
      blobCount: Math.round(history.utilization.reduce((sum, value) => sum + value * MAX_BLOBS_PER_BLOCK, 0)),
      utilization: history.utilization.length ? history.utilization.reduce((sum, value) => sum + value, 0) / history.utilization.length : null,
    }
    state.history[key] = next
    return next
  } catch (error) {
    const next = {
      status: 'limited',
      message: key === 'day' || key === 'week' ? 'provider limited' : error.message,
    }
    state.history[key] = next
    return next
  }
}

assert.equal(normalizeStationAddressInput('https://sepolia.etherscan.io/address/0x060c51D481808B506dfae72f054F39e11E4f4017'), '0x060c51d481808b506dfae72f054f39e11e4f4017')
assert.equal(normalizeStationAddressInput('0xnot-an-address'), '')
assert.equal(normalizeStationAddressInput(`https://example.invalid/${'x'.repeat(3_000)}/0x0000000000000000000000000000000000000001`), '', 'oversized address input must reject before scanning')
assert.equal(identityRuntime.isBytes32Hex(`0x${'1'.repeat(64)}`), true)
assert.equal(identityRuntime.isBytes32Hex(`0x${'1'.repeat(64)}${'f'.repeat(10_000)}`), false)
assert.equal(ioRuntime.isBytes48Hex(`0x${'2'.repeat(96)}`), true)
assert.equal(ioRuntime.isBytes48Hex(`0x${'2'.repeat(96)}${'f'.repeat(10_000)}`), false)

const lookupRuntime = new Function('MAX_LOOKUP_INPUT_CODE_UNITS', 'MAX_LOOKUP_DECIMAL_DIGITS', 'normalizeHex', 'shortHash', `${productionSlice('function extractTxHash(', 'function updateLookupMessage(')}; return { extractTxHash, parseLookupInput }`)(
  2048,
  78,
  normalizeHex,
  (value) => value,
)
const lookupHash = `0x${'4'.repeat(64)}`
assert.equal(lookupRuntime.extractTxHash(`https://example.invalid/tx/${lookupHash}`), lookupHash)
assert.equal(lookupRuntime.extractTxHash(`https://example.invalid/${'x'.repeat(3_000)}/${lookupHash}`), '', 'oversized transaction lookup must reject before regex scanning')
assert.deepEqual(lookupRuntime.parseLookupInput(`https://example.invalid/${'x'.repeat(3_000)}/${lookupHash}`), {
  kind: 'invalid',
  valid: false,
  query: '',
  message: 'Lookup input exceeds 2,048 characters.',
})
assert.equal(lookupRuntime.parseLookupInput('9'.repeat(78)).kind, 'number')
assert.equal(lookupRuntime.parseLookupInput('9'.repeat(79)).kind, 'invalid', 'decimal lookup must reject above uint256 display width')
assert.equal(lookupRuntime.parseLookupInput(`https://example.invalid/block/${'9'.repeat(79)}`).kind, 'invalid')

const boundedStreamRuntime = new Function('IO_MAX_ABI_STRING_BYTES', `${productionSlice('function boundedStreamId(', 'function safeJsonObject(')}; return { boundedStreamId }`)(4_096)
assert.equal(boundedStreamRuntime.boundedStreamId('é'.repeat(2_048)), 'é'.repeat(2_048))
assert.throws(() => boundedStreamRuntime.boundedStreamId('é'.repeat(2_049)), /4,096 UTF-8 bytes/, 'configured identities must enforce the decoder byte ceiling')

const stationLogRuntime = new Function('isBytes32Hex', 'normalizeHex', 'EVENT_TOPIC', 'MAX_STATION_LOG_DATA_BYTES', 'isByteHex', `${productionSlice('function assertSegmentLogShape(', 'function decodeSegmentLog(')}; return { assertSegmentLogShape }`)(
  identityRuntime.isBytes32Hex,
  normalizeHex,
  '0xfd61253da387da4d87d036a0276340bc4f04ff7c1173999c8392b158030f04c3',
  16 * 1024,
  ioRuntime.isByteHex,
)
const validLogHash = `0x${'3'.repeat(64)}`
assert.throws(() => stationLogRuntime.assertSegmentLogShape({
  topics: ['0xfd61253da387da4d87d036a0276340bc4f04ff7c1173999c8392b158030f04c3', validLogHash, validLogHash, validLogHash],
  data: `0x${'00'.repeat((16 * 1024) + 1)}`,
  transactionHash: validLogHash,
  blockHash: validLogHash,
}), /ABI data exceeds 16384 bytes/, 'oversized Station ABI data must reject at its byte ceiling')
assert.deepEqual(parseArchiveStationInput('https://etherscan.io/address/0x0000000000000000000000000000000000000001'), {
  kind: 'address',
  address: '0x0000000000000000000000000000000000000001',
  txHash: '',
})
assert.deepEqual(parseArchiveStationInput(`https://etherscan.io/tx/0x${'f'.repeat(64)}`), {
  kind: 'tx',
  address: '',
  txHash: `0x${'f'.repeat(64)}`,
})

const favorites = normalizeFavorites([
  {
    type: 'station',
    chainId: '1',
    stationAddress: '0x0000000000000000000000000000000000000001',
  },
  {
    type: 'channel',
    chainId: '1',
    stationAddress: '0x0000000000000000000000000000000000000001',
    publisher: '0x0000000000000000000000000000000000000002',
  },
  {
    type: 'stream',
    chainId: '1',
    stationAddress: '0x0000000000000000000000000000000000000001',
    publisher: '0x0000000000000000000000000000000000000002',
    streamId: 'rfe-mainnet-live',
    streamIdHash: identityRuntime.canonicalStreamIdHash('rfe-mainnet-live'),
    firstBlock: 10,
    latestBlock: 20,
  },
  {
    type: 'inbox-stream',
    chainId: '1',
    inboxAddress: '0x0000000000000000000000000000000000000003',
    publisher: '0x0000000000000000000000000000000000000002',
    streamId: 'rfe-inbox-live',
  },
  {
    type: 'stream',
    chainId: '1',
    stationAddress: '0x0000000000000000000000000000000000000001',
    streamId: 'missing-publisher',
  },
])
assert.equal(favorites.length, 4)
const crossChainFavorites = normalizeFavorites([
  { type: 'station', chainId: '1', stationAddress: '0x0000000000000000000000000000000000000001' },
  { type: 'station', chainId: '11155111', stationAddress: '0x0000000000000000000000000000000000000001' },
  { type: 'station', stationAddress: '0x0000000000000000000000000000000000000001' },
])
assert.equal(crossChainFavorites.length, 2, 'same-address favorites on distinct chains must not collide')
assert.notEqual(crossChainFavorites[0].id, crossChainFavorites[1].id)
assert.equal(crossChainFavorites.some((favorite) => !favorite.chainId), false, 'ambiguous legacy favorites must not be assigned to the active chain')
assert.equal(normalizeFavoriteItem({
  type: 'stream',
  chainId: '1',
  stationAddress: '0x0000000000000000000000000000000000000001',
  publisher: '0x0000000000000000000000000000000000000002',
  streamId: 'x'.repeat(4_097),
}), null, 'oversized persisted stream IDs must be rejected before hashing')
assert.throws(() => identityRuntime.channelIdentity({
  publisher: '0x0000000000000000000000000000000000000002',
  streamId: 'é'.repeat(2_049),
}), /4096 UTF-8 bytes/, 'channel identity must share the decoder UTF-8 byte ceiling')
assert.equal(normalizeFavoriteItem({
  type: 'station',
  chainId: '1',
  stationAddress: 'x'.repeat(10_000),
}), null, 'oversized persisted address inputs must be rejected before scanning')
const boundedFavorites = normalizeFavorites(Array.from({ length: 300 }, (_, index) => ({
  type: 'station',
  chainId: '1',
  stationAddress: `0x${index.toString(16).padStart(40, '0')}`,
})))
assert.equal(boundedFavorites.length, 256, 'favorite hydration must be cardinality bounded')
const normalizedFavoriteMetadata = normalizeFavoriteItem({
  type: 'station',
  chainId: '1',
  stationAddress: '0x0000000000000000000000000000000000000001',
  firstBlock: '10',
  latestBlock: '20',
  createdAt: '2026-07-11T12:34:56-04:00',
})
assert.equal(normalizedFavoriteMetadata.firstBlock, null, 'archive range metadata must retain numeric types')
assert.equal(normalizedFavoriteMetadata.createdAt, '2026-07-11T16:34:56.000Z')

const favoriteTuneState = {
  config: { chainPreset: 'sepolia', chainId: '11155111', streamId: 'old-chain-stream' },
  archive: { mode: 'inbox', streams: [{ key: 'stale-chain-result' }], segmentsByKey: new Map([['stale-chain-result', []]]), tunedKey: 'stale-chain-result', tuneSerial: 0, progress: null },
  playbackContextGeneration: 0,
  segmentNotice: '',
}
const favoriteTunePresets = {
  sepolia: { chainId: '11155111' },
  mainnet: { chainId: '1' },
}
const favoriteTuneCalls = []
const favoriteTuneStatuses = []
const favoriteTuneRuntime = new Function(
  'state', 'CHAIN_PRESETS', 'setStatus', 'loadConfig', 'saveConfig', 'resetRuntimeState', 'fillForm', 'els', 'renderArchiveMode', 'favoriteLabel', 'canonicalStreamIdHash', 'render', 'watchStationFavorite', 'publicErrorMessage', 'refresh', 'resetArchiveProgress', 'archiveDefaultMessage', 'beginArchiveTuneRequest', 'archiveTuneIsCurrent', 'isAbortError',
  `${productionSlice('function resetFavoriteArchiveState(', 'function renderPlayLatest(')}; return { tuneFavorite }`,
)(
  favoriteTuneState,
  favoriteTunePresets,
  (message) => favoriteTuneStatuses.push(message),
  ({ chainPreset }) => ({ chainPreset, chainId: favoriteTunePresets[chainPreset].chainId, streamId: `${chainPreset}-saved-stream`, streamIdHash: identityRuntime.canonicalStreamIdHash(`${chainPreset}-saved-stream`) }),
  (config) => favoriteTuneCalls.push(['save', config.chainPreset]),
  () => favoriteTuneCalls.push(['reset']),
  () => favoriteTuneCalls.push(['fill']),
  { archiveStation: { value: '' }, archivePublisher: { value: '' } },
  () => {},
  () => 'Saved Station',
  identityRuntime.canonicalStreamIdHash,
  () => favoriteTuneCalls.push(['render']),
  async () => {},
  (error) => String(error?.message || error),
  async () => {},
  (message) => { favoriteTuneState.archive.progress = { message } },
  (mode) => `Scan ${mode}.`,
  () => {
    favoriteTuneState.playbackContextGeneration += 1
    return ++favoriteTuneState.archive.tuneSerial
  },
  (serial) => serial === favoriteTuneState.archive.tuneSerial,
  (error) => error?.name === 'AbortError',
)
favoriteTuneRuntime.tuneFavorite({ type: 'station', chainId: '1', stationAddress: '0x0000000000000000000000000000000000000099' })
assert.equal(favoriteTuneState.config.chainPreset, 'mainnet')
assert.equal(favoriteTuneState.config.streamId, 'mainnet-saved-stream', 'cross-chain Station favorite must use the target network stream context')
assert.equal(favoriteTuneState.config.stationAddress, '0x0000000000000000000000000000000000000099')
assert.equal(favoriteTuneState.archive.mode, 'station')
assert.deepEqual(favoriteTuneState.archive.streams, [], 'favorite transition must clear previous-chain discovery results')
assert.equal(favoriteTuneState.archive.tunedKey, '')
assert.deepEqual(favoriteTuneCalls.slice(0, 4), [['save', 'mainnet'], ['reset'], ['fill'], ['render']])
favoriteTuneRuntime.tuneFavorite({ type: 'station', chainId: '999', stationAddress: '0x0000000000000000000000000000000000000099' })
assert.match(favoriteTuneStatuses.at(-1), /unsupported chain ID 999/)
assert.equal(favorites[2].streamId, 'rfe-mainnet-live')
assert.equal(favorites[2].firstBlock, 10)
assert.equal(favorites[2].latestBlock, 20)
assert.equal(favorites[3].type, 'inbox-stream')

const grouped = groupOldStreamsFromSegmentPublishedLogs([
  {
    publisher: '0x0000000000000000000000000000000000000002',
    streamIdHash: identityRuntime.canonicalStreamIdHash('alpha'),
    streamId: 'alpha',
    sequence: 2,
    blockNumber: 12,
  },
  {
    publisher: '0x0000000000000000000000000000000000000002',
    streamIdHash: identityRuntime.canonicalStreamIdHash('alpha'),
    streamId: 'alpha',
    sequence: 1,
    blockNumber: 10,
  },
  {
    publisher: '0x0000000000000000000000000000000000000003',
    streamIdHash: identityRuntime.canonicalStreamIdHash('beta'),
    streamId: 'beta',
    sequence: 7,
    blockNumber: 20,
  },
])
assert.equal(grouped.length, 2)
assert.equal(grouped[0].streamId, 'beta')
assert.equal(grouped[1].segmentCount, 2)
assert.equal(grouped[1].firstSequence, 1)
assert.equal(grouped[1].latestSequence, 2)
assert.equal(grouped[1].firstBlock, 10)
assert.equal(grouped[1].latestBlock, 12)

function rfe1Envelope(header, payload = new Uint8Array([1, 2, 3])) {
  const encodedHeader = new TextEncoder().encode(JSON.stringify(header))
  const encoded = new Uint8Array(8 + encodedHeader.length + payload.length)
  encoded.set([0x52, 0x46, 0x45, 0x31])
  new DataView(encoded.buffer).setUint32(4, encodedHeader.length, false)
  encoded.set(encodedHeader, 8)
  encoded.set(payload, 8 + encodedHeader.length)
  return encoded
}
const envelope = rfe1Envelope(
  {
    publisher: '0x0000000000000000000000000000000000000002',
    streamId: 'rfe-inbox-live',
    sequence: 3,
    payloadSha256: `0x${'c'.repeat(64)}`,
  },
)
const parsedEnvelope = parseRfe1Envelope(envelope)
assert.equal(parsedEnvelope.streamId, 'rfe-inbox-live')
assert.equal(parsedEnvelope.streamIdHash, identityRuntime.canonicalStreamIdHash('rfe-inbox-live'))
assert.equal(parsedEnvelope.sequence, 3)
assert.equal(parsedEnvelope.payload.byteLength, 3)
assert.equal(parseRfe1Envelope(rfe1Envelope({
  publisher: '0x0000000000000000000000000000000000000002',
  streamId: 'rfe-inbox-live',
  streamIdHash: `0x${'1'.repeat(64)}`,
  sequence: 3,
  payloadSha256: `0x${'c'.repeat(64)}`,
})), null, 'a supplied RFE1 stream hash must match its canonical stream ID')
assert.equal(parseRfe1Envelope(rfe1Envelope({
  publisher: '0x0000000000000000000000000000000000000002',
  streamId: 'é'.repeat(2_049),
  sequence: 3,
  payloadSha256: `0x${'c'.repeat(64)}`,
})), null, 'RFE1 stream identity must reject above the viewer decoder byte ceiling')

const defaultLayout = defaultLayoutSettings()
assert.equal(defaultLayout.blobFees.visible, false)
assert.equal(defaultLayout.blobFees.position, 'bottom')
assert.equal(defaultLayout.blobFees.order, 2)
const enabledLayout = normalizeLayoutSettings({
  blobFees: { visible: true, position: 'bottom', order: 4 },
})
assert.equal(enabledLayout.blobFees.visible, true)
assert.equal(enabledLayout.blobFees.position, 'bottom')
assert.equal(enabledLayout.blobFees.order, 4)

assert.equal(blobFeeWei(2_000_000_000n), 262_144_000_000_000n)
assert.equal(formatGweiFromWei(WEI_PER_GWEI), '1 Gwei')
assert.equal(formatGweiFromWei(1_500_000_000n), '1.5 Gwei')
assert.equal(formatEthFromWei(WEI_PER_ETH), '1 ETH')
assert.equal(
  fmtClockWithPrefs(new Date('2026-07-09T12:34:56Z'), {
    mode: 'utc',
    timeZone: '',
  }),
  '12:34:56 UTC',
)
assert.match(
  fmtClockWithPrefs(new Date('2026-07-09T12:34:56Z'), {
    mode: 'timezone',
    timeZone: 'America/New_York',
  }),
  /America\/New_York$/,
)
assert.equal(formatBlobWindowUsage({ sampleBlocks: 50, blobCount: 326 }).text, '50 blocks - ~326 blobs')
assert.match(formatBlobWindowUsage({ sampleBlocks: 50, blobCount: 326 }).title, /target is 14; max is 21/)
assert.equal(averageBigInts([0n, 10n, 20n]), 15n)
assert.equal(averageBigInts([0n]), null)
assert.throws(() => blobFeeHistoryValues({ oldestBlock: '0x1', blobGasUsedRatio: [0.5] }), /baseFeePerBlobGas/)
assert.deepEqual(
  blobFeeHistoryValues({
    oldestBlock: '0x10',
    baseFeePerBlobGas: ['0x0', '0xa', '0x14'],
    blobGasUsedRatio: [0, 0.5, '0.75', 'bad', 1.2],
  }),
  { baseFees: [10n, 20n], utilization: [0, 0.5], oldestBlock: 16n },
)
assert.throws(() => blobFeeHistoryValues({
  baseFeePerBlobGas: Array(BLOB_FEE_HISTORY_CHUNK_BLOCKS + 2).fill('0x1'),
}), /baseFeePerBlobGas exceeds/)
assert.throws(() => blobFeeHistoryValues({
  baseFeePerBlobGas: ['0x1'],
  blobGasUsedRatio: Array(BLOB_FEE_HISTORY_CHUNK_BLOCKS + 1).fill(0.5),
}), /blobGasUsedRatio exceeds/)

const calls = []
const history = await fetchBlobFeeHistory(1500, async (method, params) => {
  calls.push([method, params])
  return {
    oldestBlock: params[1] === 'latest' ? '0x400' : '0x1',
    baseFeePerBlobGas: ['0x1'],
    blobGasUsedRatio: [0.2],
  }
})
assert.equal(history.baseFees.length, 2)
assert.equal(calls[0][1][0], '0x400')
assert.equal(calls[1][1][0], '0x1dc')
assert.equal(calls[1][1][1], '0x3ff')

const providerLimitedState = { history: {} }
const limited = await refreshBlobFeeWindow('week', providerLimitedState, async () => {
  throw new Error('too many blocks')
})
assert.equal(limited.status, 'limited')
assert.equal(limited.message, 'provider limited')

const sensitiveUrlParamsMatch = productionAppSource.match(/const SENSITIVE_URL_PARAMS = (\[[^\n]+\])/)
assert.ok(sensitiveUrlParamsMatch, 'Production static client should declare sensitive URL parameters')
const sensitiveUrlParams = Function(`return ${sensitiveUrlParamsMatch[1]}`)()
const fakeWindow = {
  location: {
    search: `?network=sepolia&stream=public-stream&publisher=${publisherA}&executionRpc=https%3A%2F%2Fuser%3Asecret%40attacker.invalid&beaconApi=https%3A%2F%2Fbeacon.invalid%2Ftoken&archiveTemplates=https%3A%2F%2Farchive.invalid%2F%7Bhash%7D%3Fkey%3Dsecret`,
    pathname: '/radio',
    hash: '#player',
  },
  history: {
    replacedWith: '',
    replaceState(_state, _title, value) {
      this.replacedWith = value
    },
  },
}
const urlStateRuntime = new Function('URLSearchParams', 'window', 'CHAIN_PRESETS', 'SENSITIVE_URL_PARAMS', `${productionSlice('function sanitizedUrlParams(search)', 'function syncUrlState(')}; return { readUrlState, shareableUrlConfig }`)(URLSearchParams, fakeWindow, { sepolia: {} }, sensitiveUrlParams)
const sanitizedUrlState = urlStateRuntime.readUrlState()
assert.deepEqual(sanitizedUrlState.config, {
  chainPreset: 'sepolia',
  streamId: 'public-stream',
  publisher: publisherA,
})
assert.equal(sanitizedUrlState.segment, '')
assert.equal(
  urlStateRuntime.shareableUrlConfig({
    chainPreset: 'sepolia',
    streamId: 'public-stream',
    publisher: publisherA,
    executionRpcs: ['https://user:secret@attacker.invalid'],
    beaconApis: ['https://beacon.invalid/token'],
    archiveTemplates: ['https://archive.invalid/{hash}?key=secret'],
  }).executionRpcs,
  undefined,
)
assert.equal(fakeWindow.history.replacedWith, `/radio?network=sepolia&stream=public-stream&publisher=${publisherA}#player`)
assert.doesNotMatch(fakeWindow.history.replacedWith, /execution|beacon|archive|secret|attacker/i)

assert.deepEqual(
  identityRuntime.normalizeHttpEndpointList(['https://rpc.example/path', 'http://127.0.0.1:8545'], 'Execution RPC'),
  ['https://rpc.example/path', 'http://127.0.0.1:8545'],
)
assert.equal(identityRuntime.endpointRequiresSessionStorage('https://user:secret@rpc.example'), true)
assert.equal(identityRuntime.endpointRequiresSessionStorage('https://rpc.example/path?token=secret'), true)
assert.equal(identityRuntime.endpointRequiresSessionStorage('https://rpc.example/path'), false)
assert.deepEqual(
  identityRuntime.normalizeArchiveTemplateList([
    'https://archive.example/{streamId}/{sequence}?tx={txHash}&sha={payloadSha256}',
  ]),
  ['https://archive.example/{streamId}/{sequence}?tx={txHash}&sha={payloadSha256}'],
)
assert.throws(() => identityRuntime.normalizeHttpEndpointList(['file:///private/blob'], 'Execution RPC'), /HTTP or HTTPS/)
assert.throws(() => identityRuntime.normalizeHttpEndpointList(Array.from({ length: 9 }, (_, index) => `https://rpc-${index}.example`)), /exceeds 8/)
assert.throws(() => identityRuntime.normalizeHttpEndpointList(['https://rpc.example', 'https://rpc.example']), /duplicate/)
assert.throws(() => identityRuntime.normalizeHttpEndpointList([`https://rpc.example/${'a'.repeat(2049)}`]), /UTF-8 bytes/)
assert.throws(() => identityRuntime.normalizeArchiveTemplateList(['javascript:alert(1)']), /HTTP or HTTPS/)
assert.throws(() => identityRuntime.normalizeArchiveTemplateList(['https://archive.example/{unknown}']), /unsupported placeholder/)
assert.throws(() => identityRuntime.normalizeArchiveTemplateList(['https://archive.example/{sequence']), /malformed placeholder/)

const publicDiagnosticRuntime = new Function(`${productionSlice('function publicUrlLabel(', 'function parseBlockInput(')}; return { publicUrlLabel, publicErrorMessage }`)()
const diagnosticCanary = 'VIEWER_DIAGNOSTIC_SECRET_CANARY'
const credentialEndpoint = `https://viewer:${diagnosticCanary}@rpc.example/path?token=${diagnosticCanary}`
assert.equal(publicDiagnosticRuntime.publicUrlLabel(credentialEndpoint), 'https://rpc.example')
assert.doesNotMatch(
  publicDiagnosticRuntime.publicErrorMessage(new Error(`request to ${credentialEndpoint} failed`)),
  new RegExp(diagnosticCanary),
)
assert.doesNotMatch(publicDiagnosticRuntime.publicErrorMessage(new Error(`request to ${credentialEndpoint} failed`)), /viewer:|token=/)
const boundedDiagnostic = publicDiagnosticRuntime.publicErrorMessage(new Error('x'.repeat(2_000)))
assert.equal(boundedDiagnostic.length, 500)
assert.match(boundedDiagnostic, /…$/)

const requestCalls = []
const requestPlatform = {
  fetch: (resource, options) => {
    requestCalls.push({ resource, options })
    return new Promise(() => {})
  },
  AbortController,
  setTimeout,
  clearTimeout,
}
await assert.rejects(ioRuntime.fetchWithTimeout('https://rpc.invalid', { credentials: 'include', referrerPolicy: 'unsafe-url' }, { timeoutMs: 5, platform: requestPlatform }), (error) => error?.name === 'TimeoutError')
assert.equal(requestCalls[0].options.credentials, 'omit')
assert.equal(requestCalls[0].options.referrerPolicy, 'no-referrer')
assert.ok(requestCalls[0].options.signal instanceof AbortSignal)
const parentController = new AbortController()
const abortedRequest = ioRuntime.fetchWithTimeout('https://beacon.invalid', {}, { signal: parentController.signal, timeoutMs: 100, platform: requestPlatform })
parentController.abort()
await assert.rejects(abortedRequest, (error) => error?.name === 'AbortError')

const fallbackState = {
  endpointHealth: {},
  activeExecutionRpc: '',
  activeBeaconApi: '',
}
const withEndpointFallback = (kind, endpoints, request) => ioRuntime.runEndpointFallback(kind, endpoints, request, {
  onActive: (endpoint) => { fallbackState[kind === 'execution' ? 'activeExecutionRpc' : 'activeBeaconApi'] = endpoint },
  onHealth: (health) => { fallbackState.endpointHealth[kind] = health },
  publicEndpointLabel: (value) => value,
  publicError: (error) => error.message,
})
const fallbackCalls = []
const fallbackResult = await withEndpointFallback('execution', ['https://first.invalid', 'https://second.invalid'], async (endpoint) => {
  fallbackCalls.push(endpoint)
  if (endpoint.includes('first')) {
    const error = new Error('timed out')
    error.name = 'TimeoutError'
    throw error
  }
  return 'healthy'
})
assert.equal(fallbackResult, 'healthy')
assert.deepEqual(fallbackCalls, ['https://first.invalid', 'https://second.invalid'])
assert.equal(fallbackState.activeExecutionRpc, 'https://second.invalid')
fallbackCalls.length = 0
await assert.rejects(
  withEndpointFallback('execution', ['https://first.invalid', 'https://second.invalid'], async (endpoint) => {
    fallbackCalls.push(endpoint)
    const error = new Error('cancelled')
    error.name = 'AbortError'
    throw error
  }),
  (error) => error?.name === 'AbortError',
)
assert.deepEqual(fallbackCalls, ['https://first.invalid'])

const diagnosticHealth = []
await assert.rejects(
  ioRuntime.runEndpointFallback('execution', [credentialEndpoint], async () => {
    throw new Error(`provider rejected ${credentialEndpoint}`)
  }, {
    onHealth: (health) => diagnosticHealth.push(health),
    publicEndpointLabel: publicDiagnosticRuntime.publicUrlLabel,
    publicError: publicDiagnosticRuntime.publicErrorMessage,
  }),
  (error) => {
    assert.doesNotMatch(error.message, new RegExp(diagnosticCanary))
    assert.doesNotMatch(error.message, /viewer:|token=/)
    return true
  },
)
assert.doesNotMatch(JSON.stringify(diagnosticHealth), new RegExp(diagnosticCanary))
assert.doesNotMatch(JSON.stringify(diagnosticHealth), /viewer:|token=/)
assert.equal(diagnosticHealth.at(-1)?.message, 'https://rpc.example: provider rejected [redacted endpoint]')

const { singleFlight } = ioRuntime
const singleFlightHolder = { active: null }
let singleFlightInvocations = 0
let releaseSingleFlight
const sharedTask = () => {
  singleFlightInvocations += 1
  return new Promise((resolve) => {
    releaseSingleFlight = resolve
  })
}
const firstFlight = singleFlight(singleFlightHolder, 'active', sharedTask)
const secondFlight = singleFlight(singleFlightHolder, 'active', sharedTask)
assert.equal(firstFlight, secondFlight)
await Promise.resolve()
assert.equal(singleFlightInvocations, 1)
releaseSingleFlight('complete')
assert.equal(await firstFlight, 'complete')
assert.equal(singleFlightHolder.active, null)
assert.equal(
  await singleFlight(singleFlightHolder, 'active', async () => {
    singleFlightInvocations += 1
    return 'next'
  }),
  'next',
)
assert.equal(singleFlightInvocations, 2)

const archiveProgressElement = { textContent: '', dataset: {} }
const archiveProgressBar = {
  value: 0,
  active: false,
  ariaValueText: '',
  classList: {
    toggle(_name, value) {
      archiveProgressBar.active = value
    },
  },
  setAttribute(_name, value) {
    archiveProgressBar.ariaValueText = value
  },
}
const archiveState = { archive: { mode: 'station', progress: null } }
const archiveAnnouncements = []
const archiveRuntime = new Function('state', 'els', 'announceStatus', `${productionSlice('function archiveDefaultMessage(', 'function defaultBlobspaceRows(')}; return { renderArchiveProgress, setArchiveProgress, resetArchiveProgress }`)(archiveState, {
  archiveProgress: archiveProgressElement,
  archiveProgressBar,
}, (message, options) => archiveAnnouncements.push({ message, options }))
archiveRuntime.setArchiveProgress('Execution request failed.', {
  current: 4n,
  total: 10n,
  status: 'error',
})
archiveRuntime.renderArchiveProgress()
assert.equal(archiveState.archive.progress.status, 'error')
assert.equal(archiveProgressElement.textContent, 'Execution request failed.')
assert.equal(archiveProgressElement.dataset.state, 'error')
assert.equal(archiveProgressBar.value, 40)
assert.equal(archiveProgressBar.ariaValueText, 'Execution request failed.')
assert.deepEqual(archiveAnnouncements, [{ message: 'Execution request failed.', options: { assertive: true, key: 'archive-error' } }])
archiveRuntime.resetArchiveProgress()
assert.equal(archiveState.archive.progress.status, 'idle')
archiveRuntime.setArchiveProgress('Scanning...', { current: 1n, total: 2n, active: true })
assert.equal(archiveAnnouncements.length, 1, 'incremental archive progress must remain silent')
archiveRuntime.setArchiveProgress('Discovered one stream.', { current: 2n, total: 2n, status: 'success' })
assert.deepEqual(archiveAnnouncements.at(-1), { message: 'Discovered one stream.', options: { assertive: false, key: 'archive-success' } })

const metadataState = {
  config: {
    chainPreset: 'sepolia',
    chainId: '11155111',
    stationAddress: '0x0000000000000000000000000000000000000001',
    streamId: 'public-stream',
    publisher: '0x0000000000000000000000000000000000000002',
  },
}
const metadataRuntime = identityRuntime
const metadataScope = metadataRuntime.metadataScopeForConfig(metadataState.config)
assert.notEqual(
  metadataScope.cacheKey,
  metadataRuntime.metadataScopeForConfig({
    ...metadataState.config,
    publisher: publisherB,
  }).cacheKey,
  'metadata cache keys must isolate publishers sharing a stream ID',
)
assert.notEqual(metadataScope.cacheKey, metadataRuntime.metadataScopeForConfig({ ...metadataState.config, chainId: '1' }).cacheKey, 'metadata cache keys must isolate chains')
assert.notEqual(metadataScope.cacheKey, metadataRuntime.metadataScopeForConfig({ ...metadataState.config, stationAddress: '0x0000000000000000000000000000000000000003' }).cacheKey, 'metadata cache keys must isolate Station contracts')
const validCachedSegment = {
  chainId: metadataScope.chainId,
  stationAddress: metadataScope.stationAddress,
  syntheticChannelId: metadataScope.syntheticChannelId,
  streamId: 'public-stream',
  streamIdHash: identityRuntime.canonicalStreamIdHash('public-stream'),
  publisher: '0x0000000000000000000000000000000000000002',
  txHash: `0x${'1'.repeat(64)}`,
  blockHash: `0x${'2'.repeat(64)}`,
  payloadSha256: '3'.repeat(64),
  payloadSha256Hex: `0x${'3'.repeat(64)}`,
  previousSegmentHash: '',
  sequence: 1,
  blockNumber: 2,
  transactionIndex: 0,
  logIndex: 0,
  payloadBytes: 3,
  blobVersionedHashes: [`0x${'4'.repeat(64)}`],
}
validCachedSegment.cacheKey = identityRuntime.scopedSegmentIdentityKey(validCachedSegment)
const validMetadataRecord = {
  ...metadataScope,
  updatedAt: '2026-07-09T12:00:00.000Z',
  segments: [validCachedSegment],
}
const matchedMetadata = metadataRuntime.matchingCachedMetadata(validMetadataRecord, metadataScope)
assert.equal(matchedMetadata?.segments[0].continuity.status, 'unknown')
assert.equal(matchedMetadata?.segments[0].channelKey, identityRuntime.v1ScopedChannelIdentity(validCachedSegment).key)
assert.equal(metadataRuntime.matchingCachedMetadata({ ...validMetadataRecord, chainPreset: 'mainnet' }, metadataScope), null)
assert.notEqual(
  identityRuntime.scopedSegmentIdentityKey(validCachedSegment),
  identityRuntime.scopedSegmentIdentityKey({ ...validCachedSegment, chainId: '1' }),
  'payload cache keys must isolate identical V1 events across chains',
)
assert.notEqual(
  identityRuntime.scopedSegmentIdentityKey(validCachedSegment),
  identityRuntime.scopedSegmentIdentityKey({ ...validCachedSegment, stationAddress: '0x0000000000000000000000000000000000000003' }),
  'payload cache keys must isolate identical V1 events across Station contracts',
)
assert.equal(
  metadataRuntime.matchingCachedMetadata(
    {
      ...validMetadataRecord,
      segments: [{ ...validCachedSegment, txHash: 'malformed' }],
    },
    metadataScope,
  ),
  null,
)

const { archiveRangeSelection } = new Function(`${productionSlice('function archiveRangeSelection(', 'async function archiveDateBlockRange(')}; return { archiveRangeSelection }`)()
assert.deepEqual(archiveRangeSelection({ rangeMode: 'block', fromBlock: '123' }), {
  mode: 'block',
  fromBlock: '123',
  fromDate: '',
  toDate: '',
})
assert.deepEqual(
  archiveRangeSelection({
    rangeMode: 'date',
    fromDate: '2026-07-09T10:00',
    toDate: '2026-07-09T12:00',
  }),
  {
    mode: 'date',
    fromBlock: '',
    fromDate: '2026-07-09T10:00',
    toDate: '2026-07-09T12:00',
  },
)
assert.throws(
  () =>
    archiveRangeSelection({
      rangeMode: 'date',
      fromBlock: '123',
      fromDate: '2026-07-09T10:00',
    }),
  /cannot be combined/i,
)
assert.throws(() => archiveRangeSelection({ rangeMode: 'block' }), /Enter a From block/)

const inboxDiscoveryRuntime = new Function('isAbortError', 'archiveScanErrorMessage', `${productionSlice('function classifyInboxDiscoveryFailure(', 'async function inboxSegmentFromSidecar(')}; return { classifyInboxDiscoveryFailure, inboxScanCompletion }`)(
  (error) => error?.name === 'AbortError',
  (error) => error.message,
)
const abortDiscoveryError = new Error('cancelled')
abortDiscoveryError.name = 'AbortError'
assert.equal(inboxDiscoveryRuntime.classifyInboxDiscoveryFailure(abortDiscoveryError).kind, 'abort')
assert.deepEqual(inboxDiscoveryRuntime.classifyInboxDiscoveryFailure(new Error('beacon failed'), { stage: 'endpoint' }), {
  kind: 'endpoint',
  message: 'beacon failed',
})
assert.equal(inboxDiscoveryRuntime.classifyInboxDiscoveryFailure(new Error('malformed envelope')).kind, 'candidate')
const partialInboxCompletion = inboxDiscoveryRuntime.inboxScanCompletion({
  streamCount: 1,
  segmentCount: 2,
  failedCandidates: 1,
  incompatibleCandidates: 3,
  failures: [{ message: 'invalid blob payload' }],
})
assert.equal(partialInboxCompletion.status, 'warning')
assert.match(partialInboxCompletion.message, /Partial scan/)
assert.match(partialInboxCompletion.message, /Skipped 1 candidate/)
assert.match(partialInboxCompletion.message, /invalid blob payload/)
const cleanInboxCompletion = inboxDiscoveryRuntime.inboxScanCompletion({
  incompatibleCandidates: 2,
})
assert.equal(cleanInboxCompletion.status, 'success')
assert.match(cleanInboxCompletion.message, /Ignored 2 incompatible candidates normally/)

let restoredFocusOptions = null
const previousDynamicControl = {
  closest(selector) {
    assert.equal(selector, '[data-focus-key]')
    return { dataset: { focusKey: 'segment:one:play' } }
  },
}
const replacementDynamicControl = {
  dataset: { focusKey: 'segment:one:play' },
  focus(options) {
    restoredFocusOptions = options
  },
}
const focusDocument = {
  activeElement: previousDynamicControl,
  querySelectorAll(selector) {
    assert.equal(selector, '[data-focus-key]')
    return [replacementDynamicControl]
  },
}
const focusRuntime = new Function('document', `${productionSlice('function dynamicFocusKey(', 'function cachedBlobspaceRows(')}; return { dynamicFocusKey, restoreDynamicFocus }`)(focusDocument)
const retainedFocusKey = focusRuntime.dynamicFocusKey()
assert.equal(retainedFocusKey, 'segment:one:play')
assert.equal(focusRuntime.restoreDynamicFocus(retainedFocusKey), true)
assert.deepEqual(restoredFocusOptions, { preventScroll: true })

const loadedSegments = [
  {
    cacheKey: 'two',
    channelKey: 'channel',
    sequence: 2,
    blockNumber: 20,
    transactionIndex: 0,
    logIndex: 0,
  },
  {
    cacheKey: 'one',
    channelKey: 'channel',
    sequence: 1,
    blockNumber: 10,
    transactionIndex: 0,
    logIndex: 0,
  },
]
const loadedRecords = new Map([
  ['one', { cacheKey: 'one', sequence: 1 }],
  ['two', { cacheKey: 'two', sequence: 2 }],
])
const playbackState = {
  segments: loadedSegments,
  verified: loadedRecords,
  playbackAdvanceToken: 7,
  currentRecordKey: 'one',
  loopReplay: true,
  streaming: false,
}
const playedSequence = []
const playbackRuntime = new Function('state', 'prefetchSegment', 'playRecord', 'render', 'configuredChannelKey', 'segmentIsQuarantined', `${productionSlice('function orderedLoadedSegments(', 'function currentRecord()')} return { orderedLoadedSegments, nextSegmentAfter, playbackAdvanceIsCurrent, advanceLoadedPlayback }`)(
  playbackState,
  async () => null,
  (record) => {
    playedSequence.push(record.sequence)
    playbackState.currentRecordKey = record.cacheKey
    playbackState.playbackAdvanceToken += 1
  },
  () => {},
  () => 'channel',
  () => false,
)
assert.deepEqual(
  playbackRuntime.orderedLoadedSegments().map((segment) => segment.sequence),
  [1, 2],
)
const secondLoadedSegment = playbackRuntime.nextSegmentAfter(loadedRecords.get('one'))
assert.equal(secondLoadedSegment.sequence, 2)
assert.ok(
  playbackRuntime.playbackAdvanceIsCurrent(7, 'one', {
    requireLoop: true,
    replayOnly: true,
  }),
)
await playbackRuntime.advanceLoadedPlayback(secondLoadedSegment, {
  advanceToken: 7,
  currentKey: 'one',
})
assert.deepEqual(playedSequence, [2])
const loopToken = playbackState.playbackAdvanceToken
await playbackRuntime.advanceLoadedPlayback(playbackRuntime.orderedLoadedSegments()[0], {
  advanceToken: loopToken,
  currentKey: 'two',
  requireLoop: true,
})
assert.deepEqual(playedSequence, [2, 1])

let resolveInterruptedPrefetch
playbackState.verified = new Map()
playbackState.currentRecordKey = 'one'
playbackState.playbackAdvanceToken += 1
const interruptedToken = playbackState.playbackAdvanceToken
const interruptedRuntime = new Function('state', 'prefetchSegment', 'playRecord', 'render', 'configuredChannelKey', 'segmentIsQuarantined', `${productionSlice('function orderedLoadedSegments(', 'function currentRecord()')} return { advanceLoadedPlayback }`)(
  playbackState,
  () =>
    new Promise((resolve) => {
      resolveInterruptedPrefetch = resolve
    }),
  (record) => playedSequence.push(record.sequence),
  () => {},
  () => 'channel',
  () => false,
)
const interruptedAdvance = interruptedRuntime.advanceLoadedPlayback(secondLoadedSegment, {
  advanceToken: interruptedToken,
  currentKey: 'one',
})
playbackState.currentRecordKey = 'manual-choice'
playbackState.playbackAdvanceToken += 1
resolveInterruptedPrefetch({ cacheKey: 'two', sequence: 2 })
assert.equal(await interruptedAdvance, null)
assert.deepEqual(playedSequence, [2, 1])

const deniedStorageStatus = {
  localStorage: 'available',
  indexedDb: 'unknown',
  localStorageError: '',
  indexedDbError: '',
}
const deniedLocalStorage = {
  getItem() {
    const error = new Error('Access to storage is denied')
    error.name = 'SecurityError'
    throw error
  },
  setItem() {
    const error = new Error('Access to storage is denied')
    error.name = 'SecurityError'
    throw error
  },
}
const guardedStorageRuntime = new Function('localStorage', 'storageStatus', `${productionSlice('function storageErrorText(', 'function loadLayoutPreset(')}; return { safeStorageGet, safeStorageSet }`)(deniedLocalStorage, deniedStorageStatus)
assert.equal(guardedStorageRuntime.safeStorageGet('missing', 'fallback'), 'fallback')
assert.equal(guardedStorageRuntime.safeStorageSet('key', 'value'), false)
assert.equal(deniedStorageStatus.localStorage, 'unavailable')
assert.match(deniedStorageStatus.localStorageError, /denied/)

const configStorage = new Map()
const configSessionStorage = new Map()
const configPresets = {
  sepolia: {
    chainId: '11155111',
    streamId: 'sepolia-default',
    stationAddress: '0x0000000000000000000000000000000000000001',
    fromBlock: '10',
    executionRpcs: ['https://sepolia.default.invalid'],
    beaconApis: ['https://sepolia-beacon.default.invalid'],
  },
  mainnet: {
    chainId: '1',
    streamId: 'mainnet-default',
    stationAddress: '0x0000000000000000000000000000000000000002',
    fromBlock: '20',
    executionRpcs: ['https://mainnet.default.invalid'],
    beaconApis: ['https://mainnet-beacon.default.invalid'],
  },
}
const configDefaults = {
  chainPreset: 'sepolia',
  archiveTemplates: [],
  logWindowBlocks: 96,
  cacheLimitMb: 512,
}
configStorage.set(
  'config-v2',
  JSON.stringify({
    activePreset: 'mainnet',
    networks: {
      mainnet: {
        chainPreset: 'mainnet',
        streamId: 'saved-mainnet-stream',
        publisher: publisherA,
        stationAddress: '0x0000000000000000000000000000000000000012',
        executionRpcs: ['https://saved-mainnet.invalid'],
        beaconApis: ['https://saved-mainnet-beacon.invalid'],
      },
      sepolia: {
        chainPreset: 'sepolia',
        streamId: 'saved-sepolia-stream',
        publisher: publisherB,
        stationAddress: '0x0000000000000000000000000000000000000011',
        executionRpcs: ['https://saved-sepolia.invalid'],
        beaconApis: ['https://saved-sepolia-beacon.invalid'],
        cacheLimitMb: 999_999,
      },
    },
  }),
)
const configWindow = {
  location: { search: '', pathname: '/', hash: '' },
  history: {
    state: null,
    url: '',
    replaceState(value, _title, url) {
      this.state = value
      this.url = url
    },
  },
}
const configState = { config: null, selectedSegmentQuery: '' }
const configRuntime = new Function('URLSearchParams', 'window', 'CHAIN_PRESETS', 'SENSITIVE_URL_PARAMS', 'CONFIG_KEY', 'SESSION_ENDPOINT_CONFIG_KEY', 'LEGACY_CONFIG_KEY', 'DEFAULTS', 'safeStorageGet', 'safeStorageSet', 'safeJsonObject', 'sessionStorage', 'endpointRequiresSessionStorage', 'normalizeStationAddressInput', 'canonicalStreamIdHash', 'parseLines', 'unique', 'positiveNumber', 'clampCacheLimitMb', 'CACHE_LIMIT_MIN_MB', 'CACHE_LIMIT_MAX_MB', 'normalizedEndpointListOrEmpty', 'normalizedArchiveTemplatesOrEmpty', 'state', 'boundedStreamId', `${productionSlice('function sanitizedUrlParams(search)', 'function setTheme(')}; return { loadConfig, loadConfigStore, saveConfig, endpointPersistenceSplit, configPersistenceNotice }`)(
  URLSearchParams,
  configWindow,
  configPresets,
  sensitiveUrlParams,
  'config-v2',
  'session-endpoints-v1',
  'legacy-config',
  configDefaults,
  (key, fallback = '') => configStorage.get(key) ?? fallback,
  (key, value) => {
    configStorage.set(key, value)
    return true
  },
  (value) => {
    try {
      const parsed = JSON.parse(value || '{}')
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  },
  {
    getItem: (key) => configSessionStorage.get(key) ?? null,
    setItem: (key, value) => configSessionStorage.set(key, String(value)),
  },
  identityRuntime.endpointRequiresSessionStorage,
  (value) => (/^0x[0-9a-fA-F]{40}$/.test(String(value || '')) ? String(value).toLowerCase() : ''),
  identityRuntime.canonicalStreamIdHash,
  (value) =>
    String(value || '')
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean),
  (values) => [...new Set(values.filter(Boolean))],
  (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback),
  identityRuntime.clampCacheLimitMb,
  16,
  2048,
  (values, label) => {
    try { return [...identityRuntime.normalizeHttpEndpointList([...new Set((Array.isArray(values) ? values : [values]).filter(Boolean))], label)] } catch { return [] }
  },
  (values) => {
    const entries = (Array.isArray(values) ? values : [values]).filter(Boolean)
    if (!entries.length) return []
    try { return [...identityRuntime.normalizeArchiveTemplateList([...new Set(entries)])] } catch { return [] }
  },
  configState,
  (value) => {
    const text = String(value ?? '')
    if (!text || new TextEncoder().encode(text).byteLength > 4_096) throw new Error('invalid stream ID')
    return text
  },
)
const userPlaybackRequestState = { playbackAdvanceToken: 8 }
const userPlaybackRequestRuntime = new Function('state', `${productionSlice('function beginUserPlaybackRequest()', 'async function advanceLoadedPlayback(segment')}; return { beginUserPlaybackRequest, userPlaybackRequestIsCurrent }`)(userPlaybackRequestState)
const olderPlaybackRequest = userPlaybackRequestRuntime.beginUserPlaybackRequest()
const newerPlaybackRequest = userPlaybackRequestRuntime.beginUserPlaybackRequest()
assert.equal(userPlaybackRequestRuntime.userPlaybackRequestIsCurrent(olderPlaybackRequest), false)
assert.equal(userPlaybackRequestRuntime.userPlaybackRequestIsCurrent(newerPlaybackRequest), true, 'only the newest asynchronous user playback request may take over the player')
const archiveTuneState = { archive: { tuneSerial: 4 }, playbackContextGeneration: 12 }
const archiveTuneRuntime = new Function('state', 'runtimeIsCurrent', `${productionSlice('function archiveTuneIsCurrent(', 'async function tuneArchiveStream(')}; return { archiveTuneIsCurrent, beginArchiveTuneRequest }`)(
  archiveTuneState,
  (runtime) => runtime?.generation === 9,
)
assert.equal(archiveTuneRuntime.archiveTuneIsCurrent(3, { generation: 9 }), false)
assert.equal(archiveTuneRuntime.archiveTuneIsCurrent(4, { generation: 8 }), false)
assert.equal(archiveTuneRuntime.archiveTuneIsCurrent(4, { generation: 9 }), true)
assert.equal(archiveTuneRuntime.beginArchiveTuneRequest(), 5)
assert.equal(archiveTuneState.playbackContextGeneration, 13, 'archive request must invalidate prior verification before its first await')
const archiveTuneSource = productionSlice('async function tuneArchiveStream(', 'function tuneToStream(')
assert.match(archiveTuneSource, /validatedCachedSegment\(segment, runtime\)[\s\S]*archiveTuneIsCurrent\(tuneSerial, runtime\)[\s\S]*promoteVerifiedRecord/, 'cached archive promotion must recheck tune generation after await')
const favoriteArchiveTuneSource = productionSlice('async function watchStationFavorite(', 'function resetFavoriteArchiveState(')
assert.match(favoriteArchiveTuneSource, /archiveTuneIsCurrent\(tuneSerial\)[\s\S]*tuneArchiveStream\(summary\.key, \{ tuneSerial \}\)/, 'saved-stream lookup must retain the request generation created by the favorite action')
const externalSepoliaConfig = configRuntime.loadConfig({
  chainPreset: 'sepolia',
})
assert.equal(externalSepoliaConfig.streamId, 'sepolia-default')
assert.equal(externalSepoliaConfig.stationAddress, '0x0000000000000000000000000000000000000001')
assert.deepEqual(externalSepoliaConfig.executionRpcs, ['https://sepolia.default.invalid'])
assert.equal(configRuntime.loadConfig({ chainPreset: 'sepolia', cacheLimitMb: 999_999 }).cacheLimitMb, 2048, 'shared URL config must clamp cache volume')
const oversizedSharedStream = configRuntime.loadConfig({ chainPreset: 'sepolia', streamId: 'x'.repeat(4_097), publisher: publisherA })
assert.equal(oversizedSharedStream.streamId, '', 'oversized explicit shared stream identity must remain invalid rather than falling back or truncating')
assert.equal(oversizedSharedStream.streamIdHash, '')
assert.equal(oversizedSharedStream.publisher, '')

const hydrationSegments = Array.from({ length: 10 }, (_, sequence) => ({
  sequence,
  blockNumber: sequence,
  transactionIndex: 0,
  logIndex: 0,
  payloadBytes: 10,
}))
assert.deepEqual(
  identityRuntime.selectRecentSegmentsWithinByteBudget(hydrationSegments, 35).map((segment) => segment.sequence),
  [7, 8, 9],
  'cached hydration must select only the newest contiguous segments fitting the hot-payload budget',
)
const verifiedRecords = Array.from({ length: 5 }, (_, sequence) => ({
  cacheKey: `verified-${sequence}`,
  sequence,
  bytes: 10,
  verifiedAt: new Date(sequence * 1000).toISOString(),
}))
assert.deepEqual(
  [...identityRuntime.retainedVerifiedRecordKeys(verifiedRecords, { maxBytes: 25, protectedKeys: ['verified-0', 'verified-4'] })].sort(),
  ['verified-0', 'verified-4'],
  'hot verified-record eviction must preserve active/new records while removing older unprotected payloads',
)
const explicitSepoliaConfig = configRuntime.loadConfig({
  chainPreset: 'sepolia',
  chainId: '1',
  streamId: 'shared-stream',
  publisher: publisherA.toUpperCase().replace('0X', '0x'),
  stationAddress: '0x0000000000000000000000000000000000000099',
})
assert.equal(explicitSepoliaConfig.streamId, 'shared-stream')
assert.equal(explicitSepoliaConfig.publisher, publisherA)
assert.equal(explicitSepoliaConfig.streamIdHash, identityRuntime.canonicalStreamIdHash('shared-stream'))
assert.equal(explicitSepoliaConfig.stationAddress, '0x0000000000000000000000000000000000000099')
assert.equal(explicitSepoliaConfig.chainId, '11155111', 'persisted or shared data must not override the selected preset chain ID')
assert.deepEqual(explicitSepoliaConfig.executionRpcs, ['https://sepolia.default.invalid'])
const savedMainnetConfig = configRuntime.loadConfig()
assert.equal(savedMainnetConfig.streamId, 'saved-mainnet-stream')
assert.equal(savedMainnetConfig.publisher, publisherA)
assert.deepEqual(savedMainnetConfig.executionRpcs, ['https://saved-mainnet.invalid'])
const localSepoliaReload = configRuntime.loadConfig({ chainPreset: 'sepolia', streamId: 'synced-stream' }, { useSavedNetworkConfig: true })
assert.equal(localSepoliaReload.streamId, 'synced-stream')
assert.equal(localSepoliaReload.publisher, '', 'changing raw stream ID without an explicit publisher must clear prior trust')
assert.equal(localSepoliaReload.stationAddress, '0x0000000000000000000000000000000000000011')
assert.deepEqual(localSepoliaReload.executionRpcs, ['https://saved-sepolia.invalid'])
const changedStationConfig = configRuntime.loadConfig({
  chainPreset: 'sepolia',
  stationAddress: '0x0000000000000000000000000000000000000099',
}, { useSavedNetworkConfig: true })
assert.equal(changedStationConfig.streamId, 'saved-sepolia-stream')
assert.equal(changedStationConfig.publisher, '', 'changing Station without an explicit publisher must clear prior publisher trust')
assert.equal(changedStationConfig.stationAddress, '0x0000000000000000000000000000000000000099')
const malformedSharedStation = configRuntime.loadConfig({ chainPreset: 'sepolia', stationAddress: 'not-an-address' }, { useSavedNetworkConfig: true })
assert.equal(malformedSharedStation.stationAddress, '', 'an explicitly malformed Station must not silently select the preset deployment')
assert.equal(malformedSharedStation.publisher, '')
const explicitStationPublisher = configRuntime.loadConfig({
  chainPreset: 'sepolia',
  stationAddress: '0x0000000000000000000000000000000000000099',
  publisher: publisherA,
}, { useSavedNetworkConfig: true })
assert.equal(explicitStationPublisher.publisher, publisherA, 'a Station transition may explicitly bind its publisher in the same action')
const savedSepoliaConfig = configRuntime.loadConfig({ chainPreset: 'sepolia' }, { useSavedNetworkConfig: true })
assert.equal(savedSepoliaConfig.publisher, publisherB, 'endpoint/network reload must preserve its publisher when stream identity is unchanged')
assert.equal(savedSepoliaConfig.cacheLimitMb, 2048, 'saved cache limits must be clamped on load')
const validConfigStoreSnapshot = configStorage.get('config-v2')
const hostileStoredConfig = JSON.parse(validConfigStoreSnapshot)
hostileStoredConfig.networks.sepolia.executionRpcs = ['file:///private/rpc']
hostileStoredConfig.networks.sepolia.beaconApis = Array.from({ length: 9 }, (_, index) => `https://beacon-${index}.invalid`)
hostileStoredConfig.networks.sepolia.archiveTemplates = ['https://archive.invalid/{unsupported}']
configStorage.set('config-v2', JSON.stringify(hostileStoredConfig))
const boundedStoredConfig = configRuntime.loadConfig({ chainPreset: 'sepolia' }, { useSavedNetworkConfig: true })
assert.deepEqual(boundedStoredConfig.executionRpcs, [], 'invalid persisted execution endpoints must not reach fetch')
assert.deepEqual(boundedStoredConfig.beaconApis, [], 'oversized persisted endpoint lists must not reach fetch')
assert.deepEqual(boundedStoredConfig.archiveTemplates, [], 'invalid persisted archive templates must not reach fetch')
configStorage.set('config-v2', validConfigStoreSnapshot)
const explicitPublisherTransition = configRuntime.loadConfig(
  {
    chainPreset: 'sepolia',
    streamId: 'synced-stream',
    publisher: publisherA,
  },
  { useSavedNetworkConfig: true },
)
assert.equal(explicitPublisherTransition.publisher, publisherA, 'the same action may change stream and explicitly supply its publisher')
configState.config = explicitSepoliaConfig
configRuntime.saveConfig(explicitSepoliaConfig)
assert.deepEqual(configWindow.history.state, { rfeLocalConfig: true })
assert.match(configWindow.history.url, new RegExp(`publisher=${publisherA}`))
assert.match(configWindow.history.url, new RegExp(`streamIdHash=${encodeURIComponent(identityRuntime.canonicalStreamIdHash('shared-stream'))}`))
const savedNetworksAfterUpdate = JSON.parse(configStorage.get('config-v2')).networks
assert.equal(savedNetworksAfterUpdate.mainnet.streamId, 'saved-mainnet-stream')
assert.equal(savedNetworksAfterUpdate.mainnet.publisher, publisherA)
assert.equal(savedNetworksAfterUpdate.sepolia.streamId, 'shared-stream')
assert.equal(savedNetworksAfterUpdate.sepolia.publisher, publisherA)

const credentialCanary = 'VIEWER_SESSION_SECRET_CANARY'
const sensitiveEndpointConfig = {
  ...explicitSepoliaConfig,
  executionRpcs: ['https://safe-rpc.invalid', `https://user:${credentialCanary}@private-rpc.invalid`],
  beaconApis: [`https://private-beacon.invalid/api?token=${credentialCanary}`],
  archiveTemplates: [`https://private-archive.invalid/{payloadSha256}?token=${credentialCanary}`],
}
configState.config = sensitiveEndpointConfig
const sensitivePersistence = configRuntime.saveConfig(sensitiveEndpointConfig)
assert.deepEqual(sensitivePersistence, { persistent: true, session: true, hasSessionOnly: true })
assert.doesNotMatch(configStorage.get('config-v2'), new RegExp(credentialCanary), 'credential canary must not enter persistent browser configuration')
assert.match(configSessionStorage.get('session-endpoints-v1'), new RegExp(credentialCanary), 'credential canary should remain available in tab session storage')
assert.match(configRuntime.configPersistenceNotice(sensitivePersistence), /session-only/)
assert.doesNotMatch(configWindow.history.url, new RegExp(credentialCanary), 'credential canary must not enter the share URL')
const sameSessionConfig = configRuntime.loadConfig({ chainPreset: 'sepolia' }, { useSavedNetworkConfig: true })
assert.deepEqual(sameSessionConfig.executionRpcs, sensitiveEndpointConfig.executionRpcs)
assert.deepEqual(sameSessionConfig.beaconApis, sensitiveEndpointConfig.beaconApis)
assert.deepEqual(sameSessionConfig.archiveTemplates, sensitiveEndpointConfig.archiveTemplates)
configSessionStorage.clear()
const laterSessionConfig = configRuntime.loadConfig({ chainPreset: 'sepolia' }, { useSavedNetworkConfig: true })
assert.deepEqual(laterSessionConfig.executionRpcs, ['https://safe-rpc.invalid'])
assert.deepEqual(laterSessionConfig.beaconApis, [])
assert.deepEqual(laterSessionConfig.archiveTemplates, [])

const formState = {
  config: {
    chainPreset: 'sepolia',
    streamId: 'old-stream',
    streamIdHash: identityRuntime.canonicalStreamIdHash('old-stream'),
    publisher: publisherA,
    stationAddress: '0x0000000000000000000000000000000000000001',
    fromBlock: '10',
    executionRpcs: ['https://old.invalid'],
    beaconApis: ['https://old-beacon.invalid'],
    archiveTemplates: [],
    cacheLimitMb: 512,
  },
}
const formEls = {
  chainPreset: { value: 'sepolia' },
  streamId: { value: '  newly entered  ' },
  stationAddress: { value: '0x0000000000000000000000000000000000000001' },
  fromBlock: { value: '10' },
  executionRpcs: { value: 'https://new.invalid' },
  beaconApis: { value: 'https://new-beacon.invalid' },
  archiveTemplates: { value: '' },
  cacheLimit: { value: '512' },
}
const formRuntime = new Function('state', 'els', 'CHAIN_PRESETS', 'DEFAULTS', 'unique', 'parseLines', 'validateEndpointList', 'validateArchiveTemplateList', 'normalizeHttpEndpointList', 'normalizeArchiveTemplateList', 'normalizeStationAddressInput', 'positiveNumber', 'clampCacheLimitMb', 'CACHE_LIMIT_MIN_MB', 'CACHE_LIMIT_MAX_MB', 'canonicalStreamIdHash', 'boundedStreamId', `${productionSlice('function formConfig(', 'function applyCustomConfig(')}; return { formConfig }`)(
  formState,
  formEls,
  configPresets,
  configDefaults,
  (values) => [...new Set(values.filter(Boolean))],
  (value) =>
    String(value || '')
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean),
  () => [],
  () => [],
  identityRuntime.normalizeHttpEndpointList,
  identityRuntime.normalizeArchiveTemplateList,
  normalizeStationAddressInput,
  (value, fallback) => Number(value) || fallback,
  identityRuntime.clampCacheLimitMb,
  16,
  2048,
  identityRuntime.canonicalStreamIdHash,
  (value) => {
    const text = String(value ?? '')
    if (!text || new TextEncoder().encode(text).byteLength > 4_096) throw new Error('Stream ID exceeds 4,096 UTF-8 bytes')
    return text
  },
)
const changedFormConfig = formRuntime.formConfig()
assert.equal(changedFormConfig.streamId, 'newly entered', 'new free-text stream IDs should trim before identity creation')
assert.equal(changedFormConfig.publisher, '', 'form stream transition must clear prior publisher trust')
assert.equal(changedFormConfig.streamIdHash, identityRuntime.canonicalStreamIdHash('newly entered'))
formEls.streamId.value = 'x'.repeat(16_385)
assert.throws(() => formRuntime.formConfig(), /Stream ID exceeds/)
formEls.streamId.value = 'newly entered'
formEls.cacheLimit.value = '999999'
assert.equal(formRuntime.formConfig().cacheLimitMb, 2048, 'settings UI must clamp cache volume')
formEls.cacheLimit.value = '512'
formEls.streamId.value = 'old-stream'
const endpointOnlyConfig = formRuntime.formConfig()
assert.equal(endpointOnlyConfig.publisher, publisherA, 'endpoint-only changes must preserve the trusted channel')
formEls.stationAddress.value = '0x0000000000000000000000000000000000000002'
const changedStationFormConfig = formRuntime.formConfig()
assert.equal(changedStationFormConfig.publisher, '', 'form Station transition must clear prior publisher trust')
formEls.stationAddress.value = '0x0000000000000000000000000000000000000001'
formState.config.streamId = whitespaceStreamId
formState.config.streamIdHash = identityRuntime.canonicalStreamIdHash(whitespaceStreamId)
formEls.streamId.value = whitespaceStreamId
const whitespaceEndpointConfig = formRuntime.formConfig()
assert.equal(whitespaceEndpointConfig.streamId, whitespaceStreamId, 'unchanged exact raw IDs must survive endpoint-only form updates')
assert.equal(whitespaceEndpointConfig.publisher, publisherA)

const deniedIndexedDbStatus = {
  localStorage: 'available',
  indexedDb: 'unknown',
  localStorageError: '',
  indexedDbError: '',
}
const memoryOnlyStores = { segments: new Map(), metadata: new Map() }
const deniedIndexedDbRuntime = new Function('memoryStores', 'storageStatus', 'storageErrorText', 'indexedDB', 'DB_NAME', 'DB_VERSION', 'dbPromise', 'state', 'DEFAULTS', 'clampCacheLimitMb', 'CACHE_LIMIT_MIN_MB', 'CACHE_LIMIT_MAX_MB', 'MEMORY_CACHE_MAX_MB', 'cachedSegmentByteLength', `${productionSlice('function storageMemoryStore(', 'function metadataScope(')}; return { openDb, getRecord, putRecord, clearStore }`)(
  memoryOnlyStores,
  deniedIndexedDbStatus,
  (error) => String(error?.message || error),
  {
    open() {
      const error = new Error('IndexedDB denied')
      error.name = 'SecurityError'
      throw error
    },
  },
  'test-db',
  1,
  null,
  { config: { cacheLimitMb: 16 } },
  { cacheLimitMb: 512 },
  identityRuntime.clampCacheLimitMb,
  16,
  2048,
  64,
  (record) => record.bytes,
)
assert.equal(await deniedIndexedDbRuntime.openDb(), null)
assert.equal(
  await deniedIndexedDbRuntime.putRecord('segments', {
    cacheKey: 'memory-segment',
    bytes: 3,
  }),
  false,
)
assert.deepEqual(await deniedIndexedDbRuntime.getRecord('segments', 'memory-segment'), { cacheKey: 'memory-segment', bytes: 3 })
assert.equal(deniedIndexedDbStatus.indexedDb, 'unavailable')
assert.equal(await deniedIndexedDbRuntime.clearStore('segments'), false)
assert.equal(await deniedIndexedDbRuntime.getRecord('segments', 'memory-segment'), null)
for (let index = 0; index < 40; index += 1) {
  await deniedIndexedDbRuntime.putRecord('segments', {
    cacheKey: `quota-fallback-${index}`,
    bytes: 1024 * 1024,
    verifiedAt: new Date(index * 1000).toISOString(),
  })
}
assert.ok(memoryOnlyStores.segments.size <= 16, 'quota/permission fallback must retain at most the configured bounded memory volume')
assert.ok(
  [...memoryOnlyStores.segments.values()].reduce((sum, record) => sum + record.bytes, 0) <= 16 * 1024 * 1024,
  'many-record memory fallback must stay within its byte ceiling',
)

const quotaStores = { segments: new Map(), metadata: new Map() }
const quotaStatus = { localStorage: 'available', indexedDb: 'unknown', localStorageError: '', indexedDbError: '' }
const quotaDb = {
  close() {},
  transaction() {
    return {
      objectStore() {
        return {
          put() {
            const request = {}
            queueMicrotask(() => {
              const error = new Error('quota exhausted')
              error.name = 'QuotaExceededError'
              request.error = error
              request.onerror()
            })
            return request
          },
        }
      },
    }
  },
}
const quotaRuntime = new Function('memoryStores', 'storageStatus', 'storageErrorText', 'indexedDB', 'DB_NAME', 'DB_VERSION', 'dbPromise', 'state', 'DEFAULTS', 'clampCacheLimitMb', 'CACHE_LIMIT_MIN_MB', 'CACHE_LIMIT_MAX_MB', 'MEMORY_CACHE_MAX_MB', 'cachedSegmentByteLength', `${productionSlice('function storageMemoryStore(', 'function metadataScope(')}; return { putRecord }`)(
  quotaStores,
  quotaStatus,
  (error) => String(error?.message || error),
  {
    open() {
      const request = {}
      queueMicrotask(() => {
        request.result = quotaDb
        request.onsuccess()
      })
      return request
    },
  },
  'quota-db',
  5,
  null,
  { config: { cacheLimitMb: 16 } },
  { cacheLimitMb: 512 },
  identityRuntime.clampCacheLimitMb,
  16,
  2048,
  64,
  (record) => record.bytes,
)
assert.equal(await quotaRuntime.putRecord('segments', { cacheKey: 'quota', bytes: 1024, verifiedAt: new Date(0).toISOString() }), false)
assert.equal(quotaStatus.indexedDb, 'unavailable')
assert.equal(quotaStores.segments.has('quota'), true, 'quota failure should retain the verified payload only in bounded fallback memory')

const persistentStores = { segments: new Map(), metadata: new Map() }
const persistentStatus = { localStorage: 'available', indexedDb: 'unknown', localStorageError: '', indexedDbError: '' }
const persistentRuntime = new Function('memoryStores', 'storageStatus', 'storageErrorText', 'indexedDB', 'DB_NAME', 'DB_VERSION', 'dbPromise', 'state', 'DEFAULTS', 'clampCacheLimitMb', 'CACHE_LIMIT_MIN_MB', 'CACHE_LIMIT_MAX_MB', 'MEMORY_CACHE_MAX_MB', 'cachedSegmentByteLength', `${productionSlice('function storageMemoryStore(', 'function metadataScope(')}; return { putRecord }`)(
  persistentStores,
  persistentStatus,
  (error) => String(error?.message || error),
  {
    open() {
      const request = {}
      queueMicrotask(() => {
        request.result = {
          close() {},
          transaction() {
            return {
              objectStore() {
                return {
                  put() {
                    const putRequest = {}
                    queueMicrotask(() => putRequest.onsuccess())
                    return putRequest
                  },
                }
              },
            }
          },
        }
        request.onsuccess()
      })
      return request
    },
  },
  'persistent-db',
  5,
  null,
  { config: { cacheLimitMb: 16 } },
  { cacheLimitMb: 512 },
  identityRuntime.clampCacheLimitMb,
  16,
  2048,
  64,
  (record) => record.bytes,
)
assert.equal(await persistentRuntime.putRecord('segments', { cacheKey: 'persistent', bytes: 1024, payload: new Uint8Array(1024) }), true)
assert.equal(persistentStores.segments.size, 0, 'successful persistent payload writes must not be mirrored into RAM')

const migratedStoreNames = new Set(['segments', 'metadata', 'sidecars'])
const deletedLegacyStores = []
const createdSegmentIndexes = []
const clearedLegacyStores = []
const migrationSegmentStore = {
  indexNames: { contains: (name) => createdSegmentIndexes.includes(name) },
  createIndex(name) { createdSegmentIndexes.push(name) },
  clear() { clearedLegacyStores.push('segments') },
}
const migrationMetadataStore = { clear() { clearedLegacyStores.push('metadata') } }
const migrationDb = {
  objectStoreNames: { contains: (name) => migratedStoreNames.has(name) },
  createObjectStore(name) {
    migratedStoreNames.add(name)
    return name === 'segments' ? migrationSegmentStore : {}
  },
  deleteObjectStore(name) {
    deletedLegacyStores.push(name)
    migratedStoreNames.delete(name)
  },
  close() {},
}
const migrationRuntime = new Function('memoryStores', 'storageStatus', 'storageErrorText', 'indexedDB', 'DB_NAME', 'DB_VERSION', 'dbPromise', `${productionSlice('function storageMemoryStore(', 'function metadataScope(')}; return { openDb }`)(
  { segments: new Map(), metadata: new Map() },
  {
    localStorage: 'available',
    indexedDb: 'unknown',
    localStorageError: '',
    indexedDbError: '',
  },
  (error) => String(error?.message || error),
  {
    open(_name, version) {
      assert.equal(version, 7)
      const request = {
        oldVersion: 6,
        result: migrationDb,
        transaction: { objectStore: (name) => name === 'metadata' ? migrationMetadataStore : migrationSegmentStore },
      }
      queueMicrotask(() => {
        request.onupgradeneeded({ oldVersion: 6 })
        request.onsuccess()
      })
      return request
    },
  },
  'test-db',
  7,
  null,
)
assert.equal(await migrationRuntime.openDb(), migrationDb)
assert.deepEqual(deletedLegacyStores, ['sidecars'])
assert.equal(migratedStoreNames.has('sidecars'), false)
assert.deepEqual(createdSegmentIndexes, ['verifiedAt'])
assert.deepEqual(clearedLegacyStores, ['segments', 'metadata'], 'v7 upgrade must purge cache records that may persist credential-bearing archive URLs')

const storageMessageRuntime = new Function(`${productionSlice('function storageLimitationMessage(', 'async function initializeCachedState(')}; return { storageLimitationMessage }`)()
assert.match(
  storageMessageRuntime.storageLimitationMessage({
    localStorage: 'unavailable',
    indexedDb: 'available',
  }),
  /Saved settings are unavailable/,
)
assert.match(
  storageMessageRuntime.storageLimitationMessage({
    localStorage: 'available',
    indexedDb: 'unavailable',
  }),
  /network viewing remains available/,
)
assert.match(
  storageMessageRuntime.storageLimitationMessage({
    localStorage: 'unavailable',
    indexedDb: 'unavailable',
  }),
  /Settings and verified media will last only for this tab/,
)

const feeHistoryCalls = []
const productionFeeHistoryRuntime = new Function('rpc', 'BLOB_FEE_HISTORY_CHUNK_BLOCKS', 'toBlockHex', 'rpcQuantity', `${productionSlice('function rpcQuantityBigInt(', 'function cachedBlobFeeWindow(')}; return { fetchBlobFeeHistory }`)(
  async (method, params) => {
    feeHistoryCalls.push([method, params])
    assert.match(params[0], /^0x(?:0|[1-9a-f][0-9a-f]*)$/i)
    return {
      oldestBlock: params[1] === 'latest' ? '0x400' : '0x1',
      baseFeePerBlobGas: ['0x1'],
      blobGasUsedRatio: [0.25],
    }
  },
  1024,
  (value) => `0x${BigInt(value).toString(16)}`,
  ioRuntime.rpcQuantity,
)
await productionFeeHistoryRuntime.fetchBlobFeeHistory(1500)
assert.deepEqual(
  feeHistoryCalls.map(([, params]) => params[0]),
  ['0x400', '0x1dc'],
)
assert.equal(feeHistoryCalls[1][1][1], '0x3ff')

const abiWordHex = (value) => BigInt(value).toString(16).padStart(64, '0')
const validAbiArray = `${abiWordHex(32)}${abiWordHex(2)}${'1'.repeat(64)}${'2'.repeat(64)}`
assert.deepEqual(ioRuntime.readBytes32Array(validAbiArray, 0), [`0x${'1'.repeat(64)}`, `0x${'2'.repeat(64)}`])
const millionLengthAbiArray = `${abiWordHex(32)}${abiWordHex(1_000_000)}`
assert.throws(() => ioRuntime.readBytes32Array(millionLengthAbiArray, 0), /exceeds 6 entries/)
const truncatedAbiArray = `${abiWordHex(32)}${abiWordHex(6)}${'1'.repeat(64)}`
assert.throws(() => ioRuntime.readBytes32Array(truncatedAbiArray, 0), /extends past ABI data/)
assert.throws(() => ioRuntime.readString(`${abiWordHex(2 ** 20)}${abiWordHex(0)}`, 0), /dynamic offset extends past ABI data/)
assert.throws(() => ioRuntime.readString(`${abiWordHex(32)}${abiWordHex(4_097)}`, 0), /string exceeds 4096 bytes/, 'ABI decoder string ceiling must match configured identity ceiling')

const exactBlobHex = `0x${'00'.repeat(131_072)}`
assert.equal(ioRuntime.isBlobHex(exactBlobHex), true)
assert.equal(ioRuntime.isBlobHex(exactBlobHex.slice(0, -2)), false)
assert.equal(ioRuntime.isBlobHex(`${exactBlobHex}00`), false)

let oversizedBodyRead = false
await assert.rejects(
  ioRuntime.readBoundedResponseBytes(
    {
      headers: { get: () => '1000' },
      body: {
        getReader: () => ({
          read: async () => {
            oversizedBodyRead = true
            return { done: true }
          },
        }),
      },
    },
    100,
    'Oversized',
  ),
  /exceeds 100 bytes/,
)
assert.equal(oversizedBodyRead, false)
let cancelledOversizedStream = false
const streamedChunks = [new Uint8Array(3), new Uint8Array(3)]
await assert.rejects(
  ioRuntime.readBoundedResponseBytes(
    {
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => (streamedChunks.length ? { done: false, value: streamedChunks.shift() } : { done: true }),
          cancel: async () => {
            cancelledOversizedStream = true
          },
        }),
      },
    },
    4,
    'Streamed',
  ),
  /exceeds 4 bytes/,
)
assert.equal(cancelledOversizedStream, true)
let cancelledStalledStream = false
await assert.rejects(
  ioRuntime.readBoundedResponseBytes({
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => { cancelledStalledStream = true },
      }),
    },
  }, 100, 'Stalled', { timeoutMs: 5 }),
  (error) => error?.name === 'TimeoutError' && /5 ms/.test(error.message),
)
assert.equal(cancelledStalledStream, true, 'stalled response streams must be cancelled at the total body deadline')
assert.match(fs.readFileSync(new URL('../public/decentralized/static-client-io.js', import.meta.url), 'utf8'), /performance\?\.now/, 'response deadline must use a monotonic clock when the platform provides one')
const bodyAbortController = new AbortController()
let cancelledAbortedStream = false
const abortedBodyRead = ioRuntime.readBoundedResponseBytes({
  headers: { get: () => null },
  body: {
    getReader: () => ({
      read: () => new Promise(() => {}),
      cancel: async () => { cancelledAbortedStream = true },
    }),
  },
}, 100, 'Cancelled', { signal: bodyAbortController.signal, timeoutMs: 1_000 })
bodyAbortController.abort()
await assert.rejects(abortedBodyRead, (error) => error?.name === 'AbortError')
assert.equal(cancelledAbortedStream, true, 'parent cancellation must cancel a stalled response body immediately')
const validJsonBytes = new TextEncoder().encode('{"ok":true}')
assert.deepEqual(
  await ioRuntime.readBoundedJsonResponse(
    {
      headers: { get: () => String(validJsonBytes.byteLength) },
      body: {
        getReader: () => {
          let sent = false
          return {
            read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: validJsonBytes })),
          }
        },
      },
    },
    100,
    'JSON',
  ),
  { ok: true },
)
await assert.rejects(
  ioRuntime.readBoundedResponseBytes(
    {
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array(1).buffer,
    },
    100,
    'No-stream',
  ),
  /without a streaming body/,
)
assert.throws(() => ioRuntime.responseContentLength({ headers: { get: () => '1e3' } }, 'Malformed'), /invalid Content-Length/)
assert.throws(() => ioRuntime.responseContentLength({ headers: { get: () => '9'.repeat(10_000) } }, 'Oversized'), /safe integer range/, 'oversized Content-Length must reject before decimal regex scanning')
await assert.rejects(ioRuntime.readBoundedResponseBytes({}, -1, 'Negative'), /Invalid Negative response limit/)
let cancelledNonBytes = false
await assert.rejects(ioRuntime.readBoundedResponseBytes({
  headers: { get: () => null },
  body: { getReader: () => ({ read: async () => ({ done: false, value: 'not bytes' }), cancel: async () => { cancelledNonBytes = true } }) },
}, 100, 'Malformed'), /non-byte chunk/)
assert.equal(cancelledNonBytes, true)
assert.throws(() => ioRuntime.rpcQuantity('0x00', 'quantity'), /JSON-RPC quantity/)
assert.throws(() => ioRuntime.rpcQuantity(`0x1${'0'.repeat(64)}`, 'quantity'), /256-bit/)
assert.equal(ioRuntime.rpcQuantity(`0x${'f'.repeat(64)}`, 'quantity'), (1n << 256n) - 1n)
assert.throws(() => ioRuntime.rpcQuantityNumber('0x20000000000000', 'quantity'), /safe integer/)
assert.throws(() => ioRuntime.concatBytes([new Uint8Array([1])], 2), /length mismatch/)

const hostileGenesisRuntime = new Function('beacon', 'decimalSafeInteger', `${productionSlice('async function beaconGenesisTime(', 'function slotTimestampMs(')}; return { beaconGenesisTime }`)(
  async () => ({ genesis_time: '9'.repeat(100_000) }),
  (value, label) => {
    if (typeof value !== 'string' || value.length > 16 || !/^\d+$/.test(value)) throw new Error(`${label} must be a bounded decimal string`)
    return Number(value)
  },
)
await assert.rejects(hostileGenesisRuntime.beaconGenesisTime(), /bounded decimal string/, 'oversized beacon genesis time must reject before decimal regex scanning')

let normalizedHostileReceiptField = false
const receiptRuntime = new Function('state', 'normalizeHex', 'isAddressHex', 'isBytes32Hex', 'EVENT_TOPIC', 'MAX_RPC_LOGS', 'decodeSegmentLog', `${productionSlice('function receiptStationSegments(', 'function segmentOrder(')}; return { receiptStationSegments }`)(
  { config: { stationAddress: '0x0000000000000000000000000000000000000001' } },
  (value) => {
    if (String(value).length > 100) normalizedHostileReceiptField = true
    return String(value || '').toLowerCase()
  },
  (value) => typeof value === 'string' && value.length === 42 && /^0x[0-9a-fA-F]{40}$/.test(value),
  identityRuntime.isBytes32Hex,
  '0xfd61253da387da4d87d036a0276340bc4f04ff7c1173999c8392b158030f04c3',
  10_000,
  () => ({ decoded: true }),
)
assert.deepEqual(receiptRuntime.receiptStationSegments({ logs: [{ address: `0x${'1'.repeat(100_000)}`, topics: [`0x${'2'.repeat(100_000)}`] }] }), [])
assert.equal(normalizedHostileReceiptField, false, 'receipt prefilter must reject oversized address/topic fields before lowercasing')
assert.throws(() => receiptRuntime.receiptStationSegments({ logs: Array.from({ length: 10_001 }) }), /exceed 10000 entries/)
const inboxBlockSource = productionSlice('async function blockBlobTransactions(', 'function classifyInboxDiscoveryFailure(')
assert.match(inboxBlockSource, /blockNumberValue !== nonNegativeSafeInteger\(blockNumber/)
assert.match(inboxBlockSource, /!isBytes32Hex\(block\.hash\)/)
assert.match(inboxBlockSource, /!isAddressHex\(tx\?\.to\)/, 'inbox transaction destination must reject by width before normalization')
assert.match(inboxBlockSource, /!isBytes32Hex\(tx\.hash\)/)
assert.match(inboxBlockSource, /seenHashes\.has\(txHash\) \|\| seenIndices\.has\(transactionIndex\)/)
let inboxBlockResponse = null
let normalizedOversizedInboxField = false
const inboxBlockRuntime = new Function('rpc', 'toBlockHex', 'MAX_RPC_LOGS', 'normalizeHex', 'isAddressHex', 'rpcQuantityNumber', 'nonNegativeSafeInteger', 'isBytes32Hex', 'timestampMsFromSeconds', 'txBlobVersionedHashes', `${inboxBlockSource}; return { blockBlobTransactions }`)(
  async () => inboxBlockResponse,
  (value) => `0x${BigInt(value).toString(16)}`,
  10_000,
  (value) => {
    if (String(value || '').length > 100) normalizedOversizedInboxField = true
    return String(value || '').toLowerCase()
  },
  (value) => typeof value === 'string' && value.length === 42 && /^0x[0-9a-fA-F]{40}$/.test(value),
  (value) => Number(BigInt(value)),
  (value) => Number(value),
  identityRuntime.isBytes32Hex,
  () => 0,
  (tx) => tx.hashes || [],
)
inboxBlockResponse = { number: '0x2', hash: `0x${'1'.repeat(64)}`, timestamp: '0x0', transactions: [] }
await assert.rejects(inboxBlockRuntime.blockBlobTransactions(1, '0x0000000000000000000000000000000000000001'), /different block number/)
inboxBlockResponse = {
  number: '0x1',
  hash: `0x${'1'.repeat(64)}`,
  timestamp: '0x0',
  transactions: [
    { to: `0x${'a'.repeat(100_000)}`, hash: `0x${'2'.repeat(64)}`, transactionIndex: '0x0', hashes: [`0x${'5'.repeat(64)}`] },
    { to: '0x0000000000000000000000000000000000000001', hash: `0x${'2'.repeat(64)}`, transactionIndex: '0x0', hashes: [`0x${'5'.repeat(64)}`] },
    { to: '0x0000000000000000000000000000000000000001', hash: `0x${'3'.repeat(64)}`, transactionIndex: '0x0', hashes: [`0x${'6'.repeat(64)}`] },
  ],
}
await assert.rejects(inboxBlockRuntime.blockBlobTransactions(1, '0x0000000000000000000000000000000000000001'), /duplicate blob transaction identity/)
assert.equal(normalizedOversizedInboxField, false)
let normalizedOversizedBlobHash = false
const blobHashRuntime = new Function('MAX_SEGMENT_BLOBS', 'isBytes32Hex', 'normalizeHex', `${productionSlice('function normalizeBlobVersionedHashes(', 'function txBlobVersionedHashes(')}; return { normalizeBlobVersionedHashes }`)(
  6,
  identityRuntime.isBytes32Hex,
  (value) => {
    if (String(value || '').length > 100) normalizedOversizedBlobHash = true
    return String(value || '').toLowerCase()
  },
)
assert.throws(() => blobHashRuntime.normalizeBlobVersionedHashes([`0x${'f'.repeat(100_000)}`]), /unique bytes32/)
assert.equal(normalizedOversizedBlobHash, false, 'oversized blob hash must reject before lowercasing')
assert.deepEqual(blobHashRuntime.normalizeBlobVersionedHashes([`0x${'A'.repeat(64)}`]), [`0x${'a'.repeat(64)}`])
assert.equal(mediaRuntime.normalizeSidecarRecord({ slot: 1, sidecars: [] }, 1)?.slot, 1)
assert.match(productionSlice('function parseRfe1Envelope(', 'async function blockBlobTransactions('), /!isBytes32Hex\(header\.payloadSha256\)[\s\S]*normalizeHex\(header\.payloadSha256\)/)
assert.match(productionSlice('async function inboxSegmentFromSidecar(', 'async function scanBlobInboxStreams('), /!isBytes32Hex\(sidecar\?\.versionedHash\)[\s\S]*normalizeHex\(sidecar\.versionedHash\)/)

const normalizeHexValue = (value) => String(value || '').toLowerCase()
const sidecarHash = `0x${'1'.repeat(64)}`
const sidecarCommitment = `0x${'2'.repeat(96)}`
const beaconArrayRuntime = new Function('MAX_BLOBS_PER_BLOCK', `${productionSlice('function beaconDataArray(', 'function decimalSafeInteger(')}; return { beaconDataArray }`)(21)
let sidecarRows = []
let persistedSidecars = 0
let beaconSidecarCalls = 0
let delaySidecarFetch = false
let releaseSidecarFetch
const sidecarState = {
  runtimeGeneration: 0,
  sidecarCacheEpoch: 0,
  config: { chainPreset: 'sepolia' },
  sidecarMemoryCache: new Map(),
  sidecarFetchPromises: new Map(),
}
const sidecarRuntime = new Function('state', 'slotSidecarsKey', 'normalizeHex', 'isBytes32Hex', 'isBytes48Hex', 'isBlobHex', 'MAX_BLOBS_PER_BLOCK', 'beaconDataArray', 'beacon', 'BLOB_BYTES', 'sidecarVersionedHash', 'requestAbortError', 'MAX_SIDECAR_MEMORY_SLOTS', 'normalizeSidecarRecord', 'sidecarIndex', 'nonNegativeSafeInteger', `${productionSlice('async function sidecarsForSlot(', 'async function sidecarsForSegment(')}; return { normalizeSidecarRecord, sidecarsForSlot }`)(
  sidecarState,
  (slot) => `slot:${slot}`,
  normalizeHexValue,
  (value) => /^0x[0-9a-fA-F]{64}$/.test(String(value || '')),
  (value) => /^0x[0-9a-fA-F]{96}$/.test(String(value || '')),
  ioRuntime.isBlobHex,
  21,
  beaconArrayRuntime.beaconDataArray,
  async () => {
    beaconSidecarCalls += 1
    if (delaySidecarFetch)
      await new Promise((resolve) => {
        releaseSidecarFetch = resolve
      })
    return sidecarRows
  },
  131_072,
  async (sidecar) => `0x${(Number(sidecar.index) + 1).toString(16).padStart(64, '0')}`,
  (message) => new DOMException(message, 'AbortError'),
  12,
  mediaRuntime.normalizeSidecarRecord,
  mediaRuntime.sidecarIndex,
  (value, label) => {
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative safe integer`)
    return number
  },
)
const realisticSlot = 12_345_678
sidecarRows = Array.from({ length: 22 }, (_, index) => ({
  index,
  blob: exactBlobHex,
  kzg_commitment: sidecarCommitment,
}))
await assert.rejects(sidecarRuntime.sidecarsForSlot(realisticSlot), /exceeds 21 entries/)
assert.equal(persistedSidecars, 0)
sidecarRows = [{ index: 0, blob: '0x00', kzg_commitment: sidecarCommitment }]
await assert.rejects(sidecarRuntime.sidecarsForSlot(realisticSlot), /exactly 131072 bytes/)
assert.equal(persistedSidecars, 0)
sidecarRows = Array.from({ length: 21 }, (_, index) => ({
  index,
  blob: exactBlobHex,
  kzg_commitment: sidecarCommitment,
}))
const validSidecarRecord = await sidecarRuntime.sidecarsForSlot(realisticSlot)
assert.equal(validSidecarRecord.slot, realisticSlot)
assert.equal(validSidecarRecord.sidecars.length, 21)
assert.equal(persistedSidecars, 0)
const callsAfterNetworkRecord = beaconSidecarCalls
const cachedSidecarRecord = await sidecarRuntime.sidecarsForSlot(realisticSlot)
assert.equal(cachedSidecarRecord.slot, realisticSlot)
assert.equal(cachedSidecarRecord.sidecars.length, 21)
assert.equal(beaconSidecarCalls, callsAfterNetworkRecord)
sidecarState.sidecarMemoryCache.clear()
await sidecarRuntime.sidecarsForSlot(realisticSlot)
assert.equal(beaconSidecarCalls, callsAfterNetworkRecord + 1)
assert.equal(persistedSidecars, 0)

sidecarState.sidecarMemoryCache.clear()
const windowSlots = Array.from({ length: 10 }, (_, index) => realisticSlot + index)
let retainedActiveRecord
for (const slot of windowSlots) {
  const record = await sidecarRuntime.sidecarsForSlot(slot)
  if (slot === windowSlots[0]) retainedActiveRecord = record
}
const callsAfterFirstWindow = beaconSidecarCalls
for (const slot of windowSlots) await sidecarRuntime.sidecarsForSlot(slot)
assert.equal(beaconSidecarCalls, callsAfterFirstWindow)
for (let index = 10; index < 15; index += 1) await sidecarRuntime.sidecarsForSlot(realisticSlot + index)
assert.equal(sidecarState.sidecarMemoryCache.size, 12)
assert.equal(sidecarState.sidecarMemoryCache.has(`slot:${windowSlots[0]}`), false)
assert.equal(retainedActiveRecord.sidecars.length, 21)
const callsBeforeEvictedRefetch = beaconSidecarCalls
await sidecarRuntime.sidecarsForSlot(windowSlots[0])
assert.equal(beaconSidecarCalls, callsBeforeEvictedRefetch + 1)
assert.equal(persistedSidecars, 0)
delaySidecarFetch = true
const clearedSlotKey = `slot:${realisticSlot + 100}`
const clearedSidecarFetch = sidecarRuntime.sidecarsForSlot(realisticSlot + 100)
await Promise.resolve()
sidecarState.sidecarMemoryCache.clear()
sidecarState.sidecarFetchPromises.clear()
sidecarState.sidecarCacheEpoch += 1
releaseSidecarFetch()
await assert.rejects(clearedSidecarFetch, (error) => error?.name === 'AbortError')
assert.equal(sidecarState.sidecarMemoryCache.has(clearedSlotKey), false)
assert.equal(sidecarState.sidecarFetchPromises.has(clearedSlotKey), false)
delaySidecarFetch = false
assert.equal(
  sidecarRuntime.normalizeSidecarRecord(
    {
      slot: realisticSlot,
      sidecars: [
        {
          index: 0,
          versionedHash: sidecarHash,
          commitment: sidecarCommitment,
          blob: exactBlobHex,
        },
        {
          index: 0,
          versionedHash: `0x${'3'.repeat(64)}`,
          commitment: sidecarCommitment,
          blob: exactBlobHex,
        },
      ],
    },
    realisticSlot,
  ),
  null,
)

const reconstructionRuntime = mediaRuntime
const reconstructionSegment = {
  blobVersionedHashes: [sidecarHash],
  payloadBytes: 4,
}
const reconstructionSidecars = {
  matches: [{ index: 20, versionedHash: sidecarHash, blob: exactBlobHex }],
}
assert.equal((await reconstructionRuntime.reconstructPayload(reconstructionSegment, reconstructionSidecars)).byteLength, 4)
await assert.rejects(
  reconstructionRuntime.reconstructPayload(reconstructionSegment, {
    matches: Array.from({ length: 7 }, (_, index) => ({
      index,
      versionedHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
      blob: exactBlobHex,
    })),
  }),
  /matches exceed 6/,
)
await assert.rejects(
  reconstructionRuntime.reconstructPayload(
    {
      ...reconstructionSegment,
      payloadBytes: 126_977,
    },
    reconstructionSidecars,
  ),
  /truncated: expected 126977 bytes, decoded 126976/,
)
await assert.rejects(
  reconstructionRuntime.reconstructPayload(reconstructionSegment, {
    matches: [{ index: 0, versionedHash: sidecarHash, blob: exactBlobHex.slice(0, -2) }],
  }),
  /Invalid sidecar match/,
)

let verifiedArchivePayloads = 0
let archiveResponseBytes = new Uint8Array([1, 2, 3])
const archivePayloadRuntime = new Function('state', 'segmentPayloadLength', 'fetchWithTimeout', 'readBoundedResponseBytes', 'verifyPayloadHash', 'isAbortError', 'publicUrlLabel', 'publicErrorMessage', 'archiveUrl', `${productionSlice('async function payloadFromArchive(', 'async function payloadFromBeacon(')}; return { payloadFromArchive }`)(
  { config: { archiveTemplates: ['https://archive.invalid/{sequence}'] } },
  reconstructionRuntime.segmentPayloadLength,
  async () => ({
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => {
        let sent = false
        return {
          read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: archiveResponseBytes })),
        }
      },
    },
  }),
  ioRuntime.readBoundedResponseBytes,
  async () => {
    verifiedArchivePayloads += 1
  },
  (error) => error?.name === 'AbortError',
  () => 'archive.invalid',
  (error) => error.message,
  mediaRuntime.archiveUrl,
)
await assert.rejects(
  archivePayloadRuntime.payloadFromArchive({
    ...reconstructionSegment,
    sequence: 1,
    streamId: 'x',
    txHash: sidecarHash,
    payloadSha256: '0'.repeat(64),
  }),
  /length mismatch/,
)
assert.equal(verifiedArchivePayloads, 0)
archiveResponseBytes = new Uint8Array([1, 2, 3, 4])
assert.equal(
  (
    await archivePayloadRuntime.payloadFromArchive({
      ...reconstructionSegment,
      sequence: 1,
      streamId: 'x',
      txHash: sidecarHash,
      payloadSha256: '0'.repeat(64),
    })
  ).payload.byteLength,
  4,
)
assert.equal(verifiedArchivePayloads, 1)

const cachedPayloadRuntime = new Function('MAX_SEGMENT_PAYLOAD_BYTES', 'ArrayBuffer', 'Blob', `${productionSlice('async function cachedPayloadBytes(', 'async function verifySegment(')}; return { cachedPayloadBytes }`)(6 * 126_976, ArrayBuffer, Blob)
await assert.rejects(cachedPayloadRuntime.cachedPayloadBytes(new Blob([new Uint8Array(5)]), 4), /exceeds 4 bytes/)
assert.equal((await cachedPayloadRuntime.cachedPayloadBytes(new Uint8Array(4), 4)).byteLength, 4)

const lifecycleStatuses = []
const lifecycleState = {
  runtimeGeneration: 0,
  runtimeController: new AbortController(),
}
const lifecycleRuntime = new Function('state', 'setStatus', 'requestAbortError', `${productionSlice('function runtimeSnapshot()', 'function archiveDefaultMessage(')}; return { runtimeSnapshot, runtimeIsCurrent, requireCurrentRuntime, setRuntimeStatus }`)(
  lifecycleState,
  (value) => lifecycleStatuses.push(value),
  (message) => {
    const error = new Error(message)
    error.name = 'AbortError'
    return error
  },
)
const staleLifecycle = lifecycleRuntime.runtimeSnapshot()
let releaseDelayedLifecycle
const delayedLifecycleMutation = (async () => {
  await new Promise((resolve) => {
    releaseDelayedLifecycle = resolve
  })
  lifecycleRuntime.requireCurrentRuntime(staleLifecycle)
  lifecycleStatuses.push('stale mutation')
})()
lifecycleState.runtimeController.abort()
lifecycleState.runtimeGeneration += 1
lifecycleState.runtimeController = new AbortController()
releaseDelayedLifecycle()
await assert.rejects(delayedLifecycleMutation, (error) => error?.name === 'AbortError')
assert.equal(lifecycleRuntime.setRuntimeStatus(staleLifecycle, 'stale status'), false)
assert.deepEqual(lifecycleStatuses, [])

const urlRevocations = []
let nextObjectUrl = 0
const urlLifecycleState = {
  objectUrls: new Map(),
  deferredObjectUrlKeys: new Set(),
  currentRecordKey: '',
}
const urlLifecycleEls = { player: { currentSrc: '' } }
const urlLifecycleRuntime = new Function('state', 'URL', 'Blob', 'els', `${productionSlice('function objectUrl(', 'function prepareAudioForPlayback(')}; return { objectUrl, releaseObjectUrl, revokeDeferredObjectUrls, revokeAllObjectUrls }`)(
  urlLifecycleState,
  {
    createObjectURL: () => `blob:test-${++nextObjectUrl}`,
    revokeObjectURL: (url) => urlRevocations.push(url),
  },
  Blob,
  urlLifecycleEls,
)
const activeUrl = urlLifecycleRuntime.objectUrl({
  cacheKey: 'active',
  payload: new Uint8Array([1]),
})
const inactiveUrl = urlLifecycleRuntime.objectUrl({
  cacheKey: 'inactive',
  payload: new Uint8Array([2]),
})
urlLifecycleState.currentRecordKey = 'active'
urlLifecycleEls.player.currentSrc = activeUrl
assert.equal(urlLifecycleRuntime.releaseObjectUrl('active', { preserveActive: true }), false)
assert.equal(urlLifecycleState.objectUrls.get('active'), activeUrl)
assert.equal(urlLifecycleRuntime.releaseObjectUrl('inactive', { preserveActive: true }), true)
assert.deepEqual(urlRevocations, [inactiveUrl])
urlLifecycleRuntime.revokeDeferredObjectUrls('next')
assert.deepEqual(urlRevocations, [inactiveUrl, activeUrl])
for (let index = 0; index < 100; index += 1) {
  const key = `evicted-${index}`
  urlLifecycleRuntime.objectUrl({
    cacheKey: key,
    payload: new Uint8Array([index]),
  })
  urlLifecycleRuntime.releaseObjectUrl(key, { preserveActive: true })
}
assert.equal(urlLifecycleState.objectUrls.size, 0)
assert.equal(urlRevocations.length, 102)

const activeCanonicalSegment = {
  cacheKey: 'active',
  blockHash: `0x${'11'.repeat(32)}`,
  blockNumber: 100,
  transactionIndex: 1,
  logIndex: 2,
  txHash: `0x${'22'.repeat(32)}`,
  sequence: 7,
  payloadSha256: '33'.repeat(32),
  blobVersionedHashes: [`0x${'44'.repeat(32)}`],
}
const orphanPlayerCalls = []
const orphanState = {
  currentRecordKey: 'active',
  segments: [activeCanonicalSegment],
  playbackContextGeneration: 3,
  playbackAdvanceToken: 9,
  prefetching: new Set(['next']),
  prefetchPromises: new Map([['next', Promise.resolve()]]),
  liveEdgeKey: 'active',
  playbackMode: 'live',
}
const releasedOrphanUrls = []
const orphanRuntime = new Function('state', 'normalizeHex', 'requestAbortError', 'segmentIsQuarantined', 'els', 'releaseObjectUrl', `${productionSlice('function sameCanonicalSegment(', 'function safeSessionJsonObject(')}; return { sameCanonicalSegment, playbackContextSnapshot, requireCurrentPlaybackContext, invalidateOrphanedActivePlayback }`)(
  orphanState,
  normalizeHex,
  (message) => new DOMException(message, 'AbortError'),
  (segment) => Boolean(segment?.quarantined),
  {
    player: {
      pause: () => orphanPlayerCalls.push('pause'),
      removeAttribute: (name) => orphanPlayerCalls.push(`remove:${name}`),
      load: () => orphanPlayerCalls.push('load'),
    },
  },
  (key) => releasedOrphanUrls.push(key),
)
assert.equal(orphanRuntime.invalidateOrphanedActivePlayback([{ ...activeCanonicalSegment }]), false, 'unchanged canonical identity must keep active media')
assert.deepEqual(orphanPlayerCalls, [])
const priorPlaybackContext = orphanRuntime.playbackContextSnapshot()
const reorgReplacement = { ...activeCanonicalSegment, blockHash: `0x${'55'.repeat(32)}` }
assert.equal(orphanRuntime.invalidateOrphanedActivePlayback([reorgReplacement]), true, 'same-key re-inclusion at another block must invalidate active media')
assert.deepEqual(orphanPlayerCalls, ['pause', 'remove:src', 'load'])
assert.deepEqual(releasedOrphanUrls, ['active'])
assert.equal(orphanState.currentRecordKey, '')
assert.equal(orphanState.liveEdgeKey, '')
assert.equal(orphanState.playbackMode, 'interrupted')
assert.equal(orphanState.prefetching.size, 0)
assert.equal(orphanState.prefetchPromises.size, 0)
assert.throws(() => orphanRuntime.requireCurrentPlaybackContext(priorPlaybackContext), (error) => error?.name === 'AbortError')

const oldTimestampHash = `0x${'61'.repeat(32)}`
const replacementTimestampHash = `0x${'62'.repeat(32)}`
const timestampState = {
  blockTimes: new Map([[oldTimestampHash, 1_000]]),
  blockTimeHashes: new Map([[77, oldTimestampHash]]),
}
const timestampRpcCalls = []
const timestampRuntime = new Function('state', 'unique', 'isBytes32Hex', 'normalizeHex', 'rpc', 'rpcQuantityNumber', 'timestampMsFromSeconds', 'isAbortError', 'MAX_BLOCK_TIME_CACHE_ENTRIES', 'MAX_BLOCK_TIME_REQUEST_CONCURRENCY', `${productionSlice('async function runBoundedTasks(', 'function receiptStationSegments(')}; return { runBoundedTasks, cacheBlockTimestamp, hydrateSegmentTimes }`)(
  timestampState,
  (values) => [...new Set(values)],
  identityRuntime.isBytes32Hex,
  normalizeHex,
  async (method, params) => {
    timestampRpcCalls.push([method, params])
    return { hash: replacementTimestampHash, number: '0x4d', timestamp: '0x2' }
  },
  (value) => Number(BigInt(value)),
  (value) => Number(BigInt(value)) * 1000,
  (error) => error?.name === 'AbortError',
  2,
  2,
)
let activeTimestampTasks = 0
let maximumTimestampTasks = 0
await timestampRuntime.runBoundedTasks(Array.from({ length: 9 }), 3, async () => {
  activeTimestampTasks += 1
  maximumTimestampTasks = Math.max(maximumTimestampTasks, activeTimestampTasks)
  await Promise.resolve()
  activeTimestampTasks -= 1
})
assert.equal(maximumTimestampTasks, 3, 'bounded task runner must not exceed configured concurrency')
await assert.rejects(timestampRuntime.runBoundedTasks([1], 0, async () => {}), /positive safe integer/)
const oldTimestampSegment = { blockNumber: 77, blockHash: oldTimestampHash }
const replacementTimestampSegment = { blockNumber: 77, blockHash: replacementTimestampHash }
await timestampRuntime.hydrateSegmentTimes([oldTimestampSegment, replacementTimestampSegment])
assert.deepEqual(timestampRpcCalls, [['eth_getBlockByHash', [replacementTimestampHash, false]]])
assert.equal(oldTimestampSegment.createdAt, new Date(1_000).toISOString())
assert.equal(replacementTimestampSegment.createdAt, new Date(2_000).toISOString())
assert.equal(timestampState.blockTimeHashes.get(77), replacementTimestampHash, 'same-height pointer must advance to the validated canonical hash')
assert.equal(timestampState.blockTimes.has(oldTimestampHash), false, 'same-height replacement must release the orphan hash entry after segment hydration')
const nextTimestampHash = `0x${'63'.repeat(32)}`
const newestTimestampHash = `0x${'64'.repeat(32)}`
timestampRuntime.cacheBlockTimestamp(78, nextTimestampHash, 3_000)
timestampRuntime.cacheBlockTimestamp(79, newestTimestampHash, 4_000)
assert.deepEqual([...timestampState.blockTimes.keys()], [nextTimestampHash, newestTimestampHash], 'timestamp cache must evict oldest hashes at its bound')
assert.equal(timestampState.blockTimeHashes.has(77), false, 'timestamp pointer must be evicted with its hash')

const mismatchTimestampState = { blockTimes: new Map(), blockTimeHashes: new Map() }
const mismatchTimestampRuntime = new Function('state', 'unique', 'isBytes32Hex', 'normalizeHex', 'rpc', 'rpcQuantityNumber', 'timestampMsFromSeconds', 'isAbortError', 'MAX_BLOCK_TIME_CACHE_ENTRIES', 'MAX_BLOCK_TIME_REQUEST_CONCURRENCY', `${productionSlice('async function runBoundedTasks(', 'function receiptStationSegments(')}; return { hydrateSegmentTimes }`)(
  mismatchTimestampState,
  (values) => [...new Set(values)],
  identityRuntime.isBytes32Hex,
  normalizeHex,
  async () => ({ hash: oldTimestampHash, number: '0x4d', timestamp: '0x3' }),
  (value) => Number(BigInt(value)),
  (value) => Number(BigInt(value)) * 1000,
  (error) => error?.name === 'AbortError',
  2,
  2,
)
const mismatchedTimestampSegment = { blockNumber: 77, blockHash: replacementTimestampHash }
await mismatchTimestampRuntime.hydrateSegmentTimes([mismatchedTimestampSegment])
assert.equal(mismatchedTimestampSegment.createdAt, undefined)
assert.equal(mismatchTimestampState.blockTimes.size, 0, 'provider hash mismatch must not populate the timestamp cache')

const resetPlayerCalls = []
const resetController = new AbortController()
const resetState = {
  runtimeController: resetController,
  runtimeGeneration: 4,
  archive: { activeController: new AbortController(), scanning: true },
  refreshSerial: 0,
  refreshSpinToken: 0,
  playbackAdvanceToken: 0,
  playbackContextGeneration: 7,
  busy: true,
  blobspaceRefreshPromise: Promise.resolve(),
  anchor: {},
  segments: [{}],
  verified: new Map([['old', {}]]),
  prefetching: new Set(['old']),
  prefetchPromises: new Map([['old', Promise.resolve()]]),
  segmentNotice: 'old',
  blockTimes: new Map([['old', 1]]),
  blockTimeHashes: new Map([[1, 'old']]),
  sidecarMemoryCache: new Map([['old', {}]]),
  sidecarFetchPromises: new Map([['old', Promise.resolve()]]),
  sidecarCacheEpoch: 2,
  activeExecutionRpc: 'old',
  activeBeaconApi: 'old',
  config: { executionRpcs: ['new'], beaconApis: ['new'] },
  endpointHealth: {},
  metadataUpdatedAt: 'old',
  metadataState: 'fresh',
  currentRecordKey: 'old',
  playbackMode: 'live',
  playbackIntent: 'follow',
  liveEdgeKey: 'old',
  followIntent: true,
  selectedSegmentQuery: 'old',
  blobspace: {},
  blobFees: { samples: [] },
}
let resetRevokedAll = 0
const resetRuntime = new Function('state', 'requestAbortError', 'AbortController', 'els', 'revokeAllObjectUrls', 'defaultBlobspaceRows', 'loadBlobFeeSamples', `${productionSlice('function resetRuntimeState()', 'function applyPreset(')}; return { resetRuntimeState }`)(
  resetState,
  (message) => new DOMException(message, 'AbortError'),
  AbortController,
  {
    player: {
      pause: () => resetPlayerCalls.push('pause'),
      removeAttribute: (name) => resetPlayerCalls.push(`remove:${name}`),
      load: () => resetPlayerCalls.push('load'),
    },
    refresh: { disabled: true, classList: { remove: () => {} } },
    headBlock: { textContent: '' },
    headSlot: { textContent: '' },
  },
  () => {
    resetRevokedAll += 1
  },
  () => [],
  () => ({ samples: [] }),
)
resetRuntime.resetRuntimeState()
assert.equal(resetController.signal.aborted, true)
assert.equal(resetState.runtimeGeneration, 5)
assert.equal(resetState.playbackContextGeneration, 8)
assert.deepEqual(resetPlayerCalls, ['pause', 'remove:src', 'load'])
assert.equal(resetState.currentRecordKey, '')
assert.equal(resetState.prefetchPromises.size, 0)
assert.equal(resetState.blockTimes.size, 0)
assert.equal(resetState.blockTimeHashes.size, 0)
assert.equal(resetState.verified.size, 0)
assert.equal(resetState.sidecarMemoryCache.size, 0)
assert.equal(resetState.sidecarFetchPromises.size, 0)
assert.equal(resetState.sidecarCacheEpoch, 3)
assert.equal(resetRevokedAll, 1)

let releaseMetadataWrite
const metadataLifecycleState = {
  runtimeGeneration: 1,
  runtimeController: new AbortController(),
  config: { chainPreset: 'sepolia', stationAddress: '0x1', streamId: 'stream' },
  metadataUpdatedAt: '',
  metadataState: 'none',
}
const metadataLifecycleRuntime = new Function('state', 'runtimeSnapshot', 'requireCurrentRuntime', 'metadataScope', 'putRecord', `${productionSlice('async function cacheSegmentMetadata(', 'async function restoreSegmentMetadata(')}; return { cacheSegmentMetadata }`)(
  metadataLifecycleState,
  () => ({
    generation: metadataLifecycleState.runtimeGeneration,
    signal: metadataLifecycleState.runtimeController.signal,
  }),
  (runtime) => {
    if (runtime.generation !== metadataLifecycleState.runtimeGeneration || runtime.signal.aborted) {
      const error = new Error('stale')
      error.name = 'AbortError'
      throw error
    }
  },
  () => ({
    cacheKey: 'metadata',
    chainPreset: 'sepolia',
    stationAddress: '0x1',
    streamId: 'stream',
  }),
  () =>
    new Promise((resolve) => {
      releaseMetadataWrite = resolve
    }),
)
const delayedMetadataWrite = metadataLifecycleRuntime.cacheSegmentMetadata([])
metadataLifecycleState.runtimeController.abort()
metadataLifecycleState.runtimeGeneration += 1
metadataLifecycleState.runtimeController = new AbortController()
releaseMetadataWrite()
await assert.rejects(delayedMetadataWrite, (error) => error?.name === 'AbortError')
assert.equal(metadataLifecycleState.metadataUpdatedAt, '')
assert.equal(metadataLifecycleState.metadataState, 'none')

let releaseCachedHashVerification
const cachedVerificationState = {
  runtimeGeneration: 7,
  runtimeController: new AbortController(),
  playbackMode: 'idle',
  verified: new Map(),
}
const cachedVerificationRuntime = new Function('state', 'runtimeSnapshot', 'requireCurrentRuntime', 'playbackContextSnapshot', 'requireCurrentPlaybackContext', 'cachedSegment', 'segmentPayloadLength', 'cachedPayloadBytes', 'verifyPayloadHash', 'deleteCachedSegment', 'setRuntimeStatus', 'publicErrorMessage', 'assertPlayableContinuity', 'assertCurrentLoadedSegment', 'validatedCachedSegment', 'promoteVerifiedRecord', `${productionSlice('async function verifySegment(', 'function objectUrl(')}; return { verifySegment }`)(
  cachedVerificationState,
  () => ({
    generation: cachedVerificationState.runtimeGeneration,
    signal: cachedVerificationState.runtimeController.signal,
  }),
  (runtime) => {
    if (runtime.generation !== cachedVerificationState.runtimeGeneration || runtime.signal.aborted) {
      throw new DOMException('stale', 'AbortError')
    }
  },
  () => 0,
  () => {},
  async () => ({
    cacheKey: 'cached',
    payload: new Uint8Array([1, 2, 3]),
    bytes: 3,
  }),
  () => 3,
  async (payload) => payload,
  () =>
    new Promise((resolve) => {
      releaseCachedHashVerification = resolve
    }),
  async () => {
    throw new Error('stale verification must not delete cache')
  },
  () => false,
  (error) => error.message,
  identityRuntime.assertPlayableContinuity,
  (segment) => segment,
  () =>
    new Promise((resolve) => {
      releaseCachedHashVerification = () =>
        resolve({
          cacheKey: 'cached',
          payload: new Uint8Array([1, 2, 3]),
          bytes: 3,
        })
    }),
  (_segment, record) => record,
)
const cachedVerificationSnapshot = {
  generation: cachedVerificationState.runtimeGeneration,
  signal: cachedVerificationState.runtimeController.signal,
}
const delayedCachedVerification = cachedVerificationRuntime.verifySegment({ cacheKey: 'cached', sequence: 1 }, cachedVerificationSnapshot)
while (!releaseCachedHashVerification) await Promise.resolve()
cachedVerificationState.runtimeController.abort()
cachedVerificationState.runtimeGeneration += 1
cachedVerificationState.runtimeController = new AbortController()
releaseCachedHashVerification()
await assert.rejects(delayedCachedVerification, (error) => error?.name === 'AbortError')
assert.equal(cachedVerificationState.verified.size, 0)

let releaseStorageEstimate
const cacheStatsState = {
  runtimeGeneration: 2,
  runtimeController: new AbortController(),
}
const cacheStatsEls = { cacheSize: { textContent: '', title: '' } }
const cacheStatsRuntime = new Function('cacheTotalBytes', 'runtimeAllowsMutation', 'storageStatus', 'els', 'fmtBytes', 'navigator', 'storageErrorText', 'markIndexedDbUnavailable', `${productionSlice('async function refreshCacheStats(', 'function storageLimitationMessage(')}; return { refreshCacheStats }`)(
  async () => 3,
  (runtime) => !runtime || (runtime.generation === cacheStatsState.runtimeGeneration && runtime.signal === cacheStatsState.runtimeController.signal && !runtime.signal.aborted),
  { indexedDb: 'available' },
  cacheStatsEls,
  (value) => `${value} B`,
  {
    storage: {
      estimate: () =>
        new Promise((resolve) => {
          releaseStorageEstimate = resolve
        }),
    },
  },
  (error) => error.message,
  () => {},
)
const cacheStatsSnapshot = {
  generation: cacheStatsState.runtimeGeneration,
  signal: cacheStatsState.runtimeController.signal,
}
const delayedCacheStats = cacheStatsRuntime.refreshCacheStats(cacheStatsSnapshot)
while (!releaseStorageEstimate) await Promise.resolve()
cacheStatsState.runtimeController.abort()
cacheStatsState.runtimeGeneration += 1
cacheStatsState.runtimeController = new AbortController()
cacheStatsEls.cacheSize.textContent = 'current runtime'
cacheStatsEls.cacheSize.title = 'current title'
releaseStorageEstimate({ usage: 3, quota: 100 })
assert.equal(await delayedCacheStats, false)
assert.equal(cacheStatsEls.cacheSize.textContent, 'current runtime')
assert.equal(cacheStatsEls.cacheSize.title, 'current title')

let releaseSegmentWrite
let rolledBackWrite = null
let staleEnforcementCalls = 0
const cacheWriteState = { runtimeGeneration: 3 }
const cacheWriteController = new AbortController()
const cacheWriteRuntime = new Function('state', 'crypto', 'requireCurrentRuntime', 'runtimeIsCurrent', 'putPersistentSegment', 'deleteCachedSegmentIfCurrent', 'enforceCacheLimit', `${productionSlice('async function putCachedSegment(', 'async function deleteCachedSegment(')}; return { putCachedSegment }`)(
  cacheWriteState,
  { randomUUID: () => 'write-token' },
  (runtime) => {
    if (runtime.generation !== cacheWriteState.runtimeGeneration || runtime.signal.aborted) throw new DOMException('stale', 'AbortError')
  },
  (runtime) => runtime.generation === cacheWriteState.runtimeGeneration && !runtime.signal.aborted,
  async () =>
    new Promise((resolve) => {
      releaseSegmentWrite = resolve
    }),
  async (record) => {
    rolledBackWrite = record
    return true
  },
  async () => {
    staleEnforcementCalls += 1
  },
)
const cacheWriteSnapshot = {
  generation: 3,
  signal: cacheWriteController.signal,
}
const delayedSegmentWrite = cacheWriteRuntime.putCachedSegment({ cacheKey: 'segment', bytes: 3 }, cacheWriteSnapshot)
cacheWriteController.abort()
cacheWriteState.runtimeGeneration += 1
releaseSegmentWrite()
await assert.rejects(delayedSegmentWrite, (error) => error?.name === 'AbortError')
assert.equal(rolledBackWrite.runtimeWriteToken, 'write-token')
assert.equal(staleEnforcementCalls, 0)

assert.equal(identityRuntime.clampCacheLimitMb(Number.POSITIVE_INFINITY, 512), 512)
assert.equal(identityRuntime.clampCacheLimitMb('999999999', 512), 2048)
assert.equal(identityRuntime.clampCacheLimitMb('-1', 512), 16)

function longRunSegment(sequence, publisher = publisherA) {
  const hash = `0x${sequence.toString(16).padStart(64, '0')}`
  const previousHash = sequence === 0 ? `0x${'00'.repeat(32)}` : `0x${(sequence - 1).toString(16).padStart(64, '0')}`
  const segment = {
    publisher,
    streamId: 'long-run',
    streamIdHash: identityRuntime.canonicalStreamIdHash('long-run'),
    sequence,
    blockNumber: sequence,
    transactionIndex: 0,
    logIndex: 0,
    txHash: `0x${(sequence + 100_000).toString(16).padStart(64, '0')}`,
    payloadSha256Hex: hash,
    payloadSha256: hash.slice(2),
    previousSegmentHash: previousHash,
  }
  return { ...segment, cacheKey: identityRuntime.segmentIdentityKey(segment) }
}

const archiveAccumulator = identityRuntime.createArchiveAccumulator({ maxSegments: 10_000, maxStreams: 10 })
for (let chunk = 0; chunk < 100; chunk += 1) {
  identityRuntime.appendArchiveSegments(archiveAccumulator, Array.from({ length: 100 }, (_, offset) => longRunSegment(chunk * 100 + offset)))
}
assert.equal(archiveAccumulator.segmentCount, 10_000)
assert.equal(archiveAccumulator.streamKeys.size, 1)
assert.throws(
  () => identityRuntime.appendArchiveSegments(archiveAccumulator, [longRunSegment(10_000)]),
  /Choose a later from-block or add a publisher\/stream filter/,
)
assert.equal(archiveAccumulator.segmentCount, 10_000, 'failed archive appends must not grow retained work')
const streamCappedArchive = identityRuntime.createArchiveAccumulator({ maxSegments: 10, maxStreams: 1 })
identityRuntime.appendArchiveSegments(streamCappedArchive, [longRunSegment(0)])
assert.throws(() => identityRuntime.appendArchiveSegments(streamCappedArchive, [longRunSegment(1, publisherB)]), /1-stream browser limit/)
assert.equal(streamCappedArchive.streamKeys.size, 1, 'failed stream-cap appends must be atomic')

let cursorBlock = 0n
let retained = []
let maximumRange = 0n
for (let head = 999; head < 13_000; head += 1_000) {
  const range = identityRuntime.incrementalStationRange({
    anchorBlock: 0,
    cursorBlock,
    headBlock: head,
    overlapBlocks: 12,
    maxBlocks: 2_000,
  })
  maximumRange = maximumRange > range.toBlock - range.fromBlock + 1n ? maximumRange : range.toBlock - range.fromBlock + 1n
  const fresh = []
  for (let block = Number(range.fromBlock); block <= Number(range.toBlock); block += 1) fresh.push(longRunSegment(block))
  retained = identityRuntime.reconcileIncrementalStationSegments(retained, fresh, {
    replaceFromBlock: range.fromBlock,
    anchorOrder: 0n,
    maxSegments: 2_048,
  })
  cursorBlock = range.nextCursorBlock
}
assert.ok(cursorBlock > 10_000n, 'incremental refresh must advance beyond the RPC log-count horizon')
assert.ok(maximumRange <= 2_000n, 'each refresh must keep a hard block-work ceiling')
assert.equal(retained.length, 2_048, 'live history retention must remain bounded')
assert.equal(retained.at(-1).sequence, 12_999)
assert.equal(retained.at(-1).continuity.status, 'valid', 'the retained predecessor anchor must preserve recent continuity checks')
const regressedHeadRange = identityRuntime.incrementalStationRange({ anchorBlock: 0, cursorBlock, headBlock: 12_987, overlapBlocks: 12, maxBlocks: 2_000 })
assert.ok(regressedHeadRange.fromBlock <= regressedHeadRange.toBlock, 'a regressed head must still produce a valid overlap query')
assert.equal(regressedHeadRange.toBlock, 12_987n)
const canonicalReplacement = { ...longRunSegment(12_998), txHash: `0x${'ab'.repeat(32)}` }
canonicalReplacement.cacheKey = identityRuntime.segmentIdentityKey(canonicalReplacement)
const reorgReconciled = identityRuntime.reconcileIncrementalStationSegments(retained, [canonicalReplacement, longRunSegment(12_999)], {
  replaceFromBlock: 12_998,
  anchorOrder: 0n,
  maxSegments: 2_048,
})
assert.ok(reorgReconciled.some((segment) => segment.cacheKey === canonicalReplacement.cacheKey), 'overlap refresh must accept the current canonical replacement')
assert.ok(!reorgReconciled.some((segment) => segment.sequence === 12_998 && segment.cacheKey !== canonicalReplacement.cacheKey), 'overlap refresh must remove the orphaned segment')

const cacheStorageSource = productionSlice('function storageMemoryStore(', 'function metadataScope(')
assert.doesNotMatch(cacheStorageSource, /\.getAll\(/, 'cache storage must not hydrate all persistent payloads')
assert.match(cacheStorageSource, /if \(record && storeName !== 'segments'\) memory\.set/, 'persistent segment reads must not mirror payloads into RAM')
assert.match(cacheStorageSource, /if \(storeName !== 'segments'\) memory\.set/, 'persistent segment writes must not mirror payloads into RAM')
const cacheEvictionSource = productionSlice('async function enforceCacheLimit(', 'async function refreshCacheStats(')
assert.match(cacheEvictionSource, /index\('verifiedAt'\)\.openCursor\(\)/, 'persistent eviction must walk oldest records with an index cursor')
assert.doesNotMatch(cacheEvictionSource, /allCachedSegments/, 'each cache put must not trigger a full-cache scan')
const memoryEvictionSource = cacheEvictionSource.slice(cacheEvictionSource.indexOf('if (!db) {'), cacheEvictionSource.indexOf('const total = await ensureCacheAccounting'))
assert.match(memoryEvictionSource, /memory\.delete\(record\.cacheKey\)[\s\S]*state\.verified\.delete\(record\.cacheKey\)[\s\S]*releaseObjectUrl\(record\.cacheKey, \{ preserveActive: true \}\)/, 'memory-only cache eviction must release inactive object URLs and defer the active URL')
const memoryEvictionRecords = new Map([
  ['oldest', { cacheKey: 'oldest', verifiedAt: '2025-01-01T00:00:00.000Z', bytes: 4 }],
  ['middle', { cacheKey: 'middle', verifiedAt: '2025-01-02T00:00:00.000Z', bytes: 4 }],
  ['newest', { cacheKey: 'newest', verifiedAt: '2025-01-03T00:00:00.000Z', bytes: 4 }],
])
const memoryEvictionState = { config: { cacheLimitMb: 1 }, currentRecordKey: 'oldest', verified: new Map(memoryEvictionRecords) }
const memoryEvictionReleases = []
const memoryCacheRuntime = new Function(
  'state', 'clampCacheLimitMb', 'DEFAULTS', 'CACHE_LIMIT_MIN_MB', 'CACHE_LIMIT_MAX_MB', 'requireCurrentRuntime', 'openDb', 'storageMemoryStore', 'cachedSegmentByteLength', 'memorySegmentLimitBytes', 'releaseObjectUrl',
  `${cacheEvictionSource}; return { enforceCacheLimit }`,
)(
  memoryEvictionState,
  (value) => value,
  { cacheLimitMb: 1 },
  1,
  1_024,
  () => {},
  async () => null,
  () => memoryEvictionRecords,
  (record) => record.bytes,
  () => 5,
  (cacheKey, options) => memoryEvictionReleases.push({ cacheKey, options }),
)
await memoryCacheRuntime.enforceCacheLimit()
assert.deepEqual([...memoryEvictionRecords.keys()], ['oldest'], 'active playback may temporarily keep the cache over budget')
assert.deepEqual([...memoryEvictionState.verified.keys()], ['oldest'], 'active record identity must survive so ended playback can advance')
assert.deepEqual(memoryEvictionReleases, [
  { cacheKey: 'middle', options: { preserveActive: true } },
  { cacheKey: 'newest', options: { preserveActive: true } },
])
assert.match(cacheEvictionSource, /if \(record\.cacheKey === state\.currentRecordKey\) \{\s*cursor\.continue\(\)\s*return\s*\}/, 'persistent eviction must also preserve the active record')
const cachedHydrationSource = productionSlice('async function restoreSegmentMetadata(', 'async function ensureCacheAccounting(')
assert.equal([...cachedHydrationSource.matchAll(/selectRecentSegmentsWithinByteBudget\(/g)].length, 2, 'restore and refresh hydration must both enforce the hot-payload budget')
assert.match(productionSlice('function promoteVerifiedRecord(', 'function parseArchiveStationInput('), /enforceVerifiedMemoryLimit\(\[loaded\.cacheKey, state\.currentRecordKey\]\)/)

const lifecycleSource = productionAppSource
assert.match(lifecycleSource, /async function verifySegment\(segment, runtime = runtimeSnapshot\(\), playbackContext = playbackContextSnapshot\(\)\)/)
assert.match(lifecycleSource, /async function prefetchSegment\(segment, runtime = runtimeSnapshot\(\)\)/)
assert.match(lifecycleSource, /if \(runtimeIsCurrent\(runtime\)\) \{\s+state\.busy = false/)
assert.match(lifecycleSource, /async function restoreSegmentMetadata\(runtime = runtimeSnapshot\(\)\)/)
assert.match(lifecycleSource, /const MAX_SIDECAR_MEMORY_SLOTS = SLOT_WINDOW \+ 2/)
assert.match(lifecycleSource, /if \(db\.objectStoreNames\.contains\('sidecars'\)\) db\.deleteObjectStore\('sidecars'\)/)
assert.doesNotMatch(productionSlice('async function sidecarsForSlot(', 'async function sidecarsForSegment('), /(?:getRecord|putRecord)\('sidecars'/)
assert.doesNotMatch(productionSlice('async function clearCache(', 'function cachedSegmentByteLength('), /clearStore\('sidecars'\)/)
assert.match(productionSlice('async function clearCache(', 'function cachedSegmentByteLength('), /state\.sidecarMemoryCache\.clear\(\)[\s\S]*state\.sidecarFetchPromises\.clear\(\)[\s\S]*state\.sidecarCacheEpoch \+= 1/)

// The resizer owns only the scanner/segments split. Header, legend, stats, and
// status remain siblings so changing the rail cannot move their geometry.
const feedPanesMarkup = productionHtmlSource.slice(productionHtmlSource.indexOf('<div class="feed-panes"'), productionHtmlSource.indexOf('<div class="cache-actions"'))
assert.match(feedPanesMarkup, /id="blobspace-scanner"[\s\S]*id="stream-segments"/)
assert.match(feedPanesMarkup, /aria-controls="blobspace-scanner stream-segments"/)
assert.ok(productionHtmlSource.indexOf('id="blobspace-status"') < productionHtmlSource.indexOf('<div class="feed-panes"'))
assert.match(productionCssSource, /\.panel-feeds\s*\{[\s\S]*?grid-template-rows:\s*auto auto auto minmax\(0, 1fr\) auto;/)
assert.match(productionCssSource, /\.feed-panes\s*\{[\s\S]*?grid-template-rows:\s*minmax\(112px, 1fr\) var\(--segment-rail-height\);/)
assert.match(productionCssSource, /\.segment-rail-resizer\s*\{[\s\S]*?min-height:\s*24px;[\s\S]*?height:\s*24px;/, 'keyboard/pointer separator must meet the WCAG 2.2 AA minimum target size')

assert.deepEqual(identityRuntime.calculateSegmentRailBounds({ viewportHeight: 900, segmentMin: 180, paneHeight: 600, rowGap: 8, verticalPadding: 0, blobspaceMin: 112 }), {
  min: 180,
  max: 480,
  scannerMin: 112,
  paneHeight: 600,
  gap: 8,
})
const resizeInteractionSource = productionSlice('function applySegmentRailHeight(', 'function setStatus(')
assert.match(resizeInteractionSource, /aria-valuetext/)
assert.match(resizeInteractionSource, /saved = applySegmentRailHeight\(startHeight \+ startY - moveEvent\.clientY\)/)
assert.match(resizeInteractionSource, /'ArrowUp', 'ArrowDown', 'Home', 'End'/)
assert.match(resizeInteractionSource, /on\(window, 'resize'/)

const settingsTabsMarkup = productionHtmlSource.slice(productionHtmlSource.indexOf('<div class="settings-tabs"'), productionHtmlSource.indexOf('<div id="settings-panel-appearance"'))
assert.equal([...settingsTabsMarkup.matchAll(/role="tab"/g)].length, 3)
assert.equal([...settingsTabsMarkup.matchAll(/tabindex="0"/g)].length, 1)
assert.equal([...settingsTabsMarkup.matchAll(/tabindex="-1"/g)].length, 2)
for (const tab of ['appearance', 'layout', 'connections']) {
  assert.match(settingsTabsMarkup, new RegExp(`id="settings-tab-${tab}"[^>]+aria-controls="settings-panel-${tab}"`))
  assert.match(productionHtmlSource, new RegExp(`id="settings-panel-${tab}"[^>]+aria-labelledby="settings-tab-${tab}"`))
}
const settingsTabInteractionSource = productionSlice('function showSettingsTab(tab)', 'function currentStreamFavorite()')
assert.match(settingsTabInteractionSource, /button\.tabIndex = active \? 0 : -1/)
assert.match(settingsTabInteractionSource, /'ArrowLeft', 'ArrowRight', 'Home', 'End'/)
assert.match(settingsTabInteractionSource, /% tabs\.length/)

assert.match(productionHtmlSource, /class="segments-table" role="table" aria-label="Stream segments" aria-colcount="5"/)
assert.equal([...productionHtmlSource.matchAll(/role="columnheader"/g)].length, 5)
assert.match(productionHtmlSource, /id="segments" class="segments" role="rowgroup"/)
const segmentRenderSource = productionSlice('function render()', 'async function refresh()')
assert.match(segmentRenderSource, /class="segment-row [^`]+role="row"/)
assert.equal([...segmentRenderSource.matchAll(/role="cell"/g)].length >= 7, true)
assert.match(segmentRenderSource, /aria-colspan="5"/)
assert.match(productionHtmlSource, /id="player"[^>]+aria-label="Ethereum blob radio player"/)
assert.match(segmentRenderSource, /aria-label="Jump to segment #\$\{escapeHtml\(segment\.sequence\)\}"/)
assert.match(segmentRenderSource, /aria-label="\$\{escapeHtml\(segmentActionLabel\)\}"/)
assert.match(productionSlice('function renderBlobspace()', 'function renderHealth()'), /aria-label="\$\{escapeHtml\(slotJumpLabel\)\}"/)

assert.match(productionHtmlSource, /id="layout-presets" role="group" aria-label="Layout preset"/)
const layoutControlsSource = productionSlice('function renderLayoutControls()', 'function renderClockControls()')
assert.match(layoutControlsSource, /button\.setAttribute\('aria-pressed', active \? 'true' : 'false'\)/)

assert.equal(identityRuntime.classifyPlaybackMode({ playbackIntent: 'replay', followIntent: true, liveEdgeKey: 'edge', currentRecordKey: 'edge' }), 'replay', 'manual latest playback must not claim LIVE')
assert.equal(identityRuntime.classifyPlaybackMode({ playbackIntent: 'follow', followIntent: true, liveEdgeKey: 'edge', currentRecordKey: 'older' }), 'catching-up')
assert.equal(identityRuntime.classifyPlaybackMode({ playbackIntent: 'follow', followIntent: true, liveEdgeKey: 'edge', currentRecordKey: 'edge' }), 'live', 'only confirmed follow playback at the live edge may claim LIVE')
assert.equal(identityRuntime.playbackModeLabel('replay-buffering'), 'buffering replay')
assert.match(productionSlice('function playRecord(', 'function latestVerifiedRecord('), /classifyPlaybackMode/)
assert.doesNotMatch(productionSlice('function playRecord(', 'function latestVerifiedRecord('), /stationState\.textContent\s*=\s*'LIVE'/)
assert.match(productionSlice('function render()', 'async function refresh()'), /classList\.toggle\('active', state\.playbackMode === 'live'\)/)
assert.match(productionSlice("on(els.player, 'waiting'", "on(els.segments, 'click'"), /playbackMode = 'paused'[\s\S]*playbackMode = 'interrupted'[\s\S]*playbackMode = 'ended'/)
assert.match(productionSlice("on(els.player, 'waiting'", "on(els.segments, 'click'"), /mediaEventMatchesCurrentRecord\(\)/)
assert.match(productionSlice("on(els.player, 'ended'", "on(els.segments, 'click'"), /playbackAdvanceIsCurrent\(advanceToken, currentKey\)/, 'ended refresh continuation must retain playback generation identity')
assert.match(productionSlice("on(els.watchSegment, 'click'", "on(els.slots, 'click'"), /beginUserPlaybackRequest\(\)[\s\S]*userPlaybackRequestIsCurrent\(playbackRequestToken\)/)
assert.match(productionSlice("on(els.slots, 'click'", "on(els.exportIndex, 'click'"), /beginUserPlaybackRequest\(\)[\s\S]*userPlaybackRequestIsCurrent\(playbackRequestToken\)/)
assert.equal((productionSlice("on(els.segments, 'click'", 'setInterval(() =>').match(/beginUserPlaybackRequest\(\)/g) || []).length, 2, 'both segment jump and play actions must create a latest-intent token')
assert.match(productionSlice("on(els.archiveResults, 'click'", "on(els.favoritesList, 'click'"), /if \(isAbortError\(error\)\) return/, 'superseded archive tune cancellation must remain silent')
assert.doesNotMatch(productionAppSource, /state\.streaming|state\.playbackState/)

const playLatestElement = { disabled: true, title: '' }
let latestPlayable = { sequence: 42 }
const { renderPlayLatest } = new Function('els', 'latestVerifiedRecord', `${productionSlice('function renderPlayLatest(', 'function render()')}; return { renderPlayLatest }`)(
  { playLatest: playLatestElement },
  () => latestPlayable,
)
renderPlayLatest()
assert.equal(playLatestElement.disabled, false, 'Play latest should enable when a verified record becomes available')
assert.equal(playLatestElement.title, 'Play verified segment #42')
latestPlayable = null
renderPlayLatest()
assert.equal(playLatestElement.disabled, true, 'Play latest should disable again after verified state is cleared')
assert.equal(playLatestElement.title, 'No verified segment is ready to play')

console.log('static client ui logic ok')
