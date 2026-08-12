import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { loadKZG } from 'kzg-wasm'
import {
  bytesToHex,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  hexToBytes,
  http,
  keccak256,
  parseEther,
  parseGwei,
  stringToBytes,
  toBlobs,
  zeroHash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet, sepolia } from 'viem/chains'
import { stationAbi } from '../../scripts/lib/station-abi.mjs'
import {
  atomicWriteJson,
  maybeInjectPublisherFault,
  receiptCostWei,
  signedTransactionHash,
  transactionExposureWei,
} from '../../scripts/lib/publisher-safety.mjs'
import { streamFilesystemIdentity } from '../../scripts/lib/filesystem-identity.mjs'
import { readPublisherEngineState, readPublisherJobConfig, readSegmentManifest } from './lib/runtime-schema.mjs'
import { publicationIntentFromPrepared, verifySignedPublicationIntent } from './lib/publication-intent.mjs'
import { durableReserveThenSign } from './lib/signing-coordinator.mjs'
import { acquireSignerCoordinatorLease } from './lib/signer-coordinator.mjs'
import {
  lineageHealth,
  lineageReservedExposure,
  canonicalReceiptCostTransition,
  finalizedTagDecision,
  signerLiquidityDecision,
  nextReplacementFees,
  pendingReservedExposure,
  reconcileAttemptReceipts,
  replacementBudgetDecision,
  replacementEligibility,
  startupNonceDecision,
} from './lib/transaction-continuity.mjs'
import {
  DEFAULT_ENDPOINT_OPERATION_DEADLINE_MS,
  firstSuccessfulEndpoint,
  settleEndpointOperation,
} from './lib/endpoint-operation.mjs'
import {
  GAS_ESTIMATE_FLOOR,
  GAS_LIMIT_CAP,
  GAS_MARGIN_PERCENT,
  gasLimitDecision,
} from './lib/gas-preflight.mjs'
import {
  publisherDurabilityCapability,
  writePublisherEngineStateAtomic,
} from './lib/engine-state-integrity.mjs'
import { quarantineCriticalStateTemps } from './lib/recovery-artifacts.mjs'
import { ProcessLock } from './lib/process-lock.mjs'

const configPath = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (!configPath || !fs.existsSync(configPath)) throw new Error('A persisted publisher-console job configuration is required')
const config = readPublisherJobConfig(configPath, { role: 'publisher' })
const statePath = path.resolve(config.publisherStatePath)
const durabilityCapability = publisherDurabilityCapability(path.dirname(statePath))
const lockPath = `${statePath}.lock`
const chain = config.chain === 'mainnet' ? mainnet : sepolia

class GasPreflightBlockedError extends Error {
  constructor(message, evidence) {
    super(message)
    this.name = 'GasPreflightBlockedError'
    this.evidence = evidence
  }
}
if (!chain) throw new Error(`Unsupported chain ${config.chain}`)
if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY is required')
const account = privateKeyToAccount(process.env.PRIVATE_KEY)
const streamBudgetWei = parseEther(config.maxStreamCostEth)
const segmentBudgetWei = parseEther(config.maxSegmentCostEth)
const replaceAfterMs = config.replaceAfterSeconds * 1000
const maxBytes = config.maxBlobs * 126_976
const filePrefix = streamFilesystemIdentity(config.streamId).key
const manifestPath = path.join(config.segmentDir, `${filePrefix}.segments.json`)
const manifestDir = path.join(path.dirname(statePath), 'manifests')
const rpcUrls = [...new Set([config.executionRpcUrl, ...(config.sendRpcUrls || [])].filter(Boolean))]
let clients = []
let kzg
let state
let lastDurableState = null
let stopping = false
const processLock = new ProcessLock(lockPath, {
  conflictMessage: (pid) => `Reliable publisher already owns this state as process ${pid}`,
})

function log(message) {
  process.stdout.write(`${message}\n`)
}

