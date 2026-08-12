import {
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

export const MAX_FEE_HISTORY_SAMPLES = 256
export const MAX_FEE_QUANTILES = 8
export const GAS_PER_BLOB = 131_072n
const zeroBytes32 = `0x${'00'.repeat(32)}`

function uint(value, label, maximum = UINT256_MAX) {
  const source = typeof value === 'bigint' ? value.toString() : value
  return BigInt(decimalString(source, label, { maximum }))
}

function positiveBps(value, label) {
  const parsed = uint(value, label, UINT32_MAX)
  if (parsed === 0n || parsed > 10_000n) throw new RangeError(`${label} must be between 1 and 10000`)
  return parsed
}

export function normalizeFeeHistory(input) {
  const value = record(input, 'fee history')
  const chainId = decimalString(value.chainId, 'fee history.chainId', { maximum: UINT256_MAX })
  if (chainId === '0') throw new RangeError('fee history.chainId must be greater than zero')
  const samples = boundedList(value.samples, 'fee history.samples', {
    maximum: MAX_FEE_HISTORY_SAMPLES,
  }).map((entry, index) => {
    const sample = record(entry, `fee history.samples[${index}]`)
    const blockHash = bytes32(sample.blockHash, `fee history.samples[${index}].blockHash`)
    if (blockHash === zeroBytes32) {
      throw new TypeError(`fee history.samples[${index}].blockHash must not be zero`)
    }
    return Object.freeze({
      blockNumber: decimalString(sample.blockNumber, `fee history.samples[${index}].blockNumber`, { maximum: UINT64_MAX }),
      blockHash,
      blobBaseFeeWei: decimalString(sample.blobBaseFeeWei, `fee history.samples[${index}].blobBaseFeeWei`, { maximum: UINT256_MAX }),
      executionBaseFeeWei: decimalString(sample.executionBaseFeeWei, `fee history.samples[${index}].executionBaseFeeWei`, { maximum: UINT256_MAX }),
    })
  })
  for (let index = 1; index < samples.length; index += 1) {
    if (BigInt(samples[index].blockNumber) <= BigInt(samples[index - 1].blockNumber)) {
      throw new TypeError('fee history samples must have strictly increasing unique block numbers')
    }
  }
  return Object.freeze({
    chainId,
    samples: Object.freeze(samples),
  })
}

function nearestRank(sorted, quantileBps) {
  const rank = (BigInt(sorted.length) * quantileBps + 9_999n) / 10_000n
  return sorted[Number(rank === 0n ? 0n : rank - 1n)]
}

/**
 * @param {bigint[]} values
 * @param {bigint} smoothingBps
 * @returns {bigint | null}
 */
function ewma(values, smoothingBps) {
  if (values.length === 0) return null
  let smoothed = values[0]
  for (const value of values.slice(1)) {
    smoothed = (smoothed * (10_000n - smoothingBps) + value * smoothingBps) / 10_000n
  }
  return smoothed
}

export function summarizeFeeHistory(input, {
  quantileBps = ['5000', '7500', '9000', '9900'],
  smoothingBps = '2000',
} = {}) {
  const history = normalizeFeeHistory(input)
  const requestedQuantiles = boundedList(quantileBps, 'quantileBps', {
    maximum: MAX_FEE_QUANTILES,
  }).map((value, index) => positiveBps(value, `quantileBps[${index}]`))
  for (let index = 1; index < requestedQuantiles.length; index += 1) {
    if (requestedQuantiles[index] <= requestedQuantiles[index - 1]) {
      throw new TypeError('quantileBps must be strictly increasing')
    }
  }
  const smoothing = positiveBps(smoothingBps, 'smoothingBps')
  const blobFees = history.samples.map((sample) => BigInt(sample.blobBaseFeeWei))
  const sorted = [...blobFees].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const smoothed = ewma(blobFees, smoothing)
  const latest = blobFees.at(-1) ?? null
  const trendFactorBps = latest === null || smoothed === null || smoothed === 0n
    ? 10_000n
    : (latest * 10_000n + smoothed - 1n) / smoothed
  const boundedTrendFactorBps = trendFactorBps > UINT32_MAX ? UINT32_MAX : trendFactorBps
  const confidenceClass = history.samples.length === 0
    ? 'CURRENT_ONLY'
    : history.samples.length < 16
      ? 'LIMITED_HISTORY'
      : 'BOUNDED_HISTORY'
  return Object.freeze({
    chainId: history.chainId,
    sampleCount: String(history.samples.length),
    firstBlock: history.samples[0]?.blockNumber ?? null,
    lastBlock: history.samples.at(-1)?.blockNumber ?? null,
    lastBlockHash: history.samples.at(-1)?.blockHash ?? null,
    latestBlobBaseFeeWei: history.samples.at(-1)?.blobBaseFeeWei ?? null,
    latestExecutionBaseFeeWei: history.samples.at(-1)?.executionBaseFeeWei ?? null,
    quantileBps: Object.freeze(requestedQuantiles.map(String)),
    recentBlobFeeQuantiles: Object.freeze(
      requestedQuantiles.map((quantile) => sorted.length === 0 ? null : nearestRank(sorted, quantile).toString()),
    ),
    smoothedBlobFeeWei: (smoothed ?? 0n).toString(),
    trendFactorBps: boundedTrendFactorBps.toString(),
    smoothingBps: smoothing.toString(),
    confidenceClass,
  })
}

export function assertCanonicalFeeHistory(input, canonicalBlockHashes) {
  const history = normalizeFeeHistory(input)
  const hashes = record(canonicalBlockHashes, 'canonicalBlockHashes')
  for (const sample of history.samples) {
    if (!Object.hasOwn(hashes, sample.blockNumber)) {
      throw new Error(`Canonical hash is missing for fee sample block ${sample.blockNumber}`)
    }
    const canonical = bytes32(hashes[sample.blockNumber], `canonicalBlockHashes[${sample.blockNumber}]`)
    if (canonical !== sample.blockHash) {
      throw new Error(`Fee sample block ${sample.blockNumber} was replaced by a reorg`)
    }
  }
  return history
}

/**
 * @param {bigint} value
 * @param {bigint} multiplierBps
 */
function ceilBps(value, multiplierBps) {
  const result = (value * multiplierBps + 9_999n) / 10_000n
  if (result > UINT256_MAX) throw new RangeError('basis-point-scaled fee exceeds uint256')
  return result
}

function checkedAdd(left, right, label) {
  if (left > UINT256_MAX - right) throw new RangeError(`${label} exceeds uint256`)
  return left + right
}

function checkedMultiply(left, right, label) {
  if (left !== 0n && right > UINT256_MAX / left) throw new RangeError(`${label} exceeds uint256`)
  return left * right
}

function scenarioCost(blobCount, blobFeeWei, executionGasUnits, executionFeeWei, label) {
  const blobGas = checkedMultiply(blobCount, GAS_PER_BLOB, `${label} blob gas`)
  const blobCost = checkedMultiply(blobGas, blobFeeWei, `${label} blob cost`)
  const executionCost = checkedMultiply(executionGasUnits, executionFeeWei, `${label} execution cost`)
  return checkedAdd(blobCost, executionCost, `${label} total`)
}

export function estimateFeeScenarios({
  expectedBlobCount,
  maximumBlobCount,
  executionGasUnits,
  currentBlobBaseFeeWei,
  currentExecutionBaseFeeWei,
  recentBlobFeeQuantiles,
  smoothedBlobFeeWei,
  trendFactorBps,
  safetyMultiplierBps,
  stressMultiplierBps,
}) {
  const expectedBlobs = uint(expectedBlobCount, 'expectedBlobCount', UINT32_MAX)
  const maximumBlobs = uint(maximumBlobCount, 'maximumBlobCount', UINT32_MAX)
  if (expectedBlobs > maximumBlobs) throw new RangeError('expectedBlobCount must not exceed maximumBlobCount')
  const gasUnits = uint(executionGasUnits, 'executionGasUnits', UINT64_MAX)
  const currentBlobFee = uint(currentBlobBaseFeeWei, 'currentBlobBaseFeeWei')
  const currentExecutionFee = uint(currentExecutionBaseFeeWei, 'currentExecutionBaseFeeWei')
  const quantiles = boundedList(recentBlobFeeQuantiles, 'recentBlobFeeQuantiles', {
    maximum: MAX_FEE_QUANTILES,
  }).map((value, index) => uint(value, `recentBlobFeeQuantiles[${index}]`))
  for (let index = 1; index < quantiles.length; index += 1) {
    if (quantiles[index] < quantiles[index - 1]) {
      throw new TypeError('recentBlobFeeQuantiles must be nondecreasing')
    }
  }
  const smoothed = uint(smoothedBlobFeeWei, 'smoothedBlobFeeWei')
  const trend = uint(trendFactorBps, 'trendFactorBps', UINT32_MAX)
  const safety = uint(safetyMultiplierBps, 'safetyMultiplierBps', UINT32_MAX)
  const stress = uint(stressMultiplierBps, 'stressMultiplierBps', UINT32_MAX)
  if (safety < 10_000n) throw new RangeError('safetyMultiplierBps must be at least 10000')
  if (stress < 10_000n) throw new RangeError('stressMultiplierBps must be at least 10000')
  const historicalHigh = quantiles.at(-1) ?? 0n
  const guardedObservedBlobFee = [currentBlobFee, smoothed, historicalHigh]
    .reduce((maximum, value) => value > maximum ? value : maximum, 0n)
  const trendedBlobFee = ceilBps(guardedObservedBlobFee, trend > 10_000n ? trend : 10_000n)
  const guardedBlobFee = ceilBps(trendedBlobFee, safety)
  const guardedExecutionFee = ceilBps(currentExecutionFee, safety)
  const stressBlobFee = ceilBps(guardedBlobFee, stress)
  const stressExecutionFee = ceilBps(guardedExecutionFee, stress)
  const baseEstimate = scenarioCost(
    expectedBlobs,
    currentBlobFee,
    gasUnits,
    currentExecutionFee,
    'base estimate',
  )
  const guardedEstimate = scenarioCost(
    maximumBlobs,
    guardedBlobFee,
    gasUnits,
    guardedExecutionFee,
    'guarded estimate',
  )
  const stressEstimate = scenarioCost(
    maximumBlobs,
    stressBlobFee,
    gasUnits,
    stressExecutionFee,
    'stress estimate',
  )
  if (baseEstimate > guardedEstimate || guardedEstimate > stressEstimate) {
    throw new RangeError('fee scenarios must be monotonic')
  }
  return Object.freeze({
    baseEstimateWei: baseEstimate.toString(),
    guardedEstimateWei: guardedEstimate.toString(),
    stressEstimateWei: stressEstimate.toString(),
    guardedBlobFeeWei: guardedBlobFee.toString(),
    stressBlobFeeWei: stressBlobFee.toString(),
    guardedExecutionFeeWei: guardedExecutionFee.toString(),
    stressExecutionFeeWei: stressExecutionFee.toString(),
  })
}
