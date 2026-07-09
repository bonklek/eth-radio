import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const staticDir = path.join(root, 'public', 'decentralized')
const required = ['index.html', 'styles.css', 'app.js']

for (const name of required) {
  const file = path.join(staticDir, name)
  if (!fs.existsSync(file)) throw new Error(`Missing static client file: ${file}`)
}

const app = fs.readFileSync(path.join(staticDir, 'app.js'), 'utf8')
const staticBuilder = fs.readFileSync(path.join(root, 'scripts', 'build-static-client.mjs'), 'utf8')
const staticServer = fs.readFileSync(path.join(root, 'scripts', 'serve-static-client.mjs'), 'utf8')
const ipfsPrepare = fs.readFileSync(path.join(root, 'scripts', 'prepare-ipfs-publish.mjs'), 'utf8')
const liveDemo = fs.readFileSync(path.join(root, 'scripts', 'serve-live-demo.mjs'), 'utf8')
const forbidden = ['/api/', 'localhost', '127.0.0.1']
for (const token of forbidden) {
  if (app.includes(token)) throw new Error(`Static client should not reference ${token}`)
}

if (!app.includes('indexedDB')) throw new Error('Static client should cache verified payloads in IndexedDB')
if (!app.includes('eth_getLogs')) throw new Error('Static client should read Station logs from execution RPC')
if (!app.includes('/eth/v1/beacon/blob_sidecars/')) {
  throw new Error('Static client should fetch beacon blob sidecars directly')
}
if (!app.includes('archiveTemplates')) throw new Error('Static client should support decentralized archive fallbacks')
if (!app.includes('withEndpointFallback')) throw new Error('Static client should fail over across configured endpoints')
if (!app.includes('enforceCacheLimit')) throw new Error('Static client should manage browser cache limits')

const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8')
if (!staticBuilder.includes('escapeRawTextElementContent')) {
  throw new Error('Static builder should escape raw text closing tags when inlining CSS/JS')
}
if (!staticBuilder.includes("escapeRawTextElementContent(css, 'style')")) {
  throw new Error('Static builder should escape inlined CSS style closers')
}
if (!staticBuilder.includes("escapeRawTextElementContent(app, 'script')")) {
  throw new Error('Static builder should escape inlined JS script closers')
}
if (!ipfsPrepare.includes('ipfsAddRootCid')) {
  throw new Error('IPFS prepare script should normalize recursive add output to the root CID')
}
if (!ipfsPrepare.includes('split(/\\r?\\n/)') || !ipfsPrepare.includes('cids.at(-1)')) {
  throw new Error('IPFS prepare script should use the final recursive add CID for DNSLink output')
}
for (const [sourceName, source] of [['static server', staticServer], ['live demo', liveDemo]]) {
  for (const header of [
    "'cache-control': 'no-store'",
    "'cross-origin-opener-policy': 'same-origin'",
    "'referrer-policy': 'no-referrer'",
    "'x-content-type-options': 'nosniff'",
  ]) {
    if (!source.includes(header)) throw new Error(`${sourceName} should send ${header}`)
  }
}
if (!staticServer.includes('fs.realpathSync(staticDir)') || !staticServer.includes('canonicalStaticFile(filePath)')) {
  throw new Error('Static server should canonicalize served files through realpath')
}
const staticServerCanonicalFile = sourceSlice(staticServer, 'function canonicalStaticFile(filePath)', 'function resolveRequest(url)')
if (!staticServerCanonicalFile.includes('fs.realpathSync(filePath)') || !staticServerCanonicalFile.includes('isInsideStaticRoot(realPath)')) {
  throw new Error('Static server should reject symlinks that resolve outside the static root')
}
for (const id of [
  'chain-preset',
  'execution-rpcs',
  'beacon-apis',
  'archive-templates',
  'cache-limit',
  'endpoint-presets',
  'endpoint-summary',
  'endpoint-apply-status',
  'reset-preset-endpoints',
  'station-lookup',
  'station-explorer',
  'segment-lookup',
  'lookup-message',
  'blobspace-status',
  'stream-health',
]) {
  if (!html.includes(`id="${id}"`)) throw new Error(`Missing static client control: ${id}`)
}
if (!app.includes('CHAIN_PRESETS')) throw new Error('Static client should expose chain endpoint presets')
if (!app.includes('mainnet')) throw new Error('Static client should include mainnet endpoint readiness')
for (const forbiddenSync of [
  "params.set('executionRpcs'",
  "params.set('executionRpc'",
  "params.set('beaconApis'",
  "params.set('beaconApi'",
  "params.set('archiveTemplates'",
]) {
  if (app.includes(forbiddenSync)) {
    throw new Error(`Static client should not write sensitive endpoint state into URLs: ${forbiddenSync}`)
  }
}
const liveDemoUpdateLocation = liveDemo.match(/function updateLocation\(\) \{[\s\S]*?history\.replaceState\(null, '', '\?' \+ params\.toString\(\)\)[\s\S]*?\n    \}/)?.[0] || ''
if (!liveDemoUpdateLocation) throw new Error('Live demo should expose updateLocation() for URL state sync checks')
for (const forbiddenDemoSync of [
  "params.set('ethRpcUrl'",
  "params.set('beaconRpcUrl'",
]) {
  if (liveDemoUpdateLocation.includes(forbiddenDemoSync)) {
    throw new Error(`Live demo should not write sensitive endpoint state into browser URLs: ${forbiddenDemoSync}`)
  }
}
function sourceSlice(source, startPattern, endPattern) {
  const start = source.indexOf(startPattern)
  const end = source.indexOf(endPattern, start + startPattern.length)
  if (start === -1 || end === -1 || end <= start) return ''
  return source.slice(start, end)
}