function warn(message) {
  process.stderr.write(`${message}\n`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function persist() {
  state.updatedAt = new Date().toISOString()
  state.durabilityMode = durabilityCapability.mode
  syncMetrics()
  const sealed = writePublisherEngineStateAtomic(statePath, state, lastDurableState)
  state = sealed
  lastDurableState = structuredClone(sealed)
  atomicWriteJson(config.publisherProgressPath, {
    schema: 'rfe/publisher-progress@1',
    chain: config.chain,
    stationAddress: config.stationAddress,
    publisher: account.address,
    streamId: config.streamId,
    confirmedCount: state.published.filter((item) => item.finalityStatus !== 'provider-disagreement').length,
    pendingCount: state.items.length,
    updatedAt: state.updatedAt,
  })
}

function newState() {
  return {
    version: 8,
    engine: 'rfe-transaction-continuity',
    chain: config.chain,
    stationAddress: config.stationAddress,
    publisher: account.address,
    streamId: config.streamId,
    nextSequence: Number(config.startSequence || 0),
    nextNonce: null,
    previousSegmentHash: zeroHash,
    items: [],
    published: [],
    actualSpendWei: '0',
    durabilityMode: durabilityCapability.mode,
    metrics: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function loadState() {
  if (!fs.existsSync(statePath)) return newState()
  return readPublisherEngineState(statePath, {
    chain: config.chain,
    stationAddress: config.stationAddress,
    publisher: account.address,
    streamId: config.streamId,
    segmentDir: config.segmentDir,
  })
}

function syncMetrics() {
  const pendingWei = pendingReservedExposure(state.items)
  const latest = [...state.items].sort((a, b) => a.nonce - b.nonce)[0] || null
  const health = latest
    ? lineageHealth(latest, { replaceAfterMs, maxReplacements: config.maxReplacements })
    : 'idle'
  state.metrics = {
    submittedCount: state.published.length + state.items.length,
    confirmedCount: state.published.filter((item) => item.finalityStatus !== 'provider-disagreement').length,
    pendingCount: state.items.length,
    actualSpendWei: state.actualSpendWei,
    actualSpendEth: formatEther(BigInt(state.actualSpendWei)),
    reservedPendingWei: pendingWei.toString(),
    reservedPendingEth: formatEther(pendingWei),
    totalExposureWei: (BigInt(state.actualSpendWei) + pendingWei).toString(),
    durabilityMode: state.durabilityMode,
    health,
    lowestPendingNonce: latest?.nonce ?? null,
    lowestPendingSequence: latest?.sequence ?? null,
    latestAttemptCount: latest?.attempts?.length || 0,
    latestBlockedReason: state.historyBlockedReason || latest?.blockedReason || null,
  }
}

function readManifest() {
  if (!fs.existsSync(manifestPath)) return null
  return readSegmentManifest(manifestPath, { streamId: config.streamId, segmentDir: config.segmentDir })
}

function segmentForSequence(sequence) {
  const manifest = readManifest()
  return manifest?.segments.find((segment) => Number(segment.sequence) === Number(sequence)) || null
}

function payloadFor(itemOrSegment) {
  const file = path.resolve(itemOrSegment.file)
  const root = path.resolve(config.segmentDir)
  if (path.dirname(file) !== root) throw new Error('Segment payload path escaped the job directory')
  if (!fs.existsSync(file)) throw new Error(`Pending segment payload is missing: ${path.basename(file)}`)
  const payload = fs.readFileSync(file)
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex')
  if (itemOrSegment.payloadSha256 && sha256.toLowerCase() !== String(itemOrSegment.payloadSha256).replace(/^0x/, '').toLowerCase()) {
    throw new Error(`Segment ${itemOrSegment.sequence} payload hash changed on disk`)
  }
  return { file, payload, sha256, blobs: toBlobs({ data: bytesToHex(payload) }) }
}

function stationData(item) {
  return encodeFunctionData({
    abi: stationAbi,
    functionName: 'publishSegment',
    args: [
      config.streamId,
      BigInt(item.sequence),
      BigInt(item.durationMs),
      item.payloadBytes,
      `0x${item.payloadSha256.replace(/^0x/, '')}`,
      item.codec,
      item.previousSegmentHash,
      item.blobCount,
    ],
  })
}

function ceilingWei(value) {
  return value ? parseGwei(value) : null
}

function feeCeilings() {
  return {
    maxFeePerGas: ceilingWei(config.maxFeePerGasGwei),
    maxPriorityFeePerGas: ceilingWei(config.maxPriorityFeePerGasGwei),
    maxFeePerBlobGas: ceilingWei(config.maxFeePerBlobGasGwei),
  }
}

function assertWithinFeeCeilings(fees) {
  const ceilings = feeCeilings()
  for (const name of ['maxFeePerGas', 'maxPriorityFeePerGas', 'maxFeePerBlobGas']) {
    if (ceilings[name] !== null && BigInt(fees[name]) > ceilings[name]) {
      throw new Error(`${name} ${fees[name]} exceeds configured ceiling ${ceilings[name]}`)
    }
  }
}

async function initializeClients() {
  clients = rpcUrls.map((url, index) => {
    const transport = http(url, { timeout: DEFAULT_ENDPOINT_OPERATION_DEADLINE_MS, retryCount: 0 })
    return {
      label: `RPC ${index + 1}`,
      url,
      publicClient: createPublicClient({ chain, transport }),
      walletClient: createWalletClient({ account, chain, transport }),
      validated: false,
    }
  })
  const operation = await settleEndpointOperation(clients, async (client) => {
      const chainId = await client.publicClient.getChainId()
      if (chainId !== chain.id) throw new Error(`${client.label} is on chain ${chainId}, expected ${chain.id}`)
      client.validated = true
      return client
  })
  for (const [index, result] of operation.results.entries()) {
    if (result.status === 'fulfilled') log(`${clients[index].label} validated for ${chain.name}`)
    else if (/is on chain/.test(String(result.reason?.message || result.reason))) throw result.reason
    else warn(`${clients[index].label} unavailable during startup; retained as a later fallback`)
  }
  const validated = clients.filter((client) => client.validated).length
  if (!validated) throw new Error('No configured execution RPC validated successfully')
}

async function withReadClient(action) {
  const ordered = [...clients.filter((item) => item.validated), ...clients.filter((item) => !item.validated)]
  return firstSuccessfulEndpoint(ordered, async (client, context) => {
    const value = await action(client, context)
    client.validated = true
    return value
  })
}

async function observeGasPreflight(request) {
  const eligible = clients.filter((item) => item.validated)
  const operation = await settleEndpointOperation(eligible, async (client) => {
    const block = await client.publicClient.getBlock({ blockTag: 'latest' })
    const code = await client.publicClient.getCode({ address: config.stationAddress, blockNumber: block.number })
    if (!code || code === '0x') throw new Error(`${client.label} observed no Station code`)
    const estimateGas = await client.publicClient.estimateGas({ ...request, blockNumber: block.number })
    return {
      provider: client.label,
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      stationCodeHash: keccak256(code),
      estimateGas: estimateGas.toString(),
    }
  })
  const observations = operation.results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
  const decision = gasLimitDecision({ observations })
  return {
    decision,
    evidence: {
      floorGas: GAS_ESTIMATE_FLOOR.toString(),
      capGas: GAS_LIMIT_CAP.toString(),
      marginPercent: GAS_MARGIN_PERCENT.toString(),
      gasLimit: decision.gasLimit?.toString() ?? null,
      maximumEstimateGas: decision.maximumEstimateGas?.toString() ?? null,
      disagreement: Boolean(decision.disagreement),
      observations,
      observedAt: new Date().toISOString(),
    },
  }
}

async function revalidateGasPreflight(item) {
  const expectedCodeHashes = new Set((item.gasPreflightEvidence?.observations || [])
    .map((observation) => observation.stationCodeHash.toLowerCase()))
  if (expectedCodeHashes.size !== 1) throw new Error(`Sequence ${item.sequence} has no coherent Station code anchor`)
  const eligible = clients.filter((candidate) => candidate.validated)
  const operation = await settleEndpointOperation(eligible, async (client) => {
    const block = await client.publicClient.getBlock({ blockTag: 'latest' })
    const code = await client.publicClient.getCode({ address: config.stationAddress, blockNumber: block.number })
    if (!code || code === '0x') throw new Error(`${client.label} observed no Station code during revalidation`)
    return {
      provider: client.label,
      blockNumber: block.number.toString(),
      blockHash: block.hash,
      stationCodeHash: keccak256(code),
    }
  })
  const observations = operation.results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
  item.gasPreflightEvidence.revalidationObservations = observations
  item.gasPreflightEvidence.revalidatedAt = new Date().toISOString()
  persist()
  if (!observations.length) {
    item.status = 'blocked'
    item.blockedReason = `Sequence ${item.sequence} Station code could not be revalidated before signing`
    persist()
    throw new Error(item.blockedReason)
  }
  if (observations.some((observation) => !expectedCodeHashes.has(observation.stationCodeHash.toLowerCase()))) {
    item.status = 'blocked'
    item.blockedReason = `Sequence ${item.sequence} Station code changed after gas preflight; renewed intent is required`
    persist()
    throw new Error(item.blockedReason)
  }
}

async function prepareReservation(item, fees = null, fixedGas = null) {
  const { blobs } = payloadFor(item)
  const request = {
    account,
    to: config.stationAddress,
    data: stationData(item),
    blobs,
    kzg,
    nonce: item.nonce,
  }
  if (fees) Object.assign(request, fees)
  if (fixedGas === null) {
    const preflight = await observeGasPreflight(request)
    item.gasPreflightEvidence = preflight.evidence
    if (!preflight.decision.allowed) {
      throw new GasPreflightBlockedError(`Gas preflight blocked sequence ${item.sequence}: ${preflight.decision.reason}`, preflight.evidence)
    }
    request.gas = preflight.decision.gasLimit
  } else {
    request.gas = BigInt(fixedGas)
  }
  const prepared = await withReadClient((client) => client.walletClient.prepareTransactionRequest(request))
  assertWithinFeeCeilings(prepared)
  const reservedCostWei = transactionExposureWei(prepared, blobs.length)
  return {
    prepared,
    reservation: {
      ...publicationIntentFromPrepared(prepared, {
        publisher: account.address,
        reservedExposureWei: reservedCostWei,
        payloadSha256: item.payloadSha256,
        blobCount: blobs.length,
      }),
      index: item.attempts.length,
      reservedAt: new Date().toISOString(),
    },
  }
}

async function verifyLoadedStateIntents() {
  for (const item of state.items) {
    for (const [index, attempt] of item.attempts.entries()) {
      const reservation = item.reservations[index]
      if (signedTransactionHash(attempt.serializedTransaction).toLowerCase() !== attempt.txHash.toLowerCase()) {
        throw new Error(`Persisted attempt hash does not match signed transaction for sequence ${item.sequence}`)
      }
      await verifySignedPublicationIntent(attempt.serializedTransaction, reservation)
    }
  }
}

function reservationFees(reservation) {
  return {
    maxFeePerGas: BigInt(reservation.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(reservation.maxPriorityFeePerGas),
    maxFeePerBlobGas: BigInt(reservation.maxFeePerBlobGas),
  }
}

async function signReservedAttempt(item, reservation, prepared = null) {
  let transaction = prepared
  if (!transaction) {
    const rebuilt = await prepareReservation(item, reservationFees(reservation), reservation.gas)
    if (rebuilt.reservation.intentDigest !== reservation.intentDigest
      || rebuilt.reservation.reservedExposureWei !== reservation.reservedExposureWei) {
      throw new Error(`Reserved publication intent changed before signing sequence ${item.sequence}`)
    }
    transaction = rebuilt.prepared
  }
  const serializedTransaction = await account.signTransaction(transaction)
  return {
    index: reservation.index,
    intentDigest: reservation.intentDigest,
    txHash: signedTransactionHash(serializedTransaction),
    serializedTransaction,
    reservedCostWei: reservation.reservedExposureWei,
    maxFeePerGas: reservation.maxFeePerGas,
    maxPriorityFeePerGas: reservation.maxPriorityFeePerGas,
    maxFeePerBlobGas: reservation.maxFeePerBlobGas,
    preparedAt: new Date().toISOString(),
    broadcastAt: null,
    lastSendAttemptAt: null,
    sendCount: 0,
  }
}

function commitSignedAttempt(item, attempt) {
  item.attempts.push(attempt)
  item.status = 'prepared'
  item.blockedReason = null
  persist()
  log(`prepared attempt ${attempt.index + 1} for seq ${item.sequence} nonce ${item.nonce}`)
}

async function completeReservedAttempt(item, prepared = null) {
  const reservation = item.reservations.at(-1)
  if (!reservation || reservation.index !== item.attempts.length) throw new Error(`Sequence ${item.sequence} has no next durable signing reservation`)
  await revalidateGasPreflight(item)
  const attempt = await signReservedAttempt(item, reservation, prepared)
  await verifySignedPublicationIntent(attempt.serializedTransaction, reservation)
  commitSignedAttempt(item, attempt)
  await sendAttempt(item, attempt)
}

async function initialFees() {
  const [block, suggested, blobBaseFee] = await Promise.all([
    withReadClient((client) => client.publicClient.getBlock({ blockTag: 'latest' })),
    withReadClient((client) => client.publicClient.estimateFeesPerGas()),
    withReadClient((client) => client.publicClient.getBlobBaseFee()),
  ])
  const priority = suggested.maxPriorityFeePerGas || 1n
  const execution = suggested.maxFeePerGas || (BigInt(block.baseFeePerGas || 0n) * 2n + priority)
  const blob = BigInt(blobBaseFee) > 0n ? BigInt(blobBaseFee) * 2n : 1n
  const fees = {
    maxFeePerGas: execution,
    maxPriorityFeePerGas: priority,
    maxFeePerBlobGas: blob,
  }
  assertWithinFeeCeilings(fees)
  return fees
}

async function sendAttempt(item, attempt) {
  attempt.lastSendAttemptAt = new Date().toISOString()
  attempt.sendCount = Number(attempt.sendCount || 0) + 1
  persist()
  const operation = await settleEndpointOperation(clients, async (client, { signal }) => {
    try {
      const hash = await client.walletClient.sendRawTransaction({ serializedTransaction: attempt.serializedTransaction })
      if (hash.toLowerCase() !== attempt.txHash.toLowerCase()) throw new Error(`${client.label} returned an unexpected transaction hash`)
      client.validated = true
      return { accepted: true, provider: client.label }
    } catch (error) {
      if (signal.aborted) throw error
      const [known, receipt] = await Promise.all([
        client.publicClient.getTransaction({ hash: attempt.txHash }).catch(() => null),
        client.publicClient.getTransactionReceipt({ hash: attempt.txHash }).catch(() => null),
      ])
      if (known || receipt) return { accepted: true, provider: client.label, recovered: true }
      throw error
    }
  })
  const accepted = operation.results.some((result) => result.status === 'fulfilled' && result.value.accepted)
  if (!accepted) {
    const lastError = operation.results.findLast((result) => result.status === 'rejected')?.reason
    const suffix = operation.deadlineExceeded
      ? `endpoint operation exceeded ${DEFAULT_ENDPOINT_OPERATION_DEADLINE_MS}ms aggregate deadline`
      : String(lastError?.message || lastError || 'all endpoints rejected').split('\n')[0]
    warn(`seq ${item.sequence} attempt ${attempt.index + 1} was not accepted by any RPC: ${suffix}`)
    return false
  }
  attempt.broadcastAt ||= new Date().toISOString()
  item.status = 'pending'
  item.blockedReason = null
  persist()
  log(`broadcast seq ${item.sequence} nonce ${item.nonce} attempt ${attempt.index + 1}: ${attempt.txHash}`)
  return true
}

async function initializeNonce() {
  const eligible = clients.filter((item) => item.validated)
  const operation = await settleEndpointOperation(eligible, (client) => (
    client.publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
  ))
  const nonces = operation.results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
  const decision = startupNonceDecision({
    persistedNextNonce: state.nextNonce,
    pendingItems: state.items,
    observedPendingNonces: nonces,
  })
  if (!decision.allowed) throw new Error(`Could not reconcile publisher nonce at startup: ${decision.reason}`)
  if (decision.disposition === 'advanced-external') {
    warn(`publisher nonce advanced externally from ${state.nextNonce} to ${decision.nextNonce}; new intents will use the observed pending nonce`)
  }
  state.nextNonce = decision.nextNonce
  persist()
}

async function observeSignerLiquidity(requiredWei) {
  const eligible = clients.filter((item) => item.validated)
  const operation = await settleEndpointOperation(eligible, async (client) => ({
    provider: client.label,
    balanceWei: (await client.publicClient.getBalance({
      address: account.address,
      blockTag: 'pending',
    })).toString(),
  }))
  const observations = operation.results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
  const decision = signerLiquidityDecision({ observations, requiredWei })
  const evidence = {
    requiredWei: decision.requiredWei.toString(),
    minimumBalanceWei: decision.minimumBalanceWei?.toString() ?? null,
    maximumBalanceWei: decision.maximumBalanceWei?.toString() ?? null,
    disagreement: Boolean(decision.disagreement),
    observations: (decision.observations || []).map((item) => ({
      provider: item.provider,
      balanceWei: item.balanceWei.toString(),
    })),
    observedAt: new Date().toISOString(),
  }
  return { decision, evidence }
}

async function addNextSegment() {
  if (state.items.length >= config.maxPending || state.items.some((item) => ['blocked', 'failed'].includes(item.status))) return false
  const segment = segmentForSequence(state.nextSequence)
  if (!segment) return false
  const { file, payload, sha256, blobs } = payloadFor(segment)
  if (!payload.length || payload.length > maxBytes || blobs.length < 1 || blobs.length > config.maxBlobs) {
    throw new Error(`Segment ${state.nextSequence} violates its blob envelope`)
  }
  await initializeNonce()
  const item = {
    sequence: state.nextSequence,
    nonce: state.nextNonce,
    file,
    durationMs: Number(segment.durationMs || config.segmentMs),
    codec: 'av1-opus/webm',
    payloadBytes: payload.length,
    payloadSha256: sha256,
    blobCount: blobs.length,
    previousSegmentHash: state.previousSegmentHash,
    status: 'preparing',
    blockedReason: null,
    winnerHash: null,
    reservations: [],
    attempts: [],
    createdAt: new Date().toISOString(),
  }
  let prepared
  let reservation
  try {
    ({ prepared, reservation } = await prepareReservation(item, await initialFees()))
  } catch (error) {
    if (!(error instanceof GasPreflightBlockedError)) throw error
    item.status = 'blocked'
    item.blockedReason = error.message
    state.items.push(item)
    persist()
    warn(error.message)
    return false
  }
  const budget = replacementBudgetDecision({
    item,
    nextReservedCostWei: reservation.reservedExposureWei,
    pendingItems: [...state.items, item],
    actualSpendWei: state.actualSpendWei,
    streamBudgetWei,
    segmentBudgetWei,
  })
  if (!budget.allowed) {
    item.status = 'blocked'
    item.blockedReason = budget.reason
    state.items.push(item)
    persist()
    warn(`blocked seq ${item.sequence}: ${budget.reason}`)
    return false
  }
  const liquidity = await observeSignerLiquidity(budget.proposedPendingWei)
  item.liquidityEvidence = liquidity.evidence
  if (!liquidity.decision.allowed) {
    item.status = 'blocked'
    item.blockedReason = liquidity.decision.reason
    state.items.push(item)
    persist()
    warn(`blocked seq ${item.sequence}: ${liquidity.decision.reason}`)
    return false
  }
  const attempt = await durableReserveThenSign({
    reservation,
    durableReserve() {
      item.reservations.push(reservation)
      item.status = 'reserved'
      state.items.push(item)
      state.nextSequence += 1
      state.nextNonce += 1
      state.previousSegmentHash = `0x${sha256}`
      persist()
    },
    async afterDurableReserve() {
      maybeInjectPublisherFault('console-after-reservation')
      await revalidateGasPreflight(item)
    },
    sign() { return signReservedAttempt(item, reservation, prepared) },
    verify(signed) { return verifySignedPublicationIntent(signed.serializedTransaction, reservation) },
    durableCommit(signed) { commitSignedAttempt(item, signed) },
  })
  await sendAttempt(item, attempt)
  return true
}

async function receiptForHash(hash) {
  try {
    return await firstSuccessfulEndpoint(clients, async (client) => {
      const receipt = await client.publicClient.getTransactionReceipt({ hash })
      if (!receipt) throw new Error(`${client.label} has no receipt`)
      return receipt
    })
  } catch {
    return null
  }
}

async function blockHash(blockNumber) {
  return withReadClient(async (client) => (await client.publicClient.getBlock({ blockNumber: BigInt(blockNumber) })).hash)
}

function verifyStationReceipt(item, receipt) {
  const streamIdHash = keccak256(stringToBytes(config.streamId))
  const decoded = receipt.logs
    .filter((logEntry) => logEntry.address.toLowerCase() === config.stationAddress.toLowerCase())
    .map((logEntry) => {
      try { return decodeEventLog({ abi: stationAbi, data: logEntry.data, topics: logEntry.topics }) } catch { return null }
    })
    .find((event) => event?.eventName === 'SegmentPublished'
      && event.args.publisher.toLowerCase() === account.address.toLowerCase()
      && event.args.streamIdHash.toLowerCase() === streamIdHash.toLowerCase()
      && event.args.sequence === BigInt(item.sequence))
  if (!decoded) throw new Error(`Winning transaction did not emit the expected Station event for sequence ${item.sequence}`)
  const expectedPayloadHash = `0x${item.payloadSha256}`.toLowerCase()
  if (decoded.args.payloadSha256.toLowerCase() !== expectedPayloadHash
    || decoded.args.previousSegmentHash.toLowerCase() !== item.previousSegmentHash.toLowerCase()
    || Number(decoded.args.payloadBytes) !== item.payloadBytes
    || decoded.args.blobVersionedHashes.length !== item.blobCount) {
    throw new Error(`Station event metadata did not match sequence ${item.sequence}`)
  }
  return decoded
}

async function operationallyConfirmItem(item, outcome) {
  const event = verifyStationReceipt(item, outcome.receipt)
  const costs = receiptCostWei(outcome.receipt, { expectedBlobCount: item.blobCount })
  if (costs.totalWei > lineageReservedExposure(item)) throw new Error(`Sequence ${item.sequence} cost exceeded its reserved lineage exposure`)
  const winningAttempt = item.attempts.find((attempt) => attempt.txHash === outcome.winnerHash)
  const winningReservation = item.reservations[winningAttempt?.index ?? -1]
  if (!winningReservation) throw new Error(`Sequence ${item.sequence} winning attempt has no gas reservation`)
  if (BigInt(outcome.receipt.gasUsed) > BigInt(winningReservation.gas)) throw new Error(`Sequence ${item.sequence} used more gas than reserved`)
  const published = {
    sequence: item.sequence,
    nonce: item.nonce,
    file: item.file,
    durationMs: item.durationMs,
    codec: item.codec,
    payloadBytes: item.payloadBytes,
    payloadSha256: item.payloadSha256,
    blobCount: item.blobCount,
    previousSegmentHash: item.previousSegmentHash,
    txHash: outcome.winnerHash,
    winningAttempt: winningAttempt.index,
    attemptCount: item.attempts.length,
    attemptHashes: item.attempts.map((attempt) => attempt.txHash),
    blockHash: outcome.receipt.blockHash,
    blockNumber: outcome.receipt.blockNumber.toString(),
    blobVersionedHashes: event.args.blobVersionedHashes,
    costWei: costs.totalWei.toString(),
    executionCostWei: costs.executionWei.toString(),
    blobCostWei: costs.blobWei.toString(),
    gasLimit: winningReservation.gas,
    gasUsed: outcome.receipt.gasUsed.toString(),
    confirmedAt: new Date().toISOString(),
    finalityStatus: 'operationally-confirmed',
    finalityEvidence: null,
  }
  fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 })
  atomicWriteJson(path.join(manifestDir, `${String(item.sequence).padStart(6, '0')}.json`), published)
  state.published.push(published)
  state.published.sort((left, right) => left.sequence - right.sequence)
  state.actualSpendWei = (BigInt(state.actualSpendWei) + costs.totalWei).toString()
  state.items = state.items.filter((candidate) => candidate !== item)
  persist()
  log(`operationally confirmed seq ${item.sequence} after ${outcome.confirmations} confirmation(s), winning attempt ${published.winningAttempt + 1}`)
}

async function reconcileItem(item, headBlockNumber) {
  const receiptsByHash = {}
  const canonicalBlockHashes = {}
  for (const attempt of item.attempts) {
    const receipt = await receiptForHash(attempt.txHash)
    if (receipt) {
      receiptsByHash[attempt.txHash] = receipt
      canonicalBlockHashes[String(receipt.blockNumber)] = await blockHash(receipt.blockNumber)
    }
  }
  const outcome = reconcileAttemptReceipts(item, {
    receiptsByHash,
    canonicalBlockHashes,
    headBlockNumber,
    confirmationDepth: config.confirmationDepth,
  })
  if (outcome.status === 'failed') {
    const costs = receiptCostWei(outcome.receipt, { expectedBlobCount: item.blobCount })
    const accounting = canonicalReceiptCostTransition({
      totalSpendWei: state.actualSpendWei,
      recordedCostWei: item.accountedCostWei,
      observedCostWei: costs.totalWei,
      canonical: true,
    })
    state.actualSpendWei = accounting.totalSpendWei.toString()
    item.accountedCostWei = accounting.recordedCostWei.toString()
    item.accountedExecutionCostWei = costs.executionWei.toString()
    item.accountedBlobCostWei = costs.blobWei.toString()
    item.accountedAt ||= new Date().toISOString()
    item.status = 'failed'
    item.winnerHash = outcome.winnerHash
    item.blockedReason = outcome.reason
    persist()
    return
  }
  if (outcome.status === 'reorged') {
    const accounting = canonicalReceiptCostTransition({
      totalSpendWei: state.actualSpendWei,
      recordedCostWei: item.accountedCostWei,
      canonical: false,
    })
    state.actualSpendWei = accounting.totalSpendWei.toString()
    delete item.accountedCostWei
    delete item.accountedExecutionCostWei
    delete item.accountedBlobCostWei
    delete item.accountedAt
    warn(`reorg detected for seq ${item.sequence}; returning lineage to pending reconciliation`)
    item.status = 'pending'
    item.winnerHash = null
    item.blockedReason = null
    persist()
    return
  }
  if (outcome.status === 'confirming') {
    verifyStationReceipt(item, outcome.receipt)
    item.status = 'confirming'
    item.winnerHash = outcome.winnerHash
    item.confirmations = outcome.confirmations
    item.blockedReason = null
    persist()
    return
  }
  if (outcome.status === 'operationally-confirmed') await operationallyConfirmItem(item, outcome)
}

async function observePublishedFinality() {
  const eligibleClients = clients.filter((item) => item.validated)
  const headOperation = await settleEndpointOperation(eligibleClients, async (client) => ({
    client,
    head: await client.publicClient.getBlock({ blockTag: 'finalized' }),
  }))
  const observations = headOperation.results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
  if (!observations.length) return
  let changed = false
  for (const published of state.published.filter((item) => item.finalityStatus !== 'finalized-tag-observed')) {
    const eligible = observations.filter(({ head }) => BigInt(head.number) >= BigInt(published.blockNumber))
    if (!eligible.length) continue
    const blockOperation = await settleEndpointOperation(eligible, async ({ client, head }) => {
      const block = await client.publicClient.getBlock({ blockNumber: BigInt(published.blockNumber) })
      return {
        provider: client.label,
        finalizedHeadNumber: head.number.toString(),
        finalizedHeadHash: head.hash,
        observedBlockHash: block.hash,
      }
    })
    const finalityObservations = blockOperation.results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value)
    const decision = finalizedTagDecision({ expectedBlockHash: published.blockHash, observations: finalityObservations })
    if (decision.status === 'provider-disagreement') {
      state.historyBlockedReason = `Finality provider disagreement for sequence ${published.sequence}`
      published.finalityStatus = 'provider-disagreement'
      published.finalityEvidence = { matches: decision.matches, conflicts: decision.conflicts, observedAt: new Date().toISOString() }
      changed = true
      continue
    }
    if (decision.status === 'finalized-tag-observed') {
      published.finalityStatus = 'finalized-tag-observed'
      published.finalityEvidence = { matches: decision.matches, conflicts: [], observedAt: new Date().toISOString() }
      changed = true
    }
  }
  if (!state.published.some((item) => item.finalityStatus === 'provider-disagreement')) delete state.historyBlockedReason
  if (changed) persist()
}

async function checkExternalNonceConsumption() {
  if (!state.items.length) return
  const lowest = [...state.items].sort((left, right) => left.nonce - right.nonce)[0]
  if (lowest.winnerHash || ['confirming', 'failed'].includes(lowest.status)) return
  const latestNonce = await withReadClient((client) => client.publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }))
  if (latestNonce > lowest.nonce) {
    lowest.status = 'blocked'
    lowest.blockedReason = `wallet nonce ${lowest.nonce} was consumed without a receipt from this attempt lineage; another wallet process may have replaced it`
    persist()
  }
}

