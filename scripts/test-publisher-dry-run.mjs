import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readCostOptions, segmentStats } from './lib/cost-preflight.mjs'
import { gasLimitEnv, optionalGweiEnv } from './lib/tx-env.mjs'

const root = process.cwd()
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eth-radio-publisher-dry-run-'))

function runNode(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ETH_RPC_URL: '',
      ETH_SEND_RPC_URLS: '',
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

function publisherEnv() {
  return {
    CHAIN: 'sepolia',
    ETH_RPC_URL: 'http://127.0.0.1:1',
    PRIVATE_KEY: `0x${'1'.repeat(64)}`,
    STATION_ADDRESS: `0x${'2'.repeat(40)}`,
  }
}

function writeSparseSegment(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'stream-000005.webm'), 'dummy payload')
}

function assertDryRun({ label, script, expected }) {
  const dir = path.join(tempRoot, label)
  writeSparseSegment(dir)
  const result = runNode([
    script,
    '--dir',
    dir,
    '--stream-id',
    'stream',
    '--start-seq',
    '5',
    '--once',
    '--exit-when-caught-up',
    '--dry-run',
  ])
  if (result.status !== 0) {
    throw new Error(`${label} dry run failed with ${result.status}\n${result.output}`)
  }
  if (!result.output.includes(expected)) {
    throw new Error(`${label} dry run did not report expected sequence\nExpected: ${expected}\n${result.output}`)
  }
  if (!result.output.includes('dry run complete: no state written')) {
    throw new Error(`${label} dry run did not report no-state behavior\n${result.output}`)
  }
  const files = fs.readdirSync(dir)
  if (files.length !== 1 || files[0] !== 'stream-000005.webm') {
    throw new Error(`${label} dry run wrote unexpected files: ${files.join(', ')}`)
  }
}

function assertMissingValueGuard({ label, script }) {
  const dir = path.join(tempRoot, `${label}-missing-value`)
  writeSparseSegment(dir)
  const result = runNode([
    script,
    '--dir',
    dir,
    '--stream-id',
    'stream',
    '--segment-ms',
    '--once',
    '--dry-run',
  ])
  if (result.status === 0) {
    throw new Error(`${label} accepted a missing --segment-ms value\n${result.output}`)
  }
  if (!result.output.includes('--segment-ms requires a value')) {
    throw new Error(`${label} did not report the missing --segment-ms value clearly\n${result.output}`)
  }
}

function assertManifestPathGuard({ label, script }) {
  const dir = path.join(tempRoot, `${label}-manifest-path`)
  writeSparseSegment(dir)
  const outside = path.join(tempRoot, `${label}-outside.webm`)
  fs.writeFileSync(outside, 'outside payload')
  fs.writeFileSync(
    path.join(dir, 'stream.segments.json'),
    `${JSON.stringify({
      streamId: 'stream',
      filePrefix: 'stream',
      segments: [
        {
          sequence: 5,
          file: outside,
          bytes: fs.statSync(outside).size,
        },
      ],
    }, null, 2)}\n`,
  )

  const result = runNode([
    script,
    '--dir',
    dir,
    '--stream-id',
    'stream',
    '--start-seq',
    '5',
    '--once',
    '--require-manifest',
    '--dry-run',
  ])
  if (result.status === 0) {
    throw new Error(`${label} accepted a manifest segment outside the watched directory\n${result.output}`)
  }
  if (!result.output.includes('points outside the watched segment file')) {
    throw new Error(`${label} did not report unsafe manifest segment path clearly\n${result.output}`)
  }
}

