import { encodeAbiParameters, keccak256, stringToHex } from 'viem'
import {
  MAX_CATALOG_ASSETS,
  MAX_FALLBACK_ATTEMPTS,
  UINT32_MAX,
  UINT64_MAX,
} from './constants.mjs'
import {
  boundedList,
  boundedText,
  bytes32,
  decimalString,
  record,
} from './scalars.mjs'

export const PLAYBACK_DECISION_VERSION = 1
export const FALLBACK_SELECTION_DOMAIN = keccak256(stringToHex('RFE_FALLBACK_V1'))

export const FAILURE_CLASSES = Object.freeze([
  'NO_RESERVATION',
  'PROGRAM_NOT_COMMITTED',
  'LIVE_START_MISSED',
  'SEGMENT_MISSING',
  'ASSET_UNAVAILABLE',
  'ASSET_INVALID',
  'STATION_PAUSED_BY_DEFINED_POLICY',
])

export const PLAYBACK_PROVENANCE = Object.freeze([
  'LIVE_PRIMARY',
  'PREPUBLISHED_PRIMARY',
  'SCHEDULED_REPLAY',
  'RESERVATION_FALLBACK',
  'STANDING_STATION_FALLBACK',
  'PROCEDURAL_SLATE',
])

export const AVAILABILITY_RESULTS = Object.freeze([
  'AVAILABLE',
  'UNAVAILABLE',
  'INVALID',
  'UNKNOWN',
])

function uint(value, label, maximum) {
  const source = typeof value === 'bigint' ? value.toString() : value
  return BigInt(decimalString(source, label, { maximum }))
}

function failureCode(value) {
  const index = FAILURE_CLASSES.indexOf(value)
  if (index === -1) throw new TypeError(`Unsupported failure class: ${value}`)
  return index
}

/** @returns {`0x${string}`} */
function hex32(value, label) {
  return /** @type {`0x${string}`} */ (bytes32(value, label))
}

function nonzeroBytes32(value, label) {
  const normalized = bytes32(value, label)
  if (normalized === `0x${'00'.repeat(32)}`) throw new TypeError(`${label} must not be zero`)
  return normalized
}

export function deterministicFallbackIndex({
  stationId,
  seasonNumber,
  lotIndex,
  failureClass,
  fallbackSeed,
  candidateCount,
}) {
  const count = uint(candidateCount, 'candidateCount', BigInt(MAX_CATALOG_ASSETS))
  if (count === 0n) throw new RangeError('candidateCount must be greater than zero')
  const hash = keccak256(encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint64' },
      { type: 'uint32' },
      { type: 'uint8' },
      { type: 'bytes32' },
    ],
    [
      FALLBACK_SELECTION_DOMAIN,
      /** @type {`0x${string}`} */ (nonzeroBytes32(stationId, 'stationId')),
      uint(seasonNumber, 'seasonNumber', UINT64_MAX),
      Number(uint(lotIndex, 'lotIndex', UINT32_MAX)),
      failureCode(failureClass),
      hex32(fallbackSeed, 'fallbackSeed'),
    ],
  ))
  return Number(BigInt(hash) % count)
}

function candidate(input, label) {
  const value = record(input, label)
  if (Object.hasOwn(value, 'fallbackRef')) {
    throw new TypeError(`${label}.fallbackRef is unsupported; initial fallback candidates must be concrete assets`)
  }
  if (Object.hasOwn(value, 'weight')) {
    throw new TypeError(`${label}.weight is unsupported; Fallback V1 candidates are unweighted`)
  }
  return Object.freeze({
    assetId: nonzeroBytes32(value.assetId, `${label}.assetId`),
    programId: value.programId === undefined || value.programId === null
      ? null
      : nonzeroBytes32(value.programId, `${label}.programId`),
  })
}

