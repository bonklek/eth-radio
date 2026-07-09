import { parseGwei } from 'viem'

export function optionalGweiEnv(name) {
  const value = process.env[name]
  if (!value) return undefined
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid ${name}: ${value}; expected a non-negative gwei amount`)
  }
  return parseGwei(value)
}

export function gasLimitEnv(name = 'GAS_LIMIT', fallback = undefined) {
  const value = process.env[name]
  if (!value) return fallback
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${name}: ${value}; expected a non-negative integer`)
  }
  const parsed = BigInt(value)
  return parsed > 0n ? parsed : fallback
}
