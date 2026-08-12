import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Common, Hardfork, Mainnet } from '@ethereumjs/common'
import { createEVM } from '@ethereumjs/evm'
import { createAddressFromString } from '@ethereumjs/util'
import { bytesToHex } from 'viem'
import {
  MAX_CANONICAL_JSON_BYTES,
  MAX_CANONICAL_JSON_STRING_BYTES,
  canonicalizeJson,
  createEconomicEvidenceCommitmentV1,
  createEconomicEvidenceContextV1,
  createPlaybackDecisionEvidenceAssociationV1,
  normalizePlaybackDecisionEvidenceAssociationV1,
  parseEconomicEvidenceContextArtifact,
} from '../packages/economics/index.mjs'

const blockHash = `0x${'11'.repeat(32)}`
const profileId = `0x${'22'.repeat(32)}`
const sourceSetHash = `0x${'33'.repeat(32)}`
const decisionContextHash = `0x${'55'.repeat(32)}`

const evidenceProfile = {
  protocol: 'rfe',
  schema: 'economic-evidence-profile',
  version: 1,
  authority: 'ADVISORY_REQUIREMENT_PROFILE',
  profileId,
  profileVersion: '1',
  requiredInputIds: ['FEE'],
  optionalInputIds: ['NOTE'],
  inputDefinitions: [
    {
      id: 'FEE',
      valueTypeProfileId: 'exact-fee-value-v1',
      sourceBindingKind: 'CANONICAL_SNAPSHOT',
      sourceBindingProfileId: 'execution-header-v1',
    },
    {
      id: 'NOTE',
      valueTypeProfileId: 'local-note-v1',
      sourceBindingKind: 'OBSERVATION_SOURCE',
      sourceBindingProfileId: 'local-note-source-v1',
    },
  ],
}

const contextInput = {
  canonicalSnapshotRef: {
    chainId: '1',
    blockNumber: '123',
    blockHash,
    snapshotProfileId: 'execution-snapshot-v1',
  },
  finalityProfileId: 'execution-finality-observation-v1',
  finalityStateCode: 'UNVERIFIED',
  observationSourceSetHash: sourceSetHash,
  observationMetadata: { observedAtUnixMs: '1783759000000' },
  entries: [
    {
      id: 'FEE',
      presence: 'PRESENT',
      valueTypeProfileId: 'exact-fee-value-v1',
      value: {
        z_unit: 'wei',
        amount: '123456789',
        enabled: true,
      },
      sourceBinding: {
        kind: 'CANONICAL_SNAPSHOT',
        profileId: 'execution-header-v1',
        chainId: '1',
        blockNumber: '123',
        blockHash,
      },
    },
    {
      id: 'NOTE',
      presence: 'MISSING',
      reasonProfileId: 'evidence-missing-reason-v1',
      reasonCode: 'NOT_OBSERVED',
    },
  ],
}

const context = createEconomicEvidenceContextV1(contextInput, evidenceProfile)
const commitment = createEconomicEvidenceCommitmentV1(context, evidenceProfile)
assert.equal(commitment.commitment, '0x746c4b3f1222c7c2804739fceeb857c1ed470ee46e8f6fc7c718c27731501d09')
assert.match(commitment.commitment, /^0x[0-9a-f]{64}$/)
assert.equal(commitment.commitmentProfile, 'EconomicEvidenceCommitmentProfileV1')
assert.equal(commitment.canonicalDocument.schema, 'rfe/economic-evidence-context@1')
assert.equal(Object.hasOwn(commitment.canonicalDocument, 'observationMetadata'), false)
assert.equal(Object.hasOwn(commitment.canonicalDocument, 'status'), false)
assert.ok(commitment.canonicalJson.indexOf('"amount"') < commitment.canonicalJson.indexOf('"z_unit"'))

assert.equal(
  canonicalizeJson({ z: 'last', a: { y: true, x: 'first' } }),
  '{"a":{"x":"first","y":true},"z":"last"}',
)
assert.equal(
  canonicalizeJson({ '\u20ac': 'euro', '\r': 'control', '1': 'digit' }),
  '{"\\r":"control","1":"digit","€":"euro"}',
)
assert.throws(() => canonicalizeJson({ amount: 1 }), /only strings, booleans/)
assert.throws(() => canonicalizeJson({ amount: null }), /only strings, booleans/)
assert.throws(() => canonicalizeJson({ bad: '\ud800' }), /unpaired UTF-16 surrogate/)
const accessor = {}
Object.defineProperty(accessor, 'secret', { enumerable: true, get() { return 'leak' } })
assert.throws(() => canonicalizeJson(accessor), /enumerable data property/)
const accessorArray = ['safe']
let canonicalArrayGetterCalled = false
Object.defineProperty(accessorArray, '0', {
  enumerable: true,
  get() {
    canonicalArrayGetterCalled = true
    return 'unsafe'
  },
})
assert.throws(() => canonicalizeJson(accessorArray), /enumerable data property/)
assert.equal(canonicalArrayGetterCalled, false)
const hiddenArray = ['safe']
Object.defineProperty(hiddenArray, '0', { enumerable: false, value: 'hidden' })
assert.throws(() => canonicalizeJson(hiddenArray), /enumerable data property/)
const oversizedCanonicalArray = Array.from(
  { length: 64 },
  () => 'x'.repeat(MAX_CANONICAL_JSON_STRING_BYTES),
)
const largestFittingPlainArray = oversizedCanonicalArray.slice(0, 63)
assert.ok(
  new TextEncoder().encode(canonicalizeJson(largestFittingPlainArray)).length
    <= MAX_CANONICAL_JSON_BYTES,
)
assert.throws(() => canonicalizeJson(oversizedCanonicalArray), /maximum canonical byte length/)
const escapeExpandedArray = Array.from(
  { length: 11 },
  () => '\0'.repeat(MAX_CANONICAL_JSON_STRING_BYTES),
)
assert.throws(() => canonicalizeJson(escapeExpandedArray), /maximum canonical byte length/)

