import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stationDeploymentPath } from './lib/station-deployment.mjs'

const root = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-utility-cli-'))
process.on('exit', () => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function runNode(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ETH_RPC_URL: '',
      BEACON_RPC_URL: '',
      PRIVATE_KEY: '',
      STATION_ADDRESS: '',
      ...env,
    },
  })
  return {
    ...result,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function assertFails({ label, args, expected, env }) {
  const result = runNode(args, env)
  if (result.status === 0) throw new Error(`${label} unexpectedly succeeded\n${result.output}`)
  if (!result.output.includes(expected)) {
    throw new Error(`${label} did not report "${expected}"\n${result.output}`)
  }
}

function assertSucceeds({ label, args, expected, env }) {
  const result = runNode(args, env)
  if (result.status !== 0) throw new Error(`${label} failed unexpectedly\n${result.output}`)
  if (expected && !result.output.includes(expected)) {
    throw new Error(`${label} did not report "${expected}"\n${result.output}`)
  }
}

function withTemporaryFile(filePath, content, fn) {
  const existed = fs.existsSync(filePath)
  const previous = existed ? fs.readFileSync(filePath) : null
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  try {
    return fn()
  } finally {
    if (existed) fs.writeFileSync(filePath, previous)
    else fs.rmSync(filePath, { force: true })
  }
}

function assertFetchSidecarBeaconResponseGuards() {
  const source = fs.readFileSync(path.join(root, 'scripts', 'fetch-blob-sidecars.mjs'), 'utf8')
  for (const marker of [
    'function normalizeBlobVersionedHashes(value, label)',
    'function nonEmptyBlobVersionedHashes(value, label)',
    'function transactionBlobVersionedHashes(tx, manifest)',
    'function beaconDataArray(response, label)',
    'function beaconGenesisTime(response)',
    'assertBytes48Hex(commitment, \'sidecar KZG commitment\')',
    "nonEmptyBlobVersionedHashes(tx.blobVersionedHashes, 'transaction blobVersionedHashes')",
    "throw new Error('Missing transaction blobVersionedHashes; provide a manifest with blobVersionedHashes')",
    "beaconDataArray(sidecars, 'blob sidecars')",
    'const wanted = new Set(transactionBlobVersionedHashes(tx, manifest))',
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`fetch-blob-sidecars missing beacon response guard marker: ${marker}`)
    }
  }
  if (source.includes('for (const sidecar of sidecars.data || [])')) {
    throw new Error('fetch-blob-sidecars reintroduced raw sidecars.data iteration')
  }
  if (source.includes('tx.blobVersionedHashes || manifest?.blobVersionedHashes || []')) {
    throw new Error('fetch-blob-sidecars reintroduced unvalidated transaction blob hash fallback')
  }
  if (source.includes('wanted.size === 0')) {
    throw new Error('fetch-blob-sidecars reintroduced empty wanted-hash wildcard matching')
  }
}

assertFetchSidecarBeaconResponseGuards()

function assertBlobSlotMetricsBeaconResponseGuards() {
  const source = fs.readFileSync(path.join(root, 'scripts', 'blob-slot-metrics.mjs'), 'utf8')
  for (const marker of [
    'function beaconDataArray(response, label)',
    'function beaconGenesisTime(response)',
    'function sidecarIndex(value, label)',
    'function assertBytes32Hex(value, label)',
    'function transactionHash(value, label)',
    'function blobVersionedHashes(value, label)',
    'function stationSegmentBlobAttribution(log, index)',
    'parsed.map(stationSegmentBlobAttribution).forEach((segment) =>',
    'transactionHash(log.transactionHash, `SegmentPublished log ${index} transactionHash`)',
    'blobVersionedHashes(args.blobVersionedHashes, `SegmentPublished log ${index} blobVersionedHashes`)',
    'assertBytes48Hex(commitment, \'sidecar KZG commitment\')',
    "index: sidecarIndex(sidecar.index, 'sidecar index')",
    "sidecars = beaconDataArray(result, 'blob sidecars')",
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`blob-slot-metrics missing beacon response guard marker: ${marker}`)
    }
  }
  if (source.includes('sidecars = result.data || []')) {
    throw new Error('blob-slot-metrics reintroduced raw sidecar response iteration')
  }
  if (source.includes('index: Number(sidecar.index)')) {
    throw new Error('blob-slot-metrics reintroduced raw sidecar index coercion')
  }
  for (const fallback of [
    'for (const hash of log.args.blobVersionedHashes)',
    'streamId: log.args.streamId',
    'sequence: log.args.sequence.toString()',
    'txHash: log.transactionHash',
  ]) {
    if (source.includes(fallback)) {
      throw new Error(`blob-slot-metrics reintroduced raw Station attribution fallback: ${fallback}`)
    }
  }
}