function assertManifestShapeGuards({ label, script }) {
  const source = fs.readFileSync(path.join(root, script), 'utf8')
  for (const marker of [
    'function manifestNonNegativeInteger(value, label)',
    'function manifestSegmentSequence(entry, index, manifestPath)',
    'function manifestSegmentBytes(segment, sequence)',
    '.find((entry, index) => manifestSegmentSequence(entry, index, manifestPath) === sequence)',
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`${label} missing strict manifest segment guard marker: ${marker}`)
    }
  }
  for (const fallback of [
    'Number(entry.sequence) === sequence',
    'const bytes = Number(segment.bytes)',
    'has invalid bytes',
  ]) {
    if (source.includes(fallback)) {
      throw new Error(`${label} reintroduced permissive manifest segment fallback: ${fallback}`)
    }
  }

  const badSegmentsDir = path.join(tempRoot, `${label}-manifest-segments-shape`)
  writeSparseSegment(badSegmentsDir)
  fs.writeFileSync(
    path.join(badSegmentsDir, 'stream.segments.json'),
    `${JSON.stringify({ streamId: 'stream', filePrefix: 'stream', segments: {} }, null, 2)}\n`,
  )
  const badSegments = runNode([
    script,
    '--dir',
    badSegmentsDir,
    '--stream-id',
    'stream',
    '--start-seq',
    '5',
    '--once',
    '--require-manifest',
    '--dry-run',
  ])
  if (badSegments.status === 0) {
    throw new Error(`${label} accepted non-array manifest segments\n${badSegments.output}`)
  }
  if (!badSegments.output.includes('segments must be an array')) {
    throw new Error(`${label} did not report non-array manifest segments clearly\n${badSegments.output}`)
  }

  const optionalBadSegmentsDir = path.join(tempRoot, `${label}-optional-manifest-segments-shape`)
  writeSparseSegment(optionalBadSegmentsDir)
  fs.writeFileSync(
    path.join(optionalBadSegmentsDir, 'stream.segments.json'),
    `${JSON.stringify({ streamId: 'stream', filePrefix: 'stream', segments: {} }, null, 2)}\n`,
  )
  const optionalBadSegments = runNode([
    script,
    '--dir',
    optionalBadSegmentsDir,
    '--stream-id',
    'stream',
    '--start-seq',
    '5',
    '--once',
    '--dry-run',
  ])
  if (optionalBadSegments.status !== 0) {
    throw new Error(`${label} did not fall back from optional malformed manifest\n${optionalBadSegments.output}`)
  }
  const expectedAction = script.includes('pipelined') ? 'would submit seq 5' : 'would publish seq 5'
  if (!optionalBadSegments.output.includes('falling back to segment file') || !optionalBadSegments.output.includes(expectedAction)) {
    throw new Error(`${label} optional malformed manifest fallback was not visible\n${optionalBadSegments.output}`)
  }

  const badSequenceDir = path.join(tempRoot, `${label}-manifest-invalid-sequence`)
  writeSparseSegment(badSequenceDir)
  fs.writeFileSync(
    path.join(badSequenceDir, 'stream.segments.json'),
    `${JSON.stringify({
      streamId: 'stream',
      filePrefix: 'stream',
      segments: [
        {
          sequence: '5e0',
          file: 'stream-000005.webm',
          bytes: 13,
        },
      ],
    }, null, 2)}\n`,
  )
  const badSequence = runNode([
    script,
    '--dir',
    badSequenceDir,
    '--stream-id',
    'stream',
    '--start-seq',
    '5',
    '--once',
    '--require-manifest',
    '--dry-run',
  ])
  if (badSequence.status === 0) {
    throw new Error(`${label} accepted invalid manifest segment sequence\n${badSequence.output}`)
  }
  if (!badSequence.output.includes('segment 0 sequence must be a non-negative integer')) {
    throw new Error(`${label} did not report invalid manifest segment sequence clearly\n${badSequence.output}`)
  }

  const badBytesDir = path.join(tempRoot, `${label}-manifest-invalid-bytes`)
  writeSparseSegment(badBytesDir)
  fs.writeFileSync(
    path.join(badBytesDir, 'stream.segments.json'),
    `${JSON.stringify({
      streamId: 'stream',
      filePrefix: 'stream',
      segments: [
        {
          sequence: 5,
          file: 'stream-000005.webm',
          bytes: 'not-a-number',
        },
      ],
    }, null, 2)}\n`,
  )
  const badBytes = runNode([
    script,
    '--dir',
    badBytesDir,
    '--stream-id',
    'stream',
    '--start-seq',
    '5',
    '--once',
    '--require-manifest',
    '--dry-run',
  ])
  if (badBytes.status === 0) {
    throw new Error(`${label} accepted invalid manifest segment bytes\n${badBytes.output}`)
  }
  if (!badBytes.output.includes('Manifest segment 5 bytes must be a non-negative integer')) {
    throw new Error(`${label} did not report invalid manifest segment bytes clearly\n${badBytes.output}`)
  }
}

