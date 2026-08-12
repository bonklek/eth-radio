import {
  MAX_FEE_QUANTILES,
  MAX_FEE_HISTORY_SAMPLES,
  estimateFeeScenarios,
} from './fee-history.mjs'
import {
  PROTOCOL_NAME,
  UINT32_MAX,
  UINT64_MAX,
  UINT256_MAX,
} from '../protocol/constants.mjs'
import {
  boundedList,
  bytes32,
  decimalString,
  record,
} from '../protocol/scalars.mjs'

export const FEE_SNAPSHOT_SCHEMA = 'fee-estimate-snapshot'
export const FEE_SNAPSHOT_VERSION = 1
export const FEE_SNAPSHOT_AUTHORITY = 'CLIENT_PLANNING_ONLY'

export const CONTENT_MODES = Object.freeze([
  'LIVE',
  'PREPUBLISHED',
  'SCHEDULED_REPLAY',
  'STANDING_FALLBACK',
  'EXACT_REFRESH',
  'PROCEDURAL_SLATE',
])

export const CONFIDENCE_CLASSES = Object.freeze([
  'CURRENT_ONLY',
  'LIMITED_HISTORY',
  'BOUNDED_HISTORY',
])

function uintString(value, label, maximum = UINT256_MAX) {
  return decimalString(value, label, { maximum })
}

function positiveVersion(value, label) {
  const normalized = uintString(value, label, UINT32_MAX)
  if (normalized === '0') throw new RangeError(`${label} must be greater than zero`)
  return normalized
}

function validateModeSemantics(mode, expectedBlobs, maximumBlobs, executionGasUnits) {
  const expected = BigInt(expectedBlobs)
  const maximum = BigInt(maximumBlobs)
  const gas = BigInt(executionGasUnits)
  if (expected > maximum) throw new RangeError('expectedBlobCount must not exceed maximumBlobCount')
  if (['LIVE', 'PREPUBLISHED', 'EXACT_REFRESH'].includes(mode)) {
    if (expected === 0n || maximum === 0n) throw new RangeError(`${mode} requires positive blob counts`)
    if (gas === 0n) throw new RangeError(`${mode} requires positive execution gas units`)
  } else if (expected !== 0n || maximum !== 0n) {
    throw new RangeError(`${mode} must not include playback-time blob cost`)
  }
  if (['STANDING_FALLBACK', 'PROCEDURAL_SLATE'].includes(mode) && gas !== 0n) {
    throw new RangeError(`${mode} must not include a playback-time transaction`)
  }
  if (mode === 'SCHEDULED_REPLAY' && gas === 0n) {
    throw new RangeError('SCHEDULED_REPLAY requires positive execution gas units')
  }
}

function confidenceForCount(sampleCount) {
  const count = BigInt(sampleCount)
  return count === 0n ? 'CURRENT_ONLY' : count < 16n ? 'LIMITED_HISTORY' : 'BOUNDED_HISTORY'
}