assertBlobSlotMetricsBeaconResponseGuards()

function assertCompileStationSolcOutputGuards() {
  const source = fs.readFileSync(path.join(root, 'scripts', 'compile-station.mjs'), 'utf8')
  for (const marker of [
    'function assertSolcObject(value, label)',
    'function solcDiagnostics(output)',
    'function stationContract(output)',
    "throw new Error('Invalid solc output: errors must be an array')",
    "throw new Error('Invalid solc output: Station ABI must be an array')",
    "throw new Error('Invalid solc output: Station bytecode must be hex')",
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`compile-station missing solc output guard marker: ${marker}`)
    }
  }
  if (source.includes('const errors = output.errors || []')) {
    throw new Error('compile-station reintroduced permissive solc errors fallback')
  }
}

assertCompileStationSolcOutputGuards()

function assertListStationSegmentLogIndexGuards() {
  const source = fs.readFileSync(path.join(root, 'scripts', 'list-station-segments.mjs'), 'utf8')
  for (const marker of [
    'function nonNegativeInteger(value, label)',
    'function stationSegment(log, index)',
    'function normalizeBlobVersionedHashes(value, label)',
    'function compareDecimalBigintStrings(left, right, label)',
    'publisher: getAddress(args.publisher)',
    'sequence: sequence.toString()',
    'payloadSha256: bytes32(args.payloadSha256, `SegmentPublished log ${index} payloadSha256`)',
    'blobVersionedHashes: normalizeBlobVersionedHashes(args.blobVersionedHashes, `SegmentPublished log ${index} blobVersionedHashes`)',
    "compareDecimalBigintStrings(a.blockNumber, b.blockNumber, 'SegmentPublished blockNumber')",
    'transactionIndex: nonNegativeInteger(log.transactionIndex, `SegmentPublished log ${index} transactionIndex`)',
    'logIndex: nonNegativeInteger(log.logIndex, `SegmentPublished log ${index} logIndex`)',
    'a.transactionIndex - b.transactionIndex',
    'a.logIndex - b.logIndex',
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`list-station-segments missing log index guard marker: ${marker}`)
    }
  }
  if (source.includes('Number(a.transactionIndex || 0)') || source.includes('Number(a.logIndex || 0)')) {
    throw new Error('list-station-segments reintroduced log index sort fallbacks')
  }
  if (source.includes('Number(a.blockNumber) - Number(b.blockNumber)')) {
    throw new Error('list-station-segments reintroduced unsafe blockNumber sort coercion')
  }
  for (const fallback of [
    'publisher: log.args.publisher',
    'streamIdHash: log.args.streamIdHash',
    'durationMs: Number(log.args.durationMs)',
    'payloadBytes: Number(log.args.payloadBytes)',
    'payloadSha256: log.args.payloadSha256',
    'blobVersionedHashes: log.args.blobVersionedHashes',
    'Number(a.sequence) - Number(b.sequence)',
  ]) {
    if (source.includes(fallback)) {
      throw new Error(`list-station-segments reintroduced raw event argument fallback: ${fallback}`)
    }
  }
}

assertListStationSegmentLogIndexGuards()

function assertOverlayPngGuards() {
  const source = fs.readFileSync(path.join(root, 'scripts', 'generate-rfe-overlay-assets.mjs'), 'utf8')
  if (!source.includes('buffer.length < 26') || !source.includes('Overlay source PNG is truncated')) {
    throw new Error('overlay asset generator should reject truncated PNGs before reading IHDR fields')
  }
}

assertOverlayPngGuards()