function assertRecoveredStateGuard({ label, script }) {
  const dir = path.join(tempRoot, `${label}-state-guard`)
  writeSparseSegment(dir)
  const wrongStreamState = path.join(tempRoot, `${label}-wrong-stream-state.json`)
  fs.writeFileSync(wrongStreamState, `${JSON.stringify({
    streamId: 'other-stream',
    nextSequence: 5,
    previousSegmentHash: `0x${'0'.repeat(64)}`,
    published: [],
  })}\n`)

  const wrongStream = runNode([
    script,
    '--dir',
    dir,
    '--stream-id',
    'stream',
    '--start-seq',
    '5',
    '--once',
    '--state',
    wrongStreamState,
  ], publisherEnv())
  if (wrongStream.status === 0) {
    throw new Error(`${label} accepted recovered state for a different stream\n${wrongStream.output}`)
  }
  if (!wrongStream.output.includes('does not match stream')) {
    throw new Error(`${label} did not reject mismatched recovered state clearly\n${wrongStream.output}`)
  }

  const malformedState = path.join(tempRoot, `${label}-malformed-state.json`)
  fs.writeFileSync(malformedState, '{ bad json')
  const malformed = runNode([
    script,
    '--dir',
    dir,
    '--stream-id',
    'stream',
    '--start-seq',
    '5',
    '--once',
    '--state',
    malformedState,
  ], publisherEnv())
  if (malformed.status === 0) {
    throw new Error(`${label} accepted malformed recovered state\n${malformed.output}`)
  }
  if (!malformed.output.includes('Unreadable publisher state')) {
    throw new Error(`${label} did not reject malformed recovered state clearly\n${malformed.output}`)
  }

  const source = fs.readFileSync(path.join(root, script), 'utf8')
  if (!source.includes('readPublisherStateWithRecovery(statePath, state') || !source.includes("hasFlag('recover-state')")) {
    throw new Error(`${label} should expose explicit recovered-state quarantine handling`)
  }
}

function assertSerialRecoveredStateQuarantine() {
  const dir = path.join(tempRoot, 'serial-recovered-state-quarantine')
  writeSparseSegment(dir)
  const statePath = path.join(tempRoot, 'serial-invalid-recover-state.json')
  fs.writeFileSync(statePath, '{ bad json')
  const result = runNode([
    'scripts/publish-live-segments.mjs',
    '--dir',
    dir,
    '--stream-id',
    'stream',
    '--start-seq',
    '6',
    '--once',
    '--state',
    statePath,
    '--recover-state',
  ], publisherEnv())
  if (result.status !== 0) {
    throw new Error(`serial recovered-state quarantine failed\n${result.output}`)
  }
  if (!result.output.includes('Recovered from invalid publisher state') || !result.output.includes('Recovery status written')) {
    throw new Error(`serial recovered-state quarantine was not visible\n${result.output}`)
  }
  if (!fs.existsSync(statePath)) {
    throw new Error('serial recovered-state quarantine did not write a fresh state file')
  }
  const recoveredState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  if (recoveredState.streamId !== 'stream' || recoveredState.nextSequence !== 6) {
    throw new Error(`serial recovered-state quarantine wrote unexpected state\n${JSON.stringify(recoveredState)}`)
  }
  const statusPath = `${statePath}.recovery.json`
  if (!fs.existsSync(statusPath)) throw new Error('serial recovered-state quarantine did not write recovery status')
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'))
  if (!status.quarantinePath || !fs.existsSync(status.quarantinePath)) {
    throw new Error(`serial recovered-state quarantine did not preserve invalid state\n${JSON.stringify(status)}`)
  }
}