export function normalizeFeeEstimateSnapshotV1(input) {
  const value = record(input, 'fee snapshot')
  if (value.protocol !== PROTOCOL_NAME) throw new TypeError(`protocol must be ${PROTOCOL_NAME}`)
  if (value.schema !== FEE_SNAPSHOT_SCHEMA) throw new TypeError(`schema must be ${FEE_SNAPSHOT_SCHEMA}`)
  if (value.version !== FEE_SNAPSHOT_VERSION) throw new TypeError(`version must be ${FEE_SNAPSHOT_VERSION}`)
  if (value.authority !== FEE_SNAPSHOT_AUTHORITY) {
    throw new TypeError(`authority must be ${FEE_SNAPSHOT_AUTHORITY}`)
  }
  if (!CONTENT_MODES.includes(value.contentMode)) throw new TypeError('fee snapshot contentMode is not supported')
  if (!CONFIDENCE_CLASSES.includes(value.confidenceClass)) {
    throw new TypeError('fee snapshot confidenceClass is not supported')
  }
  const observationBlock = uintString(value.observationBlock, 'fee snapshot.observationBlock', UINT64_MAX)
  const horizonStartBlock = uintString(value.horizonStartBlock, 'fee snapshot.horizonStartBlock', UINT64_MAX)
  const horizonEndBlock = uintString(value.horizonEndBlock, 'fee snapshot.horizonEndBlock', UINT64_MAX)
  const expiresAtBlock = uintString(value.expiresAtBlock, 'fee snapshot.expiresAtBlock', UINT64_MAX)
  if (BigInt(horizonStartBlock) >= BigInt(horizonEndBlock)) {
    throw new RangeError('fee snapshot horizon must be a non-empty half-open block range')
  }
  if (BigInt(expiresAtBlock) < BigInt(observationBlock)) {
    throw new RangeError('fee snapshot expiration must not precede its observation block')
  }
  const expectedBlobCount = uintString(value.expectedBlobCount, 'fee snapshot.expectedBlobCount', UINT32_MAX)
  const maximumBlobCount = uintString(value.maximumBlobCount, 'fee snapshot.maximumBlobCount', UINT32_MAX)
  const executionGasUnits = uintString(value.executionGasUnits, 'fee snapshot.executionGasUnits', UINT64_MAX)
  validateModeSemantics(value.contentMode, expectedBlobCount, maximumBlobCount, executionGasUnits)
  const quantiles = boundedList(value.recentBlobFeeQuantiles, 'fee snapshot.recentBlobFeeQuantiles', {
    maximum: MAX_FEE_QUANTILES,
  }).map((entry, index) => uintString(entry, `fee snapshot.recentBlobFeeQuantiles[${index}]`))
  for (let index = 1; index < quantiles.length; index += 1) {
    if (BigInt(quantiles[index]) < BigInt(quantiles[index - 1])) {
      throw new TypeError('fee snapshot recentBlobFeeQuantiles must be nondecreasing')
    }
  }
  const historySampleCount = uintString(
    value.historySampleCount,
    'fee snapshot.historySampleCount',
    BigInt(MAX_FEE_HISTORY_SAMPLES),
  )
  if (value.confidenceClass !== confidenceForCount(historySampleCount)) {
    throw new TypeError('fee snapshot confidenceClass is inconsistent with historySampleCount')
  }
  if ((historySampleCount === '0') !== (quantiles.length === 0)) {
    throw new TypeError('fee snapshot quantiles are inconsistent with historySampleCount')
  }
  const currentBlobBaseFeeWei = uintString(
    value.currentBlobBaseFeeWei,
    'fee snapshot.currentBlobBaseFeeWei',
  )
  const currentExecutionBaseFeeWei = uintString(
    value.currentExecutionBaseFeeWei,
    'fee snapshot.currentExecutionBaseFeeWei',
  )
  const smoothedBlobFeeWei = uintString(value.smoothedBlobFeeWei, 'fee snapshot.smoothedBlobFeeWei')
  const trendFactorBps = uintString(value.trendFactorBps, 'fee snapshot.trendFactorBps', UINT32_MAX)
  if (trendFactorBps === '0') throw new RangeError('fee snapshot.trendFactorBps must be greater than zero')
  const safetyMultiplierBps = uintString(
    value.safetyMultiplierBps,
    'fee snapshot.safetyMultiplierBps',
    UINT32_MAX,
  )
  const stressMultiplierBps = uintString(
    value.stressMultiplierBps,
    'fee snapshot.stressMultiplierBps',
    UINT32_MAX,
  )
  if (BigInt(safetyMultiplierBps) < 10_000n || BigInt(stressMultiplierBps) < 10_000n) {
    throw new RangeError('fee snapshot safety and stress multipliers must be at least 10000')
  }
  const baseEstimateWei = uintString(value.baseEstimateWei, 'fee snapshot.baseEstimateWei')
  const guardedEstimateWei = uintString(value.guardedEstimateWei, 'fee snapshot.guardedEstimateWei')
  const stressEstimateWei = uintString(value.stressEstimateWei, 'fee snapshot.stressEstimateWei')
  if (BigInt(baseEstimateWei) > BigInt(guardedEstimateWei)
    || BigInt(guardedEstimateWei) > BigInt(stressEstimateWei)) {
    throw new RangeError('fee snapshot estimates must be monotonic')
  }
  const recomputed = estimateFeeScenarios({
    expectedBlobCount,
    maximumBlobCount,
    executionGasUnits,
    currentBlobBaseFeeWei,
    currentExecutionBaseFeeWei,
    recentBlobFeeQuantiles: quantiles,
    smoothedBlobFeeWei,
    trendFactorBps,
    safetyMultiplierBps,
    stressMultiplierBps,
  })
  if (baseEstimateWei !== recomputed.baseEstimateWei
    || guardedEstimateWei !== recomputed.guardedEstimateWei
    || stressEstimateWei !== recomputed.stressEstimateWei) {
    throw new RangeError('fee snapshot estimates do not match the declared reference inputs')
  }
  const economics = record(value.economics, 'fee snapshot.economics')
  const publisherLiquidityRequirementWei = uintString(
    economics.publisherLiquidityRequirementWei,
    'fee snapshot.economics.publisherLiquidityRequirementWei',
  )
  const maximumReimbursementWei = uintString(
    economics.maximumReimbursementWei,
    'fee snapshot.economics.maximumReimbursementWei',
  )
  const stationSubsidyWei = uintString(economics.stationSubsidyWei, 'fee snapshot.economics.stationSubsidyWei')
  if (BigInt(publisherLiquidityRequirementWei) < BigInt(stressEstimateWei)) {
    throw new RangeError('publisher liquidity must cover the stress estimate before reimbursement')
  }
  if (BigInt(stationSubsidyWei) > BigInt(maximumReimbursementWei)) {
    throw new RangeError('station subsidy must not exceed maximum reimbursement')
  }
  const chainId = uintString(value.chainId, 'fee snapshot.chainId')
  if (chainId === '0') throw new RangeError('fee snapshot.chainId must be greater than zero')
  const observationBlockHash = bytes32(value.observationBlockHash, 'fee snapshot.observationBlockHash')
  if (observationBlockHash === `0x${'00'.repeat(32)}`) {
    throw new TypeError('fee snapshot.observationBlockHash must not be zero')
  }
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    schema: FEE_SNAPSHOT_SCHEMA,
    version: FEE_SNAPSHOT_VERSION,
    authority: FEE_SNAPSHOT_AUTHORITY,
    chainId,
    observationBlock,
    observationBlockHash,
    estimatorVersion: positiveVersion(value.estimatorVersion, 'fee snapshot.estimatorVersion'),
    availabilityProfileVersion: positiveVersion(value.availabilityProfileVersion, 'fee snapshot.availabilityProfileVersion'),
    horizonStartBlock,
    horizonEndBlock,
    contentMode: value.contentMode,
    expectedBlobCount,
    maximumBlobCount,
    executionGasUnits,
    currentBlobBaseFeeWei,
    currentExecutionBaseFeeWei,
    recentBlobFeeQuantiles: Object.freeze(quantiles),
    historySampleCount,
    smoothedBlobFeeWei,
    trendFactorBps,
    safetyMultiplierBps,
    stressMultiplierBps,
    baseEstimateWei,
    guardedEstimateWei,
    stressEstimateWei,
    confidenceClass: value.confidenceClass,
    expiresAtBlock,
    economics: Object.freeze({
      airtimeValueWei: uintString(economics.airtimeValueWei, 'fee snapshot.economics.airtimeValueWei'),
      transmissionContributionWei: uintString(economics.transmissionContributionWei, 'fee snapshot.economics.transmissionContributionWei'),
      publisherLiquidityRequirementWei,
      performanceBondWei: uintString(economics.performanceBondWei, 'fee snapshot.economics.performanceBondWei'),
      stationSubsidyWei,
      maximumReimbursementWei,
    }),
  })
}

