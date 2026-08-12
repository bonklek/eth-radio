import { encodeAbiParameters, keccak256, stringToHex } from 'viem'
import { UINT32_MAX, UINT64_MAX, UINT256_MAX } from './constants.mjs'
import { address, bytes32, decimalString } from './scalars.mjs'

export const ID_DOMAINS = Object.freeze({
  station: keccak256(stringToHex('RFE_STATION_ID_V2')),
  channel: keccak256(stringToHex('RFE_CHANNEL_ID_V2')),
  season: keccak256(stringToHex('RFE_SEASON_ID_V2')),
  lot: keccak256(stringToHex('RFE_LOT_ID_V2')),
  reservation: keccak256(stringToHex('RFE_RESERVATION_ID_V2')),
  program: keccak256(stringToHex('RFE_PROGRAM_ID_V2')),
  asset: keccak256(stringToHex('RFE_ASSET_ID_V2')),
  segment: keccak256(stringToHex('RFE_SEGMENT_ID_V2')),
  v1Channel: keccak256(stringToHex('RFE_V1_SYNTHETIC_CHANNEL_ID')),
})

function hash(types, values) {
  return keccak256(encodeAbiParameters(types.map((type) => ({ type })), values))
}

function uint(value, label, maximum) {
  const normalized = decimalString(
    typeof value === 'bigint' ? value.toString() : value,
    label,
    { maximum },
  )
  return BigInt(normalized)
}

export function stationId(chainId, stationCore) {
  return hash(
    ['bytes32', 'uint256', 'address'],
    [ID_DOMAINS.station, uint(chainId, 'chainId', UINT256_MAX), address(stationCore, 'stationCore')],
  )
}

export function channelId(station, canonicalChannelKey) {
  return hash(
    ['bytes32', 'bytes32', 'bytes32'],
    [ID_DOMAINS.channel, bytes32(station, 'stationId'), bytes32(canonicalChannelKey, 'canonicalChannelKey')],
  )
}

export function seasonId(channel, seasonNumber) {
  return hash(
    ['bytes32', 'bytes32', 'uint64'],
    [ID_DOMAINS.season, bytes32(channel, 'channelId'), uint(seasonNumber, 'seasonNumber', UINT64_MAX)],
  )
}

export function lotId(season, lotIndex) {
  return hash(
    ['bytes32', 'bytes32', 'uint32'],
    [ID_DOMAINS.lot, bytes32(season, 'seasonId'), uint(lotIndex, 'lotIndex', UINT32_MAX)],
  )
}

export function reservationId(lot, winner, allocationNonce) {
  return hash(
    ['bytes32', 'bytes32', 'address', 'uint64'],
    [
      ID_DOMAINS.reservation,
      bytes32(lot, 'lotId'),
      address(winner, 'winner'),
      uint(allocationNonce, 'allocationNonce', UINT64_MAX),
    ],
  )
}

export function programId(reservation, programNonce) {
  return hash(
    ['bytes32', 'bytes32', 'uint64'],
    [ID_DOMAINS.program, bytes32(reservation, 'reservationId'), uint(programNonce, 'programNonce', UINT64_MAX)],
  )
}

export function assetId(manifestRoot, codecProfileHash, totalDurationMs) {
  return hash(
    ['bytes32', 'bytes32', 'bytes32', 'uint64'],
    [
      ID_DOMAINS.asset,
      bytes32(manifestRoot, 'manifestRoot'),
      bytes32(codecProfileHash, 'codecProfileHash'),
      uint(totalDurationMs, 'totalDurationMs', UINT64_MAX),
    ],
  )
}

export function segmentId(asset, sequence) {
  return hash(
    ['bytes32', 'bytes32', 'uint32'],
    [ID_DOMAINS.segment, bytes32(asset, 'assetId'), uint(sequence, 'sequence', UINT32_MAX)],
  )
}

export function v1SyntheticChannelId(chainId, stationAddress, publisher, streamIdHash) {
  return hash(
    ['bytes32', 'uint256', 'address', 'address', 'bytes32'],
    [
      ID_DOMAINS.v1Channel,
      uint(chainId, 'chainId', UINT256_MAX),
      address(stationAddress, 'stationAddress'),
      address(publisher, 'publisher'),
      bytes32(streamIdHash, 'streamIdHash'),
    ],
  )
}
