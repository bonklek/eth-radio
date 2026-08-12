import fs from 'node:fs'
import path from 'node:path'
import { isAddress } from 'viem'
import { readBoundedJsonFileSync } from '../../../scripts/lib/bounded-files.mjs'
import { streamFilesystemIdentity } from '../../../scripts/lib/filesystem-identity.mjs'
import { DEFAULT_CONFIG, normalizeConfig } from './config.mjs'
import { MEDIA_FIELDS, PUBLISHER_FIELDS } from './job-projections.mjs'
import { gasLimitDecision } from './gas-preflight.mjs'
import {
  verifyPublisherEngineStateIntegrity,
  verifyPublisherEngineStatePair,
} from './engine-state-integrity.mjs'

export const PUBLISHER_JOB_MAX_BYTES = 64 * 1024
export const SEGMENT_MANIFEST_MAX_BYTES = 32 * 1024 * 1024
export const ENGINE_STATE_MAX_BYTES = 32 * 1024 * 1024
export const SUPERVISOR_STATE_MAX_BYTES = 1024 * 1024
export const PUBLISHER_PROGRESS_MAX_BYTES = 64 * 1024
export const MAX_MANIFEST_SEGMENTS = 65_536
export const MAX_DROPPED_SEGMENTS = 65_536
export const MAX_ENGINE_ITEMS = 64
export const MAX_ENGINE_PUBLISHED = 65_536

const hash64 = /^(?:0x)?[0-9a-fA-F]{64}$/
const address = /^0x[0-9a-fA-F]{40}$/
const decimal = /^\d+$/

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function knownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) throw new Error(`${label} contains unknown field ${unknown.sort()[0]}`)
}

function text(value, max, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null
  if (typeof value !== 'string' || !value || value.length > max) throw new Error(`${label} must be a non-empty string of at most ${max} characters`)
  return value
}

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}`)
  return value
}

function array(value, max, label) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array with at most ${max} entries`)
  return value
}

function directChild(file, directory, label) {
  const resolved = path.resolve(text(file, 4096, label))
  if (path.dirname(resolved) !== path.resolve(directory)) throw new Error(`${label} escapes its job directory`)
  return resolved
}

function boundedJson(filePath, maxBytes, label) {
  return readBoundedJsonFileSync(filePath, { maxBytes, label })
}

export function readPublisherJobConfig(configPath, { env = process.env, requireSource = true, role = 'supervisor' } = {}) {
  const file = path.resolve(configPath)
  const raw = record(boundedJson(file, PUBLISHER_JOB_MAX_BYTES, 'publisher job configuration'), 'publisher job configuration')
  const roleFields = role === 'media'
    ? MEDIA_FIELDS
    : role === 'publisher'
      ? PUBLISHER_FIELDS
      : Object.keys(DEFAULT_CONFIG)
  const internalFields = new Set(['configSchema', 'segmentDir', 'publisherStatePath', 'publisherProgressPath', 'startSequence'])
  const allowed = new Set([...roleFields, ...internalFields])
  knownFields(raw, allowed, 'publisher job configuration')
  const expectedSchema = role === 'media'
    ? 'rfe/publisher-media-job@1'
    : role === 'publisher'
      ? 'rfe/publisher-transaction-job@1'
      : null
  if (expectedSchema && raw.configSchema !== expectedSchema) throw new Error(`publisher job configuration must use ${expectedSchema}`)
  if (!expectedSchema && raw.configSchema !== undefined) throw new Error('supervisor job configuration must not use a worker role schema')
  const selected = Object.fromEntries(Object.entries(raw).filter(([key]) => !internalFields.has(key)))
  const external = { ...DEFAULT_CONFIG, ...selected }
  const normalized = normalizeConfig(external, {
    env,
    requireSource: role === 'publisher' ? false : requireSource,
    requireSigner: role !== 'media',
    requireMainnetConfirmation: role !== 'media',
  })
  const jobDir = path.dirname(file)
  const segmentDir = path.resolve(text(raw.segmentDir, 4096, 'segmentDir'))
  if (segmentDir !== path.join(jobDir, 'segments')) throw new Error('segmentDir does not match the job directory')
  const output = {
    ...normalized,
    segmentDir,
    startSequence: integer(raw.startSequence, 0, Number.MAX_SAFE_INTEGER, 'startSequence'),
  }
  if (role !== 'media') {
    const publisherStatePath = path.resolve(text(raw.publisherStatePath, 4096, 'publisherStatePath'))
    if (publisherStatePath !== path.join(jobDir, 'publisher-state.json')) throw new Error('publisherStatePath does not match the job directory')
    output.publisherStatePath = publisherStatePath
  } else if (raw.publisherStatePath !== undefined) {
    throw new Error('media job configuration must not contain publisherStatePath')
  }
  if (role !== 'supervisor') {
    const publisherProgressPath = path.resolve(text(raw.publisherProgressPath, 4096, 'publisherProgressPath'))
    if (publisherProgressPath !== path.join(jobDir, 'publisher-progress.json')) throw new Error('publisherProgressPath does not match the job directory')
    output.publisherProgressPath = publisherProgressPath
  }
  return output
}