function catalog(input, label) {
  if (input === undefined || input === null) return null
  const value = record(input, label)
  const candidates = boundedList(value.candidates, `${label}.candidates`, {
    maximum: MAX_CATALOG_ASSETS,
  }).map((entry, index) => candidate(entry, `${label}.candidates[${index}]`))
  const ids = candidates.map((entry) => entry.assetId)
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${label}.candidates must contain distinct asset IDs`)
  }
  return Object.freeze({
    catalogRoot: nonzeroBytes32(value.catalogRoot, `${label}.catalogRoot`),
    candidates: Object.freeze(candidates),
  })
}

function availabilityResults(input) {
  const value = record(input, 'availabilityResults')
  return (assetId) => {
    const result = Object.hasOwn(value, assetId) ? value[assetId] : 'UNKNOWN'
    if (!AVAILABILITY_RESULTS.includes(result)) {
      throw new TypeError(`Unsupported availability result for ${assetId}`)
    }
    return result
  }
}

function playbackDecision({
  stationId,
  decisionBlock,
  candidate,
  slateHash = null,
  provenance,
  failureClass,
  policyVersion,
  catalogRoot = null,
  selectionIndex = null,
  reason,
}) {
  return Object.freeze({
    version: PLAYBACK_DECISION_VERSION,
    stationId,
    decisionBlock: decisionBlock.toString(),
    programId: candidate?.programId ?? null,
    assetId: candidate?.assetId ?? null,
    slateHash,
    provenance,
    failureClass,
    policyVersion,
    catalogRoot,
    selectionIndex: selectionIndex === null ? null : String(selectionIndex),
    reason,
  })
}

export function normalizePlaybackDecisionV1(input) {
  const value = record(input, 'playback decision')
  if (value.version !== PLAYBACK_DECISION_VERSION) {
    throw new TypeError(`version must be ${PLAYBACK_DECISION_VERSION}`)
  }
  if (!PLAYBACK_PROVENANCE.includes(value.provenance)) {
    throw new TypeError('playback decision provenance is not supported')
  }
  const isPrimary = ['LIVE_PRIMARY', 'PREPUBLISHED_PRIMARY', 'SCHEDULED_REPLAY'].includes(value.provenance)
  if (isPrimary ? value.failureClass !== null : !FAILURE_CLASSES.includes(value.failureClass)) {
    throw new TypeError('playback decision failureClass is inconsistent with provenance')
  }
  const isSlate = value.provenance === 'PROCEDURAL_SLATE'
  if (isSlate ? value.assetId !== null || value.slateHash === null : value.assetId === null || value.slateHash !== null) {
    throw new TypeError('playback decision asset/slate fields are inconsistent with provenance')
  }
  if (isPrimary && value.programId === null) {
    throw new TypeError('primary playback decision must identify a program')
  }
  const isStanding = value.provenance === 'STANDING_STATION_FALLBACK'
  if (isStanding
    ? value.catalogRoot === null || value.selectionIndex === null
    : value.catalogRoot !== null || value.selectionIndex !== null) {
    throw new TypeError('playback decision catalog fields are inconsistent with provenance')
  }
  if (!Number.isInteger(value.policyVersion) || value.policyVersion < 1 || value.policyVersion > Number(UINT32_MAX)) {
    throw new TypeError('playback decision policyVersion must be a positive uint32 number')
  }
  const normalized = {
    version: PLAYBACK_DECISION_VERSION,
    stationId: nonzeroBytes32(value.stationId, 'playback decision.stationId'),
    decisionBlock: decimalString(value.decisionBlock, 'playback decision.decisionBlock', { maximum: UINT64_MAX }),
    programId: value.programId === null ? null : nonzeroBytes32(value.programId, 'playback decision.programId'),
    assetId: value.assetId === null ? null : nonzeroBytes32(value.assetId, 'playback decision.assetId'),
    slateHash: value.slateHash === null ? null : nonzeroBytes32(value.slateHash, 'playback decision.slateHash'),
    provenance: value.provenance,
    failureClass: value.failureClass,
    policyVersion: value.policyVersion,
    catalogRoot: value.catalogRoot === null ? null : nonzeroBytes32(value.catalogRoot, 'playback decision.catalogRoot'),
    selectionIndex: value.selectionIndex === null
      ? null
      : decimalString(value.selectionIndex, 'playback decision.selectionIndex', { maximum: BigInt(MAX_CATALOG_ASSETS - 1) }),
    reason: boundedText(value.reason, 'playback decision.reason', { maxBytes: 160 }),
  }
  return Object.freeze(normalized)
}

export function resolvePlaybackDecision(input) {
  const value = record(input, 'playback input')
  const station = nonzeroBytes32(value.stationId, 'playback input.stationId')
  const block = uint(value.decisionBlock, 'playback input.decisionBlock', UINT64_MAX)
  const season = uint(value.seasonNumber, 'playback input.seasonNumber', UINT64_MAX)
  const lot = uint(value.lotIndex, 'playback input.lotIndex', UINT32_MAX)
  const failure = value.failureClass
  const seed = bytes32(value.fallbackSeed, 'playback input.fallbackSeed')
  const policyVersion = value.policyVersion
  if (!Number.isInteger(policyVersion) || policyVersion < 1 || policyVersion > Number(UINT32_MAX)) {
    throw new TypeError('playback input.policyVersion must be a positive uint32 number')
  }
  const statusFor = availabilityResults(value.availabilityResults)
  const attempts = []
  const primary = value.primary === undefined || value.primary === null
    ? null
    : candidate(value.primary, 'playback input.primary')
  const primaryProvenance = value.primary?.provenance
  if (primary && !['LIVE_PRIMARY', 'PREPUBLISHED_PRIMARY', 'SCHEDULED_REPLAY'].includes(primaryProvenance)) {
    throw new TypeError('playback input primary provenance is not supported')
  }
  if (primary && primary.programId === null) {
    throw new TypeError('playback input primary must identify a program')
  }

  function tryCandidate(entry, lane) {
    const status = statusFor(entry.assetId)
    attempts.push(Object.freeze({ lane, assetId: entry.assetId, status }))
    return status === 'AVAILABLE'
  }

  function result(decision) {
    if (attempts.length > MAX_FALLBACK_ATTEMPTS) {
      throw new RangeError('playback availability attempts exceeded the fixed bound')
    }
    return Object.freeze({
      decision: normalizePlaybackDecisionV1(decision),
      availabilityAttempts: Object.freeze(attempts),
    })
  }

  if (primary && tryCandidate(primary, 'PRIMARY')) {
    return result(playbackDecision({
      stationId: station,
      decisionBlock: block,
      candidate: primary,
      provenance: primaryProvenance,
      failureClass: null,
      policyVersion,
      reason: 'primary program selected',
    }))
  }

  failureCode(failure)
  if (failure === 'NO_RESERVATION' && primary !== null) {
    throw new TypeError('NO_RESERVATION failure cannot include a primary program')
  }

  const reservationFallback = value.reservationFallback === undefined || value.reservationFallback === null
    ? null
    : candidate(value.reservationFallback, 'playback input.reservationFallback')
  if (reservationFallback && tryCandidate(reservationFallback, 'RESERVATION_FALLBACK')) {
    return result(playbackDecision({
      stationId: station,
      decisionBlock: block,
      candidate: reservationFallback,
      provenance: 'RESERVATION_FALLBACK',
      failureClass: failure,
      policyVersion,
      reason: 'reservation fallback selected',
    }))
  }

  for (const [field, lane] of [
    ['seasonArchive', 'SEASON_ARCHIVE'],
    ['baseCatalog', 'BASE_CATALOG'],
    ['previousCatalog', 'PREVIOUS_CATALOG'],
  ]) {
    const current = catalog(value[field], `playback input.${field}`)
    if (!current || current.candidates.length === 0) continue
    const startIndex = deterministicFallbackIndex({
      stationId: station,
      seasonNumber: season,
      lotIndex: lot,
      failureClass: failure,
      fallbackSeed: seed,
      candidateCount: String(current.candidates.length),
    })
    for (let offset = 0; offset < current.candidates.length; offset += 1) {
      const selectionIndex = (startIndex + offset) % current.candidates.length
      const selected = current.candidates[selectionIndex]
      if (!tryCandidate(selected, lane)) continue
      return result(playbackDecision({
        stationId: station,
        decisionBlock: block,
        candidate: selected,
        provenance: 'STANDING_STATION_FALLBACK',
        failureClass: failure,
        policyVersion,
        catalogRoot: current.catalogRoot,
        selectionIndex,
        reason: `${lane.toLowerCase().replaceAll('_', ' ')} selected`,
      }))
    }
  }

  const slate = record(value.proceduralSlate, 'playback input.proceduralSlate')
  return result(playbackDecision({
    stationId: station,
    decisionBlock: block,
    candidate: null,
    slateHash: nonzeroBytes32(slate.slateHash, 'playback input.proceduralSlate.slateHash'),
    provenance: 'PROCEDURAL_SLATE',
    failureClass: failure,
    policyVersion,
    reason: 'procedural slate selected after bounded fallback attempts',
  }))
}