const liveDemoBlobspaceConfig = sourceSlice(liveDemo, 'function blobspaceConfig(ctx)', 'function networkContext')
const liveDemoSummarizeHealth = sourceSlice(liveDemo, 'function summarizeHealth(id, segments, blobspace, ctx = networkContext(defaultNetwork))', 'function summarizeSegment')
if (!liveDemoBlobspaceConfig || !liveDemoSummarizeHealth) {
  throw new Error('Live demo should expose response summary functions for endpoint URL leakage checks')
}
if (!liveDemoSummarizeHealth.includes('.sort(canonicalSegmentSort)')
  || !liveDemoSummarizeHealth.includes("const latestSequence = latest ? nonNegativeSafeInteger(latest.sequence, 'health latest sequence') : null")
  || !liveDemoSummarizeHealth.includes("optionalNonNegativeSafeInteger(latest?.durationMs, 'health latest durationMs')")
  || !liveDemoSummarizeHealth.includes("optionalNonNegativeSafeInteger(latest?.payloadBytes ?? latest?.bytes, 'health latest payloadBytes')")
  || !liveDemoSummarizeHealth.includes('latest?.blobCount ?? latest?.estimatedBlobs ?? latest?.blobVersionedHashes?.length')
  || liveDemoSummarizeHealth.includes('Number(a.sequence) - Number(b.sequence)')
  || liveDemoSummarizeHealth.includes('Number(latest.sequence)')
  || liveDemoSummarizeHealth.includes('Number(latest.durationMs)')) {
  throw new Error('Live demo health summaries should validate latest segment numeric fields')
}
const liveDemoSegmentSort = sourceSlice(liveDemo, 'function segmentOrderPart(value, label)', 'const defaultHeaders')
if (!liveDemoSegmentSort.includes('function compareSegmentOrderPart(left, right, label)')
  || !liveDemoSegmentSort.includes("compareSegmentOrderPart(a.transactionIndex, b.transactionIndex, 'segment transactionIndex')")
  || !liveDemoSegmentSort.includes("compareSegmentOrderPart(a.logIndex, b.logIndex, 'segment logIndex')")) {
  throw new Error('Live demo should validate segment ordering fields before sorting')
}
for (const forbiddenSortFallback of [
  'Number(a.blockNumber || 0)',
  'Number(a.transactionIndex || 0)',
  'Number(a.logIndex || 0)',
]) {
  if (liveDemoSegmentSort.includes(forbiddenSortFallback)) {
    throw new Error(`Live demo segment sorting should not coerce malformed order fields: ${forbiddenSortFallback}`)
  }
}
for (const forbiddenDemoResponseField of [
  'executionRpcUrl:',
  'beaconRpcUrl:',
]) {
  if (liveDemoBlobspaceConfig.includes(forbiddenDemoResponseField) || liveDemoSummarizeHealth.includes(forbiddenDemoResponseField)) {
    throw new Error(`Live demo should not expose endpoint URLs in JSON response fields: ${forbiddenDemoResponseField}`)
  }
}
for (const requiredDelete of [
  "params.delete('executionRpcs')",
  "params.delete('executionRpc')",
  "params.delete('beaconApis')",
  "params.delete('beaconApi')",
  "params.delete('archiveTemplates')",
]) {
  if (!app.includes(requiredDelete)) {
    throw new Error(`Static client should clear sensitive endpoint URL state: ${requiredDelete}`)
  }
}
for (const marker of [
  'readUrlState',
  'syncUrlState',
  'validateEndpointList',
  'renderEndpointSetup',
  'parseLookupInput',
  'stationExplorerUrl',
  'sidecarMemoryCache',
  'cachedPayloadBytes',
  'normalizeSidecarRecord',
  'validSidecarMatch',
  'isBlobHex',
  'isByteHex',
  'isBytes48Hex',
  'safeJsonObject',
  'abiWordNumber',
  'timestampMsFromSeconds',
  'bigintSafeInteger',
  'decimalSafeInteger',
  'beaconData',
  'beaconDataArray',
  'beaconHeadSlot',
  'sidecarVersionedHash',
  'publicUrlLabel',
  'publicErrorMessage',
]) {
  if (!app.includes(marker)) throw new Error(`Missing static client behavior marker: ${marker}`)
}
const staticHexToBytes = sourceSlice(app, 'function hexToBytes(value)', 'function bytesToHex(bytes)')
if (!staticHexToBytes.includes('isByteHex(value)')) {
  throw new Error('Static client should validate byte hex before decoding')
}
const staticDecodeSegmentLog = sourceSlice(app, 'function rpcQuantity(value, label)', 'async function withEndpointFallback')
if (!staticDecodeSegmentLog.includes("rpcQuantityNumber(log.blockNumber, 'segment blockNumber')")
  || !staticDecodeSegmentLog.includes("rpcQuantityNumber(log.transactionIndex, 'segment transactionIndex')")
  || !staticDecodeSegmentLog.includes("rpcQuantityNumber(log.logIndex, 'segment logIndex')")) {
  throw new Error('Static client should validate JSON-RPC log order quantities before segment ordering')
}
if (!app.includes('function abiWord(data, wordIndex, label)')
  || !app.includes('function abiWordNumber(data, wordIndex, label')
  || !app.includes('function assertSegmentLogShape(log)')
  || !staticDecodeSegmentLog.includes('assertSegmentLogShape(log)')
  || !staticDecodeSegmentLog.includes("topicUintNumber(log.topics[3], 'Station log sequence')")
  || !staticDecodeSegmentLog.includes("durationMs: abiWordNumber(data, 1, 'Station log durationMs')")
  || !staticDecodeSegmentLog.includes("payloadBytes: abiWordNumber(data, 2, 'Station log payloadBytes')")
  || !staticDecodeSegmentLog.includes("readString(data, 0, 'Station log streamId')")
  || !staticDecodeSegmentLog.includes("readBytes32Array(data, 6, 'Station log blobVersionedHashes')")) {
  throw new Error('Static client should validate Station log topics and ABI data before decoding')
}
for (const forbiddenDecodePattern of [
  'sequence: Number(BigInt(log.topics[3]))',
  "durationMs: Number(readWord(data, 1, 'Station log durationMs'))",
  "payloadBytes: Number(readWord(data, 2, 'Station log payloadBytes'))",
  'function readWord(data, wordIndex) {\n  return BigInt(`0x${data.slice(wordIndex * 64, wordIndex * 64 + 64)}`)',
]) {
  if (app.includes(forbiddenDecodePattern)) {
    throw new Error(`Static client should not decode Station logs without shape guards: ${forbiddenDecodePattern}`)
  }
}
const staticSegmentOrder = sourceSlice(app, 'function receiptStationSegments(receipt)', 'async function loadForwardWindowFromBlock(blockNumber)')
if (!staticSegmentOrder.includes("rpcQuantityNumber(receipt.transactionIndex, 'receipt transactionIndex')")
  || !staticSegmentOrder.includes('BigInt(segment.transactionIndex) * 1_000n')
  || !staticSegmentOrder.includes('BigInt(segment.logIndex)')
  || !staticSegmentOrder.includes('a.transactionIndex - b.transactionIndex')) {
  throw new Error('Static client should validate receipt order quantities before anchor ordering')
}
if (!staticSegmentOrder.includes('Array.isArray(receipt.logs)')
  || staticSegmentOrder.includes('receipt?.logs || []')) {
  throw new Error('Static client should require transaction receipt logs before Station log filtering')
}
for (const forbiddenOrderFallback of [
  "BigInt(log.transactionIndex || '0x0')",
  "BigInt(log.logIndex || '0x0')",
  "BigInt(receipt.transactionIndex || '0x0')",
  'BigInt(segment.transactionIndex || 0)',
  'BigInt(segment.logIndex || 0)',
]) {
  if (staticDecodeSegmentLog.includes(forbiddenOrderFallback) || staticSegmentOrder.includes(forbiddenOrderFallback)) {
    throw new Error(`Static client should not coerce missing RPC order fields: ${forbiddenOrderFallback}`)
  }
}
const staticReconstructPayload = sourceSlice(app, 'async function reconstructPayload(segment, sidecars)', 'function archiveUrl')
if (!staticReconstructPayload.includes('Array.isArray(sidecars?.matches)') || !staticReconstructPayload.includes('validSidecarMatch(match)')) {
  throw new Error('Static client should validate sidecar match shape before decoding blobs')
}
const staticSidecarsForSlot = sourceSlice(app, 'async function sidecarsForSlot(slot)', 'async function sidecarsForSegment(segment)')
if (!staticSidecarsForSlot.includes('normalizeSidecarRecord(cached, slot)') || !staticSidecarsForSlot.includes('state.sidecarMemoryCache.set(cacheKey, cachedRecord)')) {
  throw new Error('Static client should normalize cached sidecar records before returning them')
}
if (!staticSidecarsForSlot.includes("beaconDataArray(await beacon(`/eth/v1/beacon/blob_sidecars/${slot}`), 'blob sidecars')") || !staticSidecarsForSlot.includes('sidecarVersionedHash(sidecar)')) {
  throw new Error('Static client should validate beacon sidecar response shape before caching sidecars')
}
if (!staticSidecarsForSlot.includes("sidecarIndex(sidecar.index, 'beacon sidecar index')")
  || staticSidecarsForSlot.includes('index: Number(sidecar.index)')) {
  throw new Error('Static client should validate beacon sidecar indices before caching sidecars')
}
if (staticSidecarsForSlot.includes('state.sidecarMemoryCache.set(cacheKey, cached)')) {
  throw new Error('Static client should not return raw IndexedDB sidecar cache records')
}
if (staticSidecarsForSlot.includes('rows || []') || staticSidecarsForSlot.includes('versionedHashFromCommitment(commitment)')) {
  throw new Error('Static client should not use permissive sidecar response fallbacks')
}
const staticBeaconHelpers = sourceSlice(app, 'async function beacon(pathname)', 'function toBlockHex(block)')
if (!staticBeaconHelpers.includes('return beaconData(body, pathname)')
  || !staticBeaconHelpers.includes('function beaconDataArray(data, label)')
  || !staticBeaconHelpers.includes('function decimalSafeInteger(value, label)')
  || !staticBeaconHelpers.includes('function beaconHeadSlot(head)')
  || !staticBeaconHelpers.includes("return decimalSafeInteger(slot, 'beacon head slot')")
  || staticBeaconHelpers.includes('return Number(slot)')) {
  throw new Error('Static client should expose beacon response shape validators')
}
for (const rawBeaconPattern of [
  'if (!body?.data)',
  'BigInt(genesis.genesis_time)',
  'head.header.message.slot',
]) {
  if (staticBeaconHelpers.includes(rawBeaconPattern)) {
    throw new Error(`Static client should not trust raw beacon response shape: ${rawBeaconPattern}`)
  }
}
const staticTimestampHelpers = sourceSlice(app, 'function rpcQuantity(value, label)', 'function topicAddress(topic)')
if (!staticTimestampHelpers.includes('function timestampMsFromSeconds(value, label)')
  || !staticTimestampHelpers.includes("const seconds = typeof value === 'bigint' ? value : rpcQuantity(value, label)")
  || !staticTimestampHelpers.includes('if (!Number.isSafeInteger(number)) throw new Error(`${label} exceeds safe millisecond range`)')) {
  throw new Error('Static client should validate RPC/beacon timestamps before millisecond conversion')
}
const staticHydrateSegmentTimes = sourceSlice(app, 'async function hydrateSegmentTimes(segments)', 'function receiptStationSegments(receipt)')
if (!staticHydrateSegmentTimes.includes("timestampMsFromSeconds(block.timestamp, 'block timestamp')")
  || staticHydrateSegmentTimes.includes('Number(BigInt(block.timestamp)) * 1000')) {
  throw new Error('Static client should validate block timestamps before hydrating segment times')
}
const staticSegmentSlot = sourceSlice(app, 'async function segmentSlot(segment)', 'function normalizeSidecarRecord(record, expectedSlot)')
if (!staticSegmentSlot.includes("const timestamp = rpcQuantity(block.timestamp, 'block timestamp')")
  || !staticSegmentSlot.includes("throw new Error('block timestamp is before beacon genesis')")
  || !staticSegmentSlot.includes("return bigintSafeInteger((timestamp - genesis) / 12n, 'segment slot')")
  || staticSegmentSlot.includes('Number((timestamp - genesis) / 12n)')
  || staticSegmentSlot.includes('Number((BigInt(block.timestamp) - genesis) / 12n)')) {
  throw new Error('Static client should validate block timestamps before deriving blob slots')
}
const staticNormalizeSidecarRecord = sourceSlice(app, 'function normalizeSidecarRecord(record, expectedSlot)', 'function sidecarIndex(value, label)')
if (!staticNormalizeSidecarRecord.includes("sidecarIndex(record.slot, 'cached sidecar slot')")
  || !staticNormalizeSidecarRecord.includes("sidecarIndex(expectedSlot, 'expected sidecar slot')")
  || !staticNormalizeSidecarRecord.includes("sidecarIndex(sidecar.index, 'cached sidecar index')")
  || staticNormalizeSidecarRecord.includes('Number(record.slot)')
  || staticNormalizeSidecarRecord.includes('Number(expectedSlot)')
  || staticNormalizeSidecarRecord.includes('Number(sidecar.index)')) {
  throw new Error('Static client should validate cached sidecar slots and indices before reuse')
}
const staticSidecarsForSegment = sourceSlice(app, 'async function sidecarsForSegment(segment)', 'function validSidecarMatch(match)')
if (!staticSidecarsForSegment.includes('Array.isArray(record.sidecars)')) {
  throw new Error('Static client should require sidecar records to expose an array before matching')
}
const staticStreamBlobMap = sourceSlice(app, 'function streamBlobMap()', 'async function refreshBlobspace()')
if (staticStreamBlobMap.includes('segment.blobVersionedHashes || []')) {
  throw new Error('Static client blobspace should use decoded segment blob hash arrays directly')
}
const staticRefreshBlobspace = sourceSlice(app, 'async function refreshBlobspace()', 'function renderBlobspace()')
if (staticRefreshBlobspace.includes('record.sidecars || []') || staticRefreshBlobspace.includes('segment?.blobVersionedHashes || []')) {
  throw new Error('Static client blobspace should rely on normalized sidecar records and decoded segment blob hashes')
}
if (staticRefreshBlobspace.includes('Waiting for Station metadata.')
  || staticRefreshBlobspace.includes('if (!known.size)')) {
  throw new Error('Static client blobspace rail should refresh beacon slots even without Station metadata')
}
if (!app.includes('function startBlobspaceRail()')
  || !app.includes('startBlobspaceRail()')
  || !app.includes('setInterval(() => void refreshBlobspaceRail(), 15000)')) {
  throw new Error('Static client blobspace rail should refresh independently of live playback')
}
const staticRenderBlobspace = sourceSlice(app, 'function renderBlobspace()', 'function renderHealth()')
if (!app.includes('beaconSlotBase')
  || !app.includes('function explorerSlotUrl(slot)')
  || !staticRenderBlobspace.includes('const slotUrl = explorerSlotUrl(row.slot)')
  || !staticRenderBlobspace.includes('class="slot-link"')
  || !staticRenderBlobspace.includes('<a class="blob-cell ${kind}"')
  || staticRenderBlobspace.includes('<button class="blob-cell')) {
  throw new Error('Static client blobspace rows should link slots and available blob cells to explorers')
}
const staticCachedBlobspaceRows = sourceSlice(app, 'function cachedBlobspaceRows(known)', 'function renderBlobspace()')
if (!staticCachedBlobspaceRows.includes("sidecarIndex(record.slot, 'cached segment slot')")
  || staticCachedBlobspaceRows.includes('Number(record.slot)')
  || staticCachedBlobspaceRows.includes('rows.set(record.slot, row)')) {
  throw new Error('Static client cached blobspace rows should validate cached segment slots before rendering')
}
const staticVerifySegment = sourceSlice(app, 'async function verifySegment(segment)', 'function objectUrl(record)')
if (!staticVerifySegment.includes('await cachedPayloadBytes(cached.payload)') || !staticVerifySegment.includes('await verifyPayloadHash(segment, payload)')) {
  throw new Error('Static client should re-verify cached payloads before playback')
}
if (!staticVerifySegment.includes('await deleteCachedSegment(segment.cacheKey)') || !staticVerifySegment.includes('Discarded cached segment')) {
  throw new Error('Static client should discard corrupt cached payloads before refetching')
}
const staticAllCachedSegments = sourceSlice(app, 'async function allCachedSegments()', 'async function putCachedSegment(record)')
if (!staticAllCachedSegments.includes('Array.isArray(request.result)')
  || staticAllCachedSegments.includes('resolve(request.result || [])')) {
  throw new Error('Static client should validate IndexedDB segment cache array results')
}
const staticCacheByteLength = sourceSlice(app, 'function cachedSegmentByteLength(record)', 'async function refreshCacheStats()')
if (!staticCacheByteLength.includes('Number.isSafeInteger(record?.bytes)')
  || !staticCacheByteLength.includes('cachedSegmentByteLength(record)')) {
  throw new Error('Static client should validate cached segment byte lengths before cache accounting')
}
if (staticCacheByteLength.includes('record.bytes || record.payload?.byteLength || 0')) {
  throw new Error('Static client cache accounting should not coerce malformed cached byte lengths')
}
for (const forbiddenEndpointDisplay of [
  'failures.push(`${endpoint}:',
  'failures.push(`${url}:',
  '`Execution: ${endpoint}`',
  '`Beacon: ${endpoint}`',
  'setStatus(error.message)',
  'textContent = error.message',
  'error: error.message',
  'warning: error.message',
  'Playback blocked: ${error.message}',
]) {
  if (app.includes(forbiddenEndpointDisplay)) {
    throw new Error(`Static client should not display unredacted endpoint/error details: ${forbiddenEndpointDisplay}`)
  }
}

