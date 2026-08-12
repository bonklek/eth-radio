import {
  MAX_CAPABILITIES,
  MAX_CAPABILITY_TRANSITIONS,
  MAX_STATION_MODULES,
  PROTOCOL_NAME,
  UINT64_MAX,
  UINT256_MAX,
} from './constants.mjs'
import {
  address,
  boundedList,
  boundedText,
  bytes4,
  bytes32,
  decimalString,
  record,
} from './scalars.mjs'
import { stationId as deriveStationId } from './ids.mjs'

export const CONSTITUTION_SCHEMA = 'station-constitution'
export const CONSTITUTION_VERSION = 1
export const STATION_PROTOCOL_VERSION = 2

export const GWEI_RESOLUTION_STATUSES = Object.freeze([
  'VERIFIED',
  'UNVERIFIED',
  'MISMATCH',
  'UNAVAILABLE',
  'MOCK',
])

export const BINDING_STATUSES = Object.freeze([
  'MISSING',
  'MUTABLE',
  'TIMELOCKED',
  'DAO',
  'LOCKED',
])

export const MODULE_VERIFICATION_STATUSES = Object.freeze([
  'VERIFIED',
  'UNKNOWN',
  'INVALID',
])

export const CONTROLLER_KINDS = Object.freeze([
  'ADDRESS',
  'DAO',
  'TIMELOCK',
  'PUBLIC',
  'RESERVATION_HOLDER',
  'NONE',
])

const ADDRESS_CONTROLLER_KINDS = new Set(['ADDRESS', 'DAO', 'TIMELOCK'])
const zeroBytes32 = `0x${'00'.repeat(32)}`
const zeroAddress = `0x${'00'.repeat(20)}`

function nonzeroBytes32(value, label) {
  const normalized = bytes32(value, label)
  if (normalized === zeroBytes32) throw new TypeError(`${label} must not be zero`)
  return normalized
}

function nonzeroAddress(value, label) {
  const normalized = address(value, label)
  if (normalized === zeroAddress) throw new TypeError(`${label} must not be zero`)
  return normalized
}

function requiredBoolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

function positiveVersion(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) {
    throw new TypeError(`${label} must be a positive uint32 number`)
  }
  return value
}

function normalizeGweiName(value) {
  if (value === null) return null
  const normalized = boundedText(value, 'constitution.identity.gweiName', { maxBytes: 255 })
  if (normalized !== normalized.toLowerCase()
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.gwei$/.test(normalized)) {
    throw new TypeError('constitution.identity.gweiName must be a normalized .gwei name')
  }
  return normalized
}

function controller(input, label) {
  const value = record(input, label)
  if (!CONTROLLER_KINDS.includes(value.kind)) throw new TypeError(`${label}.kind is not supported`)
  const requiresAddress = ADDRESS_CONTROLLER_KINDS.has(value.kind)
  if (requiresAddress ? value.address === null : value.address !== null) {
    throw new TypeError(`${label}.address is inconsistent with controller kind`)
  }
  return Object.freeze({
    kind: value.kind,
    address: requiresAddress ? nonzeroAddress(value.address, `${label}.address`) : null,
  })
}

function transition(input, label) {
  const value = record(input, label)
  const terminal = requiredBoolean(value.terminal, `${label}.terminal`)
  const normalizedController = controller(value.controller, `${label}.controller`)
  if (terminal && normalizedController.kind !== 'NONE') {
    throw new TypeError(`${label} terminal transition must use the NONE controller`)
  }
  return Object.freeze({
    fromSeason: decimalString(value.fromSeason, `${label}.fromSeason`, { maximum: UINT64_MAX }),
    controller: normalizedController,
    terminal,
  })
}

