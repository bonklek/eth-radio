import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  MAX_CAPABILITIES,
  MAX_CAPABILITY_TRANSITIONS,
  normalizeStationConstitutionV1,
} from '../packages/protocol/index.mjs'

const fixture = JSON.parse(fs.readFileSync(
  new URL('../test/fixtures/protocol/constitution-v1.json', import.meta.url),
  'utf8',
))

function copy(value = fixture) {
  return structuredClone(value)
}

function warningCodes(constitution) {
  return constitution.warnings.map((entry) => entry.code)
}

const normalized = normalizeStationConstitutionV1(fixture)
assert.equal(normalized.capabilities[0].currentController.kind, 'DAO')
assert.equal(normalized.capabilities[0].currentController.address, '0x2222222222222222222222222222222222222222')
assert.equal(normalized.capabilities[0].freezeStatus, 'TERMINAL_SCHEDULED')
assert.equal(normalized.capabilities[1].currentController.kind, 'ADDRESS')
assert.deepEqual(warningCodes(normalized), [
  'GWEI_BINDING_MUTABLE',
  'MODULE_REPLACEABLE',
  'MODULE_UNVERIFIED',
  'MODULE_REPLACEABLE',
  'FEE_POLICY_UNVERIFIED',
])
assert.equal(normalized.vault.balanceWei, '1000')
assert.equal(normalized.rules.standingFallbackEnabled, true)

for (const mutate of [
  (input) => { input.identity.stationId = `0x${'bb'.repeat(32)}` },
  (input) => { input.observation.chainId = '1' },
  (input) => { input.identity.stationCore = '0x8888888888888888888888888888888888888888' },
]) {
  const mismatchedIdentity = copy()
  mutate(mismatchedIdentity)
  assert.throws(
    () => normalizeStationConstitutionV1(mismatchedIdentity),
    /stationId does not match the observed chain and Station Core/,
  )
}

for (const [season, expectedKind, expectedFreeze] of [
  ['2', 'ADDRESS', 'TERMINAL_SCHEDULED'],
  ['3', 'DAO', 'TERMINAL_SCHEDULED'],
  ['6', 'DAO', 'TERMINAL_SCHEDULED'],
  ['7', 'NONE', 'TERMINALLY_FROZEN'],
  ['8', 'NONE', 'TERMINALLY_FROZEN'],
]) {
  const input = copy()
  input.currentSeason = season
  const result = normalizeStationConstitutionV1(input)
  assert.equal(result.capabilities[0].currentController.kind, expectedKind, `season ${season}`)
  assert.equal(result.capabilities[0].freezeStatus, expectedFreeze, `season ${season}`)
}

const locked = copy()
locked.identity.bindingStatus = 'LOCKED'
locked.identity.bindingController = null
assert.ok(!warningCodes(normalizeStationConstitutionV1(locked)).includes('GWEI_BINDING_MUTABLE'))

const unsafeVault = copy()
unsafeVault.vault.balanceWei = '100'
unsafeVault.vault.protectedReserveWei = '500'
unsafeVault.vault.totalLiabilitiesWei = '200'
unsafeVault.vault.generalWithdrawalPath = true
unsafeVault.vault.withdrawalController = '0x1111111111111111111111111111111111111111'
unsafeVault.revenue.comminglesProtectedFunding = true
assert.deepEqual(
  warningCodes(normalizeStationConstitutionV1(unsafeVault)).filter((code) => [
    'VAULT_INSOLVENT',
    'PROTECTED_RESERVE_UNFUNDED',
    'VAULT_GENERAL_WITHDRAWAL',
    'REVENUE_PROTECTED_FUNDS_COMMINGLED',
  ].includes(code)),
  [
    'VAULT_INSOLVENT',
    'PROTECTED_RESERVE_UNFUNDED',
    'VAULT_GENERAL_WITHDRAWAL',
    'REVENUE_PROTECTED_FUNDS_COMMINGLED',
  ],
  'nonconforming stations must normalize with critical warnings rather than appearing safe',
)

