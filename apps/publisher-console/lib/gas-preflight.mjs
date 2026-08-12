export const GAS_ESTIMATE_FLOOR = 100_000n
export const GAS_LIMIT_CAP = 500_000n
export const GAS_MARGIN_PERCENT = 25n

function uint(value, label) {
  let parsed
  try { parsed = BigInt(value) } catch { throw new Error(`${label} must be an unsigned integer`) }
  if (parsed < 0n) throw new Error(`${label} must be an unsigned integer`)
  return parsed
}

export function gasLimitDecision({
  observations = [],
  floorGas = GAS_ESTIMATE_FLOOR,
  capGas = GAS_LIMIT_CAP,
  marginPercent = GAS_MARGIN_PERCENT,
}) {
  const floor = uint(floorGas, 'gas floor')
  const cap = uint(capGas, 'gas cap')
  const margin = uint(marginPercent, 'gas margin percent')
  if (floor > cap) throw new Error('gas floor exceeds gas cap')
  if (margin > 100n) throw new Error('gas margin percent exceeds 100')
  const normalized = observations.map((observation) => ({
    ...observation,
    estimateGas: uint(observation.estimateGas, 'gas estimate'),
  }))
  if (!normalized.length) return { allowed: false, reason: 'no endpoint supplied exact gas-estimate evidence' }
  if (normalized.some((observation) => observation.estimateGas === 0n)) {
    return { allowed: false, reason: 'endpoint supplied a zero gas estimate' }
  }
  const codeHashes = new Set(normalized.map((observation) => String(observation.stationCodeHash).toLowerCase()))
  if (codeHashes.size !== 1) return { allowed: false, reason: 'endpoints disagree on Station code hash' }
  const maximumEstimateGas = normalized.reduce((maximum, observation) => (
    observation.estimateGas > maximum ? observation.estimateGas : maximum
  ), 0n)
  const guardedEstimate = (maximumEstimateGas * (100n + margin) + 99n) / 100n
  const gasLimit = guardedEstimate > floor ? guardedEstimate : floor
  if (gasLimit > cap) {
    return {
      allowed: false,
      reason: `guarded gas estimate ${gasLimit} exceeds gas cap ${cap}`,
      maximumEstimateGas,
      gasLimit,
    }
  }
  return {
    allowed: true,
    reason: null,
    maximumEstimateGas,
    gasLimit,
    disagreement: normalized.some((observation) => observation.estimateGas !== maximumEstimateGas),
    observations: normalized,
  }
}
