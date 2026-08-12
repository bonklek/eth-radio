import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  assertCanonicalFeeHistory,
  CONTENT_MODES,
  createFeeEstimateSnapshotV1,
  estimateFeeScenarios,
  MAX_FEE_HISTORY_SAMPLES,
  normalizeFeeEstimateSnapshotV1,
  normalizeFeeHistory,
  summarizeFeeHistory,
  validateFeeEstimateSnapshotContext,
} from '../packages/economics/index.mjs'

function fixture(name) {
  return JSON.parse(fs.readFileSync(
    new URL(`../test/fixtures/economics/${name}`, import.meta.url),
    'utf8',
  ))
}

const historyFixture = fixture('fee-history-v1.json')
const snapshotFixture = fixture('fee-snapshot-v1.json')
const historyInput = {
  chainId: historyFixture.chainId,
  samples: historyFixture.samples,
}
const summary = summarizeFeeHistory(historyInput)
assert.deepEqual(summary, historyFixture.expectedSummary)

const canonicalHashes = Object.fromEntries(
  historyFixture.samples.map((sample) => [sample.blockNumber, sample.blockHash]),
)
assert.deepEqual(assertCanonicalFeeHistory(historyInput, canonicalHashes), normalizeFeeHistory(historyInput))
assert.throws(
  () => assertCanonicalFeeHistory(historyInput, { ...canonicalHashes, 102: `0x${'ff'.repeat(32)}` }),
  /replaced by a reorg/,
)
const missingCanonicalHash = { ...canonicalHashes }
delete missingCanonicalHash[101]
assert.throws(() => assertCanonicalFeeHistory(historyInput, missingCanonicalHash), /Canonical hash is missing/)

const snapshot = createFeeEstimateSnapshotV1({
  ...snapshotFixture,
  historySummary: summary,
})
assert.deepEqual({
  baseEstimateWei: snapshot.baseEstimateWei,
  guardedEstimateWei: snapshot.guardedEstimateWei,
  stressEstimateWei: snapshot.stressEstimateWei,
}, snapshotFixture.expectedEstimates)
assert.equal(snapshot.authority, 'CLIENT_PLANNING_ONLY')
assert.equal(snapshot.confidenceClass, 'LIMITED_HISTORY')
assert.deepEqual(snapshot.recentBlobFeeQuantiles, ['20', '30', '40', '40'])
assert.deepEqual(normalizeFeeEstimateSnapshotV1(snapshot), snapshot)

const context = {
  chainId: '11155111',
  headBlock: '109',
  canonicalObservationBlockHash: snapshot.observationBlockHash,
  canonicalBlobBaseFeeWei: '40',
  canonicalExecutionBaseFeeWei: '100',
  supportedEstimatorVersions: ['1'],
  supportedAvailabilityProfileVersions: ['1'],
}
assert.deepEqual(validateFeeEstimateSnapshotContext(snapshot, context), snapshot)
assert.deepEqual(validateFeeEstimateSnapshotContext(snapshot, { ...context, headBlock: '110' }), snapshot)
assert.throws(() => validateFeeEstimateSnapshotContext(snapshot, { ...context, headBlock: '111' }), /expired/)
assert.throws(() => validateFeeEstimateSnapshotContext(snapshot, { ...context, headBlock: '102' }), /behind/)
assert.throws(() => validateFeeEstimateSnapshotContext(snapshot, { ...context, chainId: '1' }), /wrong chain/)
assert.throws(
  () => validateFeeEstimateSnapshotContext(snapshot, {
    ...context,
    canonicalObservationBlockHash: `0x${'aa'.repeat(32)}`,
  }),
  /replaced by a reorg/,
)
assert.throws(
  () => validateFeeEstimateSnapshotContext(snapshot, { ...context, canonicalBlobBaseFeeWei: '41' }),
  /base fees do not match/,
)
assert.throws(
  () => validateFeeEstimateSnapshotContext(snapshot, { ...context, supportedEstimatorVersions: ['2'] }),
  /estimator version is unsupported/,
)
assert.throws(
  () => validateFeeEstimateSnapshotContext(snapshot, {
    ...context,
    supportedAvailabilityProfileVersions: ['2'],
  }),
  /Availability profile version is unsupported/,
)