function assertPipelinedRecoveredQueueGuard() {
  const dir = path.join(tempRoot, 'pipelined-recovered-queue-guard')
  writeSparseSegment(dir)
  const stateHelperSource = fs.readFileSync(path.join(root, 'scripts', 'lib', 'publisher-state.mjs'), 'utf8')
  const pipelinedSource = fs.readFileSync(path.join(root, 'scripts', 'publish-live-segments-pipelined.mjs'), 'utf8')
  if (!stateHelperSource.includes('function normalizeMetrics(defaults, metrics = {})')) {
    throw new Error('publisher state helper should normalize recovered metrics once at the boundary')
  }
  for (const marker of [
    'export function publisherStateInteger(value, label)',
    'const published = state.published === undefined ? [] : state.published',
    'const submittedItems = state.submitted === undefined ? [] : state.submitted',
    'published,',
    'submitted: submittedItems',
  ]) {
    if (!stateHelperSource.includes(marker)) {
      throw new Error(`publisher state helper missing recovered history normalization marker: ${marker}`)
    }
  }
  for (const fallback of [
    'validatePublishedItems(state.published || [], statePath)',
    'validateSubmittedItems(state.submitted || [], statePath)',
    'published: state.published || []',
    'submitted: state.submitted || []',
  ]) {
    if (stateHelperSource.includes(fallback)) {
      throw new Error(`publisher state helper reintroduced recovered history fallback: ${fallback}`)
    }
  }
  if (pipelinedSource.includes('const pending = state.submitted || []')) {
    throw new Error('pipelined publisher reintroduced submitted queue fallback after state normalization')
  }
  for (const marker of [
    'function normalizeBlobVersionedHashes(value, label, { optional = false } = {})',
    'function stationEventSequenceMatches(eventSequence, expectedSequence)',
    'stationEventSequenceMatches(log.args.sequence, item.sequence)',
    'function manifestBlobVersionedHashes(transaction, stationEvent)',
    "normalizeBlobVersionedHashes(stationEvent.args.blobVersionedHashes, 'Station event blobVersionedHashes')",
    'blobVersionedHashes: manifestBlobVersionedHashes(transaction, stationEvent)',
  ]) {
    if (!pipelinedSource.includes(marker)) {
      throw new Error(`pipelined publisher missing manifest blob hash validation marker: ${marker}`)
    }
  }
  for (const fallback of [
    "BigInt(state.metrics.actualSpendWei || '0')",
    "BigInt(state.metrics.actualExecutionSpendWei || '0')",
    "BigInt(state.metrics.actualBlobSpendWei || '0')",
  ]) {
    if (pipelinedSource.includes(fallback)) {
      throw new Error(`pipelined publisher reintroduced downstream metric fallback: ${fallback}`)
    }
  }
  if (pipelinedSource.includes('transaction?.blobVersionedHashes || stationEvent.args.blobVersionedHashes || []')) {
    throw new Error('pipelined publisher reintroduced unvalidated manifest blob hash fallback')
  }
  if (pipelinedSource.includes('Number(log.args.sequence) === Number(item.sequence)')) {
    throw new Error('pipelined publisher reintroduced Number-based Station event sequence matching')
  }
  for (const forbidden of [
    'Math.max(max, Number(item.nonce ?? -1))',
    'Number(published.sequence) === Number(item.sequence)',
    'Number(a.sequence) - Number(b.sequence)',
    'Number(state.metrics.confirmedCount) + 1',
    'Number(state.metrics.submittedCount) + 1',
  ]) {
    if (pipelinedSource.includes(forbidden)) {
      throw new Error(`pipelined publisher reintroduced recovered state numeric coercion: ${forbidden}`)
    }
  }
  for (const marker of [
    "publisherStateInteger(item.nonce, 'submitted nonce')",
    "publisherStateInteger(item.sequence, 'submitted sequence')",
    "publisherStateInteger(published.sequence, 'published sequence') === itemSequence",
    "publisherStateInteger(state.metrics.confirmedCount, 'metrics.confirmedCount') + 1",
    "publisherStateInteger(state.metrics.submittedCount, 'metrics.submittedCount') + 1",
  ]) {
    if (!pipelinedSource.includes(marker)) {
      throw new Error(`pipelined publisher missing recovered state numeric guard: ${marker}`)
    }
  }

  const invalidSubmittedState = path.join(tempRoot, 'pipelined-invalid-submitted-state.json')
  fs.writeFileSync(invalidSubmittedState, `${JSON.stringify({
    streamId: 'stream',
    nextSequence: 5,
    previousSegmentHash: `0x${'0'.repeat(64)}`,
    submitted: [{
      sequence: 4,
      nonce: 'not-a-nonce',
      txHash: `0x${'1'.repeat(64)}`,
    }],
    published: [],
  })}\n`)
  const invalidSubmitted = runNode([
    'scripts/publish-live-segments-pipelined.mjs',
    '--dir',
    dir,
    '--stream-id',
    'stream',
    '--start-seq',
    '5',
    '--once',
    '--state',
    invalidSubmittedState,
  ], publisherEnv())
  if (invalidSubmitted.status === 0) {
    throw new Error(`pipelined accepted invalid submitted queue state\n${invalidSubmitted.output}`)
  }
  if (!invalidSubmitted.output.includes('submitted[0].nonce must be a non-negative integer')) {
    throw new Error(`pipelined did not reject invalid submitted nonce clearly\n${invalidSubmitted.output}`)
  }

  const invalidMetricsState = path.join(tempRoot, 'pipelined-invalid-metrics-state.json')
  fs.writeFileSync(invalidMetricsState, `${JSON.stringify({
    streamId: 'stream',
    nextSequence: 5,
    previousSegmentHash: `0x${'0'.repeat(64)}`,
    submitted: [],
    published: [],
    metrics: {
      actualSpendWei: 'abc',
    },
  })}\n`)
  const invalidMetrics = runNode([
    'scripts/publish-live-segments-pipelined.mjs',
    '--dir',
    dir,
    '--stream-id',
    'stream',
    '--start-seq',
    '5',
    '--once',
    '--state',
    invalidMetricsState,
  ], publisherEnv())
  if (invalidMetrics.status === 0) {
    throw new Error(`pipelined accepted invalid recovered metrics\n${invalidMetrics.output}`)
  }
  if (!invalidMetrics.output.includes('metrics.actualSpendWei must be a non-negative integer string')) {
    throw new Error(`pipelined did not reject invalid recovered metrics clearly\n${invalidMetrics.output}`)
  }
}

