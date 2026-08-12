



import assert from 'node:assert/strict'
import {
  createEconomicEvidenceContextV1,
  normalizeEconomicEvidenceContextV1,
  normalizeEconomicEvidenceProfileV1,
  parseEconomicEvidenceContextArtifact,
  requireCoherentEconomicEvidenceV1,
} from '../packages/economics/index.mjs'

const blockHash = `0x${'11'.repeat(32)}`
const otherHash = `0x${'22'.repeat(32)}`
const valueDigest = `0x${'33'.repeat(32)}`
const sourceCommitment = `0x${'44'.repeat(32)}`
const profileId = `0x${'55'.repeat(32)}`
const canonicalSnapshotRef = {
  chainId: '1',
  blockNumber: '123',
  blockHash,
  snapshotProfileId: 'execution-snapshot-v1',
}
const contextFields = {
  canonicalSnapshotRef,
  finalityProfileId: 'finality-observation-v1',
  finalityStateCode: 'UNVERIFIED',
  observationSourceSetHash: `0x${'aa'.repeat(32)}`,
  observationMetadata: { observedAtUnixMs: '1783759000000' },
}

function profile(overrides = {}) {
  return {
    protocol: 'rfe',
    schema: 'economic-evidence-profile',
    version: 1,
    authority: 'ADVISORY_REQUIREMENT_PROFILE',
    profileId,
    profileVersion: '1',
    requiredInputIds: ['FEE', 'LEDGER'],
    optionalInputIds: ['OPTIONAL_POLICY'],
    inputDefinitions: [
      {
        id: 'FEE',
        valueTypeProfileId: 'wei-v1',
        sourceBindingKind: 'CANONICAL_SNAPSHOT',
        sourceBindingProfileId: 'execution-header-v1',
      },
      {
        id: 'LEDGER',
        valueTypeProfileId: 'ledger-hash-v1',
        sourceBindingKind: 'CANONICAL_SNAPSHOT',
        sourceBindingProfileId: 'station-view-v1',
      },
      {
        id: 'OPTIONAL_POLICY',
        valueTypeProfileId: 'policy-hash-v1',
        sourceBindingKind: 'OBSERVATION_SOURCE',
        sourceBindingProfileId: 'local-policy-cache-v1',
      },
    ],
    ...overrides,
  }
}

const evidenceProfile = normalizeEconomicEvidenceProfileV1(profile())

function presentSnapshot(id, valueTypeProfileId, bindingProfileId, overrides = {}) {
  return {
    id,
    presence: 'PRESENT',
    valueTypeProfileId,
    value: valueDigest,
    sourceBinding: {
      kind: 'CANONICAL_SNAPSHOT',
      profileId: bindingProfileId,
      chainId: '1',
      blockNumber: '123',
      blockHash,
    },
    ...overrides,
  }
}

function presentObservation(overrides = {}) {
  return {
    id: 'OPTIONAL_POLICY',
    presence: 'PRESENT',
    valueTypeProfileId: 'policy-hash-v1',
    value: valueDigest,
    sourceBinding: {
      kind: 'OBSERVATION_SOURCE',
      profileId: 'local-policy-cache-v1',
      sourceCommitment,
    },
    ...overrides,
  }
}

function missing(id) {
  return {
    id,
    presence: 'MISSING',
    reasonProfileId: 'evidence-missing-reason-v1',
    reasonCode: 'NOT_OBSERVED',
  }
}

const fee = () => presentSnapshot('FEE', 'wei-v1', 'execution-header-v1')
const ledger = (overrides = {}) => presentSnapshot('LEDGER', 'ledger-hash-v1', 'station-view-v1', overrides)

const coherent = createEconomicEvidenceContextV1({
  ...contextFields,
  entries: [fee(), ledger({ value: `0x${'00'.repeat(32)}` }), missing('OPTIONAL_POLICY')],
}, evidenceProfile)
assert.equal(coherent.status, 'COHERENT')
assert.equal(coherent.structureStatus, 'VALID')
assert.equal(coherent.completenessStatus, 'COMPLETE')
assert.deepEqual(coherent.requiredInputIds, ['FEE', 'LEDGER'])
assert.deepEqual(coherent.missingRequiredEvidenceIds, [])
assert.deepEqual(coherent.missingOptionalEvidenceIds, ['OPTIONAL_POLICY'])
assert.deepEqual(requireCoherentEconomicEvidenceV1(coherent, evidenceProfile), coherent)
assert.equal(coherent.parseStatus, 'SUPPORTED')
assert.deepEqual(coherent.profileAssessments, [{
  profileId,
  stateCode: 'SUPPORTED',
  reasonCodes: [],
}])

