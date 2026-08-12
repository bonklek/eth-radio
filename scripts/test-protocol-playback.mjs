import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Common, Hardfork, Mainnet } from '@ethereumjs/common'
import { createEVM } from '@ethereumjs/evm'
import { createAddressFromString } from '@ethereumjs/util'
import {
  bytesToHex,
  decodeFunctionResult,
  encodeFunctionData,
  hexToBytes,
} from 'viem'
import solc from 'solc'
import {
  deterministicFallbackIndex,
  FAILURE_CLASSES,
  MAX_CATALOG_ASSETS,
  normalizePlaybackDecisionV1,
  resolvePlaybackDecision,
} from '../packages/protocol/index.mjs'

const fixture = JSON.parse(fs.readFileSync(
  new URL('../test/fixtures/protocol/fallback-v1.json', import.meta.url),
  'utf8',
))
assert.equal(deterministicFallbackIndex(fixture), fixture.expectedIndex)
assert.equal(FAILURE_CLASSES.indexOf(fixture.failureClass), fixture.failureClassCode)

function compileHarness() {
  const sources = {}
  for (const path of [
    'contracts/v2/libraries/FallbackSelection.sol',
    'contracts/test/FallbackSelectionHarness.sol',
  ]) {
    sources[path] = { content: fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') }
  }
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  })))
  const fatal = (output.errors || []).filter((error) => error.severity === 'error')
  assert.deepEqual(fatal, [], fatal.map((error) => error.formattedMessage || error.message).join('\n'))
  const contract = output.contracts['contracts/test/FallbackSelectionHarness.sol'].FallbackSelectionHarness
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }
}

const harness = compileHarness()
const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun })
const evm = await createEVM({ common })
const caller = createAddressFromString(`0x${'99'.repeat(20)}`)
const deployment = await evm.runCall({
  caller,
  origin: caller,
  data: hexToBytes(harness.bytecode),
  gasLimit: 10_000_000n,
  skipBalance: true,
})
assert.equal(deployment.execResult.exceptionError, undefined)
assert.ok(deployment.createdAddress)

async function soliditySelectionIndex(vector) {
  const selectionCall = await evm.runCall({
    to: deployment.createdAddress,
    caller,
    origin: caller,
    data: hexToBytes(encodeFunctionData({
      abi: harness.abi,
      functionName: 'selectionIndex',
      args: [
        vector.stationId,
        BigInt(vector.seasonNumber),
        Number(vector.lotIndex),
        FAILURE_CLASSES.indexOf(vector.failureClass),
        vector.fallbackSeed,
        Number(vector.candidateCount),
      ],
    })),
    gasLimit: 1_000_000n,
    skipBalance: true,
    isStatic: true,
  })
  assert.equal(selectionCall.execResult.exceptionError, undefined)
  return decodeFunctionResult({
    abi: harness.abi,
    functionName: 'selectionIndex',
    data: bytesToHex(selectionCall.execResult.returnValue),
  })
}

assert.equal(await soliditySelectionIndex(fixture), fixture.expectedIndex)

const hash = (marker) => `0x${marker.repeat(64)}`
const assets = ['a', 'b', 'c', 'd', 'e'].map(hash)
const programs = ['1', '2', '3'].map(hash)
const catalogRoot = hash('f')
const slateHash = hash('9')

function baseInput(overrides = {}) {
  return {
    stationId: fixture.stationId,
    decisionBlock: '12345678',
    seasonNumber: fixture.seasonNumber,
    lotIndex: fixture.lotIndex,
    failureClass: fixture.failureClass,
    fallbackSeed: fixture.fallbackSeed,
    policyVersion: 1,
    availabilityResults: {},
    baseCatalog: {
      catalogRoot,
      candidates: assets.map((assetId) => ({ assetId })),
    },
    proceduralSlate: { slateHash },
    ...overrides,
  }
}