async function rebroadcastPrepared() {
  const now = Date.now()
  for (const item of state.items) {
    if (item.winnerHash || ['confirming', 'failed'].includes(item.status)) continue
    const attempt = item.attempts.at(-1)
    const lastSend = Date.parse(attempt.lastSendAttemptAt || '')
    if (!Number.isFinite(lastSend) || now - lastSend >= config.retryMs) await sendAttempt(item, attempt)
  }
}

async function resumeReservedAttempts() {
  for (const item of state.items.filter((candidate) => candidate.status === 'reserved')) {
    await completeReservedAttempt(item)
  }
}

async function maybeReplaceLowest() {
  const item = [...state.items]
    .filter((candidate) => !candidate.winnerHash && !['confirming', 'failed'].includes(candidate.status))
    .sort((left, right) => left.nonce - right.nonce)[0]
  if (!item) return
  const eligibility = replacementEligibility(item, {
    replaceAfterMs,
    maxReplacements: config.maxReplacements,
  })
  if (eligibility.exhausted && eligibility.ageMs >= replaceAfterMs) {
    item.status = 'blocked'
    item.blockedReason = eligibility.reason
    persist()
    return
  }
  if (!eligibility.eligible) return
  const latest = item.attempts.at(-1)
  const block = await withReadClient((client) => client.publicClient.getBlock({ blockTag: 'latest' }))
  const suggested = await withReadClient((client) => client.publicClient.estimateFeesPerGas())
  const blobBaseFee = await withReadClient((client) => client.publicClient.getBlobBaseFee())
  const feeDecision = nextReplacementFees({
    current: {
      maxFeePerGas: BigInt(latest.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(latest.maxPriorityFeePerGas),
      maxFeePerBlobGas: BigInt(latest.maxFeePerBlobGas),
    },
    suggested,
    baseFeePerGas: block.baseFeePerGas || 0n,
    blobBaseFee,
    bumpPercent: config.feeBumpPercent,
    ceilings: feeCeilings(),
  })
  if (!feeDecision.allowed) {
    item.status = 'blocked'
    item.blockedReason = feeDecision.reason
    persist()
    return
  }
  item.status = 'replacing'
  item.blockedReason = null
  persist()
  let prepared
  let reservation
  try {
    ({ prepared, reservation } = await prepareReservation(item, feeDecision.fees))
  } catch (error) {
    if (!(error instanceof GasPreflightBlockedError)) throw error
    item.status = 'blocked'
    item.blockedReason = error.message
    persist()
    return
  }
  const budget = replacementBudgetDecision({
    item,
    nextReservedCostWei: reservation.reservedExposureWei,
    pendingItems: state.items,
    actualSpendWei: state.actualSpendWei,
    streamBudgetWei,
    segmentBudgetWei,
  })
  if (!budget.allowed) {
    item.status = 'blocked'
    item.blockedReason = budget.reason
    persist()
    return
  }
  const liquidity = await observeSignerLiquidity(budget.proposedPendingWei)
  item.liquidityEvidence = liquidity.evidence
  if (!liquidity.decision.allowed) {
    item.status = 'blocked'
    item.blockedReason = liquidity.decision.reason
    persist()
    return
  }
  const attempt = await durableReserveThenSign({
    reservation,
    durableReserve() {
      item.reservations.push(reservation)
      item.status = 'reserved'
      persist()
    },
    async afterDurableReserve() {
      maybeInjectPublisherFault('console-after-reservation')
      await revalidateGasPreflight(item)
    },
    sign() { return signReservedAttempt(item, reservation, prepared) },
    verify(signed) { return verifySignedPublicationIntent(signed.serializedTransaction, reservation) },
    durableCommit(signed) { commitSignedAttempt(item, signed) },
  })
  await sendAttempt(item, attempt)
}

async function loop() {
  await observePublishedFinality()
  const head = await withReadClient((client) => client.publicClient.getBlockNumber())
  for (const item of [...state.items]) await reconcileItem(item, head)
  await checkExternalNonceConsumption()
  await resumeReservedAttempts()
  await rebroadcastPrepared()
  await maybeReplaceLowest()
  while (!stopping && !state.historyBlockedReason && state.items.length < config.maxPending) {
    if (!await addNextSegment()) break
  }
}

function publicLineageSummary() {
  return state.items.map((item) => ({
    sequence: item.sequence,
    nonce: item.nonce,
    status: item.status,
    health: lineageHealth(item, { replaceAfterMs, maxReplacements: config.maxReplacements }),
    blockedReason: item.blockedReason,
    winnerHash: item.winnerHash,
    confirmations: item.confirmations || 0,
    attempts: item.attempts.map((attempt) => ({
      index: attempt.index,
      txHash: attempt.txHash,
      reservedCostWei: attempt.reservedCostWei,
      maxFeePerGas: attempt.maxFeePerGas,
      maxPriorityFeePerGas: attempt.maxPriorityFeePerGas,
      maxFeePerBlobGas: attempt.maxFeePerBlobGas,
      preparedAt: attempt.preparedAt,
      broadcastAt: attempt.broadcastAt,
      sendCount: attempt.sendCount,
    })),
  }))
}

process.on('SIGTERM', () => { stopping = true })
process.on('SIGINT', () => { stopping = true })
process.on('exit', () => processLock.release())

processLock.acquire()
const recoveryMarker = quarantineCriticalStateTemps(statePath)
if (recoveryMarker) {
  throw new Error(`Critical temporary publisher state was quarantined; ${recoveryMarker.artifacts.length} artifact(s) require operator reconciliation`)
}
let signerLease = null
try {
  signerLease = await acquireSignerCoordinatorLease({
    chainId: chain.id,
    publisher: account.address,
    statePath,
  })
  await initializeClients()
  const wasmKzg = await loadKZG()
  kzg = {
    blobToKzgCommitment(blob) { return hexToBytes(wasmKzg.blobToKzgCommitment(bytesToHex(blob))) },
    computeBlobKzgProof(blob, commitment) { return hexToBytes(wasmKzg.computeBlobKZGProof(bytesToHex(blob), bytesToHex(commitment))) },
  }
  state = loadState()
  lastDurableState = state.revision === undefined ? null : structuredClone(state)
  await verifyLoadedStateIntents()
  await initializeNonce()
  const balance = await withReadClient((client) => client.publicClient.getBalance({ address: account.address }))
  if (balance < streamBudgetWei) warn(`wallet balance is below the full configured stream budget; runtime exposure checks remain active`)
  persist()
  log(`reliable publisher watching ${config.segmentDir}`)
  log(`publisher ${account.address}, next nonce ${state.nextNonce}, confirmation depth ${config.confirmationDepth}`)
  while (!stopping) {
    try {
      await loop()
      delete state.lastLoopError
      delete state.lastLoopErrorAt
      state.publicLineages = publicLineageSummary()
      persist()
    } catch (error) {
      state.lastLoopError = String(error.message || error).split('\n')[0]
      state.lastLoopErrorAt = new Date().toISOString()
      persist()
      warn(`publisher loop retry: ${state.lastLoopError}`)
    }
    await sleep(1000)
  }
} finally {
  await signerLease?.release({ clearOwnership: Boolean(state && state.items.length === 0) })
  processLock.release()
}

export { publicLineageSummary }
