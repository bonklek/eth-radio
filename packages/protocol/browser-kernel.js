const BROWSER_UINT64_MAX = (1n << 64n) - 1n
const BROWSER_UINT256_MAX = (1n << 256n) - 1n
const BROWSER_SECONDS_PER_SLOT = 12n
const BROWSER_KECCAK_MASK_64 = (1n << 64n) - 1n
const BROWSER_KECCAK_ROTATIONS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
]
const BROWSER_KECCAK_ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

function browserRotateKeccakLane(value, shift) {
  const amount = BigInt(shift % 64)
  if (amount === 0n) return value & BROWSER_KECCAK_MASK_64
  return ((value << amount) | (value >> (64n - amount))) & BROWSER_KECCAK_MASK_64
}

/** @param {bigint[]} state */
function browserKeccakPermutation(state) {
  for (const roundConstant of BROWSER_KECCAK_ROUND_CONSTANTS) {
    /** @type {bigint[]} */
    const columnParity = new Array(5)
    for (let x = 0; x < 5; x += 1) columnParity[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
    /** @type {bigint[]} */
    const theta = new Array(5)
    for (let x = 0; x < 5; x += 1) theta[x] = columnParity[(x + 4) % 5] ^ browserRotateKeccakLane(columnParity[(x + 1) % 5], 1)
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) state[x + 5 * y] = (state[x + 5 * y] ^ theta[x]) & BROWSER_KECCAK_MASK_64
    }
    /** @type {bigint[]} */
    const rotated = new Array(25).fill(0n)
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        rotated[y + 5 * ((2 * x + 3 * y) % 5)] = browserRotateKeccakLane(state[x + 5 * y], BROWSER_KECCAK_ROTATIONS[x + 5 * y])
      }
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) state[x + 5 * y] = rotated[x + 5 * y] ^ ((~rotated[(x + 1) % 5 + 5 * y]) & rotated[(x + 2) % 5 + 5 * y])
    }
    state[0] ^= roundConstant
  }
}

function browserKeccak256Bytes(bytes) {
  const rateBytes = 136
  const paddedLength = Math.ceil((bytes.length + 1) / rateBytes) * rateBytes
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x01
  padded[padded.length - 1] |= 0x80
  const state = new Array(25).fill(0n)
  for (let offset = 0; offset < padded.length; offset += rateBytes) {
    for (let index = 0; index < rateBytes; index += 1) state[Math.floor(index / 8)] ^= BigInt(padded[offset + index]) << BigInt((index % 8) * 8)
    browserKeccakPermutation(state)
  }
  const output = new Uint8Array(32)
  for (let index = 0; index < output.length; index += 1) output[index] = Number((state[Math.floor(index / 8)] >> BigInt((index % 8) * 8)) & 0xffn)
  return `0x${[...output].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function browserHexBytes(value, label, byteLength) {
  const text = String(value || '')
  if (!new RegExp(`^0x[0-9a-fA-F]{${byteLength * 2}}$`).test(text)) throw new TypeError(`${label} must be a 0x-prefixed ${byteLength}-byte value`)
  return Uint8Array.from(text.slice(2).match(/../g).map((byte) => Number.parseInt(byte, 16)))
}

function browserUint256Bytes(value, label) {
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)) value = BigInt(value)
  if (typeof value !== 'bigint' || value < 0n || value > BROWSER_UINT256_MAX) throw new TypeError(`${label} must be a canonical uint256 decimal string or bigint`)
  const output = new Uint8Array(32)
  for (let index = 31; index >= 0; index -= 1) {
    output[index] = Number(value & 0xffn)
    value >>= 8n
  }
  return output
}

function browserAbiWordAddress(value, label) {
  const output = new Uint8Array(32)
  output.set(browserHexBytes(value, label, 20), 12)
  return output
}

export function canonicalStreamIdHash(streamId) {
  if (typeof streamId !== 'string' || !streamId) throw new Error('streamId is required for channel identity')
  return browserKeccak256Bytes(new TextEncoder().encode(streamId))
}

export function v1SyntheticChannelId(chainId, stationAddress, publisher, streamIdHash) {
  const domain = browserHexBytes(browserKeccak256Bytes(new TextEncoder().encode('RFE_V1_SYNTHETIC_CHANNEL_ID')), 'V1 channel domain', 32)
  const encoded = new Uint8Array(160)
  encoded.set(domain, 0)
  encoded.set(browserUint256Bytes(chainId, 'chainId'), 32)
  encoded.set(browserAbiWordAddress(stationAddress, 'stationAddress'), 64)
  encoded.set(browserAbiWordAddress(publisher, 'publisher'), 96)
  encoded.set(browserHexBytes(streamIdHash, 'streamIdHash', 32), 128)
  return browserKeccak256Bytes(encoded)
}

function browserUint64Bigint(value, label) {
  if (typeof value === 'string') {
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
      throw new TypeError(`${label} must be a canonical non-negative decimal string or bigint`)
    }
    value = BigInt(value)
  }
  if (typeof value !== 'bigint') {
    throw new TypeError(`${label} must be a canonical non-negative decimal string or bigint`)
  }
  if (value < 0n || value > BROWSER_UINT64_MAX) throw new RangeError(`${label} must fit uint64`)
  return value
}

export function executionTimestampSlot(timestamp, genesisTime, secondsPerSlot = BROWSER_SECONDS_PER_SLOT) {
  const executionTimestamp = browserUint64Bigint(timestamp, 'Execution timestamp')
  const genesisTimestamp = browserUint64Bigint(genesisTime, 'Beacon genesis time')
  const slotSeconds = browserUint64Bigint(secondsPerSlot, 'Seconds per slot')
  if (slotSeconds === 0n) throw new RangeError('Seconds per slot must be greater than zero')
  if (executionTimestamp < genesisTimestamp) {
    throw new RangeError('Latest execution block timestamp is before beacon genesis')
  }
  return (executionTimestamp - genesisTimestamp) / slotSeconds
}

export function slotStartTimestamp(slot, genesisTime, secondsPerSlot = BROWSER_SECONDS_PER_SLOT) {
  const normalizedSlot = browserUint64Bigint(slot, 'Slot')
  const genesisTimestamp = browserUint64Bigint(genesisTime, 'Beacon genesis time')
  const slotSeconds = browserUint64Bigint(secondsPerSlot, 'Seconds per slot')
  if (slotSeconds === 0n) throw new RangeError('Seconds per slot must be greater than zero')
  if (normalizedSlot > BROWSER_UINT64_MAX / slotSeconds
    || genesisTimestamp > BROWSER_UINT64_MAX - normalizedSlot * slotSeconds) {
    throw new RangeError('Slot start timestamp exceeds uint64')
  }
  return genesisTimestamp + normalizedSlot * slotSeconds
}