const scheduledReplay = resolvePlaybackDecision(baseInput({
  failureClass: null,
  primary: { assetId: assets[0], programId: programs[0], provenance: 'SCHEDULED_REPLAY' },
  availabilityResults: { [assets[0]]: 'AVAILABLE' },
}))
assert.equal(scheduledReplay.decision.provenance, 'SCHEDULED_REPLAY')
assert.equal(scheduledReplay.decision.failureClass, null)
assert.equal(scheduledReplay.decision.programId, programs[0])
assert.deepEqual(scheduledReplay.availabilityAttempts, [
  { lane: 'PRIMARY', assetId: assets[0], status: 'AVAILABLE' },
])

const reservationFallback = resolvePlaybackDecision(baseInput({
  failureClass: 'LIVE_START_MISSED',
  primary: { assetId: assets[0], programId: programs[0], provenance: 'LIVE_PRIMARY' },
  reservationFallback: { assetId: assets[1], programId: programs[1] },
  availabilityResults: {
    [assets[0]]: 'UNAVAILABLE',
    [assets[1]]: 'AVAILABLE',
  },
}))
assert.equal(reservationFallback.decision.provenance, 'RESERVATION_FALLBACK')
assert.equal(reservationFallback.decision.failureClass, 'LIVE_START_MISSED')

const orderedAvailabilityA = {
  [assets[4]]: 'UNAVAILABLE',
  [assets[0]]: 'AVAILABLE',
  [assets[1]]: 'INVALID',
}
const orderedAvailabilityB = {
  [assets[1]]: 'INVALID',
  [assets[0]]: 'AVAILABLE',
  [assets[4]]: 'UNAVAILABLE',
}
const standingA = resolvePlaybackDecision(baseInput({ availabilityResults: orderedAvailabilityA }))
const standingB = resolvePlaybackDecision(baseInput({ availabilityResults: orderedAvailabilityB }))
assert.deepEqual(standingA, standingB, 'provider-result object order must not affect playback')
assert.equal(standingA.decision.provenance, 'STANDING_STATION_FALLBACK')
assert.equal(standingA.decision.assetId, assets[0])
assert.equal(standingA.decision.selectionIndex, '0')
assert.equal(standingA.decision.catalogRoot, catalogRoot)
assert.deepEqual(standingA.availabilityAttempts, [
  { lane: 'BASE_CATALOG', assetId: assets[4], status: 'UNAVAILABLE' },
  { lane: 'BASE_CATALOG', assetId: assets[0], status: 'AVAILABLE' },
])

const archiveBeforeBase = resolvePlaybackDecision(baseInput({
  availabilityResults: { [assets[2]]: 'AVAILABLE', [assets[4]]: 'AVAILABLE' },
  seasonArchive: { catalogRoot: hash('8'), candidates: [{ assetId: assets[2] }] },
}))
assert.equal(archiveBeforeBase.decision.assetId, assets[2])
assert.equal(archiveBeforeBase.availabilityAttempts[0].lane, 'SEASON_ARCHIVE')

const slate = resolvePlaybackDecision(baseInput({
  availabilityResults: Object.fromEntries(assets.map((assetId) => [assetId, 'UNAVAILABLE'])),
}))
assert.equal(slate.decision.provenance, 'PROCEDURAL_SLATE')
assert.equal(slate.decision.assetId, null)
assert.equal(slate.decision.slateHash, slateHash)
assert.equal(slate.availabilityAttempts.length, assets.length)

const maximumCandidates = Array.from({ length: MAX_CATALOG_ASSETS }, (_, index) => ({
  assetId: `0x${(index + 1).toString(16).padStart(64, '0')}`,
}))
const maximumBounded = resolvePlaybackDecision(baseInput({
  failureClass: 'SEGMENT_MISSING',
  baseCatalog: { catalogRoot, candidates: maximumCandidates },
  seasonArchive: { catalogRoot: hash('7'), candidates: maximumCandidates },
  previousCatalog: { catalogRoot: hash('6'), candidates: maximumCandidates },
  primary: { assetId: assets[0], programId: programs[0], provenance: 'LIVE_PRIMARY' },
  reservationFallback: { assetId: assets[1] },
  availabilityResults: {},
}))
assert.equal(maximumBounded.decision.provenance, 'PROCEDURAL_SLATE')
assert.equal(maximumBounded.availabilityAttempts.length, 194)

