import { PROTOCOL_NAME, UINT64_MAX, UINT256_MAX } from './constants.mjs'
import { boundedText, decimalString, record } from './scalars.mjs'
import { executionTimestampSlot, slotStartTimestamp } from './browser-kernel.js'

export { executionTimestampSlot, slotStartTimestamp }

export const AVAILABILITY_PROFILE_SCHEMA = 'network-availability-profile'
export const AVAILABILITY_PROFILE_VERSION = 1
export const ETHEREUM_SECONDS_PER_SLOT = 12n
export const ETHEREUM_SLOTS_PER_EPOCH = 32n
export const ETHEREUM_MINIMUM_BLOB_SERVE_EPOCHS = 4096n

function internalUint(value, label, maximum = UINT64_MAX) {
  const source = typeof value === 'bigint' ? value.toString() : value
  return BigInt(decimalString(source, label, { maximum }))
}

function positive(value, label, maximum = UINT64_MAX) {
  const parsed = internalUint(value, label, maximum)
  if (parsed === 0n) throw new RangeError(`${label} must be greater than zero`)
  return parsed
}

export function normalizeAvailabilityProfileV1(input) {
  const value = record(input, 'availability profile')
  if (value.protocol !== PROTOCOL_NAME) throw new TypeError(`protocol must be ${PROTOCOL_NAME}`)
  if (value.schema !== AVAILABILITY_PROFILE_SCHEMA) {
    throw new TypeError(`schema must be ${AVAILABILITY_PROFILE_SCHEMA}`)
  }
  if (value.version !== AVAILABILITY_PROFILE_VERSION) {
    throw new TypeError(`version must be ${AVAILABILITY_PROFILE_VERSION}`)
  }
  const chainId = internalUint(value.chainId, 'availability profile.chainId', UINT256_MAX)
  const secondsPerSlot = positive(value.secondsPerSlot, 'availability profile.secondsPerSlot')
  const slotsPerEpoch = positive(value.slotsPerEpoch, 'availability profile.slotsPerEpoch')
  const minimumBlobServeEpochs = positive(
    value.minimumBlobServeEpochs,
    'availability profile.minimumBlobServeEpochs',
  )
  const safetyMarginSlots = internalUint(
    value.safetyMarginSlots,
    'availability profile.safetyMarginSlots',
  )
  if (minimumBlobServeEpochs > UINT64_MAX / slotsPerEpoch) {
    throw new RangeError('availability profile serving-window multiplication exceeds uint64')
  }
  /** @type {Record<string, any>} */
  const normalized = {
    protocol: PROTOCOL_NAME,
    schema: AVAILABILITY_PROFILE_SCHEMA,
    version: AVAILABILITY_PROFILE_VERSION,
    network: boundedText(value.network, 'availability profile.network', { maxBytes: 64 }),
    chainId: chainId.toString(),
    secondsPerSlot: secondsPerSlot.toString(),
    slotsPerEpoch: slotsPerEpoch.toString(),
    minimumBlobServeEpochs: minimumBlobServeEpochs.toString(),
    safetyMarginSlots: safetyMarginSlots.toString(),
  }
  if (value.source !== undefined) {
    const source = record(value.source, 'availability profile.source')
    normalized.source = Object.freeze({
      specification: boundedText(source.specification, 'availability profile.source.specification', { maxBytes: 256 }),
      parameter: boundedText(source.parameter, 'availability profile.source.parameter', { maxBytes: 128 }),
      observedAt: boundedText(source.observedAt, 'availability profile.source.observedAt', { maxBytes: 64 }),
    })
  }
  return Object.freeze(normalized)
}

