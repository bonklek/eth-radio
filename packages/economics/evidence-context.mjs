
import {
  PROTOCOL_NAME,
  UINT32_MAX,
  UINT64_MAX,
  UINT256_MAX,
} from '../protocol/constants.mjs'
import {
  boundedList,
  boundedText,
  bytes32,
  decimalString,
  record,
} from '../protocol/scalars.mjs'
import { normalizeCanonicalJsonValue } from './canonical-json.mjs'

export const EVIDENCE_CONTEXT_SCHEMA = 'rfe/economic-evidence-context@1'
export const EVIDENCE_CONTEXT_VERSION = 1
export const EVIDENCE_CONTEXT_AUTHORITY = 'ADVISORY_EVIDENCE_ONLY'
export const EVIDENCE_PROFILE_SCHEMA = 'economic-evidence-profile'
export const EVIDENCE_PROFILE_VERSION = 1
export const EVIDENCE_PROFILE_AUTHORITY = 'ADVISORY_REQUIREMENT_PROFILE'
export const EVIDENCE_CONTEXT_STATUSES = Object.freeze(['COHERENT', 'INCOMPLETE', 'INCOHERENT'])
export const EVIDENCE_STRUCTURE_STATUSES = Object.freeze(['VALID', 'INCOHERENT'])
export const EVIDENCE_COMPLETENESS_STATUSES = Object.freeze(['COMPLETE', 'INCOMPLETE'])
export const SOURCE_BINDING_KINDS = Object.freeze(['CANONICAL_SNAPSHOT', 'OBSERVATION_SOURCE'])
export const MAX_EVIDENCE_ENTRIES = 32
export const MAX_PROFILE_ASSESSMENTS = 16
export const MAX_PROFILE_REASON_CODES = 16

const ZERO_BYTES32 = `0x${'00'.repeat(32)}`

function uintString(value, label, maximum = UINT256_MAX) {
  return decimalString(value, label, { maximum })
}

function positiveVersion(value, label) {
  const normalized = uintString(value, label, UINT32_MAX)
  if (normalized === '0') throw new RangeError(`${label} must be greater than zero`)
  return normalized
}

function boundedIntegerIdentity(value, label) {
  if (typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= Number(UINT32_MAX)) {
    return value
  }
  if (typeof value === 'string') return uintString(value, label, UINT32_MAX)
  throw new TypeError(`${label} must be a bounded integer identity`)
}

function nonzeroBytes32(value, label) {
  const normalized = bytes32(value, label)
  if (normalized === ZERO_BYTES32) throw new TypeError(`${label} must not be zero`)
  return normalized
}

