import { getAddress, isHex } from 'viem'

/** @returns {never} */
function fail(label, message) {
  throw new TypeError(`${label} ${message}`)
}

export function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(label, 'must be an object')
  }
  return value
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{maxBytes?: number, allowEmpty?: boolean}} [options]
 */
export function boundedText(value, label, { maxBytes, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(label, 'must be a string')
  if (!allowEmpty && value.length === 0) fail(label, 'must not be empty')
  const bytes = new TextEncoder().encode(value).length
  if (maxBytes !== undefined && bytes > maxBytes) {
    fail(label, `must be at most ${maxBytes} UTF-8 bytes`)
  }
  return value
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{maximum?: bigint}} [options]
 */
export function decimalString(value, label, { maximum } = {}) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    fail(label, 'must be a canonical non-negative decimal string')
  }
  const parsed = BigInt(value)
  if (maximum !== undefined && parsed > maximum) fail(label, `must be at most ${maximum}`)
  return parsed.toString()
}

export function address(value, label) {
  if (typeof value !== 'string') fail(label, 'must be an Ethereum address')
  try {
    return getAddress(value).toLowerCase()
  } catch {
    fail(label, 'must be a valid checksum-aware Ethereum address')
  }
}

export function bytes32(value, label) {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || value.length !== 66) {
    fail(label, 'must be 32 bytes of 0x-prefixed hexadecimal')
  }
  return value.toLowerCase()
}

export function bytes4(value, label) {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || value.length !== 10) {
    fail(label, 'must be 4 bytes of 0x-prefixed hexadecimal')
  }
  return value.toLowerCase()
}

export function boundedList(value, label, { minimum = 0, maximum }) {
  if (!Array.isArray(value)) fail(label, 'must be an array')
  if (value.length < minimum) fail(label, `must contain at least ${minimum} entries`)
  if (value.length > maximum) fail(label, `must contain at most ${maximum} entries`)
  return value
}

export function optionalDecimalString(value, label, options) {
  return value === undefined || value === null ? undefined : decimalString(value, label, options)
}

export function optionalBytes32(value, label) {
  return value === undefined || value === null ? undefined : bytes32(value, label)
}