const clone = (value) => structuredClone(value)
const observedLater = clone(context)
observedLater.observationMetadata.observedAtUnixMs = '1783759999999'
assert.equal(
  createEconomicEvidenceCommitmentV1(observedLater, evidenceProfile).commitment,
  commitment.commitment,
)
const extraAssessment = clone(context)
extraAssessment.profileAssessments.push({
  profileId: `0x${'66'.repeat(32)}`,
  stateCode: 'FUTURE_STATE',
  reasonCodes: ['DISPLAY_ONLY'],
})
assert.equal(
  createEconomicEvidenceCommitmentV1(extraAssessment, evidenceProfile).commitment,
  commitment.commitment,
)

for (const mutate of [
  (value) => { value.finalityStateCode = 'SAFE' },
  (value) => { value.observationSourceSetHash = `0x${'77'.repeat(32)}` },
  (value) => { value.entries[0].value.amount = '123456790' },
  (value) => { value.entries[1].reasonCode = 'UNSUPPORTED' },
  (value) => { value.canonicalSnapshotRef.snapshotProfileId = 'other-snapshot-v1' },
]) {
  const changed = clone(context)
  mutate(changed)
  assert.notEqual(
    createEconomicEvidenceCommitmentV1(changed, evidenceProfile).commitment,
    commitment.commitment,
  )
}

const nodeDigest = `0x${createHash('sha256')
  .update(Buffer.from(`RFE_ECONOMIC_EVIDENCE_CONTEXT_V1\0${commitment.canonicalJson}`, 'utf8'))
  .digest('hex')}`
assert.equal(nodeDigest, commitment.commitment)

const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun })
const evm = await createEVM({ common })
const caller = createAddressFromString(`0x${'88'.repeat(20)}`)
const sha256Precompile = createAddressFromString(`0x${'00'.repeat(19)}02`)
const precompileResult = await evm.runCall({
  to: sha256Precompile,
  caller,
  origin: caller,
  data: new TextEncoder().encode(`RFE_ECONOMIC_EVIDENCE_CONTEXT_V1\0${commitment.canonicalJson}`),
  gasLimit: 30_000_000n,
  skipBalance: true,
  isStatic: true,
})
assert.equal(precompileResult.execResult.exceptionError, undefined)
assert.equal(bytesToHex(precompileResult.execResult.returnValue), commitment.commitment)

const association = createPlaybackDecisionEvidenceAssociationV1({
  decisionContextHash,
  economicEvidenceCommitment: commitment.commitment,
})
assert.deepEqual(normalizePlaybackDecisionEvidenceAssociationV1(association), association)
assert.equal(association.authority, 'NONCANONICAL_COMPANION')
const replacementAssociation = createPlaybackDecisionEvidenceAssociationV1({
  decisionContextHash,
  economicEvidenceCommitment: `0x${'99'.repeat(32)}`,
})
assert.equal(replacementAssociation.decisionContextHash, association.decisionContextHash)
assert.notEqual(replacementAssociation.economicEvidenceCommitment, association.economicEvidenceCommitment)
assert.throws(
  () => normalizePlaybackDecisionEvidenceAssociationV1({ ...association, authority: 'CANONICAL' }),
  /authority must be NONCANONICAL_COMPANION/,
)
assert.throws(
  () => normalizePlaybackDecisionEvidenceAssociationV1({ ...association, economicEvidenceCommitment: '0x12' }),
  /must be 32 bytes/,
)
const accessorAssociation = { ...association }
let associationGetterCalled = false
Object.defineProperty(accessorAssociation, 'decisionContextHash', {
  enumerable: true,
  get() {
    associationGetterCalled = true
    return decisionContextHash
  },
})
assert.throws(
  () => normalizePlaybackDecisionEvidenceAssociationV1(accessorAssociation),
  /enumerable data property/,
)
assert.equal(associationGetterCalled, false)
const accessorAssociationInput = {
  economicEvidenceCommitment: commitment.commitment,
}
let associationInputGetterCalled = false
Object.defineProperty(accessorAssociationInput, 'decisionContextHash', {
  enumerable: true,
  get() {
    associationInputGetterCalled = true
    return decisionContextHash
  },
})
assert.throws(
  () => createPlaybackDecisionEvidenceAssociationV1(accessorAssociationInput),
  /enumerable data property/,
)
assert.equal(associationInputGetterCalled, false)
assert.throws(
  () => createPlaybackDecisionEvidenceAssociationV1({
    decisionContextHash,
    economicEvidenceCommitment: commitment.commitment,
    canonical: true,
  }),
  /canonical is not supported/,
)

const legacyPrototype = parseEconomicEvidenceContextArtifact({
  protocol: 'rfe',
  schema: 'economic-evidence-context',
  version: 1,
  evidenceProfileId: profileId,
  evidenceProfileVersion: '1',
})
assert.equal(legacyPrototype.parseStatus, 'UNSUPPORTED_SCHEMA')
assert.equal(legacyPrototype.schema, 'economic-evidence-context')
assert.equal(legacyPrototype.evidenceProfileVersion, '1')

console.log('economics evidence commitment and playback association tests passed')