const manifestRootFields = new Set([
  'app', 'kind', 'streamId', 'filePrefix', 'input', 'outDir', 'segmentMs', 'codec',
  'configFingerprint', 'durationMs', 'totalSegments', 'pipelineMode',
  'overlayBurnedIn', 'maxAheadSegments', 'nextCaptureIndex', 'droppedSegments',
  'sourceIdentity', 'createdAt', 'updatedAt', 'completedAt', 'pausedAt', 'segments', 'filesystemIdentity',
])
const segmentFields = new Set([
  'sequence', 'mediaIndex', 'captureIndex', 'file', 'bytes', 'estimatedBlobs',
  'payloadSha256', 'startMs', 'durationMs', 'videoBitrateKbps', 'overlayBurnedIn',
  'overlayProof', 'witness', 'createdAt',
])
const droppedFields = new Set(['captureIndex', 'bytes', 'blobCount', 'reason', 'overlayBurnedIn', 'witness', 'droppedAt'])

function validateObservation(value, label) {
  if (value === undefined || value === null) return
  record(value, label)
  if (Object.keys(value).length > 24) throw new Error(`${label} has too many fields`)
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 64) throw new Error(`${label} field name is too long`)
    if (typeof item === 'string' && item.length > 2048) throw new Error(`${label}.${key} is too long`)
    if (!['string', 'number', 'boolean'].includes(typeof item) && item !== null) throw new Error(`${label}.${key} has unsupported nesting`)
  }
}

export function validateSegmentManifest(manifest, { streamId, segmentDir }) {
  record(manifest, 'segment manifest')
  knownFields(manifest, manifestRootFields, 'segment manifest')
  if (manifest.streamId !== streamId) throw new Error('segment manifest streamId does not match the job')
  const identity = record(manifest.filesystemIdentity, 'segment manifest filesystemIdentity')
  const expectedIdentity = streamFilesystemIdentity(streamId)
  if (identity.version !== expectedIdentity.version || identity.kind !== expectedIdentity.kind
    || identity.key !== expectedIdentity.key || identity.scope?.streamId !== streamId) {
    throw new Error('segment manifest filesystem identity does not match the job')
  }
  if (manifest.outDir !== undefined && path.resolve(manifest.outDir) !== path.resolve(segmentDir)) {
    throw new Error('segment manifest outDir does not match the job')
  }
  if (manifest.sourceIdentity !== undefined) {
    const source = record(manifest.sourceIdentity, 'segment manifest sourceIdentity')
    knownFields(source, new Set(['path', 'size', 'mtimeMs', 'sha256']), 'segment manifest sourceIdentity')
    text(source.path, 4096, 'segment manifest sourceIdentity.path')
    integer(source.size, 0, Number.MAX_SAFE_INTEGER, 'segment manifest sourceIdentity.size')
    integer(source.mtimeMs, 0, Number.MAX_SAFE_INTEGER, 'segment manifest sourceIdentity.mtimeMs')
    if (!hash64.test(String(source.sha256 || ''))) throw new Error('segment manifest sourceIdentity.sha256 must be a SHA-256 hash')
  }
  const segments = array(manifest.segments, MAX_MANIFEST_SEGMENTS, 'segment manifest segments')
  let priorSequence = -1
  const seen = new Set()
  for (const [index, item] of segments.entries()) {
    record(item, `segment[${index}]`)
    knownFields(item, segmentFields, `segment[${index}]`)
    const sequence = integer(item.sequence, 0, Number.MAX_SAFE_INTEGER, `segment[${index}].sequence`)
    if (sequence <= priorSequence || seen.has(sequence)) throw new Error('segment manifest sequences must be unique and strictly increasing')
    seen.add(sequence)
    priorSequence = sequence
    item.file = directChild(item.file, segmentDir, `segment[${index}].file`)
    integer(item.bytes, 1, 6 * 126_976, `segment[${index}].bytes`)
    integer(item.estimatedBlobs, 1, 6, `segment[${index}].estimatedBlobs`)
    if (!hash64.test(String(item.payloadSha256 || ''))) throw new Error(`segment[${index}].payloadSha256 must be a SHA-256 hash`)
    integer(item.durationMs, 1, 600_000, `segment[${index}].durationMs`)
    validateObservation(item.overlayProof, `segment[${index}].overlayProof`)
    validateObservation(item.witness, `segment[${index}].witness`)
  }
  const dropped = manifest.droppedSegments === undefined ? [] : array(manifest.droppedSegments, MAX_DROPPED_SEGMENTS, 'droppedSegments')
  for (const [index, item] of dropped.entries()) {
    record(item, `droppedSegments[${index}]`)
    knownFields(item, droppedFields, `droppedSegments[${index}]`)
    integer(item.captureIndex, 0, Number.MAX_SAFE_INTEGER, `droppedSegments[${index}].captureIndex`)
    integer(item.bytes, 0, 6 * 126_976 * 4, `droppedSegments[${index}].bytes`)
    integer(item.blobCount, 0, 24, `droppedSegments[${index}].blobCount`)
    text(item.reason, 512, `droppedSegments[${index}].reason`)
    validateObservation(item.witness, `droppedSegments[${index}].witness`)
  }
  return manifest
}