function exactKeys(value, allowed, label) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol keys`)
    if (!allowed.includes(key)) throw new TypeError(`${label}.${key} is not supported`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`)
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label}.${key} must be an own property`)
  }
}

function requireOwnEnumerableDataProperty(value, key, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) throw new TypeError(`${label}.${key} must be an own property`)
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    throw new TypeError(`${label}.${key} must be an enumerable data property`)
  }
  return descriptor.value
}

function optionalOwnEnumerableDataProperty(value, key, label) {
  if (!Object.hasOwn(value, key)) return undefined
  return requireOwnEnumerableDataProperty(value, key, label)
}

const EVIDENCE_CONTEXT_CREATE_KEYS = Object.freeze([
  'evidenceProfileId',
  'evidenceProfileVersion',
  'requiredInputIds',
  'optionalInputIds',
  'canonicalSnapshotRef',
  'finalityProfileId',
  'finalityStateCode',
  'observationSourceSetHash',
  'observationMetadata',
  'entries',
  'profileAssessments',
])

const EVIDENCE_CONTEXT_CREATE_REQUIRED_KEYS = Object.freeze([
  'canonicalSnapshotRef',
  'finalityProfileId',
  'finalityStateCode',
  'observationSourceSetHash',
  'observationMetadata',
  'entries',
])

function validateEvidenceContextCreateInput(value, profile) {
  const label = 'evidence context input'
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} must not contain symbol keys`)
    if (!EVIDENCE_CONTEXT_CREATE_KEYS.includes(key)) {
      throw new TypeError(`${label}.${key} is not supported`)
    }
    requireOwnEnumerableDataProperty(value, key, label)
  }
  for (const key of EVIDENCE_CONTEXT_CREATE_REQUIRED_KEYS) {
    requireOwnEnumerableDataProperty(value, key, label)
  }
  if (Object.hasOwn(value, 'profileAssessments') && value.profileAssessments === undefined) {
    throw new TypeError('evidence context input.profileAssessments must not be undefined when present')
  }
  const profileKeys = [
    'evidenceProfileId',
    'evidenceProfileVersion',
    'requiredInputIds',
    'optionalInputIds',
  ]
  if (!profile) {
    for (const key of profileKeys) requireOwnEnumerableDataProperty(value, key, label)
    return
  }
  if (Object.hasOwn(value, 'evidenceProfileId')
    && opaqueId(value.evidenceProfileId, `${label}.evidenceProfileId`) !== profile.profileId) {
    throw new TypeError('evidence context input profile ID does not match the supplied profile')
  }
  if (Object.hasOwn(value, 'evidenceProfileVersion')
    && positiveVersion(value.evidenceProfileVersion, `${label}.evidenceProfileVersion`) !== profile.profileVersion) {
    throw new TypeError('evidence context input profile version does not match the supplied profile')
  }
  if (Object.hasOwn(value, 'requiredInputIds')
    && !sameList(normalizeIdList(value.requiredInputIds, `${label}.requiredInputIds`), profile.requiredInputIds)) {
    throw new TypeError('evidence context input required IDs do not match the supplied profile')
  }
  if (Object.hasOwn(value, 'optionalInputIds')
    && !sameList(normalizeIdList(value.optionalInputIds, `${label}.optionalInputIds`), profile.optionalInputIds)) {
    throw new TypeError('evidence context input optional IDs do not match the supplied profile')
  }
}

function denseBoundedList(value, label, options) {
  const list = boundedList(value, label, options)
  for (const key of Reflect.ownKeys(list)) {
    if (key === 'length') continue
    if (typeof key !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= list.length) {
      throw new TypeError(`${label} must not contain non-index own properties`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(list, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`${label}[${key}] must be an enumerable data property`)
    }
  }
  for (let index = 0; index < list.length; index += 1) {
    if (!Object.hasOwn(list, index)) throw new TypeError(`${label} must not contain sparse entries`)
  }
  return list
}

function opaqueId(value, label) {
  return boundedText(value, label, { maxBytes: 128 })
}

function inputId(value, label) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) {
    throw new TypeError(`${label} must match [A-Z][A-Z0-9_]{0,63}`)
  }
  return value
}