function assertBlobPublisherCliGuards() {
  const source = fs.readFileSync(path.join(root, 'scripts', 'publish-blob-chunk.mjs'), 'utf8')
  for (const marker of [
    'function normalizeBlobVersionedHashes(value, label, { optional = false } = {})',
    'function stationEventSequenceMatches(eventSequence, expectedSequence)',
    'stationEventSequenceMatches(log.args.sequence, sequence)',
    'function manifestBlobVersionedHashes(transaction, stationEvent)',
    "normalizeBlobVersionedHashes(transaction.blobVersionedHashes, 'transaction blobVersionedHashes')",
    "normalizeBlobVersionedHashes(stationEvent.args.blobVersionedHashes, 'Station event blobVersionedHashes')",
    'blobVersionedHashes: manifestBlobVersionedHashes(transaction, stationEvent)',
  ]) {
    if (!source.includes(marker)) {
      throw new Error(`blob publisher missing manifest blob hash validation marker: ${marker}`)
    }
  }
  if (source.includes('blobVersionedHashes: transaction.blobVersionedHashes || []')) {
    throw new Error('blob publisher reintroduced unvalidated transaction blob hash fallback')
  }
  if (source.includes('Number(log.args.sequence) === sequence')) {
    throw new Error('blob publisher reintroduced Number-based Station event sequence matching')
  }

  const missing = runNode(['scripts/publish-blob-chunk.mjs', '--input', '--seq', '0'])
  if (missing.status === 0) throw new Error(`blob publisher accepted missing --input value\n${missing.output}`)
  if (!missing.output.includes('--input requires a value')) {
    throw new Error(`blob publisher did not report missing --input clearly\n${missing.output}`)
  }

  const input = path.join(tempRoot, 'blob-input.webm')
  fs.writeFileSync(input, 'blob payload')
  const invalidSeq = runNode(['scripts/publish-blob-chunk.mjs', '--input', input, '--seq', '-1'])
  if (invalidSeq.status === 0) throw new Error(`blob publisher accepted invalid --seq\n${invalidSeq.output}`)
  if (!invalidSeq.output.includes('Invalid --seq: -1')) {
    throw new Error(`blob publisher did not report invalid --seq clearly\n${invalidSeq.output}`)
  }

  const invalidHash = runNode([
    'scripts/publish-blob-chunk.mjs',
    '--input',
    input,
    '--previous-hash',
    '0x1234',
  ])
  if (invalidHash.status === 0) throw new Error(`blob publisher accepted invalid --previous-hash\n${invalidHash.output}`)
  if (!invalidHash.output.includes('Invalid --previous-hash')) {
    throw new Error(`blob publisher did not report invalid --previous-hash clearly\n${invalidHash.output}`)
  }
}

function withEnv(name, value, fn) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

function assertTxEnvGuards() {
  withEnv('MAX_FEE_PER_GAS_GWEI', 'abc', () => {
    try {
      optionalGweiEnv('MAX_FEE_PER_GAS_GWEI')
      throw new Error('accepted invalid MAX_FEE_PER_GAS_GWEI')
    } catch (error) {
      if (!String(error.message).includes('Invalid MAX_FEE_PER_GAS_GWEI')) throw error
    }
  })
  withEnv('MAX_FEE_PER_BLOB_GAS_GWEI', '1.25', () => {
    if (optionalGweiEnv('MAX_FEE_PER_BLOB_GAS_GWEI') !== 1250000000n) {
      throw new Error('did not parse decimal blob gas fee')
    }
  })
  withEnv('GAS_LIMIT', '180000.5', () => {
    try {
      gasLimitEnv()
      throw new Error('accepted fractional GAS_LIMIT')
    } catch (error) {
      if (!String(error.message).includes('Invalid GAS_LIMIT')) throw error
    }
  })
  withEnv('GAS_LIMIT', '0', () => {
    if (gasLimitEnv('GAS_LIMIT', 180000n) !== 180000n) {
      throw new Error('zero GAS_LIMIT should fall back to the provided default')
    }
  })
}