const accessorCreateInput = {
  ...contextFields,
  entries: [fee(), ledger(), missing('OPTIONAL_POLICY')],
}
let createInputGetterCalled = false
Object.defineProperty(accessorCreateInput, 'canonicalSnapshotRef', {
  enumerable: true,
  get() {
    createInputGetterCalled = true
    return canonicalSnapshotRef
  },
})
assert.throws(
  () => createEconomicEvidenceContextV1(accessorCreateInput, evidenceProfile),
  /enumerable data property/,
)
assert.equal(createInputGetterCalled, false)
const oversizedEvidenceValue = Array.from({ length: 64 }, () => 'x'.repeat(16_384))
assert.throws(
  () => createEconomicEvidenceContextV1({
    ...contextFields,
    entries: [fee(), ledger({ value: oversizedEvidenceValue }), missing('OPTIONAL_POLICY')],
  }, evidenceProfile),
  /maximum canonical byte length/,
)
assert.throws(
  () => createEconomicEvidenceContextV1({
    ...contextFields,
    evidenceProfileId: 'different-profile',
    entries: [fee(), ledger(), missing('OPTIONAL_POLICY')],
  }, evidenceProfile),
  /profile ID does not match/,
)
assert.throws(
  () => createEconomicEvidenceContextV1({
    ...contextFields,
    profileAssessments: undefined,
    entries: [fee(), ledger(), missing('OPTIONAL_POLICY')],
  }, evidenceProfile),
  /must not be undefined when present/,
)

const incomplete = createEconomicEvidenceContextV1({
  ...contextFields,
  entries: [fee(), missing('LEDGER'), presentObservation()],
}, evidenceProfile)
assert.equal(incomplete.status, 'INCOMPLETE')
assert.equal(incomplete.structureStatus, 'VALID')
assert.equal(incomplete.completenessStatus, 'INCOMPLETE')
assert.deepEqual(incomplete.missingRequiredEvidenceIds, ['LEDGER'])
assert.throws(() => requireCoherentEconomicEvidenceV1(incomplete, evidenceProfile), /incomplete/)

const incoherent = createEconomicEvidenceContextV1({
  ...contextFields,
  entries: [fee(), ledger({
    sourceBinding: {
      kind: 'CANONICAL_SNAPSHOT',
      profileId: 'station-view-v1',
      chainId: '1',
      blockNumber: '123',
      blockHash: otherHash,
    },
  }), missing('OPTIONAL_POLICY')],
}, evidenceProfile)
assert.equal(incoherent.status, 'INCOHERENT')
assert.equal(incoherent.structureStatus, 'INCOHERENT')
assert.equal(incoherent.completenessStatus, 'COMPLETE')
assert.deepEqual(incoherent.conflictingEvidenceIds, ['LEDGER'])
assert.throws(() => requireCoherentEconomicEvidenceV1(incoherent, evidenceProfile), /incoherent/)

assert.throws(
  () => normalizeEconomicEvidenceContextV1({ ...coherent, status: 'INCOMPLETE' }, evidenceProfile),
  /must be COHERENT/,
)
assert.throws(
  () => normalizeEconomicEvidenceContextV1({ ...coherent, parseStatus: 'UNSUPPORTED_SCHEMA' }, evidenceProfile),
  /parseStatus must be SUPPORTED/,
)
assert.throws(
  () => createEconomicEvidenceContextV1({ ...contextFields, entries: [fee(), fee(), missing('OPTIONAL_POLICY')] }, evidenceProfile),
  /registered profile position/,
)
for (const forbidden of ['value', 'valueHash', 'valueTypeProfileId', 'source', 'sourceBinding']) {
  assert.throws(
    () => createEconomicEvidenceContextV1({
      ...contextFields,
      entries: [fee(), { ...missing('LEDGER'), [forbidden]: undefined }, missing('OPTIONAL_POLICY')],
    }, evidenceProfile),
    new RegExp(`${forbidden} is not supported`),
  )
}
for (const hiddenValue of [undefined, null]) {
  const hiddenMissing = missing('LEDGER')
  Object.defineProperty(hiddenMissing, 'valueHash', {
    value: hiddenValue,
    enumerable: false,
  })
  assert.equal(Object.hasOwn(hiddenMissing, 'valueHash'), true)
  assert.throws(
    () => createEconomicEvidenceContextV1({
      ...contextFields,
      entries: [fee(), hiddenMissing, missing('OPTIONAL_POLICY')],
    }, evidenceProfile),
    /valueHash is not supported/,
  )
}
const symbolMissing = missing('LEDGER')
symbolMissing[Symbol('valueHash')] = undefined
assert.throws(
  () => createEconomicEvidenceContextV1({
    ...contextFields,
    entries: [fee(), symbolMissing, missing('OPTIONAL_POLICY')],
  }, evidenceProfile),
  /must not contain symbol keys/,
)