function capability(input, label, currentSeason) {
  const value = record(input, label)
  const transitions = boundedList(value.transitions, `${label}.transitions`, {
    minimum: 1,
    maximum: MAX_CAPABILITY_TRANSITIONS,
  }).map((entry, index) => transition(entry, `${label}.transitions[${index}]`))
  if (transitions[0].fromSeason !== '0') throw new TypeError(`${label} first transition must begin at season 0`)
  for (let index = 1; index < transitions.length; index += 1) {
    if (BigInt(transitions[index].fromSeason) <= BigInt(transitions[index - 1].fromSeason)) {
      throw new TypeError(`${label} transitions must be strictly increasing`)
    }
    if (transitions[index - 1].terminal) {
      throw new TypeError(`${label} terminal transition cannot be followed by another controller`)
    }
  }
  const active = transitions.findLast((entry) => BigInt(entry.fromSeason) <= currentSeason)
  if (!active) throw new TypeError(`${label} has no controller for the current season`)
  const terminalTransition = transitions.find((entry) => entry.terminal) || null
  return Object.freeze({
    capability: nonzeroBytes32(value.capability, `${label}.capability`),
    label: boundedText(value.label, `${label}.label`, { maxBytes: 96 }),
    transitions: Object.freeze(transitions),
    currentController: active.controller,
    freezeStatus: active.terminal
      ? 'TERMINALLY_FROZEN'
      : terminalTransition
        ? 'TERMINAL_SCHEDULED'
        : 'ACTIVE',
  })
}

function moduleRecord(input, label) {
  const value = record(input, label)
  if (!MODULE_VERIFICATION_STATUSES.includes(value.verification)) {
    throw new TypeError(`${label}.verification is not supported`)
  }
  return Object.freeze({
    moduleKind: bytes4(value.moduleKind, `${label}.moduleKind`),
    label: boundedText(value.label, `${label}.label`, { maxBytes: 96 }),
    address: nonzeroAddress(value.address, `${label}.address`),
    interfaceId: bytes4(value.interfaceId, `${label}.interfaceId`),
    verification: value.verification,
    mutable: requiredBoolean(value.mutable, `${label}.mutable`),
    controllerCapability: value.controllerCapability === null
      ? null
      : nonzeroBytes32(value.controllerCapability, `${label}.controllerCapability`),
  })
}

function warning(code, severity, message) {
  return Object.freeze({ code, severity, message })
}