function assertCostPreflightOptionGuards() {
  const source = fs.readFileSync(path.join(root, 'scripts', 'lib', 'cost-preflight.mjs'), 'utf8')
  if (!source.includes('function optionalNonNegativeInteger(value, label)')
    || source.includes('Number(segment.blobCount || segment.estimatedBlobs || 0)')
    || source.includes('Number(segment.payloadBytes || segment.bytes || 0)')) {
    throw new Error('cost preflight should validate segment stats without permissive numeric fallbacks')
  }

  withEnv('GAS_LIMIT', 'not-a-number', () => {
    try {
      readCostOptions(['node', 'script', '--max-cost-eth', '0.1'])
      throw new Error('accepted invalid GAS_LIMIT in cost preflight')
    } catch (error) {
      if (!String(error.message).includes('Invalid --cost-gas-per-segment: not-a-number')) throw error
    }
  })
  withEnv('MAX_FEE_PER_GAS_GWEI', 'fast', () => {
    try {
      readCostOptions(['node', 'script', '--max-cost-eth', '0.1'])
      throw new Error('accepted invalid MAX_FEE_PER_GAS_GWEI in cost preflight')
    } catch (error) {
      if (!String(error.message).includes('Invalid --cost-max-fee-per-gas-gwei: fast')) throw error
    }
  })
  try {
    readCostOptions(['node', 'script', '--max-cost-eth', '0.1', '--expected-segments=0'])
    throw new Error('accepted invalid --expected-segments in cost preflight')
  } catch (error) {
    if (!String(error.message).includes('Invalid --expected-segments: 0')) throw error
  }
  try {
    readCostOptions(['node', 'script', '--max-cost-eth', '0.1', '--cost-safety-multiplier', 'abc'])
    throw new Error('accepted invalid --cost-safety-multiplier')
  } catch (error) {
    if (!String(error.message).includes('Invalid safety multiplier: abc')) throw error
  }

  try {
    segmentStats([{ blobCount: '1e2', payloadBytes: 10 }])
    throw new Error('accepted coerced cost segment blobCount')
  } catch (error) {
    if (!String(error.message).includes('Invalid cost segment [0].blobCount')) throw error
  }

  try {
    segmentStats([{ blobCount: 1, payloadBytes: '1e2' }])
    throw new Error('accepted coerced cost segment payloadBytes')
  } catch (error) {
    if (!String(error.message).includes('Invalid cost segment [0].payloadBytes')) throw error
  }
}

try {
  assertDryRun({
    label: 'serial',
    script: 'scripts/publish-live-segments.mjs',
    expected: 'would publish seq 5',
  })
  assertDryRun({
    label: 'pipelined',
    script: 'scripts/publish-live-segments-pipelined.mjs',
    expected: 'would submit seq 5',
  })
  assertMissingValueGuard({
    label: 'serial',
    script: 'scripts/publish-live-segments.mjs',
  })
  assertMissingValueGuard({
    label: 'pipelined',
    script: 'scripts/publish-live-segments-pipelined.mjs',
  })
  assertManifestPathGuard({
    label: 'serial',
    script: 'scripts/publish-live-segments.mjs',
  })
  assertManifestPathGuard({
    label: 'pipelined',
    script: 'scripts/publish-live-segments-pipelined.mjs',
  })
  assertManifestShapeGuards({
    label: 'serial',
    script: 'scripts/publish-live-segments.mjs',
  })
  assertManifestShapeGuards({
    label: 'pipelined',
    script: 'scripts/publish-live-segments-pipelined.mjs',
  })
  assertRecoveredStateGuard({
    label: 'serial',
    script: 'scripts/publish-live-segments.mjs',
  })
  assertRecoveredStateGuard({
    label: 'pipelined',
    script: 'scripts/publish-live-segments-pipelined.mjs',
  })
  assertSerialRecoveredStateQuarantine()
  assertPipelinedRecoveredQueueGuard()
  assertBlobPublisherCliGuards()
  assertTxEnvGuards()
  assertCostPreflightOptionGuards()
  console.log('publisher dry-run tests ok')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