const accessorProfile = { ...evidenceProfile }
let profileGetterCalled = false
Object.defineProperty(accessorProfile, 'profileId', {
  enumerable: true,
  get() {
    profileGetterCalled = true
    return evidenceProfile.profileId
  },
})
assert.throws(
  () => createEconomicEvidenceContextV1({ ...contextFields, entries: [fee(), ledger(), missing('OPTIONAL_POLICY')] }, accessorProfile),
  /enumerable data property/,
)
assert.equal(profileGetterCalled, false)
const inheritedMissing = Object.create(missing('LEDGER'))
assert.throws(
  () => createEconomicEvidenceContextV1({
    ...contextFields,
    entries: [fee(), inheritedMissing, missing('OPTIONAL_POLICY')],
  }, evidenceProfile),
  /must be an own property/,
)
const sparseEntries = [fee(), ledger(), missing('OPTIONAL_POLICY')]
delete sparseEntries[1]
assert.throws(
  () => createEconomicEvidenceContextV1({ ...contextFields, entries: sparseEntries }, evidenceProfile),
  /must not contain sparse entries/,
)
const accessorEntries = [fee(), ledger(), missing('OPTIONAL_POLICY')]
let entryGetterCalled = false
Object.defineProperty(accessorEntries, '1', {
  enumerable: true,
  get() {
    entryGetterCalled = true
    return ledger()
  },
})
assert.throws(
  () => createEconomicEvidenceContextV1({ ...contextFields, entries: accessorEntries }, evidenceProfile),
  /enumerable data property/,
)
assert.equal(entryGetterCalled, false)
const decoratedEntries = [fee(), ledger(), missing('OPTIONAL_POLICY')]
Object.defineProperty(decoratedEntries, 'hiddenValue', { value: undefined })
assert.throws(
  () => createEconomicEvidenceContextV1({ ...contextFields, entries: decoratedEntries }, evidenceProfile),
  /must not contain non-index own properties/,
)
assert.throws(
  () => createEconomicEvidenceContextV1({
    ...contextFields,
    entries: [fee(), { ...missing('LEDGER'), valueHash: null }, missing('OPTIONAL_POLICY')],
  }, evidenceProfile),
  /valueHash is not supported/,
)
assert.throws(
  () => normalizeEconomicEvidenceProfileV1(profile({ optionalInputIds: ['LEDGER'] })),
  /unique across required and optional/,
)
assert.throws(
  () => normalizeEconomicEvidenceProfileV1(profile({ inputDefinitions: profile().inputDefinitions.slice(0, 2) })),
  /required then optional registries/,
)
assert.throws(
  () => normalizeEconomicEvidenceProfileV1(profile({ requiredInputIds: ['LEDGER', 'FEE'] })),
  /strictly ascending by raw ASCII bytes/,
)
assert.throws(
  () => normalizeEconomicEvidenceProfileV1(profile({ optionalInputIds: ['Z', 'A'] })),
  /strictly ascending by raw ASCII bytes/,
)
assert.throws(
  () => normalizeEconomicEvidenceProfileV1(profile({ requiredInputIds: ['fee', 'LEDGER'] })),
  /must match/,
)
const interleavedProfile = normalizeEconomicEvidenceProfileV1(profile({
  profileId: `0x${'77'.repeat(32)}`,
  requiredInputIds: ['B'],
  optionalInputIds: ['A'],
  inputDefinitions: [
    {
      id: 'B',
      valueTypeProfileId: 'value-v1',
      sourceBindingKind: 'CANONICAL_SNAPSHOT',
      sourceBindingProfileId: 'chain-v1',
    },
    {
      id: 'A',
      valueTypeProfileId: 'value-v1',
      sourceBindingKind: 'CANONICAL_SNAPSHOT',
      sourceBindingProfileId: 'chain-v1',
    },
  ],
}))
const interleavedEntry = (id) => presentSnapshot(id, 'value-v1', 'chain-v1')
assert.equal(
  createEconomicEvidenceContextV1({
    ...contextFields,
    entries: [interleavedEntry('B'), interleavedEntry('A')],
  }, interleavedProfile).status,
  'COHERENT',
)
assert.throws(
  () => createEconomicEvidenceContextV1({
    ...contextFields,
    entries: [interleavedEntry('A'), interleavedEntry('B')],
  }, interleavedProfile),
  /registered profile position/,
)
assert.throws(
  () => createEconomicEvidenceContextV1({
    ...contextFields,
    entries: [interleavedEntry('B')],
  }, interleavedProfile),
  /exactly one entry per registered input/,
)
assert.throws(
  () => createEconomicEvidenceContextV1({
    ...contextFields,
    entries: [interleavedEntry('B'), interleavedEntry('A'), interleavedEntry('A')],
  }, interleavedProfile),
  /more entries than its input registries/,
)
assert.throws(
  () => normalizeEconomicEvidenceContextV1(coherent, {
    ...evidenceProfile,
    profileVersion: '2',
  }),
  /profile identity does not match/,
)
assert.throws(
  () => createEconomicEvidenceContextV1({ ...contextFields, entries: [fee(), ledger(), presentObservation({
    sourceBinding: {
      kind: 'OBSERVATION_SOURCE',
      profileId: 'wrong-source-profile',
      sourceCommitment,
    },
  })] }, evidenceProfile),
  /does not match the evidence profile/,
)
assert.throws(
  () => createEconomicEvidenceContextV1({ ...contextFields, entries: [fee(), ledger(), missing('OPTIONAL_POLICY')], unknown: true }, evidenceProfile),
  /unknown is not supported/,
)