const duplicateModule = copy()
duplicateModule.modules.push(copy().modules[0])
assert.throws(() => normalizeStationConstitutionV1(duplicateModule), /duplicate module kinds/)
const duplicateCapability = copy()
duplicateCapability.capabilities.push(copy().capabilities[0])
assert.throws(() => normalizeStationConstitutionV1(duplicateCapability), /must not contain duplicates/)
const revived = copy()
revived.capabilities[0].transitions.push({
  fromSeason: '8',
  controller: { kind: 'ADDRESS', address: '0x1111111111111111111111111111111111111111' },
  terminal: false,
})
assert.throws(() => normalizeStationConstitutionV1(revived), /terminal transition cannot be followed/)
const unordered = copy()
unordered.capabilities[0].transitions[1].fromSeason = '0'
assert.throws(() => normalizeStationConstitutionV1(unordered), /strictly increasing/)
const terminalController = copy()
terminalController.capabilities[0].transitions[2].controller = {
  kind: 'ADDRESS',
  address: '0x1111111111111111111111111111111111111111',
}
assert.throws(() => normalizeStationConstitutionV1(terminalController), /terminal transition must use the NONE/)
const mutableWithoutCapability = copy()
mutableWithoutCapability.modules[0].controllerCapability = null
assert.throws(() => normalizeStationConstitutionV1(mutableWithoutCapability), /must identify its controller capability/)
const unknownCapability = copy()
unknownCapability.modules[0].controllerCapability = `0x${'bb'.repeat(32)}`
assert.throws(() => normalizeStationConstitutionV1(unknownCapability), /unknown controller capability/)
const missingFeeModule = copy()
missingFeeModule.rules.feePolicy.moduleAddress = '0x8888888888888888888888888888888888888888'
assert.throws(() => normalizeStationConstitutionV1(missingFeeModule), /absent from the module list/)
const wrongFeeVerification = copy()
wrongFeeVerification.rules.feePolicy.verification = 'VERIFIED'
assert.throws(() => normalizeStationConstitutionV1(wrongFeeVerification), /disagrees with the module record/)
const ensSubstitute = copy()
ensSubstitute.identity.gweiName = 'radiofree.eth'
assert.throws(() => normalizeStationConstitutionV1(ensSubstitute), /normalized \.gwei name/)
const verifiedWithoutName = copy()
verifiedWithoutName.identity.gweiName = null
assert.throws(() => normalizeStationConstitutionV1(verifiedWithoutName), /must identify a \.gwei name/)
const verifiedMissingBinding = copy()
verifiedMissingBinding.identity.bindingStatus = 'MISSING'
verifiedMissingBinding.identity.bindingController = null
assert.throws(() => normalizeStationConstitutionV1(verifiedMissingBinding), /cannot have a missing binding/)

const tooManyCapabilities = copy()
tooManyCapabilities.capabilities = Array.from({ length: MAX_CAPABILITIES + 1 }, (_, index) => ({
  capability: `0x${(index + 1).toString(16).padStart(64, '0')}`,
  label: `Capability ${index}`,
  transitions: [{
    fromSeason: '0',
    controller: { kind: 'PUBLIC', address: null },
    terminal: false,
  }],
}))
assert.throws(() => normalizeStationConstitutionV1(tooManyCapabilities), /at most 32/)
const tooManyTransitions = copy()
tooManyTransitions.capabilities[0].transitions = Array.from({ length: MAX_CAPABILITY_TRANSITIONS + 1 }, (_, index) => ({
  fromSeason: String(index),
  controller: { kind: 'PUBLIC', address: null },
  terminal: false,
}))
assert.throws(() => normalizeStationConstitutionV1(tooManyTransitions), /at most 16/)

let randomState = 0x9e3779b9
function random(maximum) {
  randomState ^= randomState << 13
  randomState ^= randomState >>> 17
  randomState ^= randomState << 5
  return (randomState >>> 0) % maximum
}

for (let index = 0; index < 10_000; index += 1) {
  const firstBoundary = random(20) + 1
  const terminalBoundary = firstBoundary + random(20) + 1
  const season = random(terminalBoundary + 5)
  const input = copy()
  input.currentSeason = String(season)
  input.capabilities[0].transitions = [
    {
      fromSeason: '0',
      controller: { kind: 'ADDRESS', address: '0x1111111111111111111111111111111111111111' },
      terminal: false,
    },
    {
      fromSeason: String(firstBoundary),
      controller: { kind: 'DAO', address: '0x2222222222222222222222222222222222222222' },
      terminal: false,
    },
    {
      fromSeason: String(terminalBoundary),
      controller: { kind: 'NONE', address: null },
      terminal: true,
    },
  ]
  const result = normalizeStationConstitutionV1(input)
  const capability = result.capabilities[0]
  const expectedKind = season >= terminalBoundary ? 'NONE' : season >= firstBoundary ? 'DAO' : 'ADDRESS'
  assert.equal(capability.currentController.kind, expectedKind)
  assert.equal(capability.freezeStatus, season >= terminalBoundary ? 'TERMINALLY_FROZEN' : 'TERMINAL_SCHEDULED')
  assert.notEqual(result.capabilities[0].capability, result.capabilities[1].capability)
}

console.log('constitution identity, capability, module, vault, warning, and property tests ok')