export function readSegmentManifest(manifestPath, context) {
  return validateSegmentManifest(boundedJson(manifestPath, SEGMENT_MANIFEST_MAX_BYTES, 'segment manifest'), context)
}

function wei(value, label) {
  if (!decimal.test(String(value ?? ''))) throw new Error(`${label} must be a non-negative integer string`)
  return String(value)
}

const engineFields = new Set([
  'version', 'engine', 'chain', 'stationAddress', 'publisher', 'streamId',
  'nextSequence', 'nextNonce', 'previousSegmentHash', 'items', 'published',
  'actualSpendWei', 'metrics', 'publicLineages', 'lastLoopError',
  'lastLoopErrorAt', 'historyBlockedReason', 'createdAt', 'updatedAt',
  'revision', 'previousStateChecksum', 'stateChecksum',
  'durabilityMode',
])
const lineageFields = new Set([
  'sequence', 'nonce', 'file', 'durationMs', 'codec', 'payloadBytes',
  'payloadSha256', 'blobCount', 'previousSegmentHash', 'status',
  'blockedReason', 'winnerHash', 'confirmations', 'reservations', 'attempts', 'createdAt',
  'accountedCostWei', 'accountedExecutionCostWei', 'accountedBlobCostWei',
  'accountedAt', 'liquidityEvidence', 'gasPreflightEvidence',
])
const reservationFields = new Set([
  'schema', 'publisher', 'chainId', 'type', 'to', 'nonce', 'gas', 'value',
  'dataSha256', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas',
  'blobVersionedHashes', 'blobCount', 'payloadSha256', 'reservedExposureWei',
  'intentDigest', 'index', 'reservedAt',
])
const attemptFields = new Set([
  'index', 'intentDigest', 'txHash', 'serializedTransaction', 'reservedCostWei', 'maxFeePerGas',
  'maxPriorityFeePerGas', 'maxFeePerBlobGas', 'preparedAt', 'broadcastAt',
  'lastSendAttemptAt', 'sendCount',
])
const publishedFields = new Set([
  'sequence', 'nonce', 'file', 'durationMs', 'codec', 'payloadBytes',
  'payloadSha256', 'blobCount', 'previousSegmentHash', 'txHash',
  'winningAttempt', 'attemptCount', 'attemptHashes', 'blockHash', 'blockNumber',
  'blobVersionedHashes', 'costWei', 'executionCostWei', 'blobCostWei',
  'gasLimit', 'gasUsed',
  'confirmedAt', 'finalityStatus', 'finalityEvidence',
])
const finalityStatuses = new Set(['operationally-confirmed', 'finalized-tag-observed', 'provider-disagreement'])
const lineageStatuses = new Set(['reserved', 'prepared', 'pending', 'replacing', 'confirming', 'blocked', 'failed'])
const txHash = /^0x[0-9a-fA-F]{64}$/
const serializedTransaction = /^0x[0-9a-fA-F]+$/