const emptySummary = summarizeFeeHistory({ chainId: '11155111', samples: [] })
assert.equal(emptySummary.confidenceClass, 'CURRENT_ONLY')
assert.equal(emptySummary.sampleCount, '0')
assert.deepEqual(emptySummary.recentBlobFeeQuantiles, [null, null, null, null])
const oneSummary = summarizeFeeHistory({ chainId: '11155111', samples: historyFixture.samples.slice(0, 1) })
assert.equal(oneSummary.confidenceClass, 'LIMITED_HISTORY')
const sixteenSamples = Array.from({ length: 16 }, (_, index) => ({
  blockNumber: String(index + 1),
  blockHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
  blobBaseFeeWei: String(index + 1),
  executionBaseFeeWei: '1',
}))
assert.equal(
  summarizeFeeHistory({ chainId: '11155111', samples: sixteenSamples }).confidenceClass,
  'BOUNDED_HISTORY',
)
const maximumSamples = Array.from({ length: MAX_FEE_HISTORY_SAMPLES }, (_, index) => ({
  blockNumber: String(index + 1),
  blockHash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
  blobBaseFeeWei: String(index + 1),
  executionBaseFeeWei: '1',
}))
assert.equal(normalizeFeeHistory({ chainId: '1', samples: maximumSamples }).samples.length, 256)
assert.throws(
  () => normalizeFeeHistory({ chainId: '1', samples: [...maximumSamples, maximumSamples.at(-1)] }),
  /at most 256/,
)
assert.throws(
  () => normalizeFeeHistory({ chainId: '1', samples: [historyFixture.samples[1], historyFixture.samples[0]] }),
  /strictly increasing/,
)
assert.throws(() => summarizeFeeHistory(historyInput, { quantileBps: ['9000', '5000'] }), /strictly increasing/)
assert.throws(() => summarizeFeeHistory(historyInput, { smoothingBps: '0' }), /between 1 and 10000/)
assert.throws(() => normalizeFeeHistory({ chainId: '0', samples: [] }), /greater than zero/)
assert.throws(() => normalizeFeeHistory({
  chainId: '1',
  samples: [{ ...historyFixture.samples[0], blockHash: `0x${'00'.repeat(32)}` }],
}), /must not be zero/)
assert.throws(() => createFeeEstimateSnapshotV1({
  ...snapshotFixture,
  currentBlobBaseFeeWei: '41',
  historySummary: summary,
}), /latest sample does not match/)
assert.throws(() => createFeeEstimateSnapshotV1({
  ...snapshotFixture,
  chainId: '1',
  historySummary: summary,
}), /chain IDs do not match/)

function snapshotForMode(contentMode, overrides = {}) {
  const zeroTransaction = ['STANDING_FALLBACK', 'PROCEDURAL_SLATE'].includes(contentMode)
  const replay = contentMode === 'SCHEDULED_REPLAY'
  const blobPublishing = ['LIVE', 'PREPUBLISHED', 'EXACT_REFRESH'].includes(contentMode)
  const expectedBlobCount = blobPublishing ? '2' : '0'
  const maximumBlobCount = blobPublishing ? '3' : '0'
  const executionGasUnits = zeroTransaction ? '0' : replay ? '50000' : '100000'
  const estimated = estimateFeeScenarios({
    expectedBlobCount,
    maximumBlobCount,
    executionGasUnits,
    currentBlobBaseFeeWei: '40',
    currentExecutionBaseFeeWei: '100',
    recentBlobFeeQuantiles: summary.recentBlobFeeQuantiles,
    smoothedBlobFeeWei: summary.smoothedBlobFeeWei,
    trendFactorBps: summary.trendFactorBps,
    safetyMultiplierBps: '15000',
    stressMultiplierBps: '20000',
  })
  return createFeeEstimateSnapshotV1({
    ...snapshotFixture,
    contentMode,
    expectedBlobCount,
    maximumBlobCount,
    executionGasUnits,
    economics: {
      ...snapshotFixture.economics,
      publisherLiquidityRequirementWei: estimated.stressEstimateWei,
    },
    historySummary: summary,
    ...overrides,
  })
}

for (const mode of CONTENT_MODES) {
  const result = snapshotForMode(mode)
  assert.equal(result.contentMode, mode)
  if (['STANDING_FALLBACK', 'PROCEDURAL_SLATE'].includes(mode)) {
    assert.equal(result.baseEstimateWei, '0')
    assert.equal(result.guardedEstimateWei, '0')
    assert.equal(result.stressEstimateWei, '0')
  }
  if (mode === 'SCHEDULED_REPLAY') assert.equal(result.expectedBlobCount, '0')
}