const unknownProfileId = 'FUTURE_PROFILE_V7'
const unknownAssessmentId = 'FUTURE_ASSESSMENT_V9'
const unknownProfileContext = createEconomicEvidenceContextV1({
  evidenceProfileId: unknownProfileId,
  evidenceProfileVersion: '7',
  requiredInputIds: ['FEE'],
  optionalInputIds: ['FUTURE_INPUT'],
  ...contextFields,
  entries: [fee(), missing('FUTURE_INPUT')],
  profileAssessments: [{
    profileId: unknownAssessmentId,
    stateCode: 'FUTURE_STATE_7',
    reasonCodes: ['FUTURE_REASON_3'],
  }],
})
assert.equal(unknownProfileContext.parseStatus, 'SUPPORTED')
assert.equal(unknownProfileContext.status, 'COHERENT')
assert.deepEqual(unknownProfileContext.profileAssessments, [
  {
    profileId: unknownProfileId,
    stateCode: 'UNSUPPORTED',
    reasonCodes: ['UNKNOWN_EVIDENCE_PROFILE'],
  },
  {
    profileId: unknownAssessmentId,
    stateCode: 'FUTURE_STATE_7',
    reasonCodes: ['FUTURE_REASON_3'],
  },
])
assert.deepEqual(
  normalizeEconomicEvidenceContextV1(unknownProfileContext),
  unknownProfileContext,
)
assert.throws(
  () => requireCoherentEconomicEvidenceV1(unknownProfileContext),
  /profile is unsupported/,
)
assert.throws(
  () => createEconomicEvidenceContextV1({
    evidenceProfileId: unknownProfileId,
    evidenceProfileVersion: '7',
    requiredInputIds: ['FEE'],
    optionalInputIds: [],
    ...contextFields,
    entries: [fee()],
    profileAssessments: [{
      profileId: unknownProfileId,
      stateCode: 'FUTURE_STATE',
      reasonCodes: [],
    }],
  }),
  /must not repeat the evidence profile/,
)
assert.throws(
  () => createEconomicEvidenceContextV1({
    evidenceProfileId: unknownProfileId,
    evidenceProfileVersion: '7',
    requiredInputIds: ['FEE'],
    optionalInputIds: [],
    ...contextFields,
    entries: [fee()],
    profileAssessments: [{
      profileId: unknownAssessmentId,
      stateCode: 'X'.repeat(129),
      reasonCodes: [],
    }],
  }),
  /at most 128 UTF-8 bytes/,
)