export function createFeeEstimateSnapshotV1(input) {
  const value = record(input, 'fee snapshot input')
  const history = record(value.historySummary, 'fee snapshot input.historySummary')
  if (history.chainId !== value.chainId) {
    throw new TypeError('fee history and snapshot chain IDs do not match')
  }
  if (history.sampleCount !== '0') {
    if (history.lastBlock !== value.observationBlock
      || history.lastBlockHash !== value.observationBlockHash
      || history.latestBlobBaseFeeWei !== value.currentBlobBaseFeeWei
      || history.latestExecutionBaseFeeWei !== value.currentExecutionBaseFeeWei) {
      throw new TypeError('fee history latest sample does not match the snapshot observation')
    }
  }
  const estimates = estimateFeeScenarios({
    expectedBlobCount: value.expectedBlobCount,
    maximumBlobCount: value.maximumBlobCount,
    executionGasUnits: value.executionGasUnits,
    currentBlobBaseFeeWei: value.currentBlobBaseFeeWei,
    currentExecutionBaseFeeWei: value.currentExecutionBaseFeeWei,
    recentBlobFeeQuantiles: history.recentBlobFeeQuantiles.filter((entry) => entry !== null),
    smoothedBlobFeeWei: history.smoothedBlobFeeWei,
    trendFactorBps: history.trendFactorBps,
    safetyMultiplierBps: value.safetyMultiplierBps,
    stressMultiplierBps: value.stressMultiplierBps,
  })
  return normalizeFeeEstimateSnapshotV1({
    ...value,
    protocol: PROTOCOL_NAME,
    schema: FEE_SNAPSHOT_SCHEMA,
    version: FEE_SNAPSHOT_VERSION,
    authority: FEE_SNAPSHOT_AUTHORITY,
    recentBlobFeeQuantiles: history.recentBlobFeeQuantiles.filter((entry) => entry !== null),
    historySampleCount: history.sampleCount,
    smoothedBlobFeeWei: history.smoothedBlobFeeWei,
    trendFactorBps: history.trendFactorBps,
    confidenceClass: history.confidenceClass,
    ...estimates,
  })
}