function assertMonitorLatencySegmentGuards() {
  const source = fs.readFileSync(path.join(root, 'scripts', 'monitor-stream-latency.mjs'), 'utf8')
  for (const marker of [
    'function nonNegativeSafeNumber(value, label)',
    'function blockTimestampMs(value, label)',
    'function segmentBlobVersionedHashes(value, label)',
    'function monitorSegment(log, latestBlock, latestBlockMs)',
    "const latestBlockMs = blockTimestampMs(latestBlock.timestamp, 'latest block timestamp')",
    "if (typeof args.streamId !== 'string') throw new Error('SegmentPublished streamId must be a string')",
    'streamId: args.streamId',
    "nonNegativeSafeNumber(args.sequence, 'SegmentPublished sequence')",
    "nonNegativeSafeNumber(args.payloadBytes, 'SegmentPublished payloadBytes')",
    "segmentBlobVersionedHashes(args.blobVersionedHashes, 'SegmentPublished blobVersionedHashes').length",
    '.map((log) => monitorSegment(log, latestBlock, latestBlockMs))',
    '.filter((segment) => segment.streamId === streamId)',
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`monitor-stream-latency missing segment guard marker: ${marker}`)
    }
  }
  for (const fallback of [
    'sequence: Number(log.args.sequence)',
    'payloadBytes: Number(log.args.payloadBytes)',
    'blobCount: log.args.blobVersionedHashes.length',
    'Number(latestBlock.number - log.blockNumber) * 12_000',
    'Number(latestBlock.timestamp) * 1000',
    'Number(a.sequence) - Number(b.sequence)',
    '.filter((log) => log.args.streamId === streamId)',
  ]) {
    if (source.includes(fallback)) {
      throw new Error(`monitor-stream-latency reintroduced raw segment coercion: ${fallback}`)
    }
  }
}

assertMonitorLatencySegmentGuards()

try {
  stationDeploymentPath('../../../outside', tempRoot)
  throw new Error('stationDeploymentPath accepted an unsafe chain name')
} catch (error) {
  if (!error.message.includes('Invalid Station deployment chain name')) throw error
}

assertFails({
  label: 'reconstruct missing manifest',
  args: ['scripts/reconstruct-blob-media.mjs', '--manifest', '--sidecars', 'sidecars.json'],
  expected: '--manifest requires a value',
})

assertFails({
  label: 'monitor stale ms',
  args: ['scripts/monitor-live-stream.mjs', '--stale-ms', '0'],
  expected: 'Invalid --stale-ms: 0',
})

const malformedMonitorState = path.join(tempRoot, 'malformed-publish-state.json')
fs.writeFileSync(malformedMonitorState, '{ bad json')
assertFails({
  label: 'monitor malformed publish state',
  args: ['scripts/monitor-live-stream.mjs', '--state', malformedMonitorState],
  expected: 'Unreadable publish state',
})

const invalidMonitorState = path.join(tempRoot, 'invalid-publish-state.json')
fs.writeFileSync(invalidMonitorState, `${JSON.stringify({ nextSequence: -1, published: {} })}\n`)
assertFails({
  label: 'monitor invalid publish state',
  args: ['scripts/monitor-live-stream.mjs', '--state', invalidMonitorState],
  expected: 'published must be an array',
})

const coercedMonitorState = path.join(tempRoot, 'coerced-publish-state.json')
fs.writeFileSync(coercedMonitorState, `${JSON.stringify({ nextSequence: '1e2', published: [] })}\n`)
assertFails({
  label: 'monitor rejects coerced next sequence',
  args: ['scripts/monitor-live-stream.mjs', '--state', coercedMonitorState],
  expected: 'nextSequence must be a non-negative integer',
})

const coercedPublishedMonitorState = path.join(tempRoot, 'coerced-published-state.json')
fs.writeFileSync(coercedPublishedMonitorState, `${JSON.stringify({
  nextSequence: 2,
  published: [{ sequence: '1e2' }],
})}\n`)
assertFails({
  label: 'monitor rejects coerced published sequence',
  args: ['scripts/monitor-live-stream.mjs', '--state', coercedPublishedMonitorState],
  expected: 'published[0].sequence must be a non-negative integer',
})