for (const marker of [
  'normalizeLocalManifest',
  'normalizeBlobVersionedHashes',
  'normalizeCachedSidecars',
  'safeSlot',
  'readStationDeployment',
  'safeSidecarPath',
  'safeMediaPath',
  'validSidecarMatch',
  'isBlobHex',
  'isTxHash',
  'nonNegativeSafeInteger',
  'blockTimestampMs',
  'decimalSafeInteger',
  'stationSegmentFromLog',
  'beaconDataArray',
  'beaconGenesisTime',
  'beaconHeadSlot',
  'sidecarVersionedHash',
  'publicErrorMessage',
  'liveResponseSegments',
  'envBlockNumber',
  'envNumber',
]) {
  if (!liveDemo.includes(marker)) throw new Error(`Missing live demo local manifest guard: ${marker}`)
}
for (const rawLiveDemoEnvNumber of [
  'Number(process.env.PORT',
  'Number(process.env.MAX_BLOBS_PER_BLOCK',
  'Number(process.env.SLOT_WINDOW',
  'Number(process.env.SLOT_METRICS_CACHE_MS',
  'Number(process.env.VIEWER_POLL_MS',
  'Number(process.env.BEACON_TIMEOUT_MS',
]) {
  if (liveDemo.includes(rawLiveDemoEnvNumber)) {
    throw new Error(`Live demo should validate numeric environment values: ${rawLiveDemoEnvNumber}`)
  }
}
const liveDemoReadManifests = sourceSlice(liveDemo, 'function readManifests()', 'async function readStationSegments')
if (!liveDemoReadManifests.includes('normalizeLocalManifest(readJson(manifestPath))')) {
  throw new Error('Live demo should validate local manifests before deriving paths')
}
if (!liveDemoReadManifests.includes('flatMap')) {
  throw new Error('Live demo should skip invalid local manifests without aborting the feed')
}
const liveDemoNormalizeLocalManifest = sourceSlice(liveDemo, 'function normalizeBlobVersionedHashes(value)', 'function readProofSegments(id)')
if (!liveDemoNormalizeLocalManifest.includes('const blobVersionedHashes = normalizeBlobVersionedHashes(manifest.blobVersionedHashes)')
  || !liveDemoNormalizeLocalManifest.includes('blobVersionedHashes == null')
  || !liveDemoNormalizeLocalManifest.includes('blobVersionedHashes,')) {
  throw new Error('Live demo should validate local manifest blobVersionedHashes before segment use')
}
const liveDemoStationSegmentFromLog = sourceSlice(liveDemo, 'function stationSegmentFromLog(log, ctx', 'function readProofSegments(id)')
if (!liveDemoStationSegmentFromLog.includes("nonNegativeSafeInteger(log.args.sequence, 'Station segment sequence')")
  || !liveDemoStationSegmentFromLog.includes("nonNegativeSafeInteger(log.args.durationMs, 'Station segment durationMs')")
  || !liveDemoStationSegmentFromLog.includes("nonNegativeSafeInteger(log.args.payloadBytes, 'Station segment payloadBytes')")
  || !liveDemoStationSegmentFromLog.includes('normalizeBlobVersionedHashes(log.args.blobVersionedHashes)')
  || !liveDemoStationSegmentFromLog.includes("throw new Error('Invalid Station segment blobVersionedHashes')")
  || !liveDemoStationSegmentFromLog.includes("throw new Error('Invalid Station segment payloadSha256')")) {
  throw new Error('Live demo should validate decoded Station segment logs before API use')
}
const liveDemoReadStationSegments = sourceSlice(liveDemo, 'async function readStationSegments', 'function refreshStationSegments')
if (!liveDemoReadStationSegments.includes('stationSegmentFromLog(log, ctx, createdAtMs)')
  || !liveDemoReadStationSegments.includes("blockTimestampMs(block.timestamp, 'Station segment block timestamp')")
  || liveDemoReadStationSegments.includes('Number(block.timestamp) * 1000')
  || liveDemoReadStationSegments.includes('Number(log.args.sequence)')
  || liveDemoReadStationSegments.includes('Number(log.args.durationMs)')
  || liveDemoReadStationSegments.includes('Number(log.args.payloadBytes)')
  || liveDemoReadStationSegments.includes('log.args.blobVersionedHashes.length')
  || liveDemoReadStationSegments.includes('blobVersionedHashes: log.args.blobVersionedHashes')) {
  throw new Error('Live demo Station feed should use normalized decoded log fields')
}
const liveDemoSummarizeSegment = sourceSlice(liveDemo, 'function summarizeSegment(segment)', 'async function summarizeStationLog')
if (!liveDemoSummarizeSegment.includes('const blobVersionedHashes = normalizeBlobVersionedHashes(segment.blobVersionedHashes)')
  || !liveDemoSummarizeSegment.includes("throw new Error('Invalid segment blobVersionedHashes')")
  || !liveDemo.includes('function optionalNonNegativeSafeInteger(value, label)')
  || !liveDemoSummarizeSegment.includes("const sequence = nonNegativeSafeInteger(segment.sequence, 'segment sequence')")
  || !liveDemoSummarizeSegment.includes('const proof = proofSegmentBySequence(segment.streamId).get(sequence) || null')
  || !liveDemoSummarizeSegment.includes("optionalNonNegativeSafeInteger(segment.durationMs, 'segment durationMs') ?? 0")
  || !liveDemoSummarizeSegment.includes("optionalNonNegativeSafeInteger(segment.payloadBytes ?? segment.bytes, 'segment payloadBytes') ?? 0")
  || !liveDemoSummarizeSegment.includes('segment.blobCount ?? segment.estimatedBlobs ?? blobVersionedHashes.length')
  || liveDemoSummarizeSegment.includes('proofSegmentBySequence(segment.streamId).get(Number(segment.sequence))')
  || liveDemoSummarizeSegment.includes('sequence: Number(segment.sequence)')
  || liveDemoSummarizeSegment.includes('durationMs: Number(segment.durationMs || 0)')
  || liveDemoSummarizeSegment.includes('payloadBytes: Number(segment.payloadBytes || 0)')
  || liveDemoSummarizeSegment.includes('blobCount: Number(segment.blobCount || blobVersionedHashes.length || 0)')
  || liveDemoSummarizeSegment.includes('blobVersionedHashes: segment.blobVersionedHashes || []')) {
  throw new Error('Live demo segment summaries should validate numeric fields and emit normalized blobVersionedHashes')
}
const liveDemoSummarizeStationLog = sourceSlice(liveDemo, 'async function summarizeStationLog', 'async function lookupStationSegmentTargeted')
if (!liveDemoSummarizeStationLog.includes("stationSegmentFromLog(log, ctx, blockTimestampMs(block.timestamp, 'Station segment block timestamp'))")
  || liveDemoSummarizeStationLog.includes('Number(block.timestamp) * 1000')
  || liveDemoSummarizeStationLog.includes('Number(log.args.sequence)')
  || liveDemoSummarizeStationLog.includes('Number(log.args.durationMs)')
  || liveDemoSummarizeStationLog.includes('Number(log.args.payloadBytes)')
  || liveDemoSummarizeStationLog.includes('blobVersionedHashes: log.args.blobVersionedHashes')) {
  throw new Error('Live demo targeted Station lookup should use normalized decoded log fields')
}
const liveDemoReadStationDeployment = sourceSlice(liveDemo, 'function readStationDeployment(name)', 'function envBlockNumber')
if (!liveDemoReadStationDeployment.includes('try {') || !liveDemoReadStationDeployment.includes('Array.isArray(deployment?.abi)')) {
  throw new Error('Live demo should tolerate malformed Station deployment metadata')
}
if (liveDemo.includes("JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))")) {
  throw new Error('Live demo should not parse Station deployment metadata without a guard')
}
const liveDemoLookupStationSegmentTargeted = sourceSlice(liveDemo, 'async function lookupStationSegmentTargeted(value, ctx)', 'function findSegmentFromText(value, candidates)')
if (liveDemoLookupStationSegmentTargeted.includes('toBlock: blockNumber,\n  }).catch(() => [])')) {
  throw new Error('Live demo block-number Station lookup should surface RPC getLogs failures')
}
const liveDemoFetchAndCacheSidecars = sourceSlice(liveDemo, 'async function fetchAndCacheSidecars', 'function reconstructPayload')
if (!liveDemoFetchAndCacheSidecars.includes('safeSidecarPath(segment.txHash)')) {
  throw new Error('Live demo should validate sidecar cache filenames before writing')
}
if (!liveDemoFetchAndCacheSidecars.includes('beaconGenesisTime(genesis)') || !liveDemoFetchAndCacheSidecars.includes("beaconDataArray(sidecars, 'blob sidecars')")) {
  throw new Error('Live demo should validate beacon sidecar responses before caching sidecars')
}
if (!liveDemoFetchAndCacheSidecars.includes('preferredBlobVersionedHashes(tx, segment)')
  || liveDemoFetchAndCacheSidecars.includes('tx.blobVersionedHashes || segment.blobVersionedHashes || []')) {
  throw new Error('Live demo should validate transaction blob hash metadata before sidecar matching')
}
const liveDemoRecentBlobTransactions = sourceSlice(liveDemo, 'async function recentBlobTransactionsByHash', 'async function computeSlotMetrics')
if (!liveDemoRecentBlobTransactions.includes('normalizeBlobVersionedHashes(tx?.blobVersionedHashes)')
  || !liveDemoRecentBlobTransactions.includes("throw new Error('Invalid recent transaction blobVersionedHashes')")
  || !liveDemoRecentBlobTransactions.includes("throw new Error('Invalid recent transaction hash')")
  || !liveDemoRecentBlobTransactions.includes('const txHash = String(tx.hash).toLowerCase()')
  || liveDemoRecentBlobTransactions.includes('tx?.blobVersionedHashes || []')) {
  throw new Error('Live demo slot metrics should validate recent transaction blob hash metadata')
}
const liveDemoReconstructPayload = sourceSlice(liveDemo, 'function reconstructPayload(segment, sidecars)', 'async function ensureMedia')
if (!liveDemoReconstructPayload.includes('Array.isArray(sidecars?.matches)') || !liveDemoReconstructPayload.includes('validSidecarMatch(match)')) {
  throw new Error('Live demo should validate sidecar match shape before decoding blobs')
}
if (!liveDemoReconstructPayload.includes("const payloadBytes = optionalNonNegativeSafeInteger(segment.payloadBytes ?? segment.bytes, 'segment payloadBytes')")
  || !liveDemoReconstructPayload.includes("throw new Error('segment payloadBytes is required for reconstruction')")
  || !liveDemoReconstructPayload.includes('subarray(0, payloadBytes)')
  || liveDemoReconstructPayload.includes('subarray(0, Number(segment.payloadBytes))')) {
  throw new Error('Live demo should validate reconstruction payload byte length before trimming')
}
if (liveDemoReconstructPayload.includes('segment.blobVersionedHashes || []')) {
  throw new Error('Live demo should rely on normalized segment blob hashes during reconstruction')
}
const liveDemoBeaconHelpers = sourceSlice(liveDemo, 'function beaconData(response, label)', 'function safeMediaPath')
if (!liveDemoBeaconHelpers.includes('function beaconDataArray(response, label)')
  || !liveDemoBeaconHelpers.includes('function decimalSafeInteger(value, label)')
  || !liveDemoBeaconHelpers.includes('function beaconHeadSlot(response)')
  || !liveDemoBeaconHelpers.includes("return decimalSafeInteger(slot, 'Invalid beacon head response: slot')")
  || liveDemoBeaconHelpers.includes('return Number(slot)')) {
  throw new Error('Live demo should expose beacon response shape validators')
}
const liveDemoSlotMetrics = sourceSlice(liveDemo, 'async function getBeaconGenesisTime', 'function cachedBlobspaceRows')
for (const rawBeaconPattern of [
  'genesis.data.genesis_time',
  'head.data.header.message.slot',
  'body.data || []',
]) {
  if (liveDemoSlotMetrics.includes(rawBeaconPattern)) {
    throw new Error(`Live demo slot metrics should not trust raw beacon response shape: ${rawBeaconPattern}`)
  }
}
if (!liveDemoSlotMetrics.includes("sidecarIndex(sidecar.index, 'beacon sidecar index')")
  || liveDemoSlotMetrics.includes('index: Number(sidecar.index)')) {
  throw new Error('Live demo slot metrics should validate beacon sidecar indices')
}
if (!liveDemoSlotMetrics.includes("const safeSlot = nonNegativeSafeInteger(slot, 'beacon sidecar slot')")
  || !liveDemoSlotMetrics.includes('`/eth/v1/beacon/blob_sidecars/${safeSlot}`')
  || !liveDemoSlotMetrics.includes('return { slot: safeSlot, fetchMs: Math.round(performance.now() - started), sidecars: rows }')
  || liveDemoSlotMetrics.includes('return { slot: Number(slot), fetchMs: Math.round(performance.now() - started), sidecars: rows }')) {
  throw new Error('Live demo sidecar fetches should validate requested beacon slots before fetching')
}
if (!liveDemoSlotMetrics.includes("const safeSlot = nonNegativeSafeInteger(slot, 'beacon slot')")
  || !liveDemoSlotMetrics.includes("return blockTimestampMs(genesisTime + BigInt(safeSlot) * secondsPerSlot, 'beacon slot timestamp')")
  || liveDemoSlotMetrics.includes('return Number((genesisTime + BigInt(slot) * secondsPerSlot) * 1000n)')) {
  throw new Error('Live demo slot metrics should validate derived slot timestamps before millisecond conversion')
}
const liveDemoReadProofSegments = sourceSlice(liveDemo, 'function readProofSegments(id)', 'function proofSegmentBySequence')
if (!liveDemoReadProofSegments.includes('try {') || !liveDemoReadProofSegments.includes('safeSegmentSequence')) {
  throw new Error('Live demo should tolerate malformed proof manifests')
}
const liveDemoProofSegmentBySequence = sourceSlice(liveDemo, 'function proofSegmentBySequence(id)', 'function getCachedSidecars(txHash)')
if (!liveDemoProofSegmentBySequence.includes('const sequence = safeSegmentSequence(segment.sequence)')
  || !liveDemoProofSegmentBySequence.includes('if (sequence != null) proof.set(sequence, segment)')
  || liveDemoProofSegmentBySequence.includes('proof.set(Number(segment.sequence), segment)')) {
  throw new Error('Live demo proof sequence lookup should validate proof manifest sequence keys')
}
const liveDemoGetCachedSidecars = sourceSlice(liveDemo, 'function getCachedSidecars(txHash)', 'function readManifests()')
if (!liveDemoGetCachedSidecars.includes('try {') || !liveDemoGetCachedSidecars.includes('normalizeCachedSidecars(readJson(sidecarPath), txHash)')) {
  throw new Error('Live demo should tolerate malformed cached sidecar JSON')
}
const liveDemoNormalizeCachedSidecars = sourceSlice(liveDemo, 'function normalizeCachedSidecars(sidecars, txHash)', 'function safeMediaPath')
if (!liveDemoNormalizeCachedSidecars.includes('const slot = safeSlot(sidecars.slot)') || !liveDemoNormalizeCachedSidecars.includes('slot,')) {
  throw new Error('Live demo should validate cached sidecar slots before deriving blobspace rows')
}
if (!liveDemoNormalizeCachedSidecars.includes('Array.isArray(sidecars.matches)')
  || !liveDemoNormalizeCachedSidecars.includes('validSidecarMatch(match)')
  || !liveDemoNormalizeCachedSidecars.includes('safeSlot(match.index) !== null')
  || liveDemoNormalizeCachedSidecars.includes('matches: Array.isArray(sidecars.matches) ? sidecars.matches : []')) {
  throw new Error('Live demo should validate cached sidecar match arrays before reuse')
}
const liveDemoCachedBlobspaceRows = sourceSlice(liveDemo, 'function cachedBlobspaceRows(segments)', 'async function stationStreamBlobHashes')
if (!liveDemoCachedBlobspaceRows.includes('cached?.slot == null') || liveDemoCachedBlobspaceRows.includes('Number(cached.slot)')) {
  throw new Error('Live demo should skip cached sidecars with invalid slots')
}
if (!liveDemoCachedBlobspaceRows.includes("const sequence = nonNegativeSafeInteger(segment.sequence, 'cached blobspace segment sequence')")
  || liveDemoCachedBlobspaceRows.includes('cached.matches || []')
  || liveDemoCachedBlobspaceRows.includes('index: Number(match.index)')
  || liveDemoCachedBlobspaceRows.includes('sequence: Number(segment.sequence)')) {
  throw new Error('Live demo should rely on normalized cached sidecar matches in blobspace rows')
}
const liveDemoBlobspaceRows = sourceSlice(liveDemo, 'async function blobspaceRows(segments', 'async function fetchAndCacheSidecars')
if (!liveDemoBlobspaceRows.includes("const sequence = nonNegativeSafeInteger(segment.sequence, 'blobspace segment sequence')")
  || !liveDemoBlobspaceRows.includes('streamHashes.set(hash, { streamId: segment.streamId, sequence })')
  || liveDemoBlobspaceRows.includes('sequence: Number(segment.sequence)')) {
  throw new Error('Live demo blobspace rows should validate segment sequences before attribution')
}
const liveDemoRenderRail = sourceSlice(liveDemo, 'function renderRail(blobspace)', 'function setSegmentsPaneHeight(height)')
if (!liveDemo.includes('beaconSlotBase')
  || !liveDemo.includes('const slotUrl = (slot) =>')
  || !liveDemoRenderRail.includes('const rowSlotUrl = blobspace.beaconSlotBase')
  || !liveDemoRenderRail.includes('href="\' + escapeHtml(rowSlotUrl)')
  || !liveDemoRenderRail.includes("slot.querySelector('.slot-top strong')")
  || !liveDemoRenderRail.includes("link.className = 'slot-link'")) {
  throw new Error('Live demo blobspace rows should link slots and unattributed occupied blobs to explorers')
}
if (!liveDemo.includes("sendJson(response, { error: publicErrorMessage(error, ctx) }, 500)")) {
  throw new Error('Live demo should redact endpoint URLs from API error responses')
}
if (liveDemo.includes('warning: error.message')) {
  throw new Error('Live demo should redact endpoint URLs from warning fields')
}
if ((liveDemo.match(/function liveResponseSegments\(data\)/g) || []).length < 3 || !liveDemo.includes('segments = liveResponseSegments(data)')) {
  throw new Error('Live demo browser clients should validate live response segment arrays')
}
for (const rawLiveResponseSegments of [
  'data.segments || []',
  'latestSegment(data.segments)',
  'previousSegment(segment, data.segments)',
  'updateTicker(segment, data.blobspace, data.segments)',
]) {
  if (liveDemo.includes(rawLiveResponseSegments)) {
    throw new Error(`Live demo browser clients should not trust raw live response segments: ${rawLiveResponseSegments}`)
  }
}
if (liveDemo.includes('data.segments || []')) {
  throw new Error('Live demo browser clients should not treat malformed live response segments as empty')
}
for (const forbiddenLiveDemoClientError of [
  'textContent = error.message',
  '+ error.message',
  'overlayCopy.textContent = error.message',
  "setState('interrupted', 'Tuner interrupted', error.message)",
]) {
  if (liveDemo.includes(forbiddenLiveDemoClientError)) {
    throw new Error(`Live demo browser UI should redact visible error details: ${forbiddenLiveDemoClientError}`)
  }
}

console.log(`static client ok: ${staticDir}`)