assert.throws(() => resolvePlaybackDecision(baseInput({
  baseCatalog: { catalogRoot, candidates: Array(MAX_CATALOG_ASSETS + 1).fill({ assetId: assets[0] }) },
})), /at most 64/)
assert.throws(() => resolvePlaybackDecision(baseInput({
  baseCatalog: { catalogRoot, candidates: [{ assetId: assets[0] }, { assetId: assets[0] }] },
})), /distinct asset IDs/)
assert.throws(() => resolvePlaybackDecision(baseInput({
  reservationFallback: { assetId: assets[0], fallbackRef: assets[1] },
})), /must be concrete assets/)
assert.throws(() => resolvePlaybackDecision(baseInput({
  baseCatalog: { catalogRoot, candidates: [{ assetId: assets[0], fallbackRef: assets[1] }] },
})), /must be concrete assets/)
assert.throws(() => resolvePlaybackDecision(baseInput({
  reservationFallback: { assetId: assets[0], weight: 2 },
})), /Fallback V1 candidates are unweighted/)
assert.throws(() => resolvePlaybackDecision(baseInput({
  baseCatalog: { catalogRoot, candidates: [{ assetId: assets[0], weight: 2 }] },
})), /Fallback V1 candidates are unweighted/)
assert.throws(() => resolvePlaybackDecision(baseInput({
  availabilityResults: { [assets[4]]: 'MAYBE' },
})), /Unsupported availability result/)
assert.throws(() => deterministicFallbackIndex({ ...fixture, candidateCount: '0' }), /greater than zero/)
assert.throws(() => deterministicFallbackIndex({ ...fixture, candidateCount: '65' }), /at most 64/)
assert.throws(() => normalizePlaybackDecisionV1({ ...slate.decision, assetId: assets[0] }), /inconsistent/)
assert.throws(() => normalizePlaybackDecisionV1({ ...standingA.decision, catalogRoot: null }), /catalog fields are inconsistent/)
assert.throws(() => resolvePlaybackDecision(baseInput({
  primary: { assetId: assets[0], provenance: 'LIVE_PRIMARY' },
  availabilityResults: { [assets[0]]: 'AVAILABLE' },
})), /must identify a program/)
assert.throws(() => resolvePlaybackDecision(baseInput({
  baseCatalog: { catalogRoot, candidates: [{ assetId: `0x${'00'.repeat(32)}` }] },
})), /must not be zero/)

let randomState = 0xc8013ea4
function random(maximum) {
  randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0
  return randomState % maximum
}
for (let index = 0; index < 10_000; index += 1) {
  const candidateCount = random(MAX_CATALOG_ASSETS) + 1
  const vector = {
    stationId: `0x${randomState.toString(16).padStart(64, '0')}`,
    seasonNumber: String(random(1_000_000)),
    lotIndex: String(random(4096)),
    failureClass: FAILURE_CLASSES[random(FAILURE_CLASSES.length)],
    fallbackSeed: `0x${((randomState ^ 0xffffffff) >>> 0).toString(16).padStart(64, '0')}`,
    candidateCount: String(candidateCount),
  }
  const first = deterministicFallbackIndex(vector)
  assert.ok(first >= 0 && first < candidateCount)
  assert.equal(deterministicFallbackIndex(vector), first)
  if (index < 2_048) assert.equal(await soliditySelectionIndex(vector), first)
}

console.log('fallback selection, playback provenance, termination, and property tests ok')