const monitorSource = fs.readFileSync(path.join(root, 'scripts', 'monitor-live-stream.mjs'), 'utf8')
if (!monitorSource.includes('const published = state.published === undefined ? [] : state.published')
  || monitorSource.includes('published: state.published || []')) {
  throw new Error('monitor should normalize published history without permissive fallback')
}
if (!monitorSource.includes('function nonNegativeInteger(value, label)')
  || !monitorSource.includes("nonNegativeInteger(item.sequence, `published[${index}].sequence`)")
  || monitorSource.includes('const sequence = Number(segment?.sequence)')
  || monitorSource.includes('Number(latestGenerated.sequence) - Number(latest.sequence)')) {
  throw new Error('monitor should strictly validate generated and published sequences before lag math')
}

const monitorState = path.join(tempRoot, 'publish-state.json')
const monitorManifest = path.join(tempRoot, 'generated.segments.json')
fs.writeFileSync(monitorState, `${JSON.stringify({
  nextSequence: 1,
  published: [{
    sequence: 0,
    txHash: `0x${'1'.repeat(64)}`,
    blockNumber: '1',
    payloadBytes: 10,
    blobCount: 1,
    includedAt: new Date().toISOString(),
  }],
})}\n`)
fs.writeFileSync(monitorManifest, '{ bad json')
assertSucceeds({
  label: 'monitor ignores malformed optional manifest',
  args: [
    'scripts/monitor-live-stream.mjs',
    '--state',
    monitorState,
    '--manifest',
    monitorManifest,
    '--stale-ms',
    '999999999',
  ],
  expected: 'Ignoring unreadable generated manifest',
})

fs.writeFileSync(monitorManifest, `${JSON.stringify({ segments: {} })}\n`)
assertSucceeds({
  label: 'monitor warns for invalid optional manifest shape',
  args: [
    'scripts/monitor-live-stream.mjs',
    '--state',
    monitorState,
    '--manifest',
    monitorManifest,
    '--stale-ms',
    '999999999',
  ],
  expected: 'segments must be an array',
})

fs.writeFileSync(monitorManifest, `${JSON.stringify({ segments: [{ sequence: 'nope' }] })}\n`)
assertSucceeds({
  label: 'monitor warns for invalid optional manifest sequence',
  args: [
    'scripts/monitor-live-stream.mjs',
    '--state',
    monitorState,
    '--manifest',
    monitorManifest,
    '--stale-ms',
    '999999999',
  ],
  expected: 'sequence must be a non-negative integer',
})

fs.writeFileSync(monitorManifest, `${JSON.stringify({ segments: [{ sequence: '1e2' }] })}\n`)
assertSucceeds({
  label: 'monitor warns for coerced optional manifest sequence',
  args: [
    'scripts/monitor-live-stream.mjs',
    '--state',
    monitorState,
    '--manifest',
    monitorManifest,
    '--stale-ms',
    '999999999',
  ],
  expected: 'sequence must be a non-negative integer',
})

assertFails({
  label: 'latency missing rpc-url',
  args: ['scripts/monitor-stream-latency.mjs', '--rpc-url', '--max-loops', '1'],
  expected: '--rpc-url requires a value',
})

assertFails({
  label: 'latency invalid lookback',
  args: ['scripts/monitor-stream-latency.mjs', '--lookback-blocks', '-1', '--max-loops', '1'],
  expected: 'Invalid --lookback-blocks: -1',
})

assertFails({
  label: 'latency invalid from block',
  args: ['scripts/monitor-stream-latency.mjs', '--from-block', 'abc', '--max-loops', '1'],
  expected: 'Invalid --from-block: abc',
})

const sepoliaDeployment = path.join(root, 'work', 'blob-radio-testnet', 'contracts', 'Station.sepolia.json')
withTemporaryFile(sepoliaDeployment, '{ bad json', () => {
  assertFails({
    label: 'latency ignores malformed deployment metadata',
    args: ['scripts/monitor-stream-latency.mjs', '--rpc-url', 'http://127.0.0.1:1', '--max-loops', '1'],
    expected: 'Missing chain, rpc url, station address, or Station ABI',
    env: {
      CHAIN: 'sepolia',
    },
  })

  assertFails({
    label: 'list station ignores malformed deployment metadata',
    args: ['scripts/list-station-segments.mjs'],
    expected: 'Usage:',
    env: {
      ETH_RPC_URL: 'http://127.0.0.1:1',
      CHAIN: 'sepolia',
    },
  })

  assertFails({
    label: 'blob slot metrics ignores malformed deployment metadata',
    args: ['scripts/blob-slot-metrics.mjs', '--slots', '0'],
    expected: 'Invalid --slots: 0',
    env: {
      ETH_RPC_URL: 'http://127.0.0.1:1',
      BEACON_RPC_URL: 'http://127.0.0.1:1',
      CHAIN: 'sepolia',
    },
  })
})