export function validateFeeEstimateSnapshotContext(snapshot, {
  chainId,
  headBlock,
  canonicalObservationBlockHash,
  canonicalBlobBaseFeeWei,
  canonicalExecutionBaseFeeWei,
  supportedEstimatorVersions,
  supportedAvailabilityProfileVersions,
}) {
  const normalized = normalizeFeeEstimateSnapshotV1(snapshot)
  const expectedChainId = uintString(chainId, 'context.chainId')
  const currentHead = uintString(headBlock, 'context.headBlock', UINT64_MAX)
  if (normalized.chainId !== expectedChainId) throw new Error('Fee snapshot belongs to the wrong chain')
  if (BigInt(currentHead) < BigInt(normalized.observationBlock)) {
    throw new Error('Current head is behind the fee snapshot observation block')
  }
  if (BigInt(currentHead) > BigInt(normalized.expiresAtBlock)) throw new Error('Fee snapshot is expired')
  if (bytes32(canonicalObservationBlockHash, 'context.canonicalObservationBlockHash') !== normalized.observationBlockHash) {
    throw new Error('Fee snapshot observation block was replaced by a reorg')
  }
  if (uintString(canonicalBlobBaseFeeWei, 'context.canonicalBlobBaseFeeWei') !== normalized.currentBlobBaseFeeWei
    || uintString(
      canonicalExecutionBaseFeeWei,
      'context.canonicalExecutionBaseFeeWei',
    ) !== normalized.currentExecutionBaseFeeWei) {
    throw new Error('Fee snapshot base fees do not match the canonical observation block')
  }
  const estimatorVersions = boundedList(supportedEstimatorVersions, 'context.supportedEstimatorVersions', { maximum: 16 })
    .map((version, index) => positiveVersion(version, `context.supportedEstimatorVersions[${index}]`))
  const availabilityVersions = boundedList(
    supportedAvailabilityProfileVersions,
    'context.supportedAvailabilityProfileVersions',
    { maximum: 16 },
  ).map((version, index) => positiveVersion(version, `context.supportedAvailabilityProfileVersions[${index}]`))
  if (!estimatorVersions.includes(normalized.estimatorVersion)) throw new Error('Fee estimator version is unsupported')
  if (!availabilityVersions.includes(normalized.availabilityProfileVersion)) {
    throw new Error('Availability profile version is unsupported')
  }
  return normalized
}
