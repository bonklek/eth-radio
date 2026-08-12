import { PROTOCOL_NAME } from '../protocol/constants.mjs'
import { bytes32, record } from '../protocol/scalars.mjs'
import { sha256DomainSeparatedCanonicalJson } from './canonical-json.mjs'
import {
  EVIDENCE_CONTEXT_SCHEMA,
  normalizeEconomicEvidenceContextV1,
} from './evidence-context.mjs'

export const ECONOMIC_EVIDENCE_COMMITMENT_PROFILE = 'EconomicEvidenceCommitmentProfileV1'
export const ECONOMIC_EVIDENCE_COMMITMENT_DOMAIN = 'RFE_ECONOMIC_EVIDENCE_CONTEXT_V1'
export const PLAYBACK_EVIDENCE_ASSOCIATION_SCHEMA = 'rfe/playback-decision-evidence-association@1'
export const PLAYBACK_EVIDENCE_ASSOCIATION_VERSION = 1
export const PLAYBACK_EVIDENCE_ASSOCIATION_AUTHORITY = 'NONCANONICAL_COMPANION'

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

function commitmentInput(entry) {
  if (entry.presence === 'MISSING') {
    return Object.freeze({
      id: entry.id,
      presence: entry.presence,
      reasonProfileId: entry.reasonProfileId,
      reasonCode: entry.reasonCode,
    })
  }
  return Object.freeze({
    id: entry.id,
    presence: entry.presence,
    valueTypeProfileId: entry.valueTypeProfileId,
    value: entry.value,
    sourceBinding: entry.sourceBinding,
  })
}

export function economicEvidenceCommitmentDocumentV1(input, evidenceProfile) {
  const context = normalizeEconomicEvidenceContextV1(input, evidenceProfile)
  return Object.freeze({
    schema: EVIDENCE_CONTEXT_SCHEMA,
    evidenceProfileId: context.evidenceProfileId,
    evidenceProfileVersion: context.evidenceProfileVersion,
    canonicalSnapshotRef: context.canonicalSnapshotRef,
    finalityProfileId: context.finalityProfileId,
    finalityStateCode: context.finalityStateCode,
    observationSourceSetHash: context.observationSourceSetHash,
    requiredInputIds: context.requiredInputIds,
    optionalInputIds: context.optionalInputIds,
    inputs: Object.freeze(context.entries.map(commitmentInput)),
  })
}

export function createEconomicEvidenceCommitmentV1(input, evidenceProfile) {
  const document = economicEvidenceCommitmentDocumentV1(input, evidenceProfile)
  const { canonical, digest } = sha256DomainSeparatedCanonicalJson(
    ECONOMIC_EVIDENCE_COMMITMENT_DOMAIN,
    document,
    'economic evidence commitment document',
  )
  return Object.freeze({
    commitmentProfile: ECONOMIC_EVIDENCE_COMMITMENT_PROFILE,
    commitment: digest,
    canonicalDocument: document,
    canonicalJson: canonical,
  })
}

export function normalizePlaybackDecisionEvidenceAssociationV1(input) {
  const value = record(input, 'playback decision evidence association')
  exactKeys(value, [
    'protocol',
    'schema',
    'version',
    'authority',
    'decisionContextHash',
    'economicEvidenceCommitment',
  ], 'playback decision evidence association')
  if (value.protocol !== PROTOCOL_NAME) throw new TypeError(`protocol must be ${PROTOCOL_NAME}`)
  if (value.schema !== PLAYBACK_EVIDENCE_ASSOCIATION_SCHEMA) {
    throw new TypeError(`schema must be ${PLAYBACK_EVIDENCE_ASSOCIATION_SCHEMA}`)
  }
  if (value.version !== PLAYBACK_EVIDENCE_ASSOCIATION_VERSION) {
    throw new TypeError(`version must be ${PLAYBACK_EVIDENCE_ASSOCIATION_VERSION}`)
  }
  if (value.authority !== PLAYBACK_EVIDENCE_ASSOCIATION_AUTHORITY) {
    throw new TypeError(`authority must be ${PLAYBACK_EVIDENCE_ASSOCIATION_AUTHORITY}`)
  }
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    schema: PLAYBACK_EVIDENCE_ASSOCIATION_SCHEMA,
    version: PLAYBACK_EVIDENCE_ASSOCIATION_VERSION,
    authority: PLAYBACK_EVIDENCE_ASSOCIATION_AUTHORITY,
    decisionContextHash: bytes32(value.decisionContextHash, 'playback association.decisionContextHash'),
    economicEvidenceCommitment: bytes32(
      value.economicEvidenceCommitment,
      'playback association.economicEvidenceCommitment',
    ),
  })
}

export function createPlaybackDecisionEvidenceAssociationV1(input) {
  const value = record(input, 'playback decision evidence association input')
  exactKeys(
    value,
    ['decisionContextHash', 'economicEvidenceCommitment'],
    'playback decision evidence association input',
  )
  return normalizePlaybackDecisionEvidenceAssociationV1({
    protocol: PROTOCOL_NAME,
    schema: PLAYBACK_EVIDENCE_ASSOCIATION_SCHEMA,
    version: PLAYBACK_EVIDENCE_ASSOCIATION_VERSION,
    authority: PLAYBACK_EVIDENCE_ASSOCIATION_AUTHORITY,
    decisionContextHash: value.decisionContextHash,
    economicEvidenceCommitment: value.economicEvidenceCommitment,
  })
}