assertFails({
  label: 'blob slot metrics invalid slots',
  args: ['scripts/blob-slot-metrics.mjs', '--slots', '0'],
  expected: 'Invalid --slots: 0',
  env: {
    ETH_RPC_URL: 'http://127.0.0.1:1',
    BEACON_RPC_URL: 'http://127.0.0.1:1',
    CHAIN: 'sepolia',
  },
})

assertFails({
  label: 'fetch sidecars missing manifest',
  args: ['scripts/fetch-blob-sidecars.mjs', '--manifest', '--tx', '0x0'],
  expected: '--manifest requires a value',
  env: {
    ETH_RPC_URL: 'http://127.0.0.1:1',
    BEACON_RPC_URL: 'http://127.0.0.1:1',
    CHAIN: 'sepolia',
  },
})

const invalidTxManifest = path.join(tempRoot, 'invalid-tx-manifest.json')
fs.writeFileSync(invalidTxManifest, `${JSON.stringify({ txHash: '../not-a-tx' })}\n`)
assertFails({
  label: 'fetch sidecars invalid tx hash',
  args: ['scripts/fetch-blob-sidecars.mjs', '--manifest', invalidTxManifest],
  expected: 'Invalid transaction hash: ../not-a-tx',
  env: {
    ETH_RPC_URL: 'http://127.0.0.1:1',
    BEACON_RPC_URL: 'http://127.0.0.1:1',
    CHAIN: 'sepolia',
  },
})

assertFails({
  label: 'fetch sidecars inline manifest invalid tx hash',
  args: ['scripts/fetch-blob-sidecars.mjs', `--manifest=${invalidTxManifest}`],
  expected: 'Invalid transaction hash: ../not-a-tx',
  env: {
    ETH_RPC_URL: 'http://127.0.0.1:1',
    BEACON_RPC_URL: 'http://127.0.0.1:1',
    CHAIN: 'sepolia',
  },
})

const invalidBlobHashesManifest = path.join(tempRoot, 'invalid-blob-hashes-manifest.json')
fs.writeFileSync(invalidBlobHashesManifest, `${JSON.stringify({
  txHash: `0x${'1'.repeat(64)}`,
  blobVersionedHashes: 'not-an-array',
})}\n`)
assertFails({
  label: 'fetch sidecars invalid blob hash list',
  args: ['scripts/fetch-blob-sidecars.mjs', '--manifest', invalidBlobHashesManifest],
  expected: 'blobVersionedHashes: must be an array',
  env: {
    ETH_RPC_URL: 'http://127.0.0.1:1',
    BEACON_RPC_URL: 'http://127.0.0.1:1',
    CHAIN: 'sepolia',
  },
})

const emptyBlobHashesManifest = path.join(tempRoot, 'empty-blob-hashes-manifest.json')
fs.writeFileSync(emptyBlobHashesManifest, `${JSON.stringify({
  txHash: `0x${'1'.repeat(64)}`,
  blobVersionedHashes: [],
})}\n`)
assertFails({
  label: 'fetch sidecars empty blob hash list',
  args: ['scripts/fetch-blob-sidecars.mjs', '--manifest', emptyBlobHashesManifest],
  expected: 'blobVersionedHashes: must include at least one hash',
  env: {
    ETH_RPC_URL: 'http://127.0.0.1:1',
    BEACON_RPC_URL: 'http://127.0.0.1:1',
    CHAIN: 'sepolia',
  },
})

const invalidReconstructManifest = path.join(tempRoot, 'invalid-reconstruct-manifest.json')
const sidecarsPath = path.join(tempRoot, 'sidecars.json')
fs.writeFileSync(invalidReconstructManifest, `${JSON.stringify({
  streamId: 'stream',
  sequence: '../escape',
  payloadBytes: 0,
  payloadSha256: '0'.repeat(64),
  blobCount: 0,
  blobVersionedHashes: [],
})}\n`)
fs.writeFileSync(sidecarsPath, '{"matches":[]}\n')
const arrayReconstructManifest = path.join(tempRoot, 'array-reconstruct-manifest.json')
fs.writeFileSync(arrayReconstructManifest, '[]\n')
assertFails({
  label: 'reconstruct array manifest',
  args: ['scripts/reconstruct-blob-media.mjs', '--manifest', arrayReconstructManifest, '--sidecars', sidecarsPath],
  expected: 'Manifest must be a JSON object',
})