function optionalText(value, max, label) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be at most ${max} characters`)
  return value
}

function validateAttempt(attempt, itemIndex, attemptIndex) {
  const label = `items[${itemIndex}].attempts[${attemptIndex}]`
  record(attempt, label)
  knownFields(attempt, attemptFields, label)
  if (attempt.index !== attemptIndex) throw new Error(`${label}.index must match durable attempt order`)
  if (!/^[0-9a-f]{64}$/.test(String(attempt.intentDigest || ''))) throw new Error(`${label}.intentDigest must be a SHA-256 digest`)
  if (!txHash.test(String(attempt.txHash || ''))) throw new Error(`${label}.txHash must be a transaction hash`)
  const serialized = String(attempt.serializedTransaction || '')
  if (!serializedTransaction.test(serialized) || serialized.length > 16 * 1024 * 1024) {
    throw new Error(`${label}.serializedTransaction must be bounded transaction hex`)
  }
  for (const field of ['reservedCostWei', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas']) wei(attempt[field], `${label}.${field}`)
  integer(attempt.sendCount, 0, 1_000_000, `${label}.sendCount`)
  text(attempt.preparedAt, 64, `${label}.preparedAt`)
  optionalText(attempt.broadcastAt, 64, `${label}.broadcastAt`)
  optionalText(attempt.lastSendAttemptAt, 64, `${label}.lastSendAttemptAt`)
}

function validateReservation(reservation, item, expected, itemIndex, reservationIndex) {
  const label = `items[${itemIndex}].reservations[${reservationIndex}]`
  record(reservation, label)
  knownFields(reservation, reservationFields, label)
  if (reservation.schema !== 'rfe/publication-intent@1' || reservation.index !== reservationIndex) {
    throw new Error(`${label} has an unsupported schema or index`)
  }
  if (reservation.type !== 'eip4844') throw new Error(`${label}.type must be eip4844`)
  if (!address.test(String(reservation.publisher)) || !address.test(String(reservation.to))) throw new Error(`${label} contains an invalid address`)
  if ((expected.publisher && reservation.publisher.toLowerCase() !== expected.publisher.toLowerCase())
    || reservation.to.toLowerCase() !== expected.stationAddress.toLowerCase()) {
    throw new Error(`${label} signer or destination does not match the job`)
  }
  integer(reservation.chainId, 1, Number.MAX_SAFE_INTEGER, `${label}.chainId`)
  integer(reservation.nonce, 0, Number.MAX_SAFE_INTEGER, `${label}.nonce`)
  if (reservation.nonce !== item.nonce) throw new Error(`${label}.nonce does not match its lineage`)
  for (const field of ['gas', 'value', 'maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas', 'reservedExposureWei']) wei(reservation[field], `${label}.${field}`)
  if (!/^[0-9a-f]{64}$/.test(String(reservation.dataSha256 || ''))
    || !hash64.test(String(reservation.payloadSha256 || ''))
    || !/^[0-9a-f]{64}$/.test(String(reservation.intentDigest || ''))) {
    throw new Error(`${label} contains an invalid digest`)
  }
  if (String(reservation.payloadSha256).replace(/^0x/, '').toLowerCase() !== String(item.payloadSha256).replace(/^0x/, '').toLowerCase()) {
    throw new Error(`${label}.payloadSha256 does not match its lineage`)
  }
  integer(reservation.blobCount, 1, 6, `${label}.blobCount`)
  const hashes = array(reservation.blobVersionedHashes, 6, `${label}.blobVersionedHashes`)
  if (hashes.length !== reservation.blobCount || hashes.some((hash) => !hash64.test(String(hash)))) {
    throw new Error(`${label}.blobVersionedHashes does not match blobCount`)
  }
}

function validateLineage(item, index, expected) {
  const label = `items[${index}]`
  record(item, label)
  knownFields(item, lineageFields, label)
  integer(item.sequence, 0, Number.MAX_SAFE_INTEGER, `${label}.sequence`)
  integer(item.nonce, 0, Number.MAX_SAFE_INTEGER, `${label}.nonce`)
  if (expected.segmentDir) item.file = directChild(item.file, expected.segmentDir, `${label}.file`)
  integer(item.durationMs, 1, 600_000, `${label}.durationMs`)
  text(item.codec, 128, `${label}.codec`)
  integer(item.payloadBytes, 1, 6 * 126_976, `${label}.payloadBytes`)
  integer(item.blobCount, 1, 6, `${label}.blobCount`)
  if (!hash64.test(String(item.payloadSha256 || '')) || !hash64.test(String(item.previousSegmentHash || ''))) {
    throw new Error(`${label} contains an invalid payload or previous hash`)
  }
  if (!lineageStatuses.has(item.status)) throw new Error(`${label}.status is unsupported`)
  optionalText(item.blockedReason, 2048, `${label}.blockedReason`)
  if (item.winnerHash !== null && item.winnerHash !== undefined && !txHash.test(String(item.winnerHash))) {
    throw new Error(`${label}.winnerHash must be a transaction hash or null`)
  }
  const reservations = array(item.reservations, 16, `${label}.reservations`)
  const attempts = array(item.attempts, 16, `${label}.attempts`)
  if (!reservations.length && item.status !== 'blocked') throw new Error(`${label}.reservations must not be empty`)
  if (reservations.length < attempts.length || reservations.length > attempts.length + 1) {
    throw new Error(`${label} must have one reservation per attempt and at most one unsigned reservation`)
  }
  reservations.forEach((reservation, reservationIndex) => validateReservation(reservation, item, expected, index, reservationIndex))
  attempts.forEach((attempt, attemptIndex) => validateAttempt(attempt, index, attemptIndex))
  for (const [attemptIndex, attempt] of attempts.entries()) {
    const reservation = reservations[attemptIndex]
    if (attempt.intentDigest !== reservation.intentDigest || attempt.reservedCostWei !== reservation.reservedExposureWei) {
      throw new Error(`${label}.attempts[${attemptIndex}] does not match its durable reservation`)
    }
  }
  if (item.status === 'reserved' && reservations.length !== attempts.length + 1) throw new Error(`${label} reserved status has no unsigned reservation`)
  if (item.status !== 'reserved' && reservations.length !== attempts.length) throw new Error(`${label} has an unsigned reservation without reserved status`)
  if (item.winnerHash && !attempts.some((attempt) => attempt.txHash.toLowerCase() === item.winnerHash.toLowerCase())) {
    throw new Error(`${label}.winnerHash does not belong to its attempt lineage`)
  }
  if (item.liquidityEvidence !== undefined) {
    const evidence = record(item.liquidityEvidence, `${label}.liquidityEvidence`)
    knownFields(evidence, new Set([
      'requiredWei', 'minimumBalanceWei', 'maximumBalanceWei', 'disagreement',
      'observations', 'observedAt',
    ]), `${label}.liquidityEvidence`)
    wei(evidence.requiredWei, `${label}.liquidityEvidence.requiredWei`)
    if (typeof evidence.disagreement !== 'boolean') throw new Error(`${label}.liquidityEvidence.disagreement must be boolean`)
    if (evidence.minimumBalanceWei !== null) wei(evidence.minimumBalanceWei, `${label}.liquidityEvidence.minimumBalanceWei`)
    if (evidence.maximumBalanceWei !== null) wei(evidence.maximumBalanceWei, `${label}.liquidityEvidence.maximumBalanceWei`)
    const observations = array(evidence.observations, 16, `${label}.liquidityEvidence.observations`)
    for (const [observationIndex, observation] of observations.entries()) {
      record(observation, `${label}.liquidityEvidence.observations[${observationIndex}]`)
      knownFields(observation, new Set(['provider', 'balanceWei']), `${label}.liquidityEvidence.observations[${observationIndex}]`)
      text(observation.provider, 64, `${label}.liquidityEvidence.observations[${observationIndex}].provider`)
      wei(observation.balanceWei, `${label}.liquidityEvidence.observations[${observationIndex}].balanceWei`)
    }
    if (!observations.length && (evidence.minimumBalanceWei !== null || evidence.maximumBalanceWei !== null)) {
      throw new Error(`${label}.liquidityEvidence empty observations require null bounds`)
    }
    if (observations.length) {
      const balances = observations.map((observation) => BigInt(observation.balanceWei))
      const minimum = balances.reduce((current, value) => value < current ? value : current)
      const maximum = balances.reduce((current, value) => value > current ? value : current)
      if (String(minimum) !== evidence.minimumBalanceWei || String(maximum) !== evidence.maximumBalanceWei
        || Boolean(evidence.disagreement) !== (minimum !== maximum)) {
        throw new Error(`${label}.liquidityEvidence bounds do not match observations`)
      }
    }
    text(evidence.observedAt, 64, `${label}.liquidityEvidence.observedAt`)
  }
  if (item.gasPreflightEvidence !== undefined) {
    const evidence = record(item.gasPreflightEvidence, `${label}.gasPreflightEvidence`)
    knownFields(evidence, new Set([
      'floorGas', 'capGas', 'marginPercent', 'gasLimit', 'maximumEstimateGas',
      'disagreement', 'observations', 'observedAt', 'revalidationObservations', 'revalidatedAt',
    ]), `${label}.gasPreflightEvidence`)
    for (const field of ['floorGas', 'capGas', 'marginPercent']) wei(evidence[field], `${label}.gasPreflightEvidence.${field}`)
    if (evidence.gasLimit !== null) wei(evidence.gasLimit, `${label}.gasPreflightEvidence.gasLimit`)
    if (evidence.maximumEstimateGas !== null) wei(evidence.maximumEstimateGas, `${label}.gasPreflightEvidence.maximumEstimateGas`)
    if (typeof evidence.disagreement !== 'boolean') throw new Error(`${label}.gasPreflightEvidence.disagreement must be boolean`)
    const observations = array(evidence.observations, 4, `${label}.gasPreflightEvidence.observations`)
    for (const [observationIndex, observation] of observations.entries()) {
      const observationLabel = `${label}.gasPreflightEvidence.observations[${observationIndex}]`
      record(observation, observationLabel)
      knownFields(observation, new Set([
        'provider', 'blockNumber', 'blockHash', 'stationCodeHash', 'estimateGas',
      ]), observationLabel)
      text(observation.provider, 64, `${observationLabel}.provider`)
      wei(observation.blockNumber, `${observationLabel}.blockNumber`)
      if (!hash64.test(String(observation.blockHash || ''))) throw new Error(`${observationLabel}.blockHash must be bytes32`)
      if (!hash64.test(String(observation.stationCodeHash || ''))) throw new Error(`${observationLabel}.stationCodeHash must be bytes32`)
      wei(observation.estimateGas, `${observationLabel}.estimateGas`)
    }
    const decision = gasLimitDecision({
      observations,
      floorGas: evidence.floorGas,
      capGas: evidence.capGas,
      marginPercent: evidence.marginPercent,
    })
    const expectedGasLimit = decision.gasLimit?.toString() ?? null
    const expectedMaximum = decision.maximumEstimateGas?.toString() ?? null
    if (evidence.gasLimit !== expectedGasLimit || evidence.maximumEstimateGas !== expectedMaximum
      || evidence.disagreement !== Boolean(decision.disagreement)) {
      throw new Error(`${label}.gasPreflightEvidence does not match its observations and policy`)
    }
    text(evidence.observedAt, 64, `${label}.gasPreflightEvidence.observedAt`)
    if ((evidence.revalidationObservations === undefined) !== (evidence.revalidatedAt === undefined)) {
      throw new Error(`${label}.gasPreflightEvidence revalidation fields must appear together`)
    }
    if (evidence.revalidationObservations !== undefined) {
      const revalidation = array(evidence.revalidationObservations, 4, `${label}.gasPreflightEvidence.revalidationObservations`)
      for (const [observationIndex, observation] of revalidation.entries()) {
        const observationLabel = `${label}.gasPreflightEvidence.revalidationObservations[${observationIndex}]`
        record(observation, observationLabel)
        knownFields(observation, new Set(['provider', 'blockNumber', 'blockHash', 'stationCodeHash']), observationLabel)
        text(observation.provider, 64, `${observationLabel}.provider`)
        wei(observation.blockNumber, `${observationLabel}.blockNumber`)
        if (!hash64.test(String(observation.blockHash || ''))) throw new Error(`${observationLabel}.blockHash must be bytes32`)
        if (!hash64.test(String(observation.stationCodeHash || ''))) throw new Error(`${observationLabel}.stationCodeHash must be bytes32`)
      }
      text(evidence.revalidatedAt, 64, `${label}.gasPreflightEvidence.revalidatedAt`)
    }
  }
  if (reservations.length && item.gasPreflightEvidence === undefined) {
    throw new Error(`${label} reservation requires gas preflight evidence`)
  }
  const accountedFields = ['accountedCostWei', 'accountedExecutionCostWei', 'accountedBlobCostWei']
  const hasAccounting = accountedFields.some((field) => item[field] !== undefined)
  if (hasAccounting) {
    if (item.status !== 'failed' || accountedFields.some((field) => item[field] === undefined)) {
      throw new Error(`${label} receipt accounting is incomplete or not failed`)
    }
    for (const field of accountedFields) wei(item[field], `${label}.${field}`)
    if (BigInt(item.accountedCostWei) !== BigInt(item.accountedExecutionCostWei) + BigInt(item.accountedBlobCostWei)) {
      throw new Error(`${label}.accountedCostWei does not conserve execution plus blob cost`)
    }
    text(item.accountedAt, 64, `${label}.accountedAt`)
  } else if (item.accountedAt !== undefined) {
    throw new Error(`${label}.accountedAt exists without receipt cost`)
  }
}

function validatePublished(item, index, expected) {
  const label = `published[${index}]`
  record(item, label)
  knownFields(item, publishedFields, label)
  integer(item.sequence, 0, Number.MAX_SAFE_INTEGER, `${label}.sequence`)
  integer(item.nonce, 0, Number.MAX_SAFE_INTEGER, `${label}.nonce`)
  if (expected.segmentDir) item.file = directChild(item.file, expected.segmentDir, `${label}.file`)
  integer(item.durationMs, 1, 600_000, `${label}.durationMs`)
  integer(item.payloadBytes, 1, 6 * 126_976, `${label}.payloadBytes`)
  integer(item.blobCount, 1, 6, `${label}.blobCount`)
  if (!hash64.test(String(item.payloadSha256 || '')) || !hash64.test(String(item.previousSegmentHash || ''))
    || !txHash.test(String(item.txHash || '')) || !txHash.test(String(item.blockHash || ''))) {
    throw new Error(`${label} contains an invalid hash`)
  }
  const attempts = array(item.attemptHashes, 16, `${label}.attemptHashes`)
  if (!attempts.length || attempts.some((hash) => !txHash.test(String(hash)))) throw new Error(`${label}.attemptHashes contains an invalid hash`)
  integer(item.winningAttempt, 0, attempts.length - 1, `${label}.winningAttempt`)
  if (item.attemptCount !== attempts.length) throw new Error(`${label}.attemptCount does not match attemptHashes`)
  const blobHashes = array(item.blobVersionedHashes, 6, `${label}.blobVersionedHashes`)
  if (blobHashes.length !== item.blobCount || blobHashes.some((hash) => !hash64.test(String(hash)))) {
    throw new Error(`${label}.blobVersionedHashes does not match blobCount`)
  }
  for (const field of ['blockNumber', 'costWei', 'executionCostWei', 'blobCostWei', 'gasLimit', 'gasUsed']) wei(item[field], `${label}.${field}`)
  if (BigInt(item.gasUsed) > BigInt(item.gasLimit)) throw new Error(`${label}.gasUsed exceeds gasLimit`)
  if (BigInt(item.costWei) !== BigInt(item.executionCostWei) + BigInt(item.blobCostWei)) {
    throw new Error(`${label}.costWei does not conserve execution plus blob cost`)
  }
  if (!finalityStatuses.has(item.finalityStatus)) throw new Error(`${label}.finalityStatus is unsupported`)
  if (item.finalityStatus === 'operationally-confirmed') {
    if (item.finalityEvidence !== null) throw new Error(`${label}.finalityEvidence must be null before a finalized-tag observation`)
  } else {
    const evidence = record(item.finalityEvidence, `${label}.finalityEvidence`)
    knownFields(evidence, new Set(['matches', 'conflicts', 'observedAt']), `${label}.finalityEvidence`)
    const matches = array(evidence.matches, 16, `${label}.finalityEvidence.matches`)
    const conflicts = array(evidence.conflicts, 16, `${label}.finalityEvidence.conflicts`)
    if (item.finalityStatus === 'finalized-tag-observed' && (!matches.length || conflicts.length)) {
      throw new Error(`${label} finalized-tag observation requires matches and no conflicts`)
    }
    if (item.finalityStatus === 'provider-disagreement' && !conflicts.length) {
      throw new Error(`${label} provider disagreement requires conflict evidence`)
    }
    for (const [kind, entries] of [['matches', matches], ['conflicts', conflicts]]) {
      for (const [evidenceIndex, entry] of entries.entries()) {
        record(entry, `${label}.${kind}[${evidenceIndex}]`)
        text(entry.provider, 64, `${label}.${kind}[${evidenceIndex}].provider`)
        wei(entry.finalizedHeadNumber, `${label}.${kind}[${evidenceIndex}].finalizedHeadNumber`)
        if (!txHash.test(String(entry.finalizedHeadHash || ''))) throw new Error(`${label}.${kind}[${evidenceIndex}] has invalid finalized head hash`)
        if (kind === 'conflicts' && !txHash.test(String(entry.observedBlockHash || ''))) throw new Error(`${label}.${kind}[${evidenceIndex}] has invalid observed block hash`)
      }
    }
    text(evidence.observedAt, 64, `${label}.finalityEvidence.observedAt`)
  }
}

export function validatePublisherEngineState(value, expected) {
  const state = record(value, 'publisher engine state')
  knownFields(state, engineFields, 'publisher engine state')
  if (state.version !== 8 || state.engine !== 'rfe-transaction-continuity') throw new Error('publisher engine state has an unsupported version')
  if (state.chain !== expected.chain || String(state.stationAddress).toLowerCase() !== expected.stationAddress.toLowerCase()
    || (expected.publisher && String(state.publisher).toLowerCase() !== expected.publisher.toLowerCase()) || state.streamId !== expected.streamId) {
    throw new Error('publisher engine state identity does not match the job')
  }
  if (!isAddress(state.stationAddress) || !address.test(String(state.publisher))) throw new Error('publisher engine state contains an invalid address')
  if (!['file-and-directory-sync', 'file-sync-verified-readback'].includes(state.durabilityMode)) {
    throw new Error('publisher engine state durability mode is unsupported')
  }
  integer(state.nextSequence, 0, Number.MAX_SAFE_INTEGER, 'nextSequence')
  if (state.nextNonce !== null) integer(state.nextNonce, 0, Number.MAX_SAFE_INTEGER, 'nextNonce')
  if (!hash64.test(String(state.previousSegmentHash || ''))) throw new Error('previousSegmentHash must be bytes32')
  const items = array(state.items, MAX_ENGINE_ITEMS, 'publisher engine pending items')
  const published = array(state.published, MAX_ENGINE_PUBLISHED, 'publisher engine published history')
  const identity = { ...expected, publisher: expected.publisher || state.publisher }
  items.forEach((item, index) => validateLineage(item, index, identity))
  published.forEach((item, index) => validatePublished(item, index, identity))
  for (const [collection, label] of [[items, 'pending'], [published, 'published']]) {
    for (let index = 1; index < collection.length; index += 1) {
      if (collection[index - 1].sequence >= collection[index].sequence) throw new Error(`${label} sequences must be unique and strictly increasing`)
    }
  }
  const nonces = new Set(items.map((item) => item.nonce))
  if (nonces.size !== items.length) throw new Error('pending nonce lineages must be unique')
  wei(state.actualSpendWei, 'actualSpendWei')
  const recordedSpend = published.reduce((sum, item) => sum + BigInt(item.costWei), 0n)
    + items.reduce((sum, item) => sum + BigInt(item.accountedCostWei || 0), 0n)
  if (recordedSpend !== BigInt(state.actualSpendWei)) throw new Error('actualSpendWei does not equal success plus revert cost history')
  record(state.metrics, 'publisher engine metrics')
  optionalText(state.historyBlockedReason, 2048, 'historyBlockedReason')
  if (state.publicLineages !== undefined) array(state.publicLineages, MAX_ENGINE_ITEMS, 'publicLineages')
  verifyPublisherEngineStateIntegrity(state)
  return state
}

export function readPublisherEngineState(statePath, expected) {
  const state = validatePublisherEngineState(boundedJson(statePath, ENGINE_STATE_MAX_BYTES, 'publisher engine state'), expected)
  const previousPath = `${statePath}.previous`
  if (state.revision > 0) {
    if (!fs.existsSync(previousPath)) throw new Error('publisher engine state is missing its previous revision')
    const previous = validatePublisherEngineState(boundedJson(previousPath, ENGINE_STATE_MAX_BYTES, 'previous publisher engine state'), expected)
    verifyPublisherEngineStatePair(state, previous)
  }
  return state
}

export function readPublisherObservation(statePath, expected) {
  if (!fs.existsSync(statePath)) return null
  return validatePublisherEngineState(
    boundedJson(statePath, ENGINE_STATE_MAX_BYTES, 'publisher observation state'),
    expected,
  )
}

export function readOptionalSegmentManifest(manifestPath, context) {
  if (!manifestPath || !fs.existsSync(manifestPath)) return null
  return readSegmentManifest(manifestPath, context)
}

const supervisorFields = new Set([
  'version', 'jobId', 'phase', 'desired', 'startedAt', 'updatedAt',
  'encoderComplete', 'encoderFailures', 'publisherRestarts', 'lastError',
  'publisherRestartHistory', 'metrics', 'lineages',
  'recoveryRequired', 'recoveryPreviousDesired',
])
const supervisorPhases = new Set(['idle', 'starting', 'running', 'paused', 'draining', 'drained', 'complete', 'stopped', 'failed', 'recovery-required'])

export function readSupervisorState(statePath) {
  const state = record(boundedJson(statePath, SUPERVISOR_STATE_MAX_BYTES, 'publisher supervisor state'), 'publisher supervisor state')
  knownFields(state, supervisorFields, 'publisher supervisor state')
  if (state.version !== 3) throw new Error('publisher supervisor state has an unsupported version')
  if (state.jobId !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/.test(String(state.jobId))) {
    throw new Error('publisher supervisor state has an invalid jobId')
  }
  if (!supervisorPhases.has(state.phase) || !supervisorPhases.has(state.desired)) throw new Error('publisher supervisor state has an invalid phase')
  integer(state.encoderFailures, 0, 1_000_000, 'encoderFailures')
  integer(state.publisherRestarts, 0, 1_000_000, 'publisherRestarts')
  const restartHistory = array(state.publisherRestartHistory, 5, 'publisherRestartHistory')
  if (state.publisherRestarts !== restartHistory.length) throw new Error('publisherRestarts does not match publisherRestartHistory')
  for (const [index, entry] of restartHistory.entries()) {
    const label = `publisherRestartHistory[${index}]`
    record(entry, label)
    knownFields(entry, new Set(['cause', 'at']), label)
    text(entry.cause, 128, `${label}.cause`)
    text(entry.at, 64, `${label}.at`)
    if (!Number.isFinite(Date.parse(entry.at))) throw new Error(`${label}.at must be an ISO timestamp`)
    if (index && Date.parse(entry.at) < Date.parse(restartHistory[index - 1].at)) throw new Error('publisherRestartHistory must be chronological')
  }
  if (typeof state.recoveryRequired !== 'boolean') throw new Error('recoveryRequired must be boolean')
  if (state.recoveryRequired) {
    if (!['running', 'paused', 'draining'].includes(state.recoveryPreviousDesired)) {
      throw new Error('recovery-required state must preserve its prior desired mode')
    }
  } else if (state.recoveryPreviousDesired !== null) {
    throw new Error('non-recovery state must not preserve a prior desired mode')
  }
  record(state.metrics, 'publisher supervisor metrics')
  if (state.lineages !== undefined) array(state.lineages, 64, 'publisher supervisor lineages')
  return state
}

const progressFields = new Set([
  'schema', 'chain', 'stationAddress', 'publisher', 'streamId',
  'confirmedCount', 'pendingCount', 'updatedAt',
])

export function validatePublisherProgress(value, expected) {
  const progress = record(value, 'publisher progress')
  knownFields(progress, progressFields, 'publisher progress')
  if (progress.schema !== 'rfe/publisher-progress@1') throw new Error('publisher progress has an unsupported schema')
  if (progress.chain !== expected.chain
    || String(progress.stationAddress).toLowerCase() !== expected.stationAddress.toLowerCase()
    || progress.streamId !== expected.streamId) {
    throw new Error('publisher progress identity does not match the media job')
  }
  if (!address.test(String(progress.publisher))) throw new Error('publisher progress has an invalid publisher address')
  integer(progress.confirmedCount, 0, MAX_ENGINE_PUBLISHED, 'publisher progress confirmedCount')
  integer(progress.pendingCount, 0, MAX_ENGINE_ITEMS, 'publisher progress pendingCount')
  text(progress.updatedAt, 64, 'publisher progress updatedAt')
  return progress
}

export function readPublisherProgress(progressPath, expected) {
  if (!fs.existsSync(progressPath)) return null
  return validatePublisherProgress(
    boundedJson(progressPath, PUBLISHER_PROGRESS_MAX_BYTES, 'publisher progress'),
    expected,
  )
}
