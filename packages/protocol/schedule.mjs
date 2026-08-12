import { UINT32_MAX, UINT64_MAX } from './constants.mjs'
import { decimalString } from './scalars.mjs'

function uint(value, label, maximum = UINT64_MAX) {
  const source = typeof value === 'bigint' ? value.toString() : value
  return BigInt(decimalString(source, label, { maximum }))
}

export function blockRange(startBlock, endBlock, label = 'block range') {
  const start = uint(startBlock, `${label}.startBlock`)
  const end = uint(endBlock, `${label}.endBlock`)
  if (start >= end) throw new RangeError(`${label} must be a non-empty half-open range`)
  return Object.freeze({ startBlock: start, endBlock: end })
}

export function rangesOverlap(left, right) {
  const a = blockRange(left.startBlock, left.endBlock, 'left range')
  const b = blockRange(right.startBlock, right.endBlock, 'right range')
  return a.startBlock < b.endBlock && b.startBlock < a.endBlock
}

export function rangeContainsBlock(range, candidateBlock) {
  const normalized = blockRange(range.startBlock, range.endBlock)
  const block = uint(candidateBlock, 'blockNumber')
  return normalized.startBlock <= block && block < normalized.endBlock
}

export function lotRangeToBlockRange({
  seasonStartBlock,
  seasonEndBlock,
  lotSizeBlocks,
  lotCount,
  firstLot,
  reservationLotCount,
}) {
  const season = blockRange(seasonStartBlock, seasonEndBlock, 'season')
  const size = uint(lotSizeBlocks, 'lotSizeBlocks', UINT32_MAX)
  const totalLots = uint(lotCount, 'lotCount', UINT32_MAX)
  const first = uint(firstLot, 'firstLot', UINT32_MAX)
  const count = uint(reservationLotCount, 'reservationLotCount', UINT32_MAX)
  if (size === 0n) throw new RangeError('lotSizeBlocks must be greater than zero')
  if (totalLots === 0n) throw new RangeError('lotCount must be greater than zero')
  if (count === 0n) throw new RangeError('reservationLotCount must be greater than zero')
  if (first >= totalLots || count > totalLots - first) {
    throw new RangeError('reservation lot range must be inside the season lot count')
  }
  if (size > (UINT64_MAX - season.startBlock) / totalLots) {
    throw new RangeError('season start plus lot span exceeds uint64')
  }
  const configuredEnd = season.startBlock + size * totalLots
  if (configuredEnd !== season.endBlock) {
    throw new RangeError('season end must equal startBlock + lotSizeBlocks * lotCount')
  }
  const start = season.startBlock + size * first
  const end = start + size * count
  return Object.freeze({ startBlock: start, endBlock: end })
}

export function lotIndexAtBlock({ seasonStartBlock, seasonEndBlock, lotSizeBlocks, lotCount }, candidateBlock) {
  const season = blockRange(seasonStartBlock, seasonEndBlock, 'season')
  const block = uint(candidateBlock, 'blockNumber')
  if (!rangeContainsBlock(season, block)) return null
  const size = uint(lotSizeBlocks, 'lotSizeBlocks', UINT32_MAX)
  const totalLots = uint(lotCount, 'lotCount', UINT32_MAX)
  if (size === 0n || totalLots === 0n || season.startBlock + size * totalLots !== season.endBlock) {
    throw new RangeError('invalid season lot configuration')
  }
  return (block - season.startBlock) / size
}