const unsupportedSchema = parseEconomicEvidenceContextArtifact({
  protocol: 'rfe',
  schema: 'rfe/economic-evidence-context@1',
  version: 2,
  evidenceProfileId: unknownProfileId,
  evidenceProfileVersion: '9',
  profileAssessments: [{
    profileId: unknownAssessmentId,
    stateCode: 'FUTURE_STATE_8',
    reasonCodes: ['FUTURE_REASON_4'],
  }],
  unknownNormativePayload: { ignoredButNotInterpreted: true },
})
assert.deepEqual(unsupportedSchema, {
  parseStatus: 'UNSUPPORTED_SCHEMA',
  protocol: 'rfe',
  schema: 'rfe/economic-evidence-context@1',
  version: 2,
  evidenceProfileId: unknownProfileId,
  evidenceProfileVersion: '9',
  profileAssessments: [{
    profileId: unknownAssessmentId,
    stateCode: 'FUTURE_STATE_8',
    reasonCodes: ['FUTURE_REASON_4'],
  }],
})
assert.equal(Object.hasOwn(unsupportedSchema, 'evidenceProfileVersion'), true)
const unsupportedAccessor = {
  protocol: 'rfe',
  version: 2,
}
let unsupportedGetterCalled = false
Object.defineProperty(unsupportedAccessor, 'schema', {
  enumerable: true,
  get() {
    unsupportedGetterCalled = true
    return 'future-economic-evidence'
  },
})
assert.throws(
  () => parseEconomicEvidenceContextArtifact(unsupportedAccessor),
  /enumerable data property/,
)
assert.equal(unsupportedGetterCalled, false)
const unsupportedProfileAccessor = {
  protocol: 'rfe',
  schema: 'future-economic-evidence',
  version: 2,
  evidenceProfileVersion: '1',
}
Object.defineProperty(unsupportedProfileAccessor, 'evidenceProfileId', {
  enumerable: true,
  get() {
    unsupportedGetterCalled = true
    return unknownProfileId
  },
})
assert.throws(
  () => parseEconomicEvidenceContextArtifact(unsupportedProfileAccessor),
  /enumerable data property/,
)
assert.equal(unsupportedGetterCalled, false)
assert.throws(
  () => parseEconomicEvidenceContextArtifact({
    protocol: 'rfe',
    schema: 'future-economic-evidence',
    version: 2,
    profileAssessments: undefined,
  }),
  /must not be undefined when present/,
)
assert.throws(
  () => parseEconomicEvidenceContextArtifact({
    protocol: 'rfe',
    schema: 'future-economic-evidence',
    version: 7,
    evidenceProfileId: unknownProfileId,
  }),
  /must include both ID and version/,
)
assert.throws(
  () => parseEconomicEvidenceContextArtifact({
    protocol: 'rfe',
    schema: 'future-economic-evidence',
    version: 7,
    evidenceProfileVersion: '9',
  }),
  /must include both ID and version/,
)
assert.throws(
  () => parseEconomicEvidenceContextArtifact({
    protocol: 'rfe',
    schema: 'future-economic-evidence',
    version: 7,
    evidenceProfileId: unknownProfileId,
    evidenceProfileVersion: '4294967296',
  }),
  /must be at most 4294967295/,
)

const generatedDefinitions = Array.from({ length: 10 }, (_, index) => ({
  id: `EVIDENCE_${index}`,
  valueTypeProfileId: 'generated-value-v1',
  sourceBindingKind: 'CANONICAL_SNAPSHOT',
  sourceBindingProfileId: 'generated-chain-v1',
}))
const generatedRequired = generatedDefinitions.filter((_, index) => index % 2 === 0)
const generatedOptional = generatedDefinitions.filter((_, index) => index % 2 !== 0)
const generatedCanonicalDefinitions = [...generatedRequired, ...generatedOptional]
const generatedProfile = normalizeEconomicEvidenceProfileV1(profile({
  profileId: `0x${'66'.repeat(32)}`,
  requiredInputIds: generatedRequired.map((entry) => entry.id),
  optionalInputIds: generatedOptional.map((entry) => entry.id),
  inputDefinitions: generatedCanonicalDefinitions,
}))
for (let mask = 0; mask < 1_024; mask += 1) {
  const entries = generatedCanonicalDefinitions.map((definition, index) => {
    if ((mask & (1 << index)) !== 0) return missing(definition.id)
    return presentSnapshot(
      definition.id,
      definition.valueTypeProfileId,
      definition.sourceBindingProfileId,
      index === 9 && (mask & 1) !== 0
        ? { sourceBinding: {
          kind: 'CANONICAL_SNAPSHOT',
          profileId: definition.sourceBindingProfileId,
          chainId: '1',
          blockNumber: '123',
          blockHash: otherHash,
        } }
        : {},
    )
  })
  const context = createEconomicEvidenceContextV1({ ...contextFields, entries }, generatedProfile)
  const shouldConflict = entries.some((entry) => entry.presence === 'PRESENT'
    && entry.sourceBinding.blockHash !== blockHash)
  const requiredIds = new Set(generatedProfile.requiredInputIds)
  const shouldBeIncomplete = entries.some((entry) => entry.presence === 'MISSING' && requiredIds.has(entry.id))
  assert.equal(context.status, shouldConflict ? 'INCOHERENT' : shouldBeIncomplete ? 'INCOMPLETE' : 'COHERENT')
}

console.log('economics evidence-context tests passed')