export function normalizeStationConstitutionV1(input) {
  const value = record(input, 'constitution')
  if (value.protocol !== PROTOCOL_NAME) throw new TypeError(`protocol must be ${PROTOCOL_NAME}`)
  if (value.schema !== CONSTITUTION_SCHEMA) throw new TypeError(`schema must be ${CONSTITUTION_SCHEMA}`)
  if (value.version !== CONSTITUTION_VERSION) throw new TypeError(`version must be ${CONSTITUTION_VERSION}`)
  if (value.stationProtocolVersion !== STATION_PROTOCOL_VERSION) {
    throw new TypeError(`stationProtocolVersion must be ${STATION_PROTOCOL_VERSION}`)
  }
  const observation = record(value.observation, 'constitution.observation')
  const identity = record(value.identity, 'constitution.identity')
  const observedChainId = decimalString(
    observation.chainId,
    'constitution.observation.chainId',
    { maximum: UINT256_MAX },
  )
  const stationCore = nonzeroAddress(identity.stationCore, 'constitution.identity.stationCore')
  const declaredStationId = nonzeroBytes32(identity.stationId, 'constitution.identity.stationId')
  const expectedStationId = deriveStationId(observedChainId, stationCore)
  if (declaredStationId !== expectedStationId) {
    throw new TypeError('constitution.identity.stationId does not match the observed chain and Station Core')
  }
  if (!GWEI_RESOLUTION_STATUSES.includes(identity.resolutionStatus)) {
    throw new TypeError('constitution.identity.resolutionStatus is not supported')
  }
  if (!BINDING_STATUSES.includes(identity.bindingStatus)) {
    throw new TypeError('constitution.identity.bindingStatus is not supported')
  }
  if (identity.resolutionStatus === 'VERIFIED' && identity.gweiName === null) {
    throw new TypeError('verified .gwei resolution must identify a .gwei name')
  }
  if (identity.resolutionStatus === 'VERIFIED' && identity.bindingStatus === 'MISSING') {
    throw new TypeError('verified .gwei resolution cannot have a missing binding')
  }
  const bindingNeedsController = ['MUTABLE', 'TIMELOCKED', 'DAO'].includes(identity.bindingStatus)
  if (bindingNeedsController ? identity.bindingController === null : identity.bindingController !== null) {
    throw new TypeError('constitution.identity.bindingController is inconsistent with binding status')
  }
  const currentSeason = BigInt(decimalString(value.currentSeason, 'constitution.currentSeason', { maximum: UINT64_MAX }))
  const modules = boundedList(value.modules, 'constitution.modules', { maximum: MAX_STATION_MODULES })
    .map((entry, index) => moduleRecord(entry, `constitution.modules[${index}]`))
  const moduleKinds = modules.map((entry) => entry.moduleKind)
  if (new Set(moduleKinds).size !== moduleKinds.length) {
    throw new TypeError('constitution.modules must not contain duplicate module kinds')
  }
  const capabilities = boundedList(value.capabilities, 'constitution.capabilities', {
    maximum: MAX_CAPABILITIES,
  }).map((entry, index) => capability(entry, `constitution.capabilities[${index}]`, currentSeason))
  const capabilityIds = capabilities.map((entry) => entry.capability)
  if (new Set(capabilityIds).size !== capabilityIds.length) {
    throw new TypeError('constitution.capabilities must not contain duplicates')
  }
  const capabilitySet = new Set(capabilityIds)
  for (const current of modules) {
    if (current.mutable && current.controllerCapability === null) {
      throw new TypeError(`${current.label} mutable module must identify its controller capability`)
    }
    if (current.controllerCapability !== null && !capabilitySet.has(current.controllerCapability)) {
      throw new TypeError(`${current.label} module references an unknown controller capability`)
    }
  }

  const vault = record(value.vault, 'constitution.vault')
  const vaultBalance = BigInt(decimalString(vault.balanceWei, 'constitution.vault.balanceWei', { maximum: UINT256_MAX }))
  const protectedReserve = BigInt(decimalString(vault.protectedReserveWei, 'constitution.vault.protectedReserveWei', { maximum: UINT256_MAX }))
  const totalLiabilities = BigInt(decimalString(vault.totalLiabilitiesWei, 'constitution.vault.totalLiabilitiesWei', { maximum: UINT256_MAX }))
  const generalWithdrawalPath = requiredBoolean(vault.generalWithdrawalPath, 'constitution.vault.generalWithdrawalPath')
  if (generalWithdrawalPath ? vault.withdrawalController === null : vault.withdrawalController !== null) {
    throw new TypeError('constitution.vault.withdrawalController is inconsistent with withdrawal path')
  }
  const revenue = record(value.revenue, 'constitution.revenue')
  const comminglesProtectedFunding = requiredBoolean(
    revenue.comminglesProtectedFunding,
    'constitution.revenue.comminglesProtectedFunding',
  )
  const rules = record(value.rules, 'constitution.rules')
  const standingFallbackEnabled = requiredBoolean(
    rules.standingFallbackEnabled,
    'constitution.rules.standingFallbackEnabled',
  )
  if (rules.playbackDecisionVersion !== 1) {
    throw new TypeError('constitution.rules.playbackDecisionVersion must be 1')
  }
  const feePolicy = record(rules.feePolicy, 'constitution.rules.feePolicy')
  if (!['MISSING', ...MODULE_VERIFICATION_STATUSES].includes(feePolicy.verification)) {
    throw new TypeError('constitution.rules.feePolicy.verification is not supported')
  }
  const feeMissing = feePolicy.verification === 'MISSING'
  if (feeMissing
    ? feePolicy.moduleAddress !== null || feePolicy.policyVersion !== null
    : feePolicy.moduleAddress === null || feePolicy.policyVersion === null) {
    throw new TypeError('constitution.rules.feePolicy fields are inconsistent with verification')
  }
  if (!feeMissing) {
    const normalizedFeeAddress = nonzeroAddress(
      feePolicy.moduleAddress,
      'constitution.rules.feePolicy.moduleAddress',
    )
    const feeModule = modules.find((current) => current.address === normalizedFeeAddress)
    if (!feeModule) throw new TypeError('constitution.rules.feePolicy module is absent from the module list')
    if (feeModule.verification !== feePolicy.verification) {
      throw new TypeError('constitution.rules.feePolicy verification disagrees with the module record')
    }
  }

  const warnings = []
  if (identity.resolutionStatus !== 'VERIFIED') {
    warnings.push(warning('GWEI_BINDING_UNVERIFIED', 'HIGH', 'The .gwei station binding is not verified.'))
  }
  if (identity.bindingStatus === 'MISSING') {
    warnings.push(warning('GWEI_BINDING_MISSING', 'CRITICAL', 'No canonical .gwei binding is present.'))
  } else if (identity.bindingStatus !== 'LOCKED') {
    warnings.push(warning('GWEI_BINDING_MUTABLE', 'HIGH', 'The .gwei station binding can still change.'))
  }
  for (const current of modules) {
    if (current.verification === 'UNKNOWN') {
      warnings.push(warning('MODULE_UNVERIFIED', 'HIGH', `${current.label} module is not verified.`))
    } else if (current.verification === 'INVALID') {
      warnings.push(warning('MODULE_INVALID', 'CRITICAL', `${current.label} module failed interface verification.`))
    }
    if (current.mutable && current.controllerCapability !== null) {
      const controllingCapability = capabilities.find(
        (entry) => entry.capability === current.controllerCapability,
      )
      if (controllingCapability?.currentController.kind !== 'NONE') {
        warnings.push(warning(
          'MODULE_REPLACEABLE',
          'HIGH',
          `${current.label} module can be replaced by its current capability controller.`,
        ))
      }
    }
  }
  if (vaultBalance < totalLiabilities) {
    warnings.push(warning('VAULT_INSOLVENT', 'CRITICAL', 'Vault balance is below recorded liabilities.'))
  }
  if (protectedReserve > vaultBalance) {
    warnings.push(warning('PROTECTED_RESERVE_UNFUNDED', 'CRITICAL', 'Protected reserve exceeds the vault balance.'))
  }
  if (generalWithdrawalPath) {
    warnings.push(warning('VAULT_GENERAL_WITHDRAWAL', 'CRITICAL', 'Vault exposes a general administrative withdrawal path.'))
  }
  if (comminglesProtectedFunding) {
    warnings.push(warning('REVENUE_PROTECTED_FUNDS_COMMINGLED', 'CRITICAL', 'Revenue accounting is commingled with protected transmission funding.'))
  }
  if (feePolicy.verification !== 'VERIFIED') {
    warnings.push(warning('FEE_POLICY_UNVERIFIED', 'HIGH', 'The enforceable fee policy is missing or unverified.'))
  }

  return Object.freeze({
    protocol: PROTOCOL_NAME,
    schema: CONSTITUTION_SCHEMA,
    version: CONSTITUTION_VERSION,
    stationProtocolVersion: STATION_PROTOCOL_VERSION,
    observation: Object.freeze({
      chainId: observedChainId,
      blockNumber: decimalString(observation.blockNumber, 'constitution.observation.blockNumber', { maximum: UINT64_MAX }),
      blockHash: nonzeroBytes32(observation.blockHash, 'constitution.observation.blockHash'),
    }),
    identity: Object.freeze({
      stationId: declaredStationId,
      gweiName: normalizeGweiName(identity.gweiName),
      resolutionStatus: identity.resolutionStatus,
      stationCore,
      directory: identity.directory === null ? null : nonzeroAddress(identity.directory, 'constitution.identity.directory'),
      bindingStatus: identity.bindingStatus,
      bindingController: bindingNeedsController
        ? nonzeroAddress(identity.bindingController, 'constitution.identity.bindingController')
        : null,
    }),
    currentSeason: currentSeason.toString(),
    modules: Object.freeze(modules),
    capabilities: Object.freeze(capabilities),
    vault: Object.freeze({
      balanceWei: vaultBalance.toString(),
      protectedReserveWei: protectedReserve.toString(),
      totalLiabilitiesWei: totalLiabilities.toString(),
      generalWithdrawalPath,
      withdrawalController: generalWithdrawalPath
        ? nonzeroAddress(vault.withdrawalController, 'constitution.vault.withdrawalController')
        : null,
    }),
    revenue: Object.freeze({
      escrow: revenue.escrow === null ? null : nonzeroAddress(revenue.escrow, 'constitution.revenue.escrow'),
      comminglesProtectedFunding,
    }),
    rules: Object.freeze({
      standingFallbackEnabled,
      playbackDecisionVersion: 1,
      feePolicy: Object.freeze({
        moduleAddress: feeMissing ? null : nonzeroAddress(feePolicy.moduleAddress, 'constitution.rules.feePolicy.moduleAddress'),
        policyVersion: feeMissing ? null : positiveVersion(feePolicy.policyVersion, 'constitution.rules.feePolicy.policyVersion'),
        verification: feePolicy.verification,
      }),
    }),
    warnings: Object.freeze(warnings),
  })
}
