import { UINT256_MAX } from '../protocol/constants.mjs'
import { decimalString, record } from '../protocol/scalars.mjs'

export const ROUNDING_DIRECTIONS = Object.freeze(['DOWN', 'UP', 'EXACT'])

function uint(value, label, maximum = UINT256_MAX) {
  const source = typeof value === 'bigint' ? value.toString() : value
  return BigInt(decimalString(source, label, { maximum }))
}

function result(value, label, maximum = UINT256_MAX) {
  if (value < 0n) throw new RangeError(`${label} must not be negative`)
  if (value > maximum) throw new RangeError(`${label} exceeds the supported maximum`)
  return value.toString()
}

function roundingDirection(value, label = 'rounding') {
  if (!ROUNDING_DIRECTIONS.includes(value)) {
    throw new TypeError(`${label} must be DOWN, UP, or EXACT`)
  }
  return value
}

function greatestCommonDivisor(left, right) {
  let a = left
  let b = right
  while (b !== 0n) {
    const remainder = a % b
    a = b
    b = remainder
  }
  return a
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol keys`)
    if (!allowed.includes(key)) throw new TypeError(`${label}.${key} is not supported`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`)
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} must be an own property`)
  }
}

export function normalizeRatio(input, label = 'ratio', {
  numeratorMaximum = UINT256_MAX,
  denominatorMaximum = UINT256_MAX,
} = {}) {
  const value = record(input, label)
  exactKeys(value, ['numerator', 'denominator'], label)
  const numeratorBound = uint(numeratorMaximum, `${label}.numeratorMaximum`)
  const denominatorBound = uint(denominatorMaximum, `${label}.denominatorMaximum`)
  const numerator = uint(value.numerator, `${label}.numerator`, numeratorBound)
  const denominator = uint(value.denominator, `${label}.denominator`, denominatorBound)
  if (denominator === 0n) throw new RangeError(`${label}.denominator must be greater than zero`)
  if (numerator === 0n) {
    return Object.freeze({ numerator: '0', denominator: '1' })
  }
  const divisor = greatestCommonDivisor(numerator, denominator)
  return Object.freeze({
    numerator: (numerator / divisor).toString(),
    denominator: (denominator / divisor).toString(),
  })
}

export function checkedAdd(left, right, {
  leftMaximum = UINT256_MAX,
  rightMaximum = UINT256_MAX,
  resultMaximum = UINT256_MAX,
  label = 'sum',
} = {}) {
  const leftBound = uint(leftMaximum, `${label}.leftMaximum`)
  const rightBound = uint(rightMaximum, `${label}.rightMaximum`)
  const resultBound = uint(resultMaximum, `${label}.resultMaximum`)
  return result(
    uint(left, `${label}.left`, leftBound) + uint(right, `${label}.right`, rightBound),
    label,
    resultBound,
  )
}

export function checkedSubtract(left, right, {
  leftMaximum = UINT256_MAX,
  rightMaximum = UINT256_MAX,
  resultMaximum = UINT256_MAX,
  label = 'difference',
} = {}) {
  const leftBound = uint(leftMaximum, `${label}.leftMaximum`)
  const rightBound = uint(rightMaximum, `${label}.rightMaximum`)
  const resultBound = uint(resultMaximum, `${label}.resultMaximum`)
  return result(
    uint(left, `${label}.left`, leftBound) - uint(right, `${label}.right`, rightBound),
    label,
    resultBound,
  )
}

export function checkedMultiply(left, right, {
  leftMaximum = UINT256_MAX,
  rightMaximum = UINT256_MAX,
  resultMaximum = UINT256_MAX,
  label = 'product',
} = {}) {
  const leftBound = uint(leftMaximum, `${label}.leftMaximum`)
  const rightBound = uint(rightMaximum, `${label}.rightMaximum`)
  const resultBound = uint(resultMaximum, `${label}.resultMaximum`)
  return result(
    uint(left, `${label}.left`, leftBound) * uint(right, `${label}.right`, rightBound),
    label,
    resultBound,
  )
}

/**
 * @param {bigint} dividend
 * @param {bigint} divisor
 * @param {{rounding: 'DOWN' | 'UP' | 'EXACT', maximum: bigint, label: string}} options
 */
function divideBigInts(dividend, divisor, { rounding, maximum, label }) {
  const direction = roundingDirection(rounding, `${label}.rounding`)
  const quotient = dividend / divisor
  const remainder = dividend % divisor
  if (direction === 'EXACT' && remainder !== 0n) {
    throw new RangeError(`${label} is not exactly divisible`)
  }
  const rounded = direction === 'UP' && remainder !== 0n ? quotient + 1n : quotient
  return Object.freeze({
    value: result(rounded, label, maximum),
    remainder: remainder.toString(),
    rounded: remainder !== 0n,
    rounding: direction,
  })
}

/**
 * @param {string | bigint} numerator
 * @param {string | bigint} denominator
 * @param {{rounding: 'DOWN' | 'UP' | 'EXACT', numeratorMaximum?: bigint, denominatorMaximum?: bigint, resultMaximum?: bigint, label?: string}} options
 */
export function divideWithRounding(numerator, denominator, {
  rounding,
  numeratorMaximum = UINT256_MAX,
  denominatorMaximum = UINT256_MAX,
  resultMaximum = UINT256_MAX,
  label = 'quotient',
}) {
  const numeratorBound = uint(numeratorMaximum, `${label}.numeratorMaximum`)
  const denominatorBound = uint(denominatorMaximum, `${label}.denominatorMaximum`)
  const resultBound = uint(resultMaximum, `${label}.resultMaximum`)
  const dividend = uint(numerator, `${label}.numerator`, numeratorBound)
  const divisor = uint(denominator, `${label}.denominator`, denominatorBound)
  if (divisor === 0n) throw new RangeError(`${label}.denominator must be greater than zero`)
  return divideBigInts(dividend, divisor, { rounding, maximum: resultBound, label })
}

/**
 * @param {string | bigint} amount
 * @param {{numerator: string, denominator: string}} ratio
 * @param {{rounding: 'DOWN' | 'UP' | 'EXACT', amountMaximum?: bigint, ratioNumeratorMaximum?: bigint, ratioDenominatorMaximum?: bigint, resultMaximum?: bigint, label?: string}} options
 */
export function multiplyByRatio(amount, ratio, {
  rounding,
  amountMaximum = UINT256_MAX,
  ratioNumeratorMaximum = UINT256_MAX,
  ratioDenominatorMaximum = UINT256_MAX,
  resultMaximum = UINT256_MAX,
  label = 'scaled amount',
}) {
  const amountBound = uint(amountMaximum, `${label}.amountMaximum`)
  const resultBound = uint(resultMaximum, `${label}.resultMaximum`)
  const normalized = normalizeRatio(ratio, `${label}.ratio`, {
    numeratorMaximum: ratioNumeratorMaximum,
    denominatorMaximum: ratioDenominatorMaximum,
  })
  const source = uint(amount, `${label}.amount`, amountBound)
  const numerator = BigInt(normalized.numerator)
  const denominator = BigInt(normalized.denominator)
  const originalNumerator = source * numerator

  // Cross-cancellation keeps intermediate values small for parity with bounded
  // integer implementations while preserving the exact rational result.
  const divisor = greatestCommonDivisor(source, denominator)
  const reducedAmount = source / divisor
  const reducedDenominator = denominator / divisor
  const product = reducedAmount * numerator
  const scaled = divideBigInts(product, reducedDenominator, {
    rounding,
    maximum: resultBound,
    label,
  })
  const quotient = originalNumerator / denominator
  const remainder = originalNumerator % denominator
  return Object.freeze({
    value: scaled.value,
    rounded: scaled.rounded,
    roundingReceipt: Object.freeze({
      originalNumerator: originalNumerator.toString(),
      originalDenominator: denominator.toString(),
      quotient: quotient.toString(),
      remainder: remainder.toString(),
      roundingMode: scaled.rounding,
    }),
  })
}

export function compareRatios(left, right, label = 'ratio comparison') {
  const leftRatio = normalizeRatio(left, `${label}.left`)
  const rightRatio = normalizeRatio(right, `${label}.right`)
  const leftProduct = BigInt(leftRatio.numerator) * BigInt(rightRatio.denominator)
  const rightProduct = BigInt(rightRatio.numerator) * BigInt(leftRatio.denominator)
  return leftProduct < rightProduct ? -1 : leftProduct > rightProduct ? 1 : 0
}
