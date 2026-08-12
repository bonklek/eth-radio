const unsignedDecimal = /^(\d+)(?:\.(\d+))?$/
const MAX_UINT256 = (1n << 256n) - 1n

/**
 * Parse a human decimal without passing through IEEE-754. The returned text is
 * canonical and round-trips to the exact integer unit value.
 * @param {unknown} value
 * @param {{ decimals?: number, label?: string, positive?: boolean, maxUnits?: bigint, maxInputLength?: number }} options
 */
export function parseExactUnits(value, {
  decimals,
  label = 'amount',
  positive = false,
  maxUnits = MAX_UINT256,
  maxInputLength = 96,
} = {}) {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 80) {
    throw new Error('decimals must be an integer from 0 to 80')
  }
  const input = String(value ?? '')
  if (!input || input.length > maxInputLength) {
    throw new Error(`${label} must be a bounded plain decimal`)
  }
  const match = unsignedDecimal.exec(input)
  if (!match) throw new Error(`${label} must be a plain decimal without signs or exponents`)
  const fraction = match[2] || ''
  if (fraction.length > decimals) {
    throw new Error(`${label} supports at most ${decimals} decimal places`)
  }
  const whole = match[1].replace(/^0+(?=\d)/, '')
  const units = BigInt(whole) * (10n ** BigInt(decimals))
    + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')
  const maximum = BigInt(maxUnits)
  if (units > maximum) throw new Error(`${label} exceeds its supported range`)
  if (positive && units === 0n) throw new Error(`${label} must be greater than zero`)
  const canonicalFraction = fraction.replace(/0+$/, '')
  return {
    units,
    canonical: canonicalFraction ? `${whole}.${canonicalFraction}` : whole,
  }
}

export function parseExactEth(value, options = {}) {
  return parseExactUnits(value, { decimals: 18, ...options })
}

export function parseExactGwei(value, options = {}) {
  return parseExactUnits(value, { decimals: 9, ...options })
}
