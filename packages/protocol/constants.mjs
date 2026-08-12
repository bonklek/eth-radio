export const PROTOCOL_NAME = 'rfe'
export const PROTOCOL_VERSION = 2

export const MAX_BLOBS_PER_SEGMENT = 6
export const MAX_ASSET_ROLES = 8
export const MAX_CATALOG_ASSETS = 64
export const MAX_CAPABILITIES = 32
export const MAX_CAPABILITY_TRANSITIONS = 16
export const MAX_FALLBACK_ATTEMPTS = 194
export const MAX_STATION_MODULES = 32
export const MAX_MANIFEST_SEGMENTS = 65_536
export const MAX_TEXT_BYTES = 1_024

export const UINT32_MAX = (1n << 32n) - 1n
export const UINT64_MAX = (1n << 64n) - 1n
export const UINT256_MAX = (1n << 256n) - 1n

export const OVERLAY_STATUSES = Object.freeze([
  'known-present',
  'known-absent',
  'unknown',
])

export const ASSET_ROLES = Object.freeze([
  'STATION_IDENT',
  'TECHNICAL_DIFFICULTIES',
  'NO_PROGRAM_SCHEDULED',
  'DEAD_AIR_MUSIC',
  'PROMOTION',
  'ADVERTISEMENT',
  'GENERAL_FALLBACK',
])