function normalizeInputIdVector(value, label) {
  const ids = denseBoundedList(value, label, { maximum: MAX_EVIDENCE_ENTRIES })
    .map((entry, index) => inputId(entry, `${label}[${index}]`))
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label} must not contain duplicates`)
  return Object.freeze(ids)
}

function normalizeIdList(value, label) {
  const ids = normalizeInputIdVector(value, label)
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1] >= ids[index]) {
      throw new TypeError(`${label} must be strictly ascending by raw ASCII bytes`)
    }
  }
  return Object.freeze(ids)
}

function sameList(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function normalizeProfileAssessments(value, label = 'evidence context.profileAssessments') {
  const assessments = denseBoundedList(value, label, { maximum: MAX_PROFILE_ASSESSMENTS })
    .map((entry, index) => {
      const entryLabel = `${label}[${index}]`
      const assessment = record(entry, entryLabel)
      exactKeys(assessment, ['profileId', 'stateCode', 'reasonCodes'], entryLabel)
      const reasonCodes = denseBoundedList(assessment.reasonCodes, `${entryLabel}.reasonCodes`, {
        maximum: MAX_PROFILE_REASON_CODES,
      }).map((reason, reasonIndex) => opaqueId(reason, `${entryLabel}.reasonCodes[${reasonIndex}]`))
      if (new Set(reasonCodes).size !== reasonCodes.length) {
        throw new TypeError(`${entryLabel}.reasonCodes must not contain duplicates`)
      }
      return Object.freeze({
        profileId: opaqueId(assessment.profileId, `${entryLabel}.profileId`),
        stateCode: opaqueId(assessment.stateCode, `${entryLabel}.stateCode`),
        reasonCodes: Object.freeze(reasonCodes),
      })
    })
  const profileIds = assessments.map((entry) => entry.profileId)
  if (new Set(profileIds).size !== profileIds.length) {
    throw new TypeError(`${label} must not repeat a profileId`)
  }
  return Object.freeze(assessments)
}

function expectedEvidenceProfileAssessment(profileId, supported) {
  return Object.freeze({
    profileId,
    stateCode: supported ? 'SUPPORTED' : 'UNSUPPORTED',
    reasonCodes: Object.freeze(supported ? [] : ['UNKNOWN_EVIDENCE_PROFILE']),
  })
}

function sameAssessment(left, right) {
  return left.profileId === right.profileId
    && left.stateCode === right.stateCode
    && sameList(left.reasonCodes, right.reasonCodes)
}

export function normalizeEconomicEvidenceProfileV1(input) {
  const value = record(input, 'evidence profile')
  exactKeys(value, [
    'protocol',
    'schema',
    'version',
    'authority',
    'profileId',
    'profileVersion',
    'requiredInputIds',
    'optionalInputIds',
    'inputDefinitions',
  ], 'evidence profile')
  if (value.protocol !== PROTOCOL_NAME) throw new TypeError(`protocol must be ${PROTOCOL_NAME}`)
  if (value.schema !== EVIDENCE_PROFILE_SCHEMA) throw new TypeError(`schema must be ${EVIDENCE_PROFILE_SCHEMA}`)
  if (value.version !== EVIDENCE_PROFILE_VERSION) throw new TypeError(`version must be ${EVIDENCE_PROFILE_VERSION}`)
  if (value.authority !== EVIDENCE_PROFILE_AUTHORITY) {
    throw new TypeError(`authority must be ${EVIDENCE_PROFILE_AUTHORITY}`)
  }
  const requiredInputIds = normalizeIdList(value.requiredInputIds, 'evidence profile.requiredInputIds')
  const optionalInputIds = normalizeIdList(value.optionalInputIds, 'evidence profile.optionalInputIds')
  const registered = [...requiredInputIds, ...optionalInputIds]
  if (new Set(registered).size !== registered.length) {
    throw new TypeError('evidence profile input IDs must be unique across required and optional registries')
  }
  const inputDefinitions = denseBoundedList(value.inputDefinitions, 'evidence profile.inputDefinitions', {
    maximum: MAX_EVIDENCE_ENTRIES,
  }).map((entry, index) => {
    const label = `evidence profile.inputDefinitions[${index}]`
    const definition = record(entry, label)
    exactKeys(definition, [
      'id',
      'valueTypeProfileId',
      'sourceBindingKind',
      'sourceBindingProfileId',
    ], label)
    if (!SOURCE_BINDING_KINDS.includes(definition.sourceBindingKind)) {
      throw new TypeError(`${label}.sourceBindingKind is not supported`)
    }
    return Object.freeze({
      id: inputId(definition.id, `${label}.id`),
      valueTypeProfileId: opaqueId(definition.valueTypeProfileId, `${label}.valueTypeProfileId`),
      sourceBindingKind: definition.sourceBindingKind,
      sourceBindingProfileId: opaqueId(
        definition.sourceBindingProfileId,
        `${label}.sourceBindingProfileId`,
      ),
    })
  })
  const definitionIds = inputDefinitions.map((entry) => entry.id)
  if (new Set(definitionIds).size !== definitionIds.length) {
    throw new TypeError('evidence profile input definitions must have unique id values')
  }
  if (!sameList(definitionIds, registered)) {
    throw new TypeError(
      'evidence profile input definitions must equal required then optional registries in canonical order',
    )
  }
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    schema: EVIDENCE_PROFILE_SCHEMA,
    version: EVIDENCE_PROFILE_VERSION,
    authority: EVIDENCE_PROFILE_AUTHORITY,
    profileId: opaqueId(value.profileId, 'evidence profile.profileId'),
    profileVersion: positiveVersion(value.profileVersion, 'evidence profile.profileVersion'),
    requiredInputIds,
    optionalInputIds,
    inputDefinitions: Object.freeze(inputDefinitions),
  })
}

function normalizeExpectedContext(value) {
  const expected = record(value, 'evidence context.canonicalSnapshotRef')
  exactKeys(
    expected,
    ['chainId', 'blockNumber', 'blockHash', 'snapshotProfileId'],
    'evidence context.canonicalSnapshotRef',
  )
  const chainId = uintString(expected.chainId, 'evidence context.canonicalSnapshotRef.chainId')
  if (chainId === '0') {
    throw new RangeError('evidence context.canonicalSnapshotRef.chainId must be greater than zero')
  }
  return Object.freeze({
    chainId,
    blockNumber: uintString(
      expected.blockNumber,
      'evidence context.canonicalSnapshotRef.blockNumber',
      UINT64_MAX,
    ),
    blockHash: nonzeroBytes32(
      expected.blockHash,
      'evidence context.canonicalSnapshotRef.blockHash',
    ),
    snapshotProfileId: opaqueId(
      expected.snapshotProfileId,
      'evidence context.canonicalSnapshotRef.snapshotProfileId',
    ),
  })
}

function normalizeObservationMetadata(value) {
  const metadata = record(value, 'evidence context.observationMetadata')
  exactKeys(metadata, ['observedAtUnixMs'], 'evidence context.observationMetadata')
  return Object.freeze({
    observedAtUnixMs: uintString(
      metadata.observedAtUnixMs,
      'evidence context.observationMetadata.observedAtUnixMs',
      UINT64_MAX,
    ),
  })
}

function normalizeSourceBinding(value, definition, label) {
  const binding = record(value, label)
  const expectedKind = definition?.sourceBindingKind
  const kind = expectedKind ?? binding.kind
  if (kind === 'CANONICAL_SNAPSHOT') {
    exactKeys(binding, ['kind', 'profileId', 'chainId', 'blockNumber', 'blockHash'], label)
    if (binding.kind !== 'CANONICAL_SNAPSHOT') throw new TypeError(`${label}.kind must be CANONICAL_SNAPSHOT`)
    if (definition && binding.profileId !== definition.sourceBindingProfileId) {
      throw new TypeError(`${label}.profileId does not match the evidence profile`)
    }
    const chainId = uintString(binding.chainId, `${label}.chainId`)
    if (chainId === '0') throw new RangeError(`${label}.chainId must be greater than zero`)
    return Object.freeze({
      kind: binding.kind,
      profileId: opaqueId(binding.profileId, `${label}.profileId`),
      chainId,
      blockNumber: uintString(binding.blockNumber, `${label}.blockNumber`, UINT64_MAX),
      blockHash: nonzeroBytes32(binding.blockHash, `${label}.blockHash`),
    })
  }
  if (kind !== 'OBSERVATION_SOURCE') throw new TypeError(`${label}.kind is not supported`)
  exactKeys(binding, ['kind', 'profileId', 'sourceCommitment'], label)
  if (binding.kind !== 'OBSERVATION_SOURCE') throw new TypeError(`${label}.kind must be OBSERVATION_SOURCE`)
  if (definition && binding.profileId !== definition.sourceBindingProfileId) {
    throw new TypeError(`${label}.profileId does not match the evidence profile`)
  }
  return Object.freeze({
    kind: binding.kind,
    profileId: opaqueId(binding.profileId, `${label}.profileId`),
    sourceCommitment: bytes32(binding.sourceCommitment, `${label}.sourceCommitment`),
  })
}

function normalizeEvidenceEntry(value, index, expectedId, definition) {
  const label = `evidence context.entries[${index}]`
  const entry = record(value, label)
  const id = inputId(entry.id, `${label}.id`)
  if (id !== expectedId) {
    throw new TypeError(`${label}.id does not match its registered profile position`)
  }
  if (entry.presence === 'MISSING') {
    exactKeys(entry, ['id', 'presence', 'reasonProfileId', 'reasonCode'], label)
    return Object.freeze({
      id,
      presence: 'MISSING',
      reasonProfileId: opaqueId(entry.reasonProfileId, `${label}.reasonProfileId`),
      reasonCode: opaqueId(entry.reasonCode, `${label}.reasonCode`),
    })
  }
  if (entry.presence !== 'PRESENT') throw new TypeError(`${label}.presence must be PRESENT or MISSING`)
  exactKeys(entry, ['id', 'presence', 'valueTypeProfileId', 'value', 'sourceBinding'], label)
  if (definition && entry.valueTypeProfileId !== definition.valueTypeProfileId) {
    throw new TypeError(`${label}.valueTypeProfileId does not match the evidence profile`)
  }
  return Object.freeze({
    id,
    presence: 'PRESENT',
    valueTypeProfileId: opaqueId(entry.valueTypeProfileId, `${label}.valueTypeProfileId`),
    value: normalizeCanonicalJsonValue(entry.value, `${label}.value`),
    sourceBinding: normalizeSourceBinding(entry.sourceBinding, definition, `${label}.sourceBinding`),
  })
}

function assessEntries(profile, expected, entries) {
  const required = new Set(profile.requiredInputIds)
  const missingRequiredEvidenceIds = entries
    .filter((entry) => required.has(entry.id) && entry.presence === 'MISSING')
    .map((entry) => entry.id)
  const missingOptionalEvidenceIds = entries
    .filter((entry) => !required.has(entry.id) && entry.presence === 'MISSING')
    .map((entry) => entry.id)
  const conflictingEvidenceIds = entries
    .filter((entry) => entry.presence === 'PRESENT'
      && entry.sourceBinding.kind === 'CANONICAL_SNAPSHOT'
      && (entry.sourceBinding.chainId !== expected.chainId
        || entry.sourceBinding.blockNumber !== expected.blockNumber
        || entry.sourceBinding.blockHash !== expected.blockHash))
    .map((entry) => entry.id)
  const structureStatus = conflictingEvidenceIds.length > 0 ? 'INCOHERENT' : 'VALID'
  const completenessStatus = missingRequiredEvidenceIds.length > 0 ? 'INCOMPLETE' : 'COMPLETE'
  const status = structureStatus === 'INCOHERENT'
    ? 'INCOHERENT'
    : completenessStatus === 'INCOMPLETE'
      ? 'INCOMPLETE'
      : 'COHERENT'
  return {
    structureStatus,
    completenessStatus,
    status,
    missingRequiredEvidenceIds,
    missingOptionalEvidenceIds,
    conflictingEvidenceIds,
  }
}

export function normalizeEconomicEvidenceContextV1(input, evidenceProfile) {
  const profile = evidenceProfile === undefined
    ? undefined
    : normalizeEconomicEvidenceProfileV1(evidenceProfile)
  const value = record(input, 'evidence context')
  exactKeys(value, [
    'protocol',
    'schema',
    'version',
    'authority',
    'parseStatus',
    'evidenceProfileId',
    'evidenceProfileVersion',
    'canonicalSnapshotRef',
    'finalityProfileId',
    'finalityStateCode',
    'observationSourceSetHash',
    'observationMetadata',
    'requiredInputIds',
    'optionalInputIds',
    'entries',
    'status',
    'structureStatus',
    'completenessStatus',
    'missingRequiredEvidenceIds',
    'missingOptionalEvidenceIds',
    'conflictingEvidenceIds',
    'profileAssessments',
  ], 'evidence context')
  if (value.protocol !== PROTOCOL_NAME) throw new TypeError(`protocol must be ${PROTOCOL_NAME}`)
  if (value.schema !== EVIDENCE_CONTEXT_SCHEMA) throw new TypeError(`schema must be ${EVIDENCE_CONTEXT_SCHEMA}`)
  if (value.version !== EVIDENCE_CONTEXT_VERSION) throw new TypeError(`version must be ${EVIDENCE_CONTEXT_VERSION}`)
  if (value.authority !== EVIDENCE_CONTEXT_AUTHORITY) {
    throw new TypeError(`authority must be ${EVIDENCE_CONTEXT_AUTHORITY}`)
  }
  if (value.parseStatus !== 'SUPPORTED') throw new TypeError('evidence context.parseStatus must be SUPPORTED')
  const evidenceProfileId = opaqueId(value.evidenceProfileId, 'evidence context.evidenceProfileId')
  const evidenceProfileVersion = positiveVersion(
    value.evidenceProfileVersion,
    'evidence context.evidenceProfileVersion',
  )
  if (profile && (evidenceProfileId !== profile.profileId
    || evidenceProfileVersion !== profile.profileVersion)) {
    throw new TypeError('evidence context profile identity does not match the supplied profile')
  }
  const requiredInputIds = normalizeIdList(value.requiredInputIds, 'evidence context.requiredInputIds')
  const optionalInputIds = normalizeIdList(value.optionalInputIds, 'evidence context.optionalInputIds')
  if (profile && (!sameList(requiredInputIds, profile.requiredInputIds)
    || !sameList(optionalInputIds, profile.optionalInputIds))) {
    throw new TypeError('evidence context input registries do not match the supplied profile')
  }
  const registeredInputIds = [...requiredInputIds, ...optionalInputIds]
  const expected = normalizeExpectedContext(value.canonicalSnapshotRef)
  const finalityProfileId = opaqueId(value.finalityProfileId, 'evidence context.finalityProfileId')
  const finalityStateCode = opaqueId(value.finalityStateCode, 'evidence context.finalityStateCode')
  const observationSourceSetHash = bytes32(
    value.observationSourceSetHash,
    'evidence context.observationSourceSetHash',
  )
  const observationMetadata = normalizeObservationMetadata(value.observationMetadata)
  const entries = denseBoundedList(value.entries, 'evidence context.entries', {
    maximum: MAX_EVIDENCE_ENTRIES,
  }).map((entry, index) => {
    if (index >= registeredInputIds.length) {
      throw new TypeError('evidence context has more entries than its input registries')
    }
    return normalizeEvidenceEntry(
      entry,
      index,
      registeredInputIds[index],
      profile?.inputDefinitions[index],
    )
  })
  if (entries.length !== registeredInputIds.length) {
    throw new TypeError('evidence context must include exactly one entry per registered input')
  }
  const assessmentProfile = profile ?? { requiredInputIds }
  const assessment = assessEntries(assessmentProfile, expected, entries)
  for (const key of ['status', 'structureStatus', 'completenessStatus']) {
    if (value[key] !== assessment[key]) throw new TypeError(`evidence context.${key} must be ${assessment[key]}`)
  }
  for (const key of ['missingRequiredEvidenceIds', 'missingOptionalEvidenceIds', 'conflictingEvidenceIds']) {
    const declared = normalizeInputIdVector(value[key], `evidence context.${key}`)
    if (!sameList(declared, assessment[key])) throw new TypeError(`evidence context.${key} is inconsistent`)
  }
  const profileAssessments = normalizeProfileAssessments(value.profileAssessments)
  const expectedProfileAssessment = expectedEvidenceProfileAssessment(evidenceProfileId, profile !== undefined)
  if (profileAssessments.length === 0
    || !sameAssessment(profileAssessments[0], expectedProfileAssessment)) {
    throw new TypeError('evidence context first profile assessment is inconsistent with profile support')
  }
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    schema: EVIDENCE_CONTEXT_SCHEMA,
    version: EVIDENCE_CONTEXT_VERSION,
    authority: EVIDENCE_CONTEXT_AUTHORITY,
    parseStatus: 'SUPPORTED',
    evidenceProfileId,
    evidenceProfileVersion,
    requiredInputIds,
    optionalInputIds,
    canonicalSnapshotRef: expected,
    finalityProfileId,
    finalityStateCode,
    observationSourceSetHash,
    observationMetadata,
    entries: Object.freeze(entries),
    status: assessment.status,
    structureStatus: assessment.structureStatus,
    completenessStatus: assessment.completenessStatus,
    missingRequiredEvidenceIds: Object.freeze(assessment.missingRequiredEvidenceIds),
    missingOptionalEvidenceIds: Object.freeze(assessment.missingOptionalEvidenceIds),
    conflictingEvidenceIds: Object.freeze(assessment.conflictingEvidenceIds),
    profileAssessments,
  })
}

export function createEconomicEvidenceContextV1(input, evidenceProfile) {
  const profile = evidenceProfile === undefined
    ? undefined
    : normalizeEconomicEvidenceProfileV1(evidenceProfile)
  const value = record(input, 'evidence context input')
  validateEvidenceContextCreateInput(value, profile)
  const evidenceProfileId = profile?.profileId
    ?? opaqueId(value.evidenceProfileId, 'evidence context input.evidenceProfileId')
  const evidenceProfileVersion = profile?.profileVersion
    ?? positiveVersion(value.evidenceProfileVersion, 'evidence context input.evidenceProfileVersion')
  const requiredInputIds = profile?.requiredInputIds
    ?? normalizeIdList(value.requiredInputIds, 'evidence context input.requiredInputIds')
  const optionalInputIds = profile?.optionalInputIds
    ?? normalizeIdList(value.optionalInputIds, 'evidence context input.optionalInputIds')
  const registeredInputIds = [...requiredInputIds, ...optionalInputIds]
  const expected = normalizeExpectedContext(value.canonicalSnapshotRef)
  const finalityProfileId = opaqueId(value.finalityProfileId, 'evidence context input.finalityProfileId')
  const finalityStateCode = opaqueId(value.finalityStateCode, 'evidence context input.finalityStateCode')
  const observationSourceSetHash = bytes32(
    value.observationSourceSetHash,
    'evidence context input.observationSourceSetHash',
  )
  const observationMetadata = normalizeObservationMetadata(value.observationMetadata)
  const entries = denseBoundedList(value.entries, 'evidence context.entries', {
    maximum: MAX_EVIDENCE_ENTRIES,
  }).map((entry, index) => {
    if (index >= registeredInputIds.length) {
      throw new TypeError('evidence context has more entries than its input registries')
    }
    return normalizeEvidenceEntry(
      entry,
      index,
      registeredInputIds[index],
      profile?.inputDefinitions[index],
    )
  })
  if (entries.length !== registeredInputIds.length) {
    throw new TypeError('evidence context must include exactly one entry per registered input')
  }
  const assessment = assessEntries(profile ?? { requiredInputIds }, expected, entries)
  const baseProfileAssessment = expectedEvidenceProfileAssessment(evidenceProfileId, profile !== undefined)
  const additionalProfileAssessments = value.profileAssessments === undefined
    ? []
    : normalizeProfileAssessments(value.profileAssessments, 'evidence context input.profileAssessments')
  if (additionalProfileAssessments.some((entry) => entry.profileId === evidenceProfileId)) {
    throw new TypeError('additional profile assessments must not repeat the evidence profile')
  }
  return normalizeEconomicEvidenceContextV1({
    ...value,
    protocol: PROTOCOL_NAME,
    schema: EVIDENCE_CONTEXT_SCHEMA,
    version: EVIDENCE_CONTEXT_VERSION,
    authority: EVIDENCE_CONTEXT_AUTHORITY,
    parseStatus: 'SUPPORTED',
    evidenceProfileId,
    evidenceProfileVersion,
    canonicalSnapshotRef: expected,
    finalityProfileId,
    finalityStateCode,
    observationSourceSetHash,
    observationMetadata,
    requiredInputIds,
    optionalInputIds,
    status: assessment.status,
    structureStatus: assessment.structureStatus,
    completenessStatus: assessment.completenessStatus,
    missingRequiredEvidenceIds: assessment.missingRequiredEvidenceIds,
    missingOptionalEvidenceIds: assessment.missingOptionalEvidenceIds,
    conflictingEvidenceIds: assessment.conflictingEvidenceIds,
    profileAssessments: [baseProfileAssessment, ...additionalProfileAssessments],
  }, profile)
}

export function requireCoherentEconomicEvidenceV1(input, evidenceProfile) {
  const context = normalizeEconomicEvidenceContextV1(input, evidenceProfile)
  if (context.profileAssessments[0]?.stateCode !== 'SUPPORTED') {
    throw new Error('Economic evidence profile is unsupported')
  }
  if (context.status !== 'COHERENT') {
    throw new Error(`Economic evidence is ${context.status.toLowerCase()}`)
  }
  return context
}

/**
 * @param {unknown} input
 * @param {{evidenceProfile?: unknown}} [options]
 */
export function parseEconomicEvidenceContextArtifact(input, { evidenceProfile } = {}) {
  const value = record(input, 'economic evidence artifact')
  const protocolValue = requireOwnEnumerableDataProperty(
    value,
    'protocol',
    'economic evidence artifact',
  )
  const schemaValue = requireOwnEnumerableDataProperty(
    value,
    'schema',
    'economic evidence artifact',
  )
  const versionValue = requireOwnEnumerableDataProperty(
    value,
    'version',
    'economic evidence artifact',
  )
  if (protocolValue === PROTOCOL_NAME
    && schemaValue === EVIDENCE_CONTEXT_SCHEMA
    && versionValue === EVIDENCE_CONTEXT_VERSION) {
    return normalizeEconomicEvidenceContextV1(value, evidenceProfile)
  }
  const protocol = boundedText(protocolValue, 'economic evidence artifact.protocol', { maxBytes: 64 })
  const schema = boundedText(schemaValue, 'economic evidence artifact.schema', { maxBytes: 128 })
  const version = boundedIntegerIdentity(versionValue, 'economic evidence artifact.version')
  const hasEvidenceProfileId = Object.hasOwn(value, 'evidenceProfileId')
  const hasEvidenceProfileVersion = Object.hasOwn(value, 'evidenceProfileVersion')
  if (hasEvidenceProfileId !== hasEvidenceProfileVersion) {
    throw new TypeError('unsupported economic evidence profile identity must include both ID and version')
  }
  const hasProfileAssessments = Object.hasOwn(value, 'profileAssessments')
  const rawProfileAssessments = optionalOwnEnumerableDataProperty(
    value,
    'profileAssessments',
    'economic evidence artifact',
  )
  if (hasProfileAssessments && rawProfileAssessments === undefined) {
    throw new TypeError('economic evidence artifact.profileAssessments must not be undefined when present')
  }
  const profileAssessments = rawProfileAssessments === undefined
    ? Object.freeze([])
    : normalizeProfileAssessments(rawProfileAssessments, 'economic evidence artifact.profileAssessments')
  const rawEvidenceProfileId = optionalOwnEnumerableDataProperty(
    value,
    'evidenceProfileId',
    'economic evidence artifact',
  )
  const rawEvidenceProfileVersion = optionalOwnEnumerableDataProperty(
    value,
    'evidenceProfileVersion',
    'economic evidence artifact',
  )
  return Object.freeze({
    parseStatus: 'UNSUPPORTED_SCHEMA',
    protocol,
    schema,
    version,
    evidenceProfileId: rawEvidenceProfileId === undefined
      ? undefined
      : opaqueId(rawEvidenceProfileId, 'economic evidence artifact.evidenceProfileId'),
    evidenceProfileVersion: hasEvidenceProfileVersion
      ? boundedIntegerIdentity(
        rawEvidenceProfileVersion,
        'economic evidence artifact.evidenceProfileVersion',
      )
      : undefined,
    profileAssessments,
  })
}