export function ethereumAvailabilityProfile({ network, chainId, safetyMarginSlots, observedAt }) {
  return normalizeAvailabilityProfileV1({
    protocol: PROTOCOL_NAME,
    schema: AVAILABILITY_PROFILE_SCHEMA,
    version: AVAILABILITY_PROFILE_VERSION,
    network,
    chainId,
    secondsPerSlot: ETHEREUM_SECONDS_PER_SLOT.toString(),
    slotsPerEpoch: ETHEREUM_SLOTS_PER_EPOCH.toString(),
    minimumBlobServeEpochs: ETHEREUM_MINIMUM_BLOB_SERVE_EPOCHS.toString(),
    safetyMarginSlots,
    source: {
      specification: 'https://ethereum.github.io/consensus-specs/deneb/p2p-interface/',
      parameter: 'MIN_EPOCHS_FOR_BLOB_SIDECARS_REQUESTS',
      observedAt,
    },
  })
}

export function executionTimestampSlotForProfile(timestamp, genesisTime, profile) {
  const normalized = normalizeAvailabilityProfileV1(profile)
  return executionTimestampSlot(timestamp, genesisTime, BigInt(normalized.secondsPerSlot))
}

export function slotStartTimestampForProfile(slot, genesisTime, profile) {
  const normalized = normalizeAvailabilityProfileV1(profile)
  return slotStartTimestamp(internalUint(slot, 'slot'), genesisTime, BigInt(normalized.secondsPerSlot))
}

function profileWindowSlots(profile) {
  const normalized = normalizeAvailabilityProfileV1(profile)
  return {
    normalized,
    windowSlots: BigInt(normalized.minimumBlobServeEpochs) * BigInt(normalized.slotsPerEpoch),
  }
}

export function minimumAvailableUntilSlot(inclusionSlot, profile) {
  const inclusion = internalUint(inclusionSlot, 'inclusionSlot')
  const { windowSlots } = profileWindowSlots(profile)
  if (inclusion > UINT64_MAX - windowSlots) {
    throw new RangeError('Minimum availability deadline exceeds uint64')
  }
  return inclusion + windowSlots
}

export function requiredUntilSlot(estimatedSeasonEndSlot, profile) {
  const seasonEnd = internalUint(estimatedSeasonEndSlot, 'estimatedSeasonEndSlot')
  const normalized = normalizeAvailabilityProfileV1(profile)
  const safetyMargin = BigInt(normalized.safetyMarginSlots)
  if (seasonEnd > UINT64_MAX - safetyMargin) {
    throw new RangeError('Required availability deadline exceeds uint64')
  }
  return seasonEnd + safetyMargin
}

export function assessAssetAvailability({ inclusionSlot, estimatedSeasonEndSlot, observationSlot, profile }) {
  const inclusion = internalUint(inclusionSlot, 'inclusionSlot')
  const seasonEnd = internalUint(estimatedSeasonEndSlot, 'estimatedSeasonEndSlot')
  const observation = internalUint(observationSlot, 'observationSlot')
  if (seasonEnd < inclusion) throw new RangeError('Estimated season end slot must not precede inclusion slot')
  if (observation < inclusion) throw new RangeError('Observation slot must not precede inclusion slot')
  const minimumUntil = minimumAvailableUntilSlot(inclusion, profile)
  const requiredUntil = requiredUntilSlot(seasonEnd, profile)
  const eligible = minimumUntil >= requiredUntil
  const insideMinimumServingWindow = observation < minimumUntil
  return Object.freeze({
    eligible,
    theoreticalStatus: insideMinimumServingWindow
      ? 'inside-minimum-serving-window'
      : 'outside-minimum-serving-window',
    inclusionSlot: inclusion.toString(),
    observationSlot: observation.toString(),
    minimumAvailableUntilSlot: minimumUntil.toString(),
    requiredUntilSlot: requiredUntil.toString(),
    marginSlots: (eligible ? minimumUntil - requiredUntil : 0n).toString(),
    shortfallSlots: (eligible ? 0n : requiredUntil - minimumUntil).toString(),
    remainingMinimumServingSlots: (insideMinimumServingWindow ? minimumUntil - observation : 0n).toString(),
  })
}