assertFails({
  label: 'reconstruct invalid sequence',
  args: ['scripts/reconstruct-blob-media.mjs', '--manifest', invalidReconstructManifest, '--sidecars', sidecarsPath],
  expected: 'Invalid manifest sequence: ../escape',
})

fs.writeFileSync(invalidReconstructManifest, `${JSON.stringify({
  streamId: 'stream',
  sequence: '1e2',
  payloadBytes: 0,
  payloadSha256: '0'.repeat(64),
  blobCount: 0,
  blobVersionedHashes: [],
})}\n`)
assertFails({
  label: 'reconstruct rejects coerced numeric sequence',
  args: ['scripts/reconstruct-blob-media.mjs', '--manifest', invalidReconstructManifest, '--sidecars', sidecarsPath],
  expected: 'Invalid manifest sequence: 1e2',
})

const validReconstructManifest = path.join(tempRoot, 'valid-reconstruct-manifest.json')
fs.writeFileSync(validReconstructManifest, `${JSON.stringify({
  streamId: 'stream',
  sequence: 0,
  payloadBytes: 0,
  payloadSha256: '0'.repeat(64),
  blobCount: 1,
  blobVersionedHashes: [`0x${'1'.repeat(64)}`],
})}\n`)
const invalidSidecarShape = path.join(tempRoot, 'invalid-sidecar-shape.json')
fs.writeFileSync(invalidSidecarShape, '{"matches":{}}\n')
assertFails({
  label: 'reconstruct invalid sidecar matches shape',
  args: ['scripts/reconstruct-blob-media.mjs', '--manifest', validReconstructManifest, '--sidecars', invalidSidecarShape],
  expected: 'Sidecars matches must be an array',
})

const invalidSidecarBlob = path.join(tempRoot, 'invalid-sidecar-blob.json')
fs.writeFileSync(invalidSidecarBlob, `${JSON.stringify({
  matches: [{
    versionedHash: `0x${'1'.repeat(64)}`,
    blob: 'not-hex',
  }],
})}\n`)
assertFails({
  label: 'reconstruct invalid sidecar blob',
  args: ['scripts/reconstruct-blob-media.mjs', '--manifest', validReconstructManifest, '--sidecars', invalidSidecarBlob],
  expected: 'Invalid sidecar match 0 blob',
})

assertFails({
  label: 'list station missing station',
  args: ['scripts/list-station-segments.mjs', '--station', '--from-block', '0'],
  expected: '--station requires a value',
  env: {
    ETH_RPC_URL: 'http://127.0.0.1:1',
    CHAIN: 'sepolia',
  },
})

assertFails({
  label: 'overlay assets missing input',
  args: ['scripts/generate-rfe-overlay-assets.mjs', '--input', '--out-dir', 'unused'],
  expected: '--input requires a value',
})

const truncatedOverlayPng = path.join(tempRoot, 'truncated-overlay.png')
fs.writeFileSync(truncatedOverlayPng, Buffer.from('89504e470d0a1a0a', 'hex'))
assertFails({
  label: 'overlay assets truncated png',
  args: ['scripts/generate-rfe-overlay-assets.mjs', '--input', truncatedOverlayPng, '--out-dir', path.join(tempRoot, 'overlays')],
  expected: 'Overlay source PNG is truncated',
})

assertFails({
  label: 'static server invalid port',
  args: ['scripts/serve-static-client.mjs', '--port=0'],
  expected: 'Invalid --port: 0',
})

assertFails({
  label: 'static server missing host',
  args: ['scripts/serve-static-client.mjs', '--host', '--port', '8080'],
  expected: '--host requires a value',
})

assertFails({
  label: 'static server invalid source',
  args: ['scripts/serve-static-client.mjs', '--source', 'staging', '--port', '8080'],
  expected: 'Invalid --source: staging',
})

console.log('utility CLI guard tests ok')