assert.throws(
  () => createFeeEstimateSnapshotV1({
    ...snapshotFixture,
    contentMode: 'STANDING_FALLBACK',
    expectedBlobCount: '1',
    maximumBlobCount: '1',
    executionGasUnits: '1',
    historySummary: summary,
  }),
  /must not include playback-time blob cost/,
)
assert.throws(
  () => createFeeEstimateSnapshotV1({
    ...snapshotFixture,
    contentMode: 'LIVE',
    expectedBlobCount: '0',
    maximumBlobCount: '0',
    historySummary: summary,
  }),
  /requires positive blob counts/,
)
assert.throws(() => normalizeFeeEstimateSnapshotV1({
  ...snapshot,
  baseEstimateWei: (BigInt(snapshot.baseEstimateWei) + 1n).toString(),
}), /do not match the declared reference inputs/)
assert.throws(() => normalizeFeeEstimateSnapshotV1({ ...snapshot, authority: 'AUTHORITATIVE' }), /CLIENT_PLANNING_ONLY/)
assert.throws(() => normalizeFeeEstimateSnapshotV1({ ...snapshot, estimatorVersion: '0' }), /greater than zero/)
assert.throws(() => normalizeFeeEstimateSnapshotV1({ ...snapshot, observationBlockHash: `0x${'00'.repeat(32)}` }), /must not be zero/)
assert.throws(() => normalizeFeeEstimateSnapshotV1({ ...snapshot, expiresAtBlock: '102' }), /must not precede/)
assert.throws(
  () => normalizeFeeEstimateSnapshotV1({
    ...snapshot,
    historySampleCount: '0',
    confidenceClass: 'CURRENT_ONLY',
  }),
  /quantiles are inconsistent/,
)
assert.throws(() => normalizeFeeEstimateSnapshotV1({
  ...snapshot,
  economics: { ...snapshot.economics, publisherLiquidityRequirementWei: '1' },
}), /liquidity must cover the stress estimate/)
assert.throws(() => normalizeFeeEstimateSnapshotV1({
  ...snapshot,
  economics: { ...snapshot.economics, stationSubsidyWei: '60000001' },
}), /subsidy must not exceed maximum reimbursement/)

let randomState = 0x243f6a88
function random(maximum) {
  randomState = (Math.imul(randomState, 1_103_515_245) + 12_345) >>> 0
  return randomState % maximum
}

for (let index = 0; index < 10_000; index += 1) {
  const expectedBlobCount = random(32) + 1
  const maximumBlobCount = expectedBlobCount + random(32)
  const currentBlobBaseFeeWei = random(1_000_000) + 1
  const currentExecutionBaseFeeWei = random(1_000_000) + 1
  const lower = estimateFeeScenarios({
    expectedBlobCount: String(expectedBlobCount),
    maximumBlobCount: String(maximumBlobCount),
    executionGasUnits: String(random(1_000_000) + 1),
    currentBlobBaseFeeWei: String(currentBlobBaseFeeWei),
    currentExecutionBaseFeeWei: String(currentExecutionBaseFeeWei),
    recentBlobFeeQuantiles: [String(currentBlobBaseFeeWei)],
    smoothedBlobFeeWei: String(currentBlobBaseFeeWei),
    trendFactorBps: '10000',
    safetyMultiplierBps: '12500',
    stressMultiplierBps: '20000',
  })
  assert.ok(BigInt(lower.baseEstimateWei) <= BigInt(lower.guardedEstimateWei))
  assert.ok(BigInt(lower.guardedEstimateWei) <= BigInt(lower.stressEstimateWei))
  const higher = estimateFeeScenarios({
    expectedBlobCount: String(expectedBlobCount),
    maximumBlobCount: String(maximumBlobCount),
    executionGasUnits: '1',
    currentBlobBaseFeeWei: String(currentBlobBaseFeeWei + 1),
    currentExecutionBaseFeeWei: String(currentExecutionBaseFeeWei + 1),
    recentBlobFeeQuantiles: [String(currentBlobBaseFeeWei + 1)],
    smoothedBlobFeeWei: String(currentBlobBaseFeeWei + 1),
    trendFactorBps: '10000',
    safetyMultiplierBps: '12500',
    stressMultiplierBps: '20000',
  })
  const comparable = estimateFeeScenarios({
    expectedBlobCount: String(expectedBlobCount),
    maximumBlobCount: String(maximumBlobCount),
    executionGasUnits: '1',
    currentBlobBaseFeeWei: String(currentBlobBaseFeeWei),
    currentExecutionBaseFeeWei: String(currentExecutionBaseFeeWei),
    recentBlobFeeQuantiles: [String(currentBlobBaseFeeWei)],
    smoothedBlobFeeWei: String(currentBlobBaseFeeWei),
    trendFactorBps: '10000',
    safetyMultiplierBps: '12500',
    stressMultiplierBps: '20000',
  })
  assert.ok(BigInt(higher.baseEstimateWei) >= BigInt(comparable.baseEstimateWei))
  assert.ok(BigInt(higher.guardedEstimateWei) >= BigInt(comparable.guardedEstimateWei))
  assert.ok(BigInt(higher.stressEstimateWei) >= BigInt(comparable.stressEstimateWei))
}

console.log('fee history, snapshot, context, content-mode, and property tests ok')
